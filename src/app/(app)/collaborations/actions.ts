"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ContributionType, FeeKind } from "@/domain/collaboration";
import type { Side } from "@/domain/collaborationTerms";
import { getDb, requireMember } from "@/lib/server";
import * as collab from "@/modules/network/collaborations";
import { checked, fail, FEE_ROWS, lines, minorDigits, optional, text, uuid, withParam } from "@/modules/network/forms";
import { CONTRIBUTIONS } from "@/modules/network/membership";

const EXPERTS = ["owner", "advisor", "admin"] as const;
const SideEnum = z.enum(["requester", "specialist"], { message: "Choose a side" });
const FEE_KINDS: FeeKind[] = ["commission_split", "advisory", "design", "referral", "execution"];

const page = (id: string) => `/collaborations/${id}`;

async function run(id: string, fn: (db: Awaited<ReturnType<typeof getDb>>, tenant: Awaited<ReturnType<typeof requireMember>>["tenant"]) => Promise<unknown>, ok: string, roles?: readonly ("owner" | "advisor" | "assistant" | "admin")[]) {
  const { tenant } = await requireMember(roles ? [...roles] : undefined);
  try {
    await fn(await getDb(), tenant);
  } catch (err) {
    fail(page(id), err);
  }
  revalidatePath("/collaborations", "layout");
  redirect(withParam(page(id), "ok", ok));
}

export async function requestAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember([...EXPERTS]);
  const to = uuid.parse(text(form, "to"));
  const back = `/collaborations/new?to=${to}`;
  let id = "";
  try {
    id = await collab.requestCollaboration(
      await getDb(),
      tenant,
      {
        specialistMemberId: to,
        contribution: z.enum(CONTRIBUTIONS as [ContributionType, ...ContributionType[]], { message: "Choose what you need" }).parse(text(form, "contribution")),
        tripId: optional(form, "tripId") ? uuid.parse(text(form, "tripId")) : null,
        destination: optional(form, "destination"),
        text: z.string().trim().min(1, "Describe what you need").max(6000).parse(text(form, "text")),
        partySize: z.coerce.number({ message: "Party size must be a number" }).int().min(1).max(200).parse(text(form, "partySize")),
        budgetBand: text(form, "budgetBand"),
        dates: text(form, "dates"),
      },
      new Date(),
    );
  } catch (err) {
    fail(back, err);
  }
  revalidatePath("/collaborations");
  redirect(withParam(page(id), "ok", "Request sent with an anonymized brief"));
}

export async function respondAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const decision = form.get("decision") === "accept" ? "accept" : "decline";
  await run(id, (db, t) => collab.respondToRequest(db, t, id, decision, optional(form, "reason"), new Date()), decision === "accept" ? "Accepted: now agree terms" : "Declined", EXPERTS);
}

export async function withdrawAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  await run(id, (db, t) => collab.withdraw(db, t, id, optional(form, "reason"), new Date()), "Withdrawn", EXPERTS);
}

export async function startAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  await run(id, (db, t) => collab.startWork(db, t, id, new Date()), "Work started", EXPERTS);
}

export async function completeAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  await run(id, (db, t) => collab.complete(db, t, id, new Date()), "Completed: client-detail access has ended", EXPERTS);
}

/** "1,250.50" in USD -> 125050. Uses the currency's own minor-unit precision. */
function toMinor(amount: string, currency: string): number {
  const clean = amount.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new z.ZodError([{ code: "custom", message: `Amount "${amount}" isn't a number`, path: [], input: amount }]);
  return Math.round(Number(clean) * 10 ** minorDigits(currency));
}

function termsInput(form: FormData): collab.TermsInput {
  const fees: collab.TermsInput["fees"] = [];
  for (let i = 0; i < FEE_ROWS; i++) {
    const kind = text(form, `fee_kind_${i}`);
    if (!kind) continue;
    const k = z.enum(FEE_KINDS as [FeeKind, ...FeeKind[]]).parse(kind);
    const payee = SideEnum.parse(text(form, `fee_payee_${i}`) || "specialist");
    const items = z.array(uuid).parse(form.getAll(`fee_items_${i}`).map(String));
    if (k === "commission_split") {
      const pct = Number(text(form, `fee_pct_${i}`).replace("%", "").trim());
      fees.push({ kind: k, payee, amount: null, commissionShareBps: Number.isFinite(pct) ? Math.round(pct * 100) : null, bookingItemIds: items });
    } else {
      const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code").parse(text(form, `fee_currency_${i}`) || "USD");
      fees.push({ kind: k, payee, amount: { amountMinor: toMinor(text(form, `fee_amount_${i}`), currency), currency }, commissionShareBps: null, bookingItemIds: [] });
    }
  }
  const deliveryOwners = lines(form, "deliveryOwners").map((l) => {
    const at = l.lastIndexOf(":");
    const owner = SideEnum.parse(l.slice(at + 1).trim().toLowerCase());
    return { service: l.slice(0, at).trim() || "Service", owner: owner as Side };
  });
  const expires = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose when client-detail access ends").parse(text(form, "clientAccessExpiresAt"));
  return {
    finalRecommendationOwner: SideEnum.parse(text(form, "finalRecommendationOwner")),
    delegatedDecisions: lines(form, "delegatedDecisions"),
    changesRequiringSpecialistReview: lines(form, "changesRequiringSpecialistReview"),
    deliveryOwners,
    attributionRule: z.enum(["never", "with_endorsement", "always"]).parse(text(form, "attributionRule")),
    specialistVisibleToClient: checked(form, "specialistVisibleToClient"),
    fees,
    nonSolicit: checked(form, "nonSolicit"),
    clientAccessExpiresAt: `${expires}T23:59:59.000Z`,
    reversalLossBearer: z.enum(["requester", "specialist", "shared_pro_rata"]).parse(text(form, "reversalLossBearer")),
    notes: optional(form, "notes"),
  };
}

