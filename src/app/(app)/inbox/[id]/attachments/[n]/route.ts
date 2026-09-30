import { withTenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { decryptBytes } from "@/server/crypto";
import { blobs } from "@/server/storage";

export const dynamic = "force-dynamic";

/** Streams a decrypted attachment to a member who can see the message. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{1,2}$/.test(n)) return new Response("Not found", { status: 404 });
  const me = await requireMember();
  const db = await getDb();
  const att = await withTenant(db, me.tenant, async (q) => {
    const { rows } = await q.query<{ attachments: { name: string; contentType: string; key: string | null }[] }>("select attachments from inbound_messages where id = $1", [id]);
    return rows[0]?.attachments[Number(n)] ?? null;
  });
  if (!att?.key) return new Response("Not found", { status: 404 });
  const sealed = (await blobs().get(att.key)).toString("utf8");
  const bytes = await withTenant(db, me.tenant, (q) => decryptBytes(q, me.tenant.workspaceId, `blob:${att.key}`, sealed));
  return new Response(new Uint8Array(bytes), {
    headers: {
      // Always a download: never render supplier-sent HTML or SVG in our origin.
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
