/**
 * An in-memory Duffel API behind a fake `fetch`, following the v2 wire format
 * ({data: ...} bodies, {errors: [...]} failures, cursor pagination). Failures
 * can be scripted per route, including the one that matters most: the order
 * is created and the response never arrives.
 */
import type { DuffelOffer, DuffelOrder, DuffelOrderCancellation } from "@/providers/duffel";

export type Fault =
  | { kind: "http"; status: number; type: string; code?: string }
  | { kind: "refused" } // connection refused: never sent
  | { kind: "timeout_after" } // the request is processed, then the connection drops
  | { kind: "accepted_202" }; // accepted, still processing

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export class FakeDuffel {
  offers = new Map<string, DuffelOffer>();
  orders: DuffelOrder[] = [];
  cancellations: DuffelOrderCancellation[] = [];
  calls: Call[] = [];
  faults: Record<string, Fault[]> = {};
  pageSize = 200;
  private seq = 1;

  constructor(private readonly clock: () => Date) {}

  addOffer(over: Partial<DuffelOffer> = {}): DuffelOffer {
    const id = over.id ?? `off_${this.seq++}`;
    const offer: DuffelOffer = {
      id,
      total_amount: "1840.00",
      total_currency: "USD",
      expires_at: new Date(this.clock().getTime() + 2 * 3_600_000).toISOString(),
      owner: { name: "Aeroméxico", iata_code: "AM" },
      passengers: [{ id: `pas_${id}_1`, type: "adult" }, { id: `pas_${id}_2`, type: "adult" }],
      conditions: {
        refund_before_departure: { allowed: true, penalty_amount: "200.00", penalty_currency: "USD" },
        change_before_departure: { allowed: true, penalty_amount: null, penalty_currency: null },
      },
      slices: [
        {
          origin: { iata_code: "JFK" },
          destination: { iata_code: "MEX" },
          segments: [
            {
              origin: { iata_code: "JFK" },
              destination: { iata_code: "MEX" },
              departing_at: "2027-01-09T08:05:00",
              arriving_at: "2027-01-09T12:10:00",
              marketing_carrier: { name: "Aeroméxico", iata_code: "AM" },
              marketing_carrier_flight_number: "403",
            },
          ],
        },
      ],
      ...over,
    };
    this.offers.set(id, offer);
    return offer;
  }

  /** Add unrelated orders so lookups have to paginate. */
  addNoise(n: number, ageHours = 1): void {
    for (let i = 0; i < n; i++) {
      this.orders.unshift({
        id: `ord_noise_${this.seq++}`,
        booking_reference: "NOISE1",
        total_amount: "100.00",
        total_currency: "USD",
        created_at: new Date(this.clock().getTime() - ageHours * 3_600_000).toISOString(),
        metadata: {},
      });
    }
  }

  fault(route: string, ...f: Fault[]): void {
    (this.faults[route] ??= []).push(...f);
  }

  get createdOrders(): DuffelOrder[] {
    return this.orders.filter((o) => !o.id.startsWith("ord_noise_"));
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, headers, body });
    const route = `${method} ${url.pathname.replace(/\/(off|ord|ore)_[A-Za-z0-9_]+/g, "/:id")}`;
    const fault = this.faults[route]?.shift();
    if (fault?.kind === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (fault?.kind === "http") {
      return json(fault.status, { errors: [{ type: fault.type, code: fault.code ?? "error", title: "Error", message: `scripted ${fault.status}` }], meta: { status: fault.status } });
    }
    const res = this.handle(method, url, body);
    if (fault?.kind === "timeout_after") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    if (fault?.kind === "accepted_202") return json(202, { data: null });
    return res;
  };

  private handle(method: string, url: URL, body: { data?: Record<string, unknown> } | undefined): Response {
    const p = url.pathname;
    const d = body?.data ?? {};
    if (method === "POST" && p === "/air/offer_requests") {
      const n = (d.passengers as unknown[]).length;
      const cheap = this.addOffer({ total_amount: "1650.00", passengers: Array.from({ length: n }, (_, i) => ({ id: `pas_c_${i}`, type: "adult" })) });
      const dear = this.addOffer({ total_amount: "2100.00", passengers: Array.from({ length: n }, (_, i) => ({ id: `pas_d_${i}`, type: "adult" })) });
      return json(201, { data: { id: `orq_${this.seq++}`, offers: [dear, cheap] } });
    }
    let m = /^\/air\/offers\/(.+)$/.exec(p);
    if (method === "GET" && m) {
      const offer = this.offers.get(decodeURIComponent(m[1]!));
      return offer ? json(200, { data: offer }) : json(404, { errors: [{ type: "invalid_request_error", code: "not_found", message: "Offer not found" }] });
    }
    if (method === "POST" && p === "/air/orders") {
      const offer = this.offers.get((d.selected_offers as string[])[0]!);
      if (!offer || new Date(offer.expires_at) <= this.clock()) {
        return json(422, { errors: [{ type: "airline_error", code: "offer_no_longer_available", message: "The offer is no longer available" }] });
      }
      const pay = (d.payments as { amount: string; currency: string }[])[0]!;
      if (pay.amount !== offer.total_amount || pay.currency !== offer.total_currency) {
        return json(422, { errors: [{ type: "validation_error", code: "invalid_payment", message: "Payment does not match offer total" }] });
      }
      const order: DuffelOrder = {
        id: `ord_${this.seq++}`,
        booking_reference: `PNR${this.seq}`,
        total_amount: offer.total_amount,
        total_currency: offer.total_currency,
        created_at: this.clock().toISOString(),
        metadata: d.metadata as Record<string, string>,
      };
      this.orders.unshift(order);
      return json(201, { data: order });
    }
    if (method === "GET" && p === "/air/orders") {
      const after = url.searchParams.get("after");
      const start = after ? Number(after) : 0;
      const page = this.orders.slice(start, start + this.pageSize);
      const next = start + this.pageSize < this.orders.length ? String(start + this.pageSize) : null;
      return json(200, { data: page, meta: { after: next, before: null, limit: this.pageSize } });
    }
    m = /^\/air\/orders\/(.+)$/.exec(p);
    if (method === "GET" && m) {
      const order = this.orders.find((o) => o.id === decodeURIComponent(m![1]!));
      return order ? json(200, { data: order }) : json(404, { errors: [{ type: "invalid_request_error", code: "not_found", message: "Order not found" }] });
    }
    if (method === "GET" && p === "/air/order_cancellations") {
      const orderId = url.searchParams.get("order_id");
      return json(200, { data: this.cancellations.filter((c) => c.order_id === orderId), meta: { after: null } });
    }
    if (method === "POST" && p === "/air/order_cancellations") {
      const c: DuffelOrderCancellation = {
        id: `ore_${this.seq++}`,
        order_id: String(d.order_id),
        refund_amount: "1640.00",
        refund_currency: "USD",
        expires_at: new Date(this.clock().getTime() + 3_600_000).toISOString(),
        confirmed_at: null,
      };
      this.cancellations.push(c);
      return json(201, { data: c });
    }
    m = /^\/air\/order_cancellations\/(.+)\/actions\/confirm$/.exec(p);
    if (method === "POST" && m) {
      const c = this.cancellations.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!c) return json(404, { errors: [{ type: "invalid_request_error", code: "not_found" }] });
      c.confirmed_at = this.clock().toISOString();
      const order = this.orders.find((o) => o.id === c.order_id);
      if (order) order.cancelled_at = c.confirmed_at;
      return json(200, { data: c });
    }
    return json(404, { errors: [{ type: "invalid_request_error", code: "not_found", message: `No route ${method} ${p}` }] });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req_fake" } });
}
