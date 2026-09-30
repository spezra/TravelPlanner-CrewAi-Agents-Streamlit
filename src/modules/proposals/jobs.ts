import { ClaudeLLM, type StructuredLLM } from "@/agents/llm";
import { draftProposal } from "@/agents/proposalDrafter";
import { audit, getTrip, listItems } from "@/db/repo";
import { withTenant } from "@/db/tenant";
import type { BriefStatement } from "@/domain/brief";
import type { Observation } from "@/domain/knowledge";
import { PermanentJobError, type JobHandler } from "@/server/jobs/queue";
import type { Schedule } from "@/server/jobs/scheduler";
import { insertProposal } from "./service";

let llmFactory: () => StructuredLLM = () => new ClaudeLLM();
export const setProposalLLM = (f: () => StructuredLLM) => (llmFactory = f);

/**
 * Taste notes come from the ops slice's learnings table when present; the
 * query tolerates its absence so this module stands alone.
 */
async function tasteNotes(q: import("@/db/client").Queryable, expertId: string): Promise<string[]> {
  const { rows } = await q.query<{ exists: boolean }>("select to_regclass('public.taste_learnings') is not null as exists");
  if (!rows[0]?.exists) return [];
  const r = await q.query<{ summary: string }>("select summary from taste_learnings where expert_id = $1 and retracted_at is null order by created_at desc limit 60", [expertId]);
  return r.rows.map((x) => x.summary);
}

export const handlers: Record<string, JobHandler> = {
  "proposals.draft": async ({ db, job, tenant }) => {
    if (!tenant) throw new PermanentJobError("proposals.draft needs a tenant");
    const tripId = String(job.payload.tripId ?? "");
    await withTenant(db, tenant, async (q) => {
      const trip = await getTrip(q, tripId);
      if (!trip) throw new PermanentJobError("Trip not visible to the requesting member");
      const items = await listItems(q, tripId);
      const brief: BriefStatement[] = trip.clientId
        ? (
            await q.query<Record<string, unknown>>("select * from brief_statements where client_id = $1 and superseded_by is null and (trip_id is null or trip_id = $2)", [trip.clientId, tripId])
          ).rows.map((r) => ({
            id: String(r.id),
            clientId: String(r.client_id),
            tripId: r.trip_id ? String(r.trip_id) : null,
            dimension: r.dimension as BriefStatement["dimension"],
            text: String(r.text),
            evidence: r.evidence as BriefStatement["evidence"],
            source: String(r.source),
            recordedAt: String(r.recorded_at),
            supersededBy: null,
          }))
        : [];
      const suppliers = [...new Set(items.map((i) => i.supplierName).filter(Boolean))] as string[];
      const observations = (
        await q.query<Record<string, unknown>>("select * from observations where supplier_name = any($1::text[]) order by observed_at desc limit 80", [suppliers])
      ).rows.map((r) => ({
        id: String(r.id),
        supplierId: String(r.supplier_name),
        supplierName: String(r.supplier_name),
        observedAt: String(r.observed_at instanceof Date ? r.observed_at.toISOString() : r.observed_at),
        source: r.source as Observation["source"],
        personallyInspected: Boolean(r.personally_inspected),
        statement: String(r.statement),
        applicability: r.applicability as Observation["applicability"],
        request: (r.request as string | null) ?? null,
        outcome: (r.outcome as Observation["outcome"]) ?? null,
        bookingRef: (r.booking_ref as string | null) ?? null,
      }));
      const samples = (await q.query<{ body: string }>("select body from style_samples where owner_id = $1 order by created_at desc limit 3", [trip.ownerId])).rows.map((r) => r.body);
      const result = await draftProposal(llmFactory(), {
        tripTitle: trip.title,
        expertName: trip.ownerName,
        items,
        brief,
        tasteNotes: await tasteNotes(q, trip.ownerId),
        observations,
        styleSamples: samples,
        now: new Date(),
      });
      if ("error" in result) throw new Error(result.error);
      const p = await insertProposal(q, tenant.workspaceId, { ...result.proposal, tripId, status: "draft", createdBy: "agent:proposals", editedByExpert: false });
      await audit(q, tenant.workspaceId, "agent:proposals", "proposal.drafted", p.id, { issues: result.issues.length });
    });
  },
};

export const schedules: Schedule[] = [];
