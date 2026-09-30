"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { agentsConfigured } from "@/agents/llm";
import { DomainError } from "@/domain/common";
import type { KnowledgeCategory } from "@/domain/knowledge";
import { getDb, requireMember } from "@/lib/server";
import { checked, fail, optional, safeBack, text, uuid, withParam } from "@/modules/network/forms";
import * as knowledge from "@/modules/network/knowledge";
import {
  attachPhoto,
  createObservation,
  deleteObservation,
  OUTCOMES,
  removePhoto,
  SOURCES,
  updateObservation,
  type ObservationInput,
} from "@/modules/network/observations";
import { blobs } from "@/server/storage";

const Category = z.enum(knowledge.CATEGORIES as [KnowledgeCategory, ...KnowledgeCategory[]], { message: "Choose a category" });
const Scope = z.enum(["private", "workspace", "network"], { message: "Choose who may see it" });
const Target = z.enum(["workspace", "network"], { message: "Choose where to publish" });

function itemInput(form: FormData): knowledge.ItemInput {
  return {
    category: Category.parse(text(form, "category")),
    destination: optional(form, "destination"),
    body: z.string().trim().min(1, "Write the knowledge item first").max(8000).parse(text(form, "body")),
    sharingPermission: Scope.parse(text(form, "sharingPermission")),
    confidentiality: z.enum(["shareable", "confidential", "restricted"], { message: "Choose confidentiality" }).parse(text(form, "confidentiality")),
    confidence: z.enum(["low", "medium", "high"], { message: "Choose your confidence" }).parse(text(form, "confidence")),
    sourceObservationIds: z.array(uuid).max(50).parse(form.getAll("sourceObservationIds").map(String)),
    dependsOnPersonId: optional(form, "dependsOnPersonId") ? uuid.parse(text(form, "dependsOnPersonId")) : null,
  };
}

export async function createItemAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  let id = "";
  try {
    id = await knowledge.createItem(await getDb(), tenant, itemInput(form), new Date());
  } catch (err) {
    fail("/knowledge", err);
  }
  revalidatePath("/knowledge");
  redirect(`/knowledge/${id}`);
}

export async function updateItemAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  try {
    await knowledge.updateItem(await getDb(), tenant, id, itemInput(form), new Date());
  } catch (err) {
    fail(`/knowledge/${id}`, err);
  }
  revalidatePath("/knowledge", "layout");
  redirect(withParam(`/knowledge/${id}`, "ok", "Saved"));
}

export async function deleteItemAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  try {
    await knowledge.deleteItem(await getDb(), tenant, id);
  } catch (err) {
    fail(`/knowledge/${id}`, err);
  }
  revalidatePath("/knowledge", "layout");
  redirect(withParam("/knowledge", "ok", "Deleted"));
}

export async function submitItemAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  let message = "";
  try {
    const r = await knowledge.submitForPublication(await getDb(), tenant, id, Target.parse(text(form, "target")), { agents: agentsConfigured(), now: new Date() });
    if (r.status === "blocked") throw new DomainError("publication_blocked", r.reason);
    message =
      r.status === "processing" ? "Submitted: the review agents are checking the redaction" : r.status === "published" ? "Published" : "Ready for your review below";
  } catch (err) {
    fail(`/knowledge/${id}`, err);
  }
  revalidatePath("/", "layout");
  redirect(withParam(`/knowledge/${id}`, "ok", message));
}

export async function approveAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  const back = safeBack(form.get("back"), "/knowledge/review");
  try {
    await knowledge.approvePublication(await getDb(), tenant, id, optional(form, "text"), new Date());
  } catch (err) {
    fail(back, err);
  }
  revalidatePath("/", "layout");
  redirect(withParam(back, "ok", "Published"));
}

export async function declineAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  const back = safeBack(form.get("back"), "/knowledge/review");
  try {
    await knowledge.declinePublication(await getDb(), tenant, id, optional(form, "reason"), new Date());
  } catch (err) {
    fail(back, err);
  }
  revalidatePath("/", "layout");
  redirect(withParam(back, "ok", "Kept private"));
}

