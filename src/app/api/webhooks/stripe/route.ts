import { ingestStripeWebhook } from "@/modules/money/webhook";
import { config } from "@/server/config";
import { getDb } from "@/server/db";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;

/**
 * Stripe webhook endpoint. Verifies Stripe-Signature over the raw body (5-minute
 * tolerance), stores the event once by id and queues processing. Replies 2xx
 * for duplicates so Stripe stops redelivering them.
 */
export async function POST(req: Request) {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  const result = await ingestStripeWebhook(await getDb(), raw, req.headers.get("stripe-signature"), config().STRIPE_WEBHOOK_SECRET, new Date());
  if (result.status !== 200) {
    log.warn({ status: result.status, reason: result.error }, "stripe webhook rejected");
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ received: true, duplicate: result.duplicate });
}
