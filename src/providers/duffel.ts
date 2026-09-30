/**
 * Duffel (air) adapter: offer search, order creation, lookup, cancellation and
 * webhook signature verification against https://api.duffel.com (v2).
 *
 * Idempotency. Duffel has no idempotency header, so every order we create
 * carries our key in `metadata`. `lookup(key)` scans recent orders for it, and
 * `submit` looks first, so a resubmission after an ambiguous failure finds the
 * existing order instead of buying a second ticket.
 *
 * Error classes follow Duffel's documented error types:
 *  - rate_limit_error / 429: nothing was accepted, retry later.
 *  - api_error 500/502/503: Duffel did not complete the request; retry (submit
 *    re-checks for an existing order first).
 *  - 504, airline_error with a 5xx: the airline may have processed it: unknown.
 *  - other 4xx (validation, invalid_request, invalid_state, authentication,
 *    airline errors such as offer_no_longer_available): rejected.
 *  - 202 Accepted: accepted and still processing, which is not a failure.
 *  - a timeout or reset after the request left: unknown.
 *  - connection refused / DNS failure: never sent, retryable.
 */
import type { MaterialTerms } from "@/domain/approvals";
import type { LookupOutcome, ProviderAdapter, ProviderOutcome } from "@/domain/execution";
import { decimalToMinor, minorToDecimal } from "@/domain/tripPlanning";
import type { Money } from "@/domain/common";
import { hmacSha256Hex, safeEqual } from "@/server/crypto";

export const DUFFEL_BASE_URL = "https://api.duffel.com";
export const IDEMPOTENCY_METADATA_KEY = "atp_idempotency_key";

// ---------------------------------------------------------------------------
// Wire types (the subset of Duffel's v2 schema we use)

export interface DuffelPlace {
  iata_code: string;
  name?: string;
  city_name?: string | null;
}

export interface DuffelSegment {
  origin: DuffelPlace;
  destination: DuffelPlace;
  departing_at: string;
  arriving_at: string;
  marketing_carrier: { name: string; iata_code: string };
  marketing_carrier_flight_number: string;
}

export interface DuffelSlice {
  origin: DuffelPlace;
  destination: DuffelPlace;
  duration?: string | null;
  segments: DuffelSegment[];
}

export interface DuffelCondition {
  allowed: boolean;
  penalty_amount: string | null;
  penalty_currency: string | null;
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at: string;
  owner: { name: string; iata_code: string };
  slices: DuffelSlice[];
  passengers: { id: string; type?: string | null }[];
  conditions?: { refund_before_departure?: DuffelCondition | null; change_before_departure?: DuffelCondition | null } | null;
}

export interface DuffelOrder {
  id: string;
  booking_reference: string | null;
  total_amount: string;
  total_currency: string;
  created_at: string;
  cancelled_at?: string | null;
  metadata?: Record<string, string> | null;
  slices?: DuffelSlice[];
}

export interface DuffelOrderCancellation {
  id: string;
  order_id: string;
  refund_amount: string | null;
  refund_currency: string | null;
  expires_at: string | null;
  confirmed_at: string | null;
}

export interface DuffelApiError {
  type: string;
  code?: string;
  title?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Transport and errors

export class DuffelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errors: DuffelApiError[],
    readonly requestId: string | null,
  ) {
    const first = errors[0];
    super(`Duffel ${status}${first ? ` ${first.type}${first.code ? `/${first.code}` : ""}: ${first.message ?? first.title ?? ""}` : ""}`.trim());
    this.name = "DuffelHttpError";
  }
}

/** A transport failure. `sent` says whether the request may have reached Duffel. */
export class DuffelNetworkError extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
  ) {
    super(message);
    this.name = "DuffelNetworkError";
  }
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED"]);

function networkError(err: unknown, aborted: boolean): DuffelNetworkError {
  if (aborted) return new DuffelNetworkError("Timed out waiting for Duffel", true);
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return new DuffelNetworkError(`${message}${code ? ` (${code})` : ""}`, !(code && NOT_SENT_CODES.has(code)));
}

