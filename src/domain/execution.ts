/**
 * Reliable execution. Every booking, cancellation, payout and browser action
 * carries an idempotency key, and any of them can end in an outcome-unknown
 * state: the request went out and the result never came back. Nothing in that
 * state is retried until it has been reconciled with the supplier, since a
 * blind retry can double-book and treating it as failed can orphan a real
 * reservation.
 */
import { DomainError, fingerprint, type Id } from "./common";
import type { ActionKind } from "./approvals";

export type AttemptState =
  | "prepared"
  | "sent"
  | "succeeded"
  | "rejected" // provider definitively refused; safe to change and resubmit
  | "retryable_error" // provider says nothing was accepted and a retry is safe
  | "outcome_unknown";

export interface ExecutionAttempt {
  id: Id;
  idempotencyKey: string;
  action: ActionKind;
  itemId: Id;
  state: AttemptState;
  providerRef: string | null;
  attempts: number;
  lastError: string | null;
}

/**
 * Same item + action + approved terms => same key, so a duplicate submission
 * collapses at the provider instead of double-booking.
 */
export function idempotencyKey(p: { workspaceId: Id; itemId: Id; action: ActionKind; termsFingerprint: string; generation?: number }): string {
  return `atp_${p.action}_${fingerprint({ ...p, generation: p.generation ?? 0 })}`;
}

/** What a provider adapter reports for a submit call. */
export type ProviderOutcome =
  | { kind: "accepted"; providerRef: string }
  | { kind: "rejected"; error: string }
  | { kind: "retryable"; error: string } // e.g. rate-limited before acceptance
  | { kind: "processing"; error?: string } // accepted but still processing: NOT a failure
  | { kind: "unknown"; error: string }; // timeout, connection reset after send

/** What a provider adapter reports for a lookup by idempotency key. */
export type LookupOutcome = { kind: "found"; providerRef: string } | { kind: "absent" } | { kind: "unknown"; error: string };

export interface ProviderAdapter {
  name: string;
  submit(key: string, payload: unknown): Promise<ProviderOutcome>;
  lookup(key: string): Promise<LookupOutcome>;
}

export function applyOutcome(a: ExecutionAttempt, o: ProviderOutcome): ExecutionAttempt {
  const attempts = a.attempts + 1;
  switch (o.kind) {
    case "accepted":
      return { ...a, attempts, state: "succeeded", providerRef: o.providerRef, lastError: null };
    case "rejected":
      return { ...a, attempts, state: "rejected", lastError: o.error };
    case "retryable":
      return { ...a, attempts, state: "retryable_error", lastError: o.error };
    case "processing":
    case "unknown":
      return { ...a, attempts, state: "outcome_unknown", lastError: o.error ?? "accepted, still processing" };
  }
}

export function canSubmit(a: ExecutionAttempt, maxAttempts = 3): boolean {
  return (a.state === "prepared" || a.state === "retryable_error") && a.attempts < maxAttempts;
}

/**
 * Submit once, following the provider's own retry semantics. Never retries
 * from outcome_unknown; the caller must reconcile.
 */
export async function execute(
  a: ExecutionAttempt,
  adapter: ProviderAdapter,
  payload: unknown,
  maxAttempts = 3,
): Promise<ExecutionAttempt> {
  let current = a;
  while (canSubmit(current, maxAttempts)) {
    current = { ...current, state: "sent" };
    let outcome: ProviderOutcome;
    try {
      outcome = await adapter.submit(current.idempotencyKey, payload);
    } catch (err) {
      // An exception after the request may have left the process is not a failure.
      outcome = { kind: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
    current = applyOutcome(current, outcome);
  }
  return current;
}

/**
 * Resolve an outcome_unknown attempt by asking the provider what happened
 * under the same idempotency key. If the lookup itself is inconclusive the
 * attempt stays unknown and goes to a human.
 */
export async function reconcile(a: ExecutionAttempt, adapter: ProviderAdapter): Promise<ExecutionAttempt> {
  if (a.state !== "outcome_unknown") {
    throw new DomainError("not_unknown", `Attempt ${a.id} is ${a.state}; only outcome_unknown attempts are reconciled`);
  }
  const r = await adapter.lookup(a.idempotencyKey);
  switch (r.kind) {
    case "found":
      return { ...a, state: "succeeded", providerRef: r.providerRef, lastError: null };
    case "absent":
      // Confirmed nothing exists under this key: resubmitting with the same key is now safe.
      return { ...a, state: "retryable_error", lastError: "reconciled: no reservation found" };
    case "unknown":
      return { ...a, lastError: `reconcile inconclusive: ${r.error}` };
  }
}
