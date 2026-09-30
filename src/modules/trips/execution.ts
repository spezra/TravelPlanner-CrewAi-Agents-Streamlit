/**
 * Booking and cancellation execution for trip items. Runs from background
 * jobs, never from a request: the UI queues work and shows the item's state.
 *
 * Booking goes through `bookItem` (src/services/operations.ts): re-read current
 * terms, check the action gate, claim the item, call the rail once under an
 * idempotency key, record the outcome. This module adds what a job needs
 * around that: choosing the adapter, the current-terms source per rail,
 * recovery when a worker died mid-call, reconciliation, and cancellation.
 */
import { randomUUID } from "node:crypto";
import { evaluateAction, type GateFailure } from "@/domain/actionGate";
import type { Approval, MaterialTerms } from "@/domain/approvals";
import { transitionItem, type TripItem } from "@/domain/bookings";
import { DomainError } from "@/domain/common";
import { execute, idempotencyKey, reconcile, type ExecutionAttempt, type ProviderAdapter } from "@/domain/execution";
import type { Db, Queryable } from "@/db/client";
import * as coreRepo from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { DuffelHttpError } from "@/providers/duffel";
import { bookItem, reconcileItem } from "@/services/operations";
import { adapterForBooking, adapterForProvider, providerForItem, type ExecutionAdapter, type ProviderDeps } from "./providers";
import * as repo from "./repo";

/** A person's confirmation that they re-checked terms with a supplier that has no API. */
export interface TermsConfirmation {
  by: string;
  at: string;
}

/** How long a person's "I re-checked the terms" stays good for a manual booking. */
export const MANUAL_TERMS_FRESH_MINUTES = 120;
/** An attempt with no recorded outcome after this long means the worker died mid-call. */
export const STALE_ATTEMPT_MINUTES = 15;

export type ExecutionResult =
  | { status: "noop"; state: TripItem["state"] }
  | { status: "blocked"; reasons: string[] }
  | { status: "done"; state: TripItem["state"] }
  | { status: "in_flight" };

const reasonsOf = (failures: GateFailure[]) => failures.map((f) => `${f.test}: ${f.detail}`);

async function findApproval(q: Queryable, item: TripItem, kind: "book" | "cancel"): Promise<Approval | null> {
  const approvals = await coreRepo.listApprovals(q, { tripId: item.tripId, status: "approved" });
  return approvals.filter((a) => a.actions.some((x) => x.kind === kind && x.itemId === item.id)).at(-1) ?? null;
}

function manualTerms(approval: Approval, confirmation: TermsConfirmation | null | undefined, now: Date): MaterialTerms {
  if (!confirmation) throw new DomainError("terms_not_rechecked", "Re-check the terms with the supplier and confirm them before booking");
  if (now.getTime() - new Date(confirmation.at).getTime() > MANUAL_TERMS_FRESH_MINUTES * 60_000) {
    throw new DomainError("terms_stale", "The re-checked terms are more than two hours old; check with the supplier again");
  }
  return approval.terms;
}

async function note(db: Db, tenant: Tenant, itemId: string, text: string | null): Promise<void> {
  await withTenant(db, tenant, (q) => repo.setExecutionNote(q, itemId, text));
}

const isStale = (updatedAt: string, now: Date) => now.getTime() - new Date(updatedAt).getTime() > STALE_ATTEMPT_MINUTES * 60_000;

// ---------------------------------------------------------------------------
// Booking

/**
 * The trips.book job. Safe to run any number of times: an approved item is
 * booked once; an item already sent is recovered or reconciled, never resent.
 */
export async function runBooking(
  db: Db,
  tenant: Tenant,
  input: { itemId: string; termsConfirmation?: TermsConfirmation | null },
  deps: ProviderDeps,
  now: Date,
): Promise<ExecutionResult> {
  const item = await withTenant(db, tenant, (q) => coreRepo.getItem(q, input.itemId));
  if (!item) throw new DomainError("not_found", `Item ${input.itemId} not found`);
  try {
    switch (item.state) {
      case "approved":
        return await bookApproved(db, tenant, item, input.termsConfirmation ?? null, deps, now);
      case "booking":
        return await recoverInterrupted(db, tenant, item, deps, now, false);
      case "outcome_unknown":
        return await reconcileBooking(db, tenant, item, deps);
      default:
        return { status: "noop", state: item.state };
    }
  } finally {
    await withTenant(db, tenant, (q) => repo.clearExecutionRequest(q, item.id));
  }
}

