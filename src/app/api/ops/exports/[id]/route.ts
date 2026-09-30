import { DomainError } from "@/domain/common";
import { downloadExport } from "@/modules/ops/exports";
import { currentSession } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { log } from "@/server/log";
import { blobs } from "@/server/storage";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single download of a prepared export, by the member who requested it. The
 * export is marked downloaded in the same transaction that reads it, and the
 * file is deleted afterwards.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  if (!session?.member) return new Response("Sign in required", { status: 401 });
  if (session.member.role !== "owner" && session.member.role !== "admin") return new Response("Forbidden", { status: 403 });
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  try {
    const file = await downloadExport(await getDb(), blobs(), { workspaceId: session.member.workspaceId, memberId: session.member.id }, id, new Date());
    return new Response(new Uint8Array(file.body), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof DomainError) return new Response(err.message, { status: err.code === "not_found" ? 404 : 410 });
    log.error({ exportId: id, err: err instanceof Error ? err.message : String(err) }, "export download failed");
    return new Response("Download failed", { status: 500 });
  }
}
