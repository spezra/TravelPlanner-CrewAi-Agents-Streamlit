"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DomainError } from "@/domain/common";
import { localInputToIso } from "@/domain/tripPlanning";
import { withTenant, type Tenant } from "@/db/tenant";
import { getDb, requireMember } from "@/lib/server";
import { parseActions, parseId, parseItemForm, parseTermsForm, parseTravelers, parseTripForm } from "@/modules/trips/forms";
import { createPortalLink, PORTAL_FLASH_COOKIE, revokePortalLink } from "@/modules/trips/portal";
import { defaultDuffelClient } from "@/modules/trips/providers";
import * as repo from "@/modules/trips/repo";
import {
  addItem,
  createTrip,
  grantDelegation,
  moveItem,
  recordManualOutcome,
  requestBooking,
  requestCancellation,
  requestItemApproval,
  requestReconcile,
  requoteItemApproval,
  revokeDelegation,
  saveTravelers,
  selectDuffelOffer,
  updateItem,
  updateTrip,
  withdrawItemApproval,
  type ManualMove,
} from "@/modules/trips/service";
import { isProduction } from "@/server/config";
import { decide } from "@/services/operations";

const tripPath = (id: string) => `/trips/${id}`;

function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

/** Run a mutation, then redirect: to `dest` on success, back with ?error= on a DomainError. */
async function run(back: string, fn: () => Promise<string | void>): Promise<never> {
  let dest = back;
  try {
    const r = await fn();
    if (typeof r === "string") dest = r;
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    dest = withParam(back, "error", err.message);
  }
  revalidatePath("/trips", "layout");
  revalidatePath("/");
  redirect(dest);
}

async function timeZone(tenant: Tenant): Promise<string> {
  return withTenant(await getDb(), tenant, async (q) => (await repo.getMember(q, tenant.memberId))?.timeZone ?? "UTC");
}

const idOr = (form: FormData, k: string, fallback: string): string => {
  try {
    return parseId(form, k);
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Trips

export async function createTripAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  await run("/trips/new", async () => tripPath(await createTrip(await getDb(), tenant, parseTripForm(form))));
}

export async function updateTripAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(`${tripPath(tripId)}/edit`, async () => {
    await updateTrip(await getDb(), tenant, parseId(form, "tripId"), parseTripForm(form));
    return tripPath(tripId);
  });
}

export async function grantDelegationAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(`${tripPath(tripId)}/access`, async () => {
    const until = String(form.get("expiresOn") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new DomainError("bad_input", "Choose when access expires");
    const purpose = form.get("purpose") === "assistant" ? "assistant" : "backup";
    await grantDelegation(
      await getDb(),
      tenant,
      { tripId: parseId(form, "tripId"), memberId: parseId(form, "memberId"), purpose, expiresAt: localInputToIso(`${until}T23:59`, await timeZone(tenant)) },
      new Date(),
    );
  });
}

export async function revokeDelegationAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(`${tripPath(tripId)}/access`, async () => revokeDelegation(await getDb(), tenant, parseId(form, "tripId"), parseId(form, "memberId")));
}

// ---------------------------------------------------------------------------
// Items

export async function addItemAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(`${tripPath(tripId)}/items/new`, async () => {
    const id = await addItem(await getDb(), tenant, parseId(form, "tripId"), parseItemForm(form, await timeZone(tenant)));
    return `${tripPath(tripId)}/items/${id}`;
  });
}

export async function updateItemAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  const itemId = idOr(form, "itemId", "");
  const back = `${tripPath(tripId)}/items/${itemId}`;
  await run(back, async () => {
    const r = await updateItem(await getDb(), tenant, parseId(form, "itemId"), parseItemForm(form, await timeZone(tenant)));
    return r.lapsedApproval ? withParam(back, "ok", "Saved. The change was material, so its approval lapsed and the item is back in design.") : withParam(back, "ok", "Saved");
  });
}

const MOVES: readonly ManualMove[] = ["propose", "to_design", "cancel", "accept_change"];

export async function moveItemAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  const back = String(form.get("back") ?? "") === "item" ? `${tripPath(tripId)}/items/${idOr(form, "itemId", "")}` : tripPath(tripId);
  await run(back, async () => {
    const move = String(form.get("move")) as ManualMove;
    if (!MOVES.includes(move)) throw new DomainError("bad_input", "Unknown change");
    await moveItem(await getDb(), tenant, parseId(form, "itemId"), move);
  });
}