async function bookApproved(db: Db, tenant: Tenant, item: TripItem, confirmation: TermsConfirmation | null, deps: ProviderDeps, now: Date): Promise<ExecutionResult> {
  const approval = await withTenant(db, tenant, (q) => findApproval(q, item, "book"));
  if (!approval) {
    const reasons = ["permission: No approved approval covers booking this item"];
    await note(db, tenant, item.id, reasons.join("; "));
    return { status: "blocked", reasons };
  }
  let adapter: ExecutionAdapter;
  try {
    adapter = await adapterForBooking(item, deps);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    await note(db, tenant, item.id, err.message);
    return { status: "blocked", reasons: [err.message] };
  }

  const readCurrentTerms = async (): Promise<MaterialTerms> => {
    if (!adapter.currentTerms) return manualTerms(approval, confirmation, now);
    try {
      return await adapter.currentTerms(approval.terms);
    } catch (err) {
      // A definitive "no" about the offer (expired, gone) is a blocked booking, not a job to retry.
      if (err instanceof DuffelHttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new DomainError("offer_unavailable", `The offer can't be re-read: ${err.message}. Re-quote before booking.`);
      }
      throw err;
    }
  };

  let result;
  try {
    result = await bookItem(db, tenant, { itemId: item.id, adapter, readCurrentTerms, evidenceTier: "recommend", now });
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    await note(db, tenant, item.id, err.message);
    await withTenant(db, tenant, (q) => coreRepo.audit(q, tenant.workspaceId, "agent:booking", "booking.blocked", item.id, { reasons: [err.message] }));
    return { status: "blocked", reasons: [err.message] };
  }
  if (result.status === "blocked") {
    const reasons = reasonsOf(result.failures);
    await withTenant(db, tenant, async (q) => {
      await repo.setExecutionNote(q, item.id, reasons.join("; "));
      await coreRepo.audit(q, tenant.workspaceId, "agent:booking", "booking.blocked", item.id, { reasons });
    });
    return { status: "blocked", reasons };
  }
  await afterOutcome(db, tenant, result.item, result.attempt, adapter);
  return { status: "done", state: result.item.state };
}

/** Record the rail's reference, the traveler-facing confirmation number, and any error for the team. */
async function afterOutcome(db: Db, tenant: Tenant, item: TripItem, attempt: ExecutionAttempt, adapter: ExecutionAdapter): Promise<void> {
  const pnr = item.state === "confirmed" && attempt.providerRef && adapter.confirmationRef ? await adapter.confirmationRef(attempt.providerRef) : null;
  await withTenant(db, tenant, async (q) => {
    if (attempt.providerRef) await repo.setProviderRef(q, item.id, adapter.name, attempt.providerRef);
    if (pnr) await coreRepo.updateItemState(q, { ...item, confirmationRef: pnr });
    const text =
      item.state === "failed"
        ? `Booking failed: ${attempt.lastError ?? "rejected by the supplier"}`
        : item.state === "outcome_unknown"
          ? `Outcome unknown: ${attempt.lastError ?? "no response"}. Reconcile before anything else.`
          : null;
    await repo.setExecutionNote(q, item.id, text);
  });
}

/**
 * The item is 'booking' but no outcome was recorded: the worker died after
 * claiming it. The request may or may not have gone out, so it becomes
 * outcome-unknown and is reconciled; it is never resent blind.
 */
export async function recoverInterrupted(db: Db, tenant: Tenant, item: TripItem, deps: ProviderDeps, now: Date, force: boolean): Promise<ExecutionResult> {
  const recovered = await withTenant(db, tenant, async (q) => {
    const current = await coreRepo.getItem(q, item.id);
    if (!current || current.state !== "booking") return current;
    const attempt = await repo.latestAttempt(q, item.id, "book");
    if (attempt && !force && !isStale(attempt.updatedAt, now)) return null; // still in flight
    if (attempt && (attempt.state === "prepared" || attempt.state === "sent")) {
      await repo.setAttemptState(q, attempt.id, "outcome_unknown", "Worker stopped before the outcome was recorded");
    }
    const next = transitionItem(current, "outcome_unknown");
    await coreRepo.updateItemState(q, next);
    await coreRepo.audit(q, tenant.workspaceId, "agent:booking", "booking.outcome_unknown", item.id, { reason: "interrupted" });
    return next;
  });
  if (recovered === null) return { status: "in_flight" };
  if (recovered.state !== "outcome_unknown") return { status: "noop", state: recovered.state };
  return reconcileBooking(db, tenant, recovered, deps);
}

