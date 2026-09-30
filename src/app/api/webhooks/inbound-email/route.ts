import { handleInboundWebhook, inboundDomain } from "@/modules/crm/inbound";
import { config } from "@/server/config";
import { getDb } from "@/server/db";
import { blobs } from "@/server/storage";

export const dynamic = "force-dynamic";

/**
 * Postmark-style inbound email. Authenticated with HTTP Basic (secret as the
 * password) or ?secret=, both compared in constant time against
 * INBOUND_EMAIL_SECRET. Routed to a workspace by its in+<token>@ address.
 */
export async function POST(req: Request) {
  const c = config();
  return handleInboundWebhook(req, { db: await getDb(), secret: c.INBOUND_EMAIL_SECRET, domain: inboundDomain(c.APP_URL), blobs: blobs(), now: new Date() });
}
