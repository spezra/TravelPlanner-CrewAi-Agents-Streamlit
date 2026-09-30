import { getDb } from "@/lib/server";
import { handleDuffelWebhook } from "@/modules/trips/webhook";
import { config } from "@/server/config";

export const dynamic = "force-dynamic";

/** Duffel webhooks (air). Signature-verified, deduplicated by event id; see src/modules/trips/webhook.ts. */
export async function POST(req: Request) {
  const secret = config().DUFFEL_WEBHOOK_SECRET;
  if (!secret) return Response.json({ ok: false, error: "webhooks not configured" }, { status: 503 });
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 1_000_000) return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  // Verify against the exact bytes received: re-serialized JSON would not match the signature.
  const rawBody = await req.text();
  const r = await handleDuffelWebhook(await getDb(), { rawBody, signature: req.headers.get("x-duffel-signature"), secret, now: new Date() });
  return Response.json(r.body, { status: r.status });
}