export interface DuffelClientOptions {
  accessToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Per request. Order creation can take a while at some airlines. */
  timeoutMs?: number;
}

export class DuffelClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DuffelClientOptions) {
    if (!opts.accessToken) throw new Error("Duffel access token is required");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.baseUrl = (opts.baseUrl ?? DUFFEL_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T; meta: Record<string, unknown> | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.accessToken}`,
          "Duffel-Version": "v2",
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify({ data: body }) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw networkError(err, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
    let json: { data?: T; meta?: Record<string, unknown> | null; errors?: DuffelApiError[] } = {};
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : {};
    } catch {
      // A response we can't read after the request was accepted is still a response: fall through on status.
    }
    if (!res.ok) {
      throw new DuffelHttpError(res.status, json.errors ?? [], res.headers.get("x-request-id"));
    }
    return { status: res.status, data: json.data as T, meta: json.meta ?? null };
  }

  // Offers -----------------------------------------------------------------

  async searchOffers(input: OfferSearch): Promise<DuffelOffer[]> {
    const slices = [{ origin: input.origin, destination: input.destination, departure_date: input.departureDate }];
    if (input.returnDate) slices.push({ origin: input.destination, destination: input.origin, departure_date: input.returnDate });
    const { data } = await this.request<{ offers: DuffelOffer[] }>("POST", "/air/offer_requests?return_offers=true&supplier_timeout=20000", {
      slices,
      passengers: Array.from({ length: input.adults }, () => ({ type: "adult" })),
      cabin_class: input.cabinClass,
      max_connections: input.maxConnections ?? 1,
    });
    return (data?.offers ?? []).slice().sort((a, b) => Number(a.total_amount) - Number(b.total_amount));
  }

  async getOffer(id: string): Promise<DuffelOffer> {
    return (await this.request<DuffelOffer>("GET", `/air/offers/${encodeURIComponent(id)}?return_available_services=false`)).data;
  }

  // Orders -----------------------------------------------------------------

  async createOrder(input: { offerId: string; passengers: OrderPassenger[]; payment: Money; idempotencyKey: string }): Promise<{ status: number; order: DuffelOrder }> {
    const { status, data } = await this.request<DuffelOrder>("POST", "/air/orders", {
      type: "instant",
      selected_offers: [input.offerId],
      passengers: input.passengers,
      payments: [{ type: "balance", currency: input.payment.currency, amount: minorToDecimal(input.payment) }],
      metadata: { [IDEMPOTENCY_METADATA_KEY]: input.idempotencyKey },
    });
    return { status, order: data };
  }

  async getOrder(id: string): Promise<DuffelOrder> {
    return (await this.request<DuffelOrder>("GET", `/air/orders/${encodeURIComponent(id)}`)).data;
  }

  async listOrders(after?: string | null): Promise<{ orders: DuffelOrder[]; after: string | null }> {
    const qs = new URLSearchParams({ limit: "200" });
    if (after) qs.set("after", after);
    const { data, meta } = await this.request<DuffelOrder[]>("GET", `/air/orders?${qs}`);
    return { orders: data ?? [], after: (meta?.after as string | null | undefined) ?? null };
  }

  // Cancellations ----------------------------------------------------------

  async listOrderCancellations(orderId: string): Promise<DuffelOrderCancellation[]> {
    const qs = new URLSearchParams({ order_id: orderId });
    return (await this.request<DuffelOrderCancellation[]>("GET", `/air/order_cancellations?${qs}`)).data ?? [];
  }

  async createOrderCancellation(orderId: string): Promise<DuffelOrderCancellation> {
    return (await this.request<DuffelOrderCancellation>("POST", "/air/order_cancellations", { order_id: orderId })).data;
  }

  async confirmOrderCancellation(id: string): Promise<DuffelOrderCancellation> {
    return (await this.request<DuffelOrderCancellation>("POST", `/air/order_cancellations/${encodeURIComponent(id)}/actions/confirm`)).data;
  }
}

export interface OfferSearch {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string | null;
  adults: number;
  cabinClass: "economy" | "premium_economy" | "business" | "first";
  maxConnections?: number;
}

/** Passenger as Duffel's create-order call expects it; `id` comes from the offer. */
export interface OrderPassenger {
  id: string;
  title: "mr" | "ms" | "mrs" | "miss" | "dr";
  given_name: string;
  family_name: string;
  gender: "m" | "f";
  born_on: string;
  email: string;
  phone_number: string;
}

export type TravelerDetails = Omit<OrderPassenger, "id">;

// ---------------------------------------------------------------------------
// Mapping

/** Deterministic wording of fare conditions. Used in approvals, so identical conditions give identical text. */
export function describeConditions(offer: Pick<DuffelOffer, "conditions">): string {
  const part = (label: string, c: DuffelCondition | null | undefined) => {
    if (!c) return `${label}: not stated by the airline`;
    if (!c.allowed) return `${label}: not permitted`;
    if (c.penalty_amount && c.penalty_currency && Number(c.penalty_amount) > 0) return `${label}: permitted, penalty ${c.penalty_currency} ${c.penalty_amount}`;
    return `${label}: permitted, no penalty`;
  };
  return `${part("Refund before departure", offer.conditions?.refund_before_departure)}. ${part("Changes before departure", offer.conditions?.change_before_departure)}.`;
}

export interface OfferSnapshot {
  provider: "duffel";
  offerId: string;
  price: Money;
  expiresAt: string;
  owner: string;
  passengerIds: string[];
  cancellationPolicy: string;
  slices: { origin: string; destination: string; departingAt: string; arrivingAt: string; flights: string[]; stops: number }[];
}

export function snapshotOffer(offer: DuffelOffer): OfferSnapshot {
  return {
    provider: "duffel",
    offerId: offer.id,
    price: decimalToMinor(offer.total_amount, offer.total_currency),
    expiresAt: new Date(offer.expires_at).toISOString(),
    owner: offer.owner.name,
    passengerIds: offer.passengers.map((p) => p.id),
    cancellationPolicy: describeConditions(offer),
    slices: offer.slices.map((s) => ({
      origin: s.origin.iata_code,
      destination: s.destination.iata_code,
      departingAt: s.segments[0]?.departing_at ?? "",
      arrivingAt: s.segments.at(-1)?.arriving_at ?? "",
      flights: s.segments.map((g) => `${g.marketing_carrier.iata_code}${g.marketing_carrier_flight_number}`),
      stops: Math.max(0, s.segments.length - 1),
    })),
  };
}

/** Current conditions for a booking re-read from the offer; downstream changes and actor stay those approved. */
export function termsFromOffer(offer: DuffelOffer, approved: MaterialTerms): MaterialTerms {
  return {
    ...approved,
    price: decimalToMinor(offer.total_amount, offer.total_currency),
    offerExpiresAt: new Date(offer.expires_at).toISOString(),
    cancellationPolicy: describeConditions(offer),
  };
}

/** Maps a failed order/cancellation call to the execution outcome it implies. */
export function classifyFailure(err: unknown): ProviderOutcome {
  if (err instanceof DuffelNetworkError) {
    return err.sent ? { kind: "unknown", error: err.message } : { kind: "retryable", error: err.message };
  }
  if (err instanceof DuffelHttpError) {
    const types = new Set(err.errors.map((e) => e.type));
    const detail = err.message + (err.requestId ? ` [request ${err.requestId}]` : "");
    if (err.status === 429 || types.has("rate_limit_error")) return { kind: "retryable", error: detail };
    if (err.status >= 500) {
      if (types.has("airline_error") || err.status === 504) return { kind: "unknown", error: detail };
      return { kind: "retryable", error: detail };
    }
    return { kind: "rejected", error: detail };
  }
  return { kind: "unknown", error: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// Execution adapter

export interface DuffelBookingRequest {
  offerId: string;
  /** In the offer's passenger order. */
  travelers: TravelerDetails[];
}

export interface DuffelAdapterOptions {
  /** How far back `lookup` scans orders for a key. */
  lookbackHours?: number;
  maxLookupPages?: number;
  now?: () => Date;
}

/**
 * ProviderAdapter for one booking. `booking` is the selected offer and the
 * travelers; lookup and cancellation need only the client.
 */
export class DuffelAdapter implements ProviderAdapter {
  readonly name = "duffel";
  private readonly lookbackMs: number;
  private readonly maxPages: number;
  private readonly now: () => Date;

  constructor(
    readonly client: DuffelClient,
    private readonly booking: DuffelBookingRequest | null = null,
    opts: DuffelAdapterOptions = {},
  ) {
    this.lookbackMs = (opts.lookbackHours ?? 24 * 7) * 3_600_000;
    this.maxPages = opts.maxLookupPages ?? 10;
    this.now = opts.now ?? (() => new Date());
  }

  /** Re-read current conditions from the offer itself. */
  async currentTerms(approved: MaterialTerms): Promise<MaterialTerms> {
    if (!this.booking) throw new Error("No Duffel offer selected for this item");
    return termsFromOffer(await this.client.getOffer(this.booking.offerId), approved);
  }

  async submit(key: string, payload: unknown): Promise<ProviderOutcome> {
    if (!this.booking) return { kind: "rejected", error: "No Duffel offer selected for this item" };
    // Look before buying: an earlier ambiguous attempt under this key may have created the order.
    const prior = await this.lookup(key);
    if (prior.kind === "found") return { kind: "accepted", providerRef: prior.providerRef };
    if (prior.kind === "unknown") return { kind: "retryable", error: `Could not verify there is no earlier order: ${prior.error}` };

    const terms = (payload as { terms?: MaterialTerms } | null)?.terms;
    if (!terms) return { kind: "rejected", error: "Booking payload has no terms" };
    let offer: DuffelOffer;
    try {
      offer = await this.client.getOffer(this.booking.offerId);
    } catch (err) {
      // Nothing was ordered yet, so any failure reading the offer is safe to retry, except a definitive 4xx.
      const o = classifyFailure(err);
      return o.kind === "unknown" ? { kind: "retryable", error: o.error } : o;
    }
    const offerPrice = decimalToMinor(offer.total_amount, offer.total_currency);
    if (offerPrice.currency !== terms.price.currency || offerPrice.amountMinor !== terms.price.amountMinor) {
      return { kind: "rejected", error: `Offer price moved to ${offer.total_currency} ${offer.total_amount} after the pre-booking check` };
    }
    if (offer.passengers.length !== this.booking.travelers.length) {
      return { kind: "rejected", error: `Offer is for ${offer.passengers.length} passengers but ${this.booking.travelers.length} travelers are on file` };
    }
    const passengers: OrderPassenger[] = offer.passengers.map((p, i) => ({ id: p.id, ...this.booking!.travelers[i]! }));
    try {
      const { status, order } = await this.client.createOrder({ offerId: offer.id, passengers, payment: terms.price, idempotencyKey: key });
      if (status === 202 || !order?.id) return { kind: "processing", error: "Duffel accepted the order and is still processing it" };
      return { kind: "accepted", providerRef: order.id };
    } catch (err) {
      return classifyFailure(err);
    }
  }

  async lookup(key: string): Promise<LookupOutcome> {
    const cutoff = this.now().getTime() - this.lookbackMs;
    let after: string | null = null;
    try {
      for (let page = 0; page < this.maxPages; page++) {
        const res = await this.client.listOrders(after);
        const hit = res.orders.find((o) => o.metadata?.[IDEMPOTENCY_METADATA_KEY] === key);
        if (hit) return { kind: "found", providerRef: hit.id };
        const allOlder = res.orders.length > 0 && res.orders.every((o) => new Date(o.created_at).getTime() < cutoff);
        if (!res.after || allOlder) return { kind: "absent" };
        after = res.after;
      }
    } catch (err) {
      return { kind: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
    return { kind: "unknown", error: `No order found in the ${this.maxPages * 200} most recent orders; scan did not reach the lookback window` };
  }

  /** Traveler-facing reference (PNR) for an order. */
  async confirmationRef(providerRef: string): Promise<string | null> {
    try {
      return (await this.client.getOrder(providerRef)).booking_reference ?? null;
    } catch {
      return null;
    }
  }

  // Cancellation: a quote (order_cancellation) followed by confirmation.

  /** Cost of cancelling now: order total minus the refund Duffel quotes. */
  async cancellationQuote(orderId: string): Promise<{ cancellationId: string; cost: Money; expiresAt: string | null }> {
    const existing = (await this.client.listOrderCancellations(orderId)).find((c) => !c.confirmed_at);
    const quote = existing ?? (await this.client.createOrderCancellation(orderId));
    const order = await this.client.getOrder(orderId);
    const total = decimalToMinor(order.total_amount, order.total_currency);
    const refund = quote.refund_amount && quote.refund_currency === order.total_currency ? decimalToMinor(quote.refund_amount, order.total_currency).amountMinor : 0;
    return { cancellationId: quote.id, cost: { amountMinor: Math.max(0, total.amountMinor - refund), currency: total.currency }, expiresAt: quote.expires_at };
  }

  async cancel(_key: string, orderId: string): Promise<ProviderOutcome> {
    let pending: DuffelOrderCancellation | undefined;
    try {
      const existing = await this.client.listOrderCancellations(orderId);
      const done = existing.find((c) => c.confirmed_at);
      if (done) return { kind: "accepted", providerRef: done.id };
      pending = existing.find((c) => !c.confirmed_at) ?? (await this.client.createOrderCancellation(orderId));
    } catch (err) {
      // Nothing irreversible happens until confirm.
      const o = classifyFailure(err);
      return o.kind === "unknown" ? { kind: "retryable", error: o.error } : o;
    }
    try {
      const confirmed = await this.client.confirmOrderCancellation(pending.id);
      return confirmed.confirmed_at ? { kind: "accepted", providerRef: confirmed.id } : { kind: "processing", error: "Cancellation confirmation pending at Duffel" };
    } catch (err) {
      return classifyFailure(err);
    }
  }

  async lookupCancellation(_key: string, orderId: string): Promise<LookupOutcome> {
    try {
      const done = (await this.client.listOrderCancellations(orderId)).find((c) => c.confirmed_at);
      return done ? { kind: "found", providerRef: done.id } : { kind: "absent" };
    } catch (err) {
      return { kind: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Webhooks

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * `X-Duffel-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * Rejects missing or malformed headers, timestamps more than five minutes
 * from now in either direction, and any signature that doesn't match.
 */
export function verifyDuffelSignature(header: string | null, rawBody: string, secret: string, now: Date): SignatureCheck {
  if (!header) return { ok: false, reason: "missing" };
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v.toLowerCase());
  }
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(now.getTime() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  const expected = hmacSha256Hex(secret, `${t}.${rawBody}`);
  return sigs.some((s) => safeEqual(s, expected)) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export function signDuffelPayload(rawBody: string, secret: string, now: Date): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}

export interface DuffelWebhookEvent {
  id: string;
  type: string;
  live_mode?: boolean;
  created_at?: string;
  data?: { object?: Record<string, unknown> } | null;
}

/** The order an event concerns: an order object itself, or an object that points at one. */
export function eventOrderId(ev: DuffelWebhookEvent): string | null {
  const obj = ev.data?.object;
  if (!obj) return null;
  if (typeof obj.order_id === "string") return obj.order_id;
  if (typeof obj.id === "string" && obj.id.startsWith("ord_")) return obj.id;
  return null;
}
