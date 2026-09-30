"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ContributionType } from "@/domain/collaboration";
import { parseList } from "@/domain/networkSearch";
import { getDb, requireMember } from "@/lib/server";
import { checked, fail, optional, text, withParam } from "@/modules/network/forms";
import { applyForMembership, CONTRIBUTIONS, saveProfile } from "@/modules/network/membership";

export async function applyAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "admin"]);
  try {
    await applyForMembership(await getDb(), tenant, optional(form, "note"), new Date());
  } catch (err) {
    fail("/network", err);
  }
  revalidatePath("/network");
  redirect(withParam("/network", "ok", "Application sent. The platform team reviews every workspace before admitting it."));
}

export async function saveProfileAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  try {
    const capabilities = z
      .array(z.enum(CONTRIBUTIONS as [ContributionType, ...ContributionType[]]))
      .parse(form.getAll("capabilities").map(String));
    await saveProfile(
      await getDb(),
      tenant,
      {
        displayName: z.string().trim().min(1, "Choose a display name").max(120).parse(text(form, "displayName")),
        headline: optional(form, "headline"),
        destinations: parseList(text(form, "destinations")),
        capabilities,
        languages: parseList(text(form, "languages"), 12),
        responseCapacity: z.enum(["available", "limited", "unavailable"]).parse(text(form, "responseCapacity")),
        discoverable: checked(form, "discoverable"),
      },
      new Date(),
    );
  } catch (err) {
    fail("/network/profile", err);
  }
  revalidatePath("/network", "layout");
  redirect(withParam("/network/profile", "ok", "Profile saved"));
}
