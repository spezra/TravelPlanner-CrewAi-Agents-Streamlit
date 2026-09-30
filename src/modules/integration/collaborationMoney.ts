/**
 * Bridge from an agreed collaboration to the money ledger: the fee lines both
 * experts agreed become the split terms for one booking line, so commission
 * that arrives on it is allocated exactly as agreed. The requester's side
 * records it (the booking and its commission sit in their workspace); the
 * split still has to be agreed in Money before anything is paid.
 */
import type { Db } from "@/db/client";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import type { CollaborationFeeLineInput, LossBearer, SplitTerms } from "@/domain/money";
import * as moneyRepo from "@/modules/money/repo";
import { importCollaborationFeeLines } from "@/modules/money/splits";
import { getCollaboration, listTerms } from "@/modules/network/collaborations";

export interface RecordSplitInput {
  collaborationId: string;
  itemId: string;
  /** The money recipient that stands for the specialist (onboarded payee or settlement contact). */
  specialistRecipientId: string;
  hostRulesOurs: SplitTerms["hostRulesOurs"];
  hostRulesTheirs: SplitTerms["hostRulesTheirs"];
}

export async function feeLinesForItem(db: Db, tenant: Tenant, collaborationId: string, itemId: string, specialistRecipientId: string) {
  return withTenant(db, tenant, async (q) => {
    const c = await getCollaboration(q, collaborationId);
    if (!c) throw new DomainError("not_found", "Collaboration not found");
    if (c.requesterWorkspaceId !== tenant.workspaceId) throw new DomainError("forbidden", "Only the requesting workspace records the split on its booking");
    if (c.agreedTermsVersion === null) throw new DomainError("not_agreed", "Terms aren't agreed by both sides yet");
    const terms = (await listTerms(q, c.id)).find((t) => t.version === c.agreedTermsVersion)?.terms;
    if (!terms) throw new DomainError("not_found", "Agreed terms not found");
    const recipients = await moneyRepo.listRecipients(q);
    if (!recipients.some((r) => r.id === specialistRecipientId)) throw new DomainError("not_found", "Choose a payee for the specialist");
    const ws = await moneyRepo.ensureWorkspaceRecipient(q, tenant.workspaceId);
    const lines: CollaborationFeeLineInput[] = terms.fees
      .filter((f) => f.bookingItemIds.includes(itemId))
      .map((f) => ({
        kind: f.kind,
        amount: f.amount,
        commissionShareBps: f.commissionShareBps,
        bookingItemIds: [itemId],
        recipientId: f.payee === "requester" ? ws : specialistRecipientId,
      }));
    if (lines.length === 0) throw new DomainError("no_lines", "The agreed terms have no fee lines for this booking");
    // The ledger can put a reversal on the owner workspace or share it pro rata; a specialist-borne loss is shared pro rata and noted.
    const bearer: LossBearer = terms.reversalLossBearer === "requester" ? "owner_workspace" : "pro_rata";
    return { lines, bearer, version: c.agreedTermsVersion };
  });
}

export async function recordCollaborationSplit(db: Db, tenant: Tenant, input: RecordSplitInput) {
  const { lines, bearer, version } = await feeLinesForItem(db, tenant, input.collaborationId, input.itemId, input.specialistRecipientId);
  return importCollaborationFeeLines(db, tenant, {
    itemId: input.itemId,
    collaborationRef: `${input.collaborationId}@v${version}`,
    lines,
    reversalLossBearer: bearer,
    hostRulesOurs: input.hostRulesOurs,
    hostRulesTheirs: input.hostRulesTheirs,
  });
}