/** Ask the rail what happened under the attempt's key. Inconclusive answers leave the item for a person. */
export async function reconcileBooking(db: Db, tenant: Tenant, item: TripItem, deps: ProviderDeps): Promise<ExecutionResult> {
  if (item.state !== "outcome_unknown") return { status: "noop", state: item.state };
  const attempt = await withTenant(db, tenant, (q) => repo.latestAttempt(q, item.id, "book"));
  if (!attempt) throw new DomainError("nothing_to_reconcile", "No booking attempt recorded for this item");
  const adapter = adapterForProvider(attempt.provider, item, deps);
  const next = await reconcileItem(db, tenant, item.id, adapter);
  const resolved = await withTenant(db, tenant, (q) => coreRepo.getAttemptByKey(q, attempt.idempotencyKey));
  if (resolved) await afterOutcome(db, tenant, next, resolved, adapter);
  if (next.state === "failed") await note(db, tenant, item.id, "Reconciled: the supplier has no reservation. Nothing was booked.");
  return { status: "done", state: next.state };
}

// ---------------------------------------------------------------------------
// Cancellation

async function providerRefFor(q: Queryable, item: TripItem): Promise<{ provider: string; ref: string } | null> {
  const extras = await repo.getItemExtras(q, item.id);
  if (extras?.provider && extras.providerRef) return { provider: extras.provider, ref: extras.providerRef };
  const booked = await repo.latestAttempt(q, item.id, "book");
  if (booked?.state === "succeeded" && booked.providerRef) return { provider: booked.provider, ref: booked.providerRef };
  // Booked outside the platform (or before it): the supplier's own reference, through the item's channel.
  if (item.confirmationRef) return { provider: providerForItem(item), ref: item.confirmationRef };
  return null;
}

function cancelRail(adapter: ExecutionAdapter, ref: string): ProviderAdapter {
  return { name: adapter.name, submit: (k) => adapter.cancel(k, ref), lookup: (k) => adapter.lookupCancellation(k, ref) };
}

/**
 * The trips.cancel job: cancel a booking held with a supplier, under an
 * approval covering the cancellation, with the same reliability rules as a
 * booking. A cancellation whose outcome is unknown keeps the item in
 * cancel_requested until it is reconciled.
 */
export async function runCancellation(
  db: Db,
  tenant: Tenant,
  input: { itemId: string; termsConfirmation?: TermsConfirmation | null },
  deps: ProviderDeps,
  now: Date,
): Promise<ExecutionResult> {
  const item = await withTenant(db, tenant, (q) => coreRepo.getItem(q, input.itemId));
  if (!item) throw new DomainError("not_found", `Item ${input.itemId} not found`);
  try {
    if (item.state === "cancel_requested") return await reconcileCancellation(db, tenant, item, deps, now, false);
    if (item.state !== "confirmed" && item.state !== "disrupted") return { status: "noop", state: item.state };
    return await cancelHeld(db, tenant, item, input.termsConfirmation ?? null, deps, now);
  } finally {
    await withTenant(db, tenant, (q) => repo.clearExecutionRequest(q, item.id));
  }
}

async function cancelHeld(db: Db, tenant: Tenant, item: TripItem, confirmation: TermsConfirmation | null, deps: ProviderDeps, now: Date): Promise<ExecutionResult> {
  const pre = await withTenant(db, tenant, async (q) => ({ approval: await findApproval(q, item, "cancel"), held: await providerRefFor(q, item) }));
  const blocked = async (reasons: string[]): Promise<ExecutionResult> => {
    await withTenant(db, tenant, async (q) => {
      await repo.setExecutionNote(q, item.id, reasons.join("; "));
      await coreRepo.audit(q, tenant.workspaceId, "agent:booking", "cancellation.blocked", item.id, { reasons });
    });
    return { status: "blocked", reasons };
  };
  if (!pre.held) return blocked(["evidence: No supplier reference is recorded for this booking"]);
  let adapter: ExecutionAdapter;
  let currentTerms: MaterialTerms | null = null;
  try {
    adapter = adapterForProvider(pre.held.provider, item, deps);
    if (pre.approval) {
      currentTerms = adapter.cancellationCost
        ? { ...pre.approval.terms, price: await adapter.cancellationCost(pre.held.ref) }
        : manualTerms(pre.approval, confirmation, now);
    }
  } catch (err) {
    if (err instanceof DomainError) return blocked([err.message]);
    if (err instanceof DuffelHttpError && err.status < 500 && err.status !== 429) return blocked([`The cancellation can't be quoted: ${err.message}`]);
    throw err;
  }
  const gate = evaluateAction({ action: { kind: "cancel", itemId: item.id }, evidenceTier: "recommend", requiredTier: "recommend", approval: pre.approval, currentTerms, now });
  if (!gate.allowed) return blocked(reasonsOf(gate.failures));
  const approval = pre.approval!;
  const ref = pre.held.ref;

  const claimed = await withTenant(db, tenant, async (q) => {
    const current = await coreRepo.getItem(q, item.id);
    if (!current || (current.state !== "confirmed" && current.state !== "disrupted")) return null;
    const key = idempotencyKey({ workspaceId: tenant.workspaceId, itemId: item.id, action: "cancel", termsFingerprint: approval.termsFingerprint });
    const attempt: ExecutionAttempt = (await coreRepo.getAttemptByKey(q, key)) ?? {
      id: randomUUID(),
      idempotencyKey: key,
      action: "cancel",
      itemId: item.id,
      state: "prepared",
      providerRef: null,
      attempts: 0,
      lastError: null,
    };
    const next = transitionItem(current, "cancel_requested");
    await coreRepo.updateItemState(q, next);
    await coreRepo.saveAttempt(q, tenant.workspaceId, attempt, adapter.name);
    await coreRepo.audit(q, tenant.workspaceId, "agent:booking", "cancellation.sent", item.id, { key, approvalId: approval.id });
    return { item: next, attempt };
  });
  if (!claimed) return { status: "noop", state: item.state };

  const result = await execute(claimed.attempt, cancelRail(adapter, ref), { itemId: item.id, providerRef: ref });
  return recordCancellation(db, tenant, claimed.item, result, adapter.name);
}

