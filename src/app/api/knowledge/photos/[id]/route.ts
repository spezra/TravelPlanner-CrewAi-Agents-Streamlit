/**
 * Serves an observation photo, decrypted for a member who can see the
 * observation (RLS decides). Never cached by shared caches.
 */
import { getDb } from "@/server/db";
import { currentSession } from "@/server/auth/session";
import { log } from "@/server/log";
import { readPhoto } from "@/modules/network/observations";
import { blobs } from "@/server/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const session = await currentSession();
  if (!session?.member) return new Response("Unauthorized", { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  try {
    const photo = await readPhoto(await getDb(), { workspaceId: session.member.workspaceId, memberId: session.member.id }, id, blobs());
    if (!photo) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(photo.bytes), {
      headers: {
        "Content-Type": photo.contentType,
        "Cache-Control": "private, no-store",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    log.error({ observationId: id, err: err instanceof Error ? err.message : String(err) }, "observation photo read failed");
    return new Response("Unavailable", { status: 500 });
  }
}
