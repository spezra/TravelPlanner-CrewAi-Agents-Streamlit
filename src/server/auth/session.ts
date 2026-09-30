/**
 * Next.js adapter for sessions: cookie handling and route guards.
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Tenant } from "@/db/tenant";
import type { Role } from "@/domain/common";
import { isProduction } from "../config";
import { getDb } from "../db";
import { getSession, type SessionInfo } from "./core";

// __Host- prefix: Secure, Path=/, no Domain, so no subdomain can set or read it.
export const sessionCookieName = () => (isProduction() ? "__Host-sid" : "sid");

export async function setSessionCookie(token: string, maxAgeDays: number): Promise<void> {
  (await cookies()).set(sessionCookieName(), token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeDays * 86_400,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(sessionCookieName());
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(sessionCookieName())?.value ?? null;
}

export async function currentSession(): Promise<SessionInfo | null> {
  const token = await sessionToken();
  if (!token) return null;
  return getSession(await getDb(), token);
}

export interface MemberContext {
  session: SessionInfo;
  member: NonNullable<SessionInfo["member"]>;
  tenant: Tenant;
}

/** For pages and actions inside the app: signed in, with an active workspace. */
export async function requireMember(roles?: Role[]): Promise<MemberContext> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!session.member) redirect(session.memberships.length ? "/workspaces" : "/onboarding");
  if (roles && !roles.includes(session.member.role)) redirect("/?error=" + encodeURIComponent("You don't have access to that."));
  return { session, member: session.member, tenant: { workspaceId: session.member.workspaceId, memberId: session.member.id } };
}

export async function requireSession(): Promise<SessionInfo> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

export async function clientMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return { ip: fwd ? fwd.split(",")[0]!.trim() : h.get("x-real-ip"), userAgent: h.get("user-agent") };
}