async function recordCancellation(db: Db, tenant: Tenant, item: TripItem, attempt: ExecutionAttempt, provider: string): Promise<ExecutionResult> {
  return withTenant(db, tenant, async (q) => {
    await coreRepo.saveAttempt(q, tenant.workspaceId, attempt, provider);
    let next = item;
    let text: string | null = null;
    if (attempt.state === "succeeded") {
      next = transitionItem(item, "canceled");
    } else if (attempt.state === "rejected" || attempt.state === "retryable_error") {
      // The supplier did not cancel: the booking still stands.
      next = transitionItem(item, "confirmed");
      text = `Cancellation not completed: ${attempt.lastError ?? "refused"}. The booking still stands.`;
    } else {
      text = `Cancellation outcome unknown: ${attempt.lastError ?? "no response"}. Reconcile before retrying.`;
    }
    if (next !== item) await coreRepo.updateItemState(q, next);
    await repo.setExecutionNote(q, item.id, text);
    await coreRepo.audit(q, tenant.workspaceId, "agent:booking", `cancellation.${attempt.state === "succeeded" ? "confirmed" : attempt.state}`, item.id, {
      key: attempt.idempotencyKey,
      error: attempt.lastError,
    });
    return { status: "done" as const, state: next.state };
  });
}

/** Resolve a cancellation that went out without a recorded result. */
export async function reconcileCancellation(db: Db, tenant: Tenant, item: TripItem, deps: ProviderDeps, now: Date, force: boolean): Promise<ExecutionResult> {
  if (item.state !== "cancel_requested") return { status: "noop", state: item.state };
  const pre = await withTenant(db, tenant, async (q) => ({ attempt: await repo.latestAttempt(q, item.id, "cancel"), held: await providerRefFor(q, item) }));
  const attempt = pre.attempt;
  if (!attempt || !pre.held) throw new DomainError("nothing_to_reconcile", "No cancellation attempt recorded for this item");
  if (attempt.state === "prepared" || attempt.state === "sent") {
    if (!force && !isStale(attempt.updatedAt, now)) return { status: "in_flight" };
    attempt.state = "outcome_unknown";
  }
  if (attempt.state !== "outcome_unknown") return { status: "noop", state: item.state };
  const adapter = adapterForProvider(attempt.provider, item, deps);
  const resolved = await reconcile(attempt, cancelRail(adapter, pre.held.ref));
  if (resolved.state === "outcome_unknown") {
    await withTenant(db, tenant, async (q) => {
      await coreRepo.saveAttempt(q, tenant.workspaceId, resolved, attempt.provider);
      await repo.setExecutionNote(q, item.id, `Cancellation still unconfirmed: ${resolved.lastError ?? ""}`.trim());
    });
    return { status: "done", state: item.state };
  }
  await withTenant(db, tenant, (q) => coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "cancellation.reconciled", item.id, { result: resolved.state }));
  return recordCancellation(db, tenant, item, resolved, attempt.provider);
}

/** trips.reconcile: whatever the item is waiting on, find out from the rail. */
export async function runReconcile(db: Db, tenant: Tenant, itemId: string, deps: ProviderDeps, now: Date): Promise<ExecutionResult> {
  const item = await withTenant(db, tenant, (q) => coreRepo.getItem(q, itemId));
  if (!item) throw new DomainError("not_found", `Item ${itemId} not found`);
  try {
    switch (item.state) {
      case "outcome_unknown":
        return await reconcileBooking(db, tenant, item, deps);
      case "booking":
        return await recoverInterrupted(db, tenant, item, deps, now, false);
      case "cancel_requested":
        return await reconcileCancellation(db, tenant, item, deps, now, false);
      default:
        return { status: "noop", state: item.state };
    }
  } finally {
    await withTenant(db, tenant, (q) => repo.clearExecutionRequest(q, item.id));
  }
}
