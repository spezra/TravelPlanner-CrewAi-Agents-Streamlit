/**
 * Stripe adapter: Connect Express onboarding for payees, transfers from the
 * platform balance (and their reversals), and Checkout in setup mode for the
 * card vault. Plain fetch against the REST API: form-encoded bodies, bearer
 * auth, and an Idempotency-Key on every POST so a retried request can never
 * move money twice. Card numbers never touch this code; Stripe-hosted pages
 * collect them and we only ever see payment-method ids and display metadata.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API_VERSION = "2024-06-20";

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };

/**
 * Stripe's bracket form encoding: nested objects as a[b][c]=v, arrays as
 * a[0]=v. Null and undefined are omitted (Stripe treats "" as "unset").
 */
export function formEncode(params: Record<string, FormValue>): string {
  const out: string[] = [];
  const walk = (key: string, v: FormValue) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "StripeError";
  }
  /**
   * Safe to retry with the same idempotency key: network failures (status 0),
   * rate limits, idempotency-key-in-use conflicts and server errors. Card and
   * invalid-request errors are final.
   */
  get retryable(): boolean {
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

export interface StripeAccount {
  id: string;
  email: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements?: { currently_due?: string[]; disabled_reason?: string | null } | null;
  metadata?: Record<string, string>;
}

export interface StripeAccountLink {
  url: string;
  expires_at: number;
}

export interface StripeTransfer {
  id: string;
  amount: number;
  amount_reversed: number;
  currency: string;
  destination: string;
  reversed: boolean;
  transfer_group: string | null;
  metadata: Record<string, string>;
  reversals?: { data: StripeTransferReversal[] };
}

export interface StripeTransferReversal {
  id: string;
  amount: number;
  currency: string;
  transfer: string;
  metadata?: Record<string, string>;
}

export interface StripeCustomer {
  id: string;
  metadata: Record<string, string>;
}

export interface StripeCardDetails {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

export interface StripePaymentMethod {
  id: string;
  type: string;
  customer: string | null;
  card?: StripeCardDetails;
}

export interface StripeSetupIntent {
  id: string;
  status: string;
  customer: string | null;
  payment_method: string | StripePaymentMethod | null;
  metadata: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  mode: "payment" | "setup" | "subscription";
  status: string | null;
  customer: string | null;
  setup_intent: string | StripeSetupIntent | null;
  metadata: Record<string, string>;
}

export interface StripeEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  created: number;
  account?: string;
  livemode: boolean;
  data: { object: T; previous_attributes?: Record<string, unknown> };
}

type Fetch = typeof globalThis.fetch;

export class StripeClient {
  private readonly fetch: Fetch;
  private readonly base: string;

  constructor(
    private readonly secretKey: string,
    opts: { fetch?: Fetch; apiBase?: string } = {},
  ) {
    if (!secretKey) throw new Error("Stripe secret key is required");
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = opts.apiBase ?? "https://api.stripe.com";
  }

  private async request<T>(method: "GET" | "POST", path: string, params: Record<string, FormValue>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}`, "Stripe-Version": STRIPE_API_VERSION };
    let url = `${this.base}${path}`;
    let body: string | undefined;
    if (method === "POST") {
      if (!idempotencyKey) throw new Error(`Stripe POST ${path} requires an idempotency key`);
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Idempotency-Key"] = idempotencyKey;
      body = formEncode(params);
    } else {
      const qs = formEncode(params);
      if (qs) url += `?${qs}`;
    }
    let res: Response;
    try {
      res = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      // The request may or may not have reached Stripe; the caller retries with the same key.
      throw new StripeError(`Stripe request failed: ${err instanceof Error ? err.message : String(err)}`, 0, "connection_error", null, null);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new StripeError(`Stripe returned a non-JSON response (${res.status})`, res.status || 502, "api_error", null, res.headers.get("request-id"));
    }
    if (!res.ok) {
      const e = (json.error ?? {}) as { message?: string; type?: string; code?: string };
      throw new StripeError(e.message ?? `Stripe error ${res.status}`, res.status, e.type ?? null, e.code ?? null, res.headers.get("request-id"));
    }
    return json as T;
  }

  // Connect: Express accounts for payees -------------------------------------

  createExpressAccount(input: { email: string | null; country?: string | null; metadata: Record<string, string> }, idempotencyKey: string) {
    return this.request<StripeAccount>(
      "POST",
      "/v1/accounts",
      {
        type: "express",
        email: input.email,
        country: input.country ?? undefined,
        capabilities: { transfers: { requested: true } },
        metadata: input.metadata,
      },
      idempotencyKey,
    );
  }

  createAccountLink(input: { account: string; refreshUrl: string; returnUrl: string }, idempotencyKey: string) {
    return this.request<StripeAccountLink>(
      "POST",
      "/v1/account_links",
      { account: input.account, refresh_url: input.refreshUrl, return_url: input.returnUrl, type: "account_onboarding" },
      idempotencyKey,
    );
  }

  retrieveAccount(id: string) {
    return this.request<StripeAccount>("GET", `/v1/accounts/${encodeURIComponent(id)}`, {});
  }

  // Transfers from the platform balance ---------------------------------------

  createTransfer(
    input: { amountMinor: number; currency: string; destination: string; transferGroup: string; description?: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ) {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("Transfer amount must be a positive integer");
    return this.request<StripeTransfer>(
      "POST",
      "/v1/transfers",
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        destination: input.destination,
        transfer_group: input.transferGroup,
        description: input.description,
        metadata: input.metadata,
      },
      idempotencyKey,
    );
  }

  /** Reconcile before retry: find a transfer we may already have made (idempotency keys expire after 24h). */
  async findTransferByGroup(transferGroup: string): Promise<StripeTransfer | null> {
    const list = await this.request<{ data: StripeTransfer[] }>("GET", "/v1/transfers", { transfer_group: transferGroup, limit: 10 });
    return list.data[0] ?? null;
  }

  createTransferReversal(transferId: string, input: { amountMinor?: number; metadata?: Record<string, string> }, idempotencyKey: string) {
    return this.request<StripeTransferReversal>(
      "POST",
      `/v1/transfers/${encodeURIComponent(transferId)}/reversals`,
      { amount: input.amountMinor, metadata: input.metadata },
      idempotencyKey,
    );
  }

  // Card vault: customers and Checkout in setup mode --------------------------

  createCustomer(input: { name: string; email?: string | null; metadata: Record<string, string> }, idempotencyKey: string) {
    return this.request<StripeCustomer>("POST", "/v1/customers", { name: input.name, email: input.email ?? undefined, metadata: input.metadata }, idempotencyKey);
  }

  createSetupCheckoutSession(
    input: { customer: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ) {
    return this.request<StripeCheckoutSession>(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "setup",
        customer: input.customer,
        payment_method_types: ["card"],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: input.metadata,
        setup_intent_data: { metadata: input.metadata },
      },
      idempotencyKey,
    );
  }

  retrieveSetupIntent(id: string) {
    return this.request<StripeSetupIntent>("GET", `/v1/setup_intents/${encodeURIComponent(id)}`, { expand: ["payment_method"] });
  }

  retrievePaymentMethod(id: string) {
    return this.request<StripePaymentMethod>("GET", `/v1/payment_methods/${encodeURIComponent(id)}`, {});
  }

  detachPaymentMethod(id: string, idempotencyKey: string) {
    return this.request<StripePaymentMethod>("POST", `/v1/payment_methods/${encodeURIComponent(id)}/detach`, {}, idempotencyKey);
  }
}

// ---------------------------------------------------------------------------
// Webhook signatures

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * Verifies a `Stripe-Signature` header (t=<unix>,v1=<hex>[,v1=...]): HMAC-SHA256
 * of "<t>.<raw body>" with the endpoint secret, compared in constant time,
 * within a tolerance of the current time to limit replays. Event-id dedupe
 * handles replays inside the window.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now: Date, toleranceSeconds = 300): SignatureCheck {
  if (!header) return { ok: false, reason: "missing" };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    if (k === "v1" && /^[0-9a-f]+$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (t === null || v1.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const match = v1.some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Builds a valid header, for tests and local replays of fixture events. */
export function signStripePayload(rawBody: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}
