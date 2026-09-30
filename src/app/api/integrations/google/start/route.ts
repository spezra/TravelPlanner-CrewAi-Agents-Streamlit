import { DomainError } from "@/domain/common";
import { getDb } from "@/lib/server";
import { beginGoogleAuth, googleClientFromConfig } from "@/modules/crm/google";
import { currentSession } from "@/server/auth/session";
import { config } from "@/server/config";

export const dynamic = "force-dynamic";

const back = (path: string) => new Response(null, { status: 303, headers: { location: new URL(path, config().APP_URL).toString() } });

/**
 * Starts Google OAuth for the signed-in member. POST from the Integrations
 * page only: the session cookie is SameSite=Lax (not sent on cross-site
 * POSTs), and a present Origin must be our own.
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(config().APP_URL).origin) return new Response("Forbidden", { status: 403 });
  const session = await currentSession();
  if (!session?.member) return back("/login");
  const client = googleClientFromConfig();
  if (!client) return back(`/integrations?error=${encodeURIComponent("Google isn't configured on this installation")}`);
  try {
    const url = await beginGoogleAuth(await getDb(), { workspaceId: session.member.workspaceId, memberId: session.member.id }, client, new Date());
    return new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof DomainError) return back(`/integrations?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
}
