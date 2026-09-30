import { DomainError } from "@/domain/common";
import { checkOnboardingToken, moneyDeps } from "@/modules/money/deps";
import { onboardingLinkForRefresh } from "@/modules/money/recipients";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1f1c18;background:#f7f4ef}</style></head>
<body><h1 style="font-weight:500">${title}</h1><p>${body}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );

/**
 * Stripe Connect onboarding hand-offs for payees, who may not be members:
 * refresh_url (expired link → a fresh one) and return_url (&done=1 → record
 * their status). The link is signed so only the payee's own URL works.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const recipientId = url.searchParams.get("r") ?? "";
  const token = url.searchParams.get("t") ?? "";
  const deps = moneyDeps();
  if (!deps.linkSecret || !/^[0-9a-f-]{36}$/.test(recipientId) || !checkOnboardingToken(deps.linkSecret, recipientId, token)) {
    return page("Link not valid", "This payout setup link isn't valid. Ask the advisor who invited you for a new one.", 404);
  }
  try {
    const out = await onboardingLinkForRefresh(await getDb(), recipientId, deps, new Date(), url.searchParams.get("done") === "1");
    if ("redirect" in out) return Response.redirect(out.redirect, 303);
    return out.status === "enabled"
      ? page("You're set up for payouts", "Thank you. Transfers for your collaboration fees and commission shares will arrive in the account you connected. You can close this window.")
      : page("Almost there", "Stripe still needs a few details before payouts can start. Open the link from your invitation again to finish, or close this window and come back later.");
  } catch (err) {
    if (err instanceof DomainError) return page("Link not valid", "This payout setup link isn't valid any more. Ask the advisor who invited you for a new one.", 404);
    throw err;
  }
}