export async function selectOfferAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  const itemId = idOr(form, "itemId", "");
  await run(`${tripPath(tripId)}/items/${itemId}`, async () => {
    const client = defaultDuffelClient();
    if (!client) throw new DomainError("duffel_not_configured", "Duffel isn't configured");
    const offerId = String(form.get("offerId") ?? "");
    if (!/^off_[A-Za-z0-9]+$/.test(offerId)) throw new DomainError("bad_input", "Unknown offer");
    await selectDuffelOffer(await getDb(), tenant, parseId(form, "itemId"), offerId, client);
  });
}

export async function saveTravelersAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  const itemId = idOr(form, "itemId", "");
  const back = `${tripPath(tripId)}/items/${itemId}`;
  await run(back, async () => {
    const count = Number(form.get("count"));
    if (!Number.isInteger(count) || count < 1 || count > 9) throw new DomainError("bad_input", "Traveler count is invalid");
    await saveTravelers(await getDb(), tenant, parseId(form, "itemId"), parseTravelers(form, count));
    return withParam(back, "ok", "Traveler details saved (encrypted)");
  });
}

// ---------------------------------------------------------------------------
// Approvals

export async function requestApprovalAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(`${tripPath(tripId)}/approvals/new`, async () => {
    await requestItemApproval(
      await getDb(),
      tenant,
      { tripId: parseId(form, "tripId"), actions: parseActions(form), terms: parseTermsForm(form, await timeZone(tenant)) },
      new Date(),
    );
    return withParam(tripPath(tripId), "ok", "Approval requested");
  });
}

export async function requoteApprovalAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  const approvalId = idOr(form, "approvalId", "");
  await run(`${tripPath(tripId)}/approvals/new?requote=${approvalId}`, async () => {
    await requoteItemApproval(await getDb(), tenant, parseId(form, "approvalId"), parseTermsForm(form, await timeZone(tenant)), new Date());
    return withParam(tripPath(tripId), "ok", "Re-quoted; the new terms need a decision");
  });
}

export async function withdrawApprovalAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(tripPath(tripId), async () => withdrawItemApproval(await getDb(), tenant, parseId(form, "approvalId")));
}

/** Money decisions: the service allows only the trip owner or a workspace owner. */
export async function decideApprovalAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(tripPath(tripId), async () => {
    const decision = form.get("decision") === "approved" ? "approved" : "rejected";
    const note = String(form.get("note") ?? "").trim().slice(0, 1000) || null;
    await decide(await getDb(), tenant, parseId(form, "approvalId"), decision, new Date(), note);
  });
}

// ---------------------------------------------------------------------------
// Execution

export async function bookAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(tripPath(tripId), async () => {
    await requestBooking(await getDb(), tenant, { itemId: parseId(form, "itemId"), termsRechecked: form.get("termsRechecked") === "yes" }, new Date());
    return withParam(tripPath(tripId), "ok", "Booking queued. The item shows 'booking' while the supplier is contacted.");
  });
}

export async function cancelBookingAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(tripPath(tripId), async () => {
    await requestCancellation(await getDb(), tenant, { itemId: parseId(form, "itemId"), termsRechecked: form.get("termsRechecked") === "yes" }, new Date());
    return withParam(tripPath(tripId), "ok", "Cancellation queued");
  });
}

export async function reconcileAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(tripPath(tripId), async () => {
    await requestReconcile(await getDb(), tenant, parseId(form, "itemId"), new Date());
    return withParam(tripPath(tripId), "ok", "Checking with the supplier");
  });
}

export async function recordManualAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(tripPath(tripId), async () => {
    const outcome = form.get("outcome") === "not_found" ? "not_found" : "confirmed";
    const db = await getDb();
    await recordManualOutcome(
      db,
      tenant,
      {
        taskId: parseId(form, "taskId"),
        outcome,
        confirmationRef: String(form.get("confirmationRef") ?? "").slice(0, 100),
        note: String(form.get("note") ?? "").slice(0, 1000),
      },
      { db, tenant },
      new Date(),
    );
  });
}

// ---------------------------------------------------------------------------
// Client portal links

export async function createPortalLinkAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(`${tripPath(tripId)}/access`, async () => {
    const link = await createPortalLink(
      await getDb(),
      tenant,
      { tripId: parseId(form, "tripId"), label: String(form.get("label") ?? "").slice(0, 100) || null, days: Number(form.get("days")) },
      new Date(),
    );
    (await cookies()).set(PORTAL_FLASH_COOKIE, link.url, {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "strict",
      path: `${tripPath(tripId)}/access`,
      maxAge: 300,
    });
  });
}

export async function revokePortalLinkAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const tripId = idOr(form, "tripId", "");
  await run(`${tripPath(tripId)}/access`, async () => {
    await revokePortalLink(await getDb(), tenant, parseId(form, "tripId"), parseId(form, "linkId"), new Date());
    (await cookies()).delete({ name: PORTAL_FLASH_COOKIE, path: `${tripPath(tripId)}/access` });
  });
}
