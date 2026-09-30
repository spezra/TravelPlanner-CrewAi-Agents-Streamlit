/**
 * Proposal persistence and workflow: request a draft (agent job), edit,
 * review, send. Sending requires a clean review and the trip owner.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "@/db/client";
import { audit, getTrip, listItems } from "@/db/repo";
import { withTenant, type Tenant } from "@/db/tenant";
import { DomainError } from "@/domain/common";
import { canSend, reviewProposal, type Proposal, type ProposalIssue, type ProposalSection } from "@/domain/proposals";
import { enqueueAsTenant } from "@/server/jobs/queue";

function mapProposal(r: Record<string, unknown>): Proposal & { sentAt: string | null } {
  return {
    id: String(r.id),
    tripId: String(r.trip_id),
    version: Number(r.version),
    status: r.status as Proposal["status"],
    title: String(r.title),
    intro: String(r.intro),
    sections: r.sections as ProposalSection[],
    closing: String(r.closing),
    createdBy: String(r.created_by),
    editedByExpert: Boolean(r.edited_by_expert),
    sentAt: r.sent_at ? String(r.sent_at) : null,
  };
}

export async function listProposals(q: Queryable, tripId: string) {
  const { rows } = await q.query<Record<string, unknown>>("select * from proposals where trip_id = $1 order by version desc", [tripId]);
  return rows.map(mapProposal);
}

export async function latestSentProposal(q: Queryable, tripId: string) {
  const { rows } = await q.query<Record<string, unknown>>("select * from proposals where trip_id = $1 and status in ('sent', 'accepted') order by version desc limit 1", [tripId]);
  return rows[0] ? mapProposal(rows[0]) : null;
}

export async function insertProposal(q: Queryable, workspaceId: string, p: Omit<Proposal, "id" | "version">): Promise<Proposal> {
  const { rows } = await q.query<{ v: number | null }>("select max(version) as v from proposals where trip_id = $1", [p.tripId]);
  const proposal: Proposal = { ...p, id: randomUUID(), version: (rows[0]?.v ?? 0) + 1 };
  await q.query(
    `insert into proposals (id, workspace_id, trip_id, version, status, title, intro, sections, closing, created_by, edited_by_expert)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [proposal.id, workspaceId, proposal.tripId, proposal.version, proposal.status, proposal.title, proposal.intro, JSON.stringify(proposal.sections), proposal.closing, proposal.createdBy, proposal.editedByExpert],
  );
  return proposal;
}

export function requestDraft(db: Db, tenant: Tenant, tripId: string): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    if (!(await getTrip(q, tripId))) throw new DomainError("not_found", "Trip not found");
    // One draft request in flight per trip per minute; double-clicks don't spawn duplicate drafts.
    await enqueueAsTenant(q, { kind: "proposals.draft", payload: { tripId }, dedupeKey: `proposals.draft:${tripId}:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 3 });
    await audit(q, tenant.workspaceId, tenant.memberId, "proposal.draft_requested", tripId);
  });
}

export async function reviewFor(q: Queryable, p: Pick<Proposal, "tripId" | "intro" | "sections" | "closing">): Promise<ProposalIssue[]> {
  const items = await listItems(q, p.tripId);
  return reviewProposal(p, { itemIds: new Set(items.map((i) => i.id)), perksByItem: new Map(items.map((i) => [i.id, i.credentials?.perks ?? []])) });
}

/** Expert edits are saved in place on a draft; editing a sent proposal starts a new draft version. */
export function saveEdit(db: Db, tenant: Tenant, input: { proposalId: string; title: string; intro: string; closing: string; sectionBodies: Record<string, { heading: string; body: string }> }) {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>("select * from proposals where id = $1", [input.proposalId]);
    if (!rows[0]) throw new DomainError("not_found", "Proposal not found");
    const current = mapProposal(rows[0]);
    const sections = current.sections.map((s) => ({ ...s, ...(input.sectionBodies[s.key] ?? {}) }));
    const edited = { title: input.title.trim(), intro: input.intro.trim(), closing: input.closing.trim(), sections };
    if (current.status === "draft" || current.status === "ready") {
      await q.query("update proposals set title = $2, intro = $3, closing = $4, sections = $5, edited_by_expert = true, status = 'draft' where id = $1", [
        current.id,
        edited.title,
        edited.intro,
        edited.closing,
        JSON.stringify(sections),
      ]);
      await audit(q, tenant.workspaceId, tenant.memberId, "proposal.edited", current.id);
      return current.id;
    }
    const next = await insertProposal(q, tenant.workspaceId, { ...current, ...edited, status: "draft", createdBy: tenant.memberId, editedByExpert: true });
    await audit(q, tenant.workspaceId, tenant.memberId, "proposal.new_version", next.id, { from: current.version });
    return next.id;
  });
}

/** Send to the client portal. Only the trip owner sends, and only a draft with no blocking issues. */
export function sendProposal(db: Db, tenant: Tenant, proposalId: string, now = new Date()) {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>("select * from proposals where id = $1", [proposalId]);
    if (!rows[0]) throw new DomainError("not_found", "Proposal not found");
    const p = mapProposal(rows[0]);
    const trip = await getTrip(q, p.tripId);
    if (trip?.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the trip owner sends proposals to the client");
    if (p.status !== "draft" && p.status !== "ready") throw new DomainError("bad_state", `Proposal is already ${p.status}`);
    const issues = await reviewFor(q, p);
    if (!canSend(issues)) throw new DomainError("blocked", issues.filter((i) => i.severity === "block").map((i) => i.message).join(" "));
    await q.query("update proposals set status = 'superseded' where trip_id = $1 and status in ('sent', 'accepted') and id <> $2", [p.tripId, p.id]);
    await q.query("update proposals set status = 'sent', sent_at = $2 where id = $1", [p.id, now.toISOString()]);
    await audit(q, tenant.workspaceId, tenant.memberId, "proposal.sent", p.id, { version: p.version });
  });
}

export function addStyleSample(db: Db, tenant: Tenant, body: string) {
  const text = body.trim();
  if (text.length < 40) throw new DomainError("too_short", "Paste a longer sample of your own writing (a past proposal or client email).");
  return withTenant(db, tenant, (q) =>
    q.query("insert into style_samples (id, workspace_id, owner_id, body) values ($1, $2, $3, $4)", [randomUUID(), tenant.workspaceId, tenant.memberId, text.slice(0, 20_000)]),
  );
}

/** Without agents, the expert starts from a skeleton: one section per live item, in trip order. */
export function createBlankProposal(db: Db, tenant: Tenant, tripId: string) {
  return withTenant(db, tenant, async (q) => {
    const trip = await getTrip(q, tripId);
    if (!trip) throw new DomainError("not_found", "Trip not found");
    const items = (await listItems(q, tripId)).filter((i) => i.state !== "canceled");
    const p = await insertProposal(q, tenant.workspaceId, {
      tripId,
      status: "draft",
      title: trip.title,
      intro: "",
      closing: "",
      sections: items.map((i, n) => ({ key: `s${n + 1}`, heading: i.title, body: "", itemIds: [i.id], recommendations: [] })),
      createdBy: tenant.memberId,
      editedByExpert: true,
    });
    await audit(q, tenant.workspaceId, tenant.memberId, "proposal.created", p.id);
    return p.id;
  });
}
