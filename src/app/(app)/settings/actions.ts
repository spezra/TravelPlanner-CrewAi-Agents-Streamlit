"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DomainError, type Role } from "@/domain/common";
import { disableMember, inviteMember, revokeAllSessions } from "@/server/auth/core";
import { clearSessionCookie, requireMember } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { mailer } from "@/server/mail";

const ROLES: Role[] = ["owner", "advisor", "assistant", "admin"];

function fail(err: unknown): never {
  if (!(err instanceof DomainError)) throw err;
  redirect(`/settings?error=${encodeURIComponent(err.message)}`);
}

export async function invite(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "admin"]);
  const role = String(form.get("role")) as Role;
  try {
    if (!ROLES.includes(role)) throw new DomainError("bad_role", "Unknown role");
    await inviteMember(await getDb(), mailer(), { workspaceId: tenant.workspaceId, invitedBy: tenant.memberId, email: String(form.get("email") ?? ""), role });
  } catch (err) {
    fail(err);
  }
  revalidatePath("/settings");
  redirect("/settings?ok=" + encodeURIComponent("Invitation sent"));
}

export async function removeMember(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner"]);
  try {
    await disableMember(await getDb(), { workspaceId: tenant.workspaceId, actorId: tenant.memberId, memberId: String(form.get("memberId")) });
  } catch (err) {
    fail(err);
  }
  revalidatePath("/settings");
  redirect("/settings");
}

export async function signOutEverywhere(): Promise<void> {
  const { session } = await requireMember();
  await revokeAllSessions(await getDb(), session.userId);
  await clearSessionCookie();
  redirect("/login");
}