export async function withdrawAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  try {
    await knowledge.withdrawPublication(await getDb(), tenant, id, new Date());
  } catch (err) {
    fail(`/knowledge/${id}`, err);
  }
  revalidatePath("/", "layout");
  redirect(withParam(`/knowledge/${id}`, "ok", "Withdrawn"));
}

export async function markReviewedAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  try {
    await knowledge.markReviewed(await getDb(), tenant, id, new Date());
  } catch (err) {
    fail(`/knowledge/${id}`, err);
  }
  revalidatePath("/", "layout");
  redirect(withParam(`/knowledge/${id}`, "ok", "Marked reviewed"));
}

export async function setRuleAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  try {
    const scope = text(form, "scope");
    await knowledge.setStandingRule(await getDb(), tenant, Category.parse(text(form, "category")), scope === "none" ? null : Target.parse(scope), new Date());
  } catch (err) {
    fail("/knowledge/rules", err);
  }
  revalidatePath("/knowledge/rules");
  redirect(withParam("/knowledge/rules", "ok", "Standing rule saved"));
}

// ---------------------------------------------------------------------------
// Observations

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the date of the observation");

function observationInput(form: FormData): ObservationInput {
  const outcome = optional(form, "outcome");
  const relationship = text(form, "relationshipInvolved");
  return {
    supplierName: z.string().trim().min(1, "Name the supplier").max(200).parse(text(form, "supplierName")),
    observedAt: dateString.parse(text(form, "observedAt")),
    source: z.enum(SOURCES as [string, ...string[]], { message: "Say how you know" }).parse(text(form, "source")) as ObservationInput["source"],
    personallyInspected: checked(form, "personallyInspected"),
    statement: z.string().trim().min(1, "Say what was observed").max(4000).parse(text(form, "statement")),
    applicability: {
      program: optional(form, "program"),
      roomCategory: optional(form, "roomCategory"),
      season: optional(form, "season"),
      relationshipInvolved: relationship === "yes",
    },
    request: optional(form, "request")?.toLowerCase().replace(/\s+/g, "_").slice(0, 60) ?? null,
    outcome: outcome ? (z.enum(OUTCOMES, { message: "Unknown outcome" }).parse(outcome) as ObservationInput["outcome"]) : null,
    bookingRef: optional(form, "bookingRef"),
    scope: z.enum(["private", "workspace"]).parse(text(form, "scope") || "workspace"),
  };
}

async function photoFrom(form: FormData): Promise<{ bytes: Buffer; contentType: string } | null> {
  const f = form.get("photo");
  if (!f || typeof f === "string" || f.size === 0) return null;
  return { bytes: Buffer.from(await f.arrayBuffer()), contentType: f.type };
}

export async function createObservationAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const back = safeBack(form.get("back"), "/knowledge/suppliers");
  let supplier = "";
  try {
    const input = observationInput(form);
    supplier = input.supplierName;
    const db = await getDb();
    const now = new Date();
    const id = await createObservation(db, tenant, input, now);
    const photo = await photoFrom(form);
    if (photo) await attachPhoto(db, tenant, id, photo, blobs(), now);
  } catch (err) {
    fail(back, err);
  }
  revalidatePath("/knowledge/suppliers");
  redirect(withParam("/knowledge/suppliers", "s", supplier));
}

export async function updateObservationAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  const back = `/knowledge/observations/${id}`;
  try {
    const db = await getDb();
    const now = new Date();
    await updateObservation(db, tenant, id, observationInput(form), now);
    const photo = await photoFrom(form);
    if (photo) await attachPhoto(db, tenant, id, photo, blobs(), now);
    else if (checked(form, "removePhoto")) await removePhoto(db, tenant, id, blobs(), now);
  } catch (err) {
    fail(back, err);
  }
  revalidatePath("/knowledge/suppliers");
  redirect(withParam(back, "ok", "Saved"));
}

export async function deleteObservationAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const id = uuid.parse(text(form, "id"));
  try {
    await deleteObservation(await getDb(), tenant, id, blobs());
  } catch (err) {
    fail(`/knowledge/observations/${id}`, err);
  }
  revalidatePath("/knowledge/suppliers");
  redirect(withParam("/knowledge/suppliers", "ok", "Observation deleted"));
}
