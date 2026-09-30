"use server";

import { redirect } from "next/navigation";
import { DomainError } from "@/domain/common";
import { config } from "@/server/config";
import { getDb } from "@/server/db";
import { mailer } from "@/server/mail";
import {
  acceptInvitation,
  consumeLoginToken,
  createWorkspace,
  devLogin,
  requestLoginLink,
  revokeSession,
  switchMembership,
} from "@/server/auth/core";
import { clearSessionCookie, clientMeta, requireSession, sessionToken, setSessionCookie } from "@/server/auth/session";

const back = (path: string, error: unknown): never => {
  if (!(error instanceof DomainError)) throw error;
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error.message)}`);
};

const localPath = (p: unknown) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p : "/");

export async function requestLink(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "");
  try {
    await requestLoginLink(await getDb(), mailer(), { email, ip: (await clientMeta()).ip, next: localPath(form.get("next")) });
  } catch (err) {
    back("/login", err);
  }
  redirect(`/login?sent=1`);
}

export async function verifyLink(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const next = localPath(form.get("next"));
  let sessionTok: string;
  try {
    ({ sessionToken: sessionTok } = await consumeLoginToken(await getDb(), token, await clientMeta()));
  } catch (err) {
    return back("/login", err);
  }
  await setSessionCookie(sessionTok, config().SESSION_TTL_DAYS);
  redirect(next);
}

export async function devSignIn(form: FormData): Promise<void> {
  const token = await devLogin(await getDb(), String(form.get("email")));
  await setSessionCookie(token, 1);
  redirect("/");
}

export async function signOut(): Promise<void> {
  const token = await sessionToken();
  if (token) await revokeSession(await getDb(), token);
  await clearSessionCookie();
  redirect("/login");
}

export async function switchWorkspace(form: FormData): Promise<void> {
  const s = await requireSession();
  try {
    await switchMembership(await getDb(), s.sessionId, s.userId, String(form.get("memberId")));
  } catch (err) {
    back("/", err);
  }
  redirect("/");
}

export async function createWorkspaceAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const portability = String(form.get("portability"));
  try {
    await createWorkspace(await getDb(), {
      userId: s.userId,
      sessionId: s.sessionId,
      workspaceName: String(form.get("workspaceName") ?? ""),
      memberName: String(form.get("memberName") ?? ""),
      bookPortability: portability === "agency_owns" || portability === "shared" ? portability : "advisor_owns",
      timeZone: String(form.get("timeZone") || "UTC"),
    });
  } catch (err) {
    back("/onboarding", err);
  }
  redirect("/");
}

export async function acceptInviteAction(form: FormData): Promise<void> {
  const s = await requireSession();
  const token = String(form.get("token") ?? "");
  try {
    await acceptInvitation(await getDb(), {
      token,
      userId: s.userId,
      sessionId: s.sessionId,
      name: String(form.get("name") ?? ""),
      timeZone: String(form.get("timeZone") || "UTC"),
    });
  } catch (err) {
    back(`/invite?token=${encodeURIComponent(token)}`, err);
  }
  redirect("/");
}
