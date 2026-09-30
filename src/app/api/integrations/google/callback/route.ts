import { DomainError } from "@/domain/common";
import { getDb } from "@/lib/server";
import { completeGoogleAuth, googleClientFromConfig } from "@/modules/crm/google";
import { currentSession } from "@/server/auth/session";
import { config } from "@/server/config";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

const back = (path: string) => new Response(null, { status: 303, headers: { location: new URL(path, config().APP_URL).toString(), "cache-control": "no-store" } });

/** Google redirects here. The state must belong to the member whose session this is. */
export async function GET(req: Request) {
  const session = await currentSession();
  if (!session?.member) return back("/login?next=%2Fintegrations");
  const client = googleClientFromConfig();
  if (!client) return back(`/integrations?error=${encodeURIComponent("Google isn't configured on this installation")}`);
  const params = new URL(req.url).searchParams;
  try {
    await completeGoogleAuth(
      await getDb(),
      { workspaceId: session.member.workspaceId, memberId: session.member.id },
      client,
      { code: params.get("code"), state: params.get("state"), error: params.get("error") },
      new Date(),
    );
  } catch (err) {
    if (err instanceof DomainError) return back(`/integrations?error=${encodeURIComponent(err.message)}`);
    log.error({ err: err instanceof Error ? err.message : String(err) }, "google oauth callback failed");
    return back(`/integrations?error=${encodeURIComponent("Couldn't reach Google. Try again.")}`);
  }
  return back(`/integrations?ok=${encodeURIComponent("Google connected. Importing two years of history in the background.")}`);
}
