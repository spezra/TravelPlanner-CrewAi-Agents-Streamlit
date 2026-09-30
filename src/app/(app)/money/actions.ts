"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError } from "@/domain/common";
import { parseAmountMinor } from "@/domain/money";
import { StripeError } from "@/providers/stripe";
import { getDb, requireMember } from "@/lib/server";
import { createCardSetupLink, removePaymentMethod } from "@/modules/money/cards";
import { moneyDeps } from "@/modules/money/deps";
import { ignoreStatementRow, importStatement, matchStatementRow, recordReceipt, setCommissionTerms } from "@/modules/money/ledger";
import { approveBatch, cancelBatch, markInstructionSettled, prepareBatches, reverseTransfer } from "@/modules/money/payouts";
import { addRecipient, refreshRecipient, setSettlementDetails, startOnboarding } from "@/modules/money/recipients";
import { agreeSplit, reopenSplit, saveSplitTerms } from "@/modules/money/splits";

const localPath = (p: unknown, fallback: string) => (typeof p === "string" && p.startsWith("/money") && !p.startsWith("//") ? p : fallback);
const withParam = (path: string, key: string, value: string) => `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

/**
 * Runs an action, sending the member back with ?error= for rule violations
 * (DomainError, Stripe refusals, bad input) and ?ok= on success. Anything else
 * is a bug and propagates.
 */
async function run(back: string, ok: string, fn: () => Promise<string | { message: string; to: string } | void>): Promise<never> {
  let message = ok;
  let to = back;
  try {
    const out = await fn();
    if (typeof out === "string") message = out;
    else if (out) ({ message, to } = out);
  } catch (err) {
    const text =
      err instanceof DomainError ? err.message
      : err instanceof StripeError ? `Stripe: ${err.message}`
      : err instanceof z.ZodError ? `Check the form: ${err.issues.map((i) => i.message).join("; ")}`
      : null;
    if (text === null) throw err;
    redirect(withParam(back, "error", text));
  }
  revalidatePath("/money", "layout");
  redirect(withParam(to, "ok", message));
}

const text = (max = 500) => z.string().trim().max(max);
const optText = (max = 500) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code");
const uuid = z.string().uuid();

/** "10" or "12.5" percent → basis points. */
const percentToBps = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new DomainError("bad_input", "Percentages must be between 0 and 100");
  return Math.round(n * 100);
};

// ---------------------------------------------------------------------------
// Ledger

export async function saveCommissionTerms(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  const back = localPath(form.get("back"), "/money/terms");
  await run(back, "Commission terms saved", async () => {
    const f = z
      .object({ itemId: uuid, basis: z.enum(["rate", "amount"]), value: text(40), currency: currency.optional(), expectedBy: optText(10), hostAgency: optText(200) })
      .parse(Object.fromEntries(form));
    await setCommissionTerms(await getDb(), tenant, {
      itemId: f.itemId,
      rateBps: f.basis === "rate" ? percentToBps(f.value) : null,
      amountMinor: f.basis === "amount" ? parseAmountMinor(f.value, f.currency ?? "USD") : null,
      expectedBy: f.expectedBy,
      hostAgency: f.hostAgency,
    });
  });
}

export async function recordReceiptAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  await run("/money", "Recorded", async () => {
    const f = z
      .object({
        receivableId: uuid,
        kind: z.enum(["received", "host_deduction", "short_payment", "fx", "reversal", "dispute_hold", "dispute_release"]),
        amount: text(40),
        currency,
        fxRate: optText(20),
        landedIn: z.enum(["platform_balance", "external_account"]).optional(),
        at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
        note: optText(500),
      })
      .parse(Object.fromEntries(form));
    const magnitude = Math.abs(parseAmountMinor(f.amount, f.currency));
    // People enter amounts as positive numbers; the kind decides the sign.
    const signed = f.kind === "received" || f.kind === "dispute_release" ? magnitude : f.kind === "fx" ? parseAmountMinor(f.amount, f.currency) : -magnitude;
    const fxRate = f.fxRate ? Number(f.fxRate) : null;
    if (fxRate !== null && !(fxRate > 0)) throw new DomainError("bad_rate", "FX rate must be a positive number");
    await recordReceipt(
      await getDb(),
      tenant,
      {
        receivableId: f.receivableId,
        kind: f.kind === "dispute_release" ? "dispute_hold" : f.kind,
        amountMinor: signed,
        currency: f.currency,
        fxRate,
        landedIn: f.landedIn ?? null,
        at: new Date(`${f.at}T12:00:00Z`).toISOString(),
        note: f.note,
      },
      new Date(),
    );
  });
}

const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;

export async function importStatementAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  await run("/money/statements", "Imported", async () => {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new DomainError("bad_input", "Choose a CSV file");
    if (file.size > MAX_STATEMENT_BYTES) throw new DomainError("bad_input", "Statements over 2 MB aren't supported; split the file");
    const f = z
      .object({ defaultCurrency: optText(3), hostAgency: optText(200) })
      .parse({ defaultCurrency: form.get("defaultCurrency") ?? undefined, hostAgency: form.get("hostAgency") ?? undefined });
    const res = await importStatement(
      await getDb(),
      tenant,
      { fileName: file.name, content: await file.text(), defaultCurrency: f.defaultCurrency?.toUpperCase() ?? null, hostAgency: f.hostAgency },
      new Date(),
    );
    return {
      to: `/money/statements/${res.importId}`,
      message: res.duplicate
        ? "This statement was already imported; nothing changed"
        : `Imported: ${res.matched} matched, ${res.unmatched} to match by hand${res.errors.length ? `, ${res.errors.length} unreadable` : ""}`,
    };
  });
}

export async function matchRowAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  const back = localPath(form.get("back"), "/money/statements");
  await run(back, "Matched", async () => {
    const f = z.object({ rowId: uuid, receivableId: uuid }).parse(Object.fromEntries(form));
    await matchStatementRow(await getDb(), tenant, f, new Date());
  });
}

export async function ignoreRowAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  const back = localPath(form.get("back"), "/money/statements");
  await run(back, "Row set aside", async () => {
    const f = z.object({ rowId: uuid, reason: optText(200) }).parse(Object.fromEntries(form));
    await ignoreStatementRow(await getDb(), tenant, f.rowId, f.reason ?? "Not ours");
  });
}

// ---------------------------------------------------------------------------
// Split terms

export async function saveSplitAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  const back = localPath(form.get("back"), "/money/terms");
  await run(back, "Split terms saved as a draft", async () => {
    const f = z
      .object({
        itemId: uuid,
        collaborationRef: optText(100),
        reversalLossBearer: z.enum(["pro_rata", "owner_workspace"]),
        hostRulesOurs: z.enum(["unknown", "permitted", "not_permitted"]),
        hostRulesTheirs: z.enum(["unknown", "permitted", "not_permitted"]),
      })
      .parse(Object.fromEntries(form));
    const shares: { recipientId: string; bps: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const rid = String(form.get(`shareRecipient${i}`) ?? "");
      const pct = String(form.get(`sharePct${i}`) ?? "").trim();
      if (rid && pct) shares.push({ recipientId: uuid.parse(rid), bps: percentToBps(pct) });
    }
    const fees: { recipientId: string; kind: "advisory" | "design" | "referral" | "execution"; amountMinor: number; currency: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const rid = String(form.get(`feeRecipient${i}`) ?? "");
      const amount = String(form.get(`feeAmount${i}`) ?? "").trim();
      if (!rid || !amount) continue;
      const cur = currency.parse(String(form.get(`feeCurrency${i}`) ?? "USD"));
      fees.push({
        recipientId: uuid.parse(rid),
        kind: z.enum(["advisory", "design", "referral", "execution"]).parse(form.get(`feeKind${i}`)),
        amountMinor: parseAmountMinor(amount, cur),
        currency: cur,
      });
    }
    await saveSplitTerms(await getDb(), tenant, { ...f, shares, fees });
  });
}

export async function agreeSplitAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  const back = localPath(form.get("back"), "/money/terms");
  await run(back, "Terms agreed", async () => {
    await agreeSplit(await getDb(), tenant, uuid.parse(form.get("splitId")), new Date());
  });
}

export async function reopenSplitAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  const back = localPath(form.get("back"), "/money/terms");
  await run(back, "Terms reopened", async () => {
    await reopenSplit(await getDb(), tenant, uuid.parse(form.get("splitId")));
  });
}

// ---------------------------------------------------------------------------
// Payees

export async function addRecipientAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  await run("/money/recipients", "Payee added", async () => {
    const f = z
      .object({ memberId: optText(40), name: text(200), email: optText(200).pipe(z.string().email("Enter a valid email").nullable()) })
      .parse(Object.fromEntries(form));
    await addRecipient(await getDb(), tenant, {
      kind: f.memberId ? "member" : "external",
      memberId: f.memberId ? uuid.parse(f.memberId) : null,
      name: f.name,
      email: f.email,
    });
  });
}

export async function settlementDetailsAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner"]);
  await run("/money/recipients", "Payment details saved (encrypted)", async () => {
    const f = z.object({ recipientId: uuid, details: text(1000) }).parse(Object.fromEntries(form));
    await setSettlementDetails(await getDb(), tenant, f.recipientId, f.details);
  });
}

export async function onboardAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner"]);
  await run("/money/recipients", "Onboarding link emailed to the payee", async () => {
    await startOnboarding(await getDb(), tenant, uuid.parse(form.get("recipientId")), moneyDeps(), new Date());
  });
}

export async function refreshRecipientAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  await run("/money/recipients", "Status refreshed", async () => {
    const status = await refreshRecipient(await getDb(), tenant, uuid.parse(form.get("recipientId")), moneyDeps());
    return `Stripe status: ${status}`;
  });
}

// ---------------------------------------------------------------------------
// Payouts

export async function prepareBatchesAction(): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin", "assistant"]);
  await run("/money/payouts", "Prepared", async () => {
    const ids = await prepareBatches(await getDb(), tenant, new Date());
    return `Prepared ${ids.length} batch${ids.length === 1 ? "" : "es"} for an owner to approve`;
  });
}

export async function approveBatchAction(form: FormData): Promise<void> {
  // Role is re-checked in the service and by row-level security; this only keeps others off the path.
  const { tenant } = await requireMember(["owner"]);
  await run("/money/payouts", "Approved; payouts are being sent", async () => {
    await approveBatch(await getDb(), tenant, uuid.parse(form.get("batchId")), new Date());
  });
}

export async function cancelBatchAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  await run("/money/payouts", "Batch canceled", async () => {
    await cancelBatch(await getDb(), tenant, uuid.parse(form.get("batchId")));
  });
}

export async function markSettledAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner"]);
  const back = localPath(form.get("back"), "/money/payouts");
  await run(back, "Marked settled", async () => {
    await markInstructionSettled(await getDb(), tenant, uuid.parse(form.get("instructionId")), new Date());
  });
}

export async function reverseTransferAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner"]);
  await run("/money/payouts", "Reversal requested; the ledger updates when Stripe confirms it", async () => {
    const f = z.object({ lineId: uuid, amount: optText(40), currency }).parse(Object.fromEntries(form));
    await reverseTransfer(await getDb(), tenant, f.lineId, moneyDeps(), f.amount ? Math.abs(parseAmountMinor(f.amount, f.currency)) : null);
  });
}

// ---------------------------------------------------------------------------
// Card vault

export async function createCardLinkAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember();
  const f = z.object({ clientId: uuid, email: optText(200).pipe(z.string().email("Enter a valid email").nullable()) }).safeParse(Object.fromEntries(form));
  const back = f.success ? `/money/cards?client=${f.data.clientId}` : "/money/cards";
  await run(back, "Link created", async () => {
    if (!f.success) throw f.error;
    const url = await createCardSetupLink(await getDb(), tenant, f.data, moneyDeps(), new Date());
    return f.data.email ? `Secure link emailed to ${f.data.email}` : `Send the client this secure link: ${url}`;
  });
}

export async function removeCardAction(form: FormData): Promise<void> {
  const { tenant } = await requireMember(["owner", "advisor", "admin"]);
  const back = localPath(form.get("back"), "/money/cards");
  await run(back, "Card removed", async () => {
    await removePaymentMethod(await getDb(), tenant, uuid.parse(form.get("paymentMethodId")), moneyDeps(), new Date());
  });
}