export async function proposeTermsAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  await run(id, (db, t) => collab.proposeTerms(db, t, id, termsInput(form), new Date()), "Terms proposed: waiting for the other side to accept this version", EXPERTS);
}

export async function acceptTermsAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const version = z.coerce.number().int().positive().parse(text(form, "version"));
  await run(id, (db, t) => collab.acceptTerms(db, t, id, version, text(form, "fingerprint"), new Date()), "Terms accepted", EXPERTS);
}

export async function shareAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const [kind, sourceId] = text(form, "source").split(":");
  await run(
    id,
    (db, t) =>
      collab.addShare(db, t, id, {
        kind: z.enum(["client", "trip_item", "brief_statement", "note"]).parse(kind),
        sourceId: sourceId ? uuid.parse(sourceId) : null,
        text: optional(form, "text"),
      }, new Date()),
    "Shared: visible to the specialist only while terms are agreed and access hasn't expired",
  );
}

export async function refreshShareAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const shareId = uuid.parse(text(form, "shareId"));
  const { tenant } = await requireMember();
  let changed = false;
  try {
    changed = (await collab.refreshShare(await getDb(), tenant, id, shareId, new Date())).changed;
  } catch (err) {
    fail(page(id), err);
  }
  revalidatePath("/collaborations", "layout");
  redirect(withParam(page(id), "ok", changed ? "Updated: any endorsement of it now needs the specialist's review" : "Already up to date"));
}

export async function revokeShareAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const shareId = uuid.parse(text(form, "shareId"));
  await run(id, (db, t) => collab.revokeShare(db, t, id, shareId, new Date()), "Access to that detail revoked");
}

export async function endorseAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const shareId = uuid.parse(text(form, "shareId"));
  await run(id, (db, t) => collab.endorse(db, t, id, shareId, optional(form, "note"), new Date()), "Endorsed", EXPERTS);
}

export async function activationRequestAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  await run(
    id,
    (db, t) => collab.requestActivation(db, t, id, { relationshipHint: text(form, "relationshipHint"), ask: text(form, "ask") }, new Date()),
    "Sent to the relationship holder for a yes or no",
    EXPERTS,
  );
}

export async function activationDecideAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const activationId = uuid.parse(text(form, "activationId"));
  const decision = form.get("decision") === "yes" ? "yes" : "no";
  await run(id, (db, t) => collab.decideActivationRequest(db, t, activationId, decision, optional(form, "note"), new Date()), decision === "yes" ? "You said yes" : "You said no");
}

export async function logAction(form: FormData): Promise<void> {
  const id = uuid.parse(text(form, "id"));
  const kind = z.enum(collab.LOG_KINDS).parse(text(form, "kind"));
  await run(id, (db, t) => collab.addLogEntry(db, t, id, kind, text(form, "text"), new Date()), "Added to the contribution log");
}

export async function recordSplitAction(form: FormData): Promise<void> {
  const id = uuid.parse(form.get("collaborationId"));
  const rules = z.enum(["unknown", "permitted", "not_permitted"]);
  await run(
    id,
    async (db, tenant) => {
      const { recordCollaborationSplit } = await import("@/modules/integration/collaborationMoney");
      await recordCollaborationSplit(db, tenant, {
        collaborationId: id,
        itemId: uuid.parse(form.get("itemId")),
        specialistRecipientId: uuid.parse(form.get("recipientId")),
        hostRulesOurs: rules.parse(form.get("hostRulesOurs")),
        hostRulesTheirs: rules.parse(form.get("hostRulesTheirs")),
      });
    },
    "Split recorded in Money as a draft; agree it there before anything is paid",
    EXPERTS,
  );
}
