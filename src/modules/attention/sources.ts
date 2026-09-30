/**
 * Everything outside the core trip loop that needs a person's decision,
 * shaped for the Today queue. Each source reads through row-level security
 * as the current member and returns only items that are theirs to decide.
 * Aggregated where one line is kinder than twenty (inbox, lessons).
 */
import type { Queryable } from "@/db/client";
import type { Tenant } from "@/db/tenant";
import type { AttentionItem } from "@/domain/attention";
import type { Role } from "@/domain/common";

const DAY = 24 * 60;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function collectSignals(q: Queryable, tenant: Tenant, role: Role): Promise<AttentionItem[]> {
  const me = tenant.memberId;
  const out: AttentionItem[] = [];

  // Inbox: suggestions from forwarded supplier email waiting for the person who owns them.
  const inbox = await q.query<{ n: number; confirmations: number }>(
    `select count(*)::int as n, count(*) filter (where kind = 'attach_confirmation')::int as confirmations
       from crm_suggestions where status = 'pending' and owner_id = $1`,
    [me],
  );
  const pending = inbox.rows[0];
  if (pending && pending.n > 0) {
    out.push({
      key: "inbox:pending",
      kind: "inbox",
      tripId: null,
      title: `${plural(pending.n, "suggestion", "suggestions")} from supplier email`,
      context: pending.confirmations ? `${plural(pending.confirmations, "is a booking confirmation", "are booking confirmations")} that can settle an open booking.` : "Contacts, touches and commitments found in forwarded email.",
      recommendedAction: "Accept or dismiss; nothing is applied until you do",
      urgencyMinutes: pending.confirmations ? 60 : DAY,
      href: "/inbox",
    });
  }

  // Unhappy clients: the system never handles these alone.
  const unhappy = await q.query<{ id: string; trip_id: string; title: string; detail: string }>(
    "select id, trip_id, title, detail from escalations where kind = 'unhappy_client' and resolved_at is null order by raised_at",
  );
  for (const e of unhappy.rows) {
    out.push({
      key: `unhappy_client:${e.id}`,
      kind: "unhappy_client",
      tripId: e.trip_id,
      title: e.title,
      context: e.detail || "A client is unhappy. Only the advisor or the named backup responds.",
      recommendedAction: "Call the client yourself, then record what you agreed",
      urgencyMinutes: 0,
      href: `/trips/${e.trip_id}/plan`,
    });
  }

  // Payout batches: money moves only on an owner's approval.
  if (role === "owner") {
    const batches = await q.query<{ id: string; n: number }>(
      "select b.id, (select count(*)::int from money_payout_lines l where l.batch_id = b.id) as n from money_payout_batches b where b.status = 'draft' order by b.prepared_at",
    );
    for (const b of batches.rows) {
      out.push({
        key: `payout:${b.id}`,
        kind: "payout",
        tripId: null,
        title: `Payout batch ready for approval (${plural(b.n, "line", "lines")})`,
        context: "Prepared from verified receipts; transfers and settlement instructions go out only after you approve.",
        recommendedAction: "Review the lines and approve or cancel",
        urgencyMinutes: 2 * DAY,
        href: "/money/payouts",
      });
    }
  }

  // Collaborations: requests addressed to me, and terms waiting for my side's acceptance.
  const collabs = await q.query<{ id: string; state: string; contribution: string; is_specialist: boolean }>(
    `select id, state, contribution, (specialist_member_id = $1) as is_specialist
       from collaborations where (specialist_member_id = $1 or requester_member_id = $1) and state in ('requested', 'brief_shared')`,
    [me],
  );
  for (const c of collabs.rows) {
    if (c.state === "requested" && c.is_specialist) {
      out.push({
        key: `collaboration:${c.id}`,
        kind: "collaboration",
        tripId: null,
        title: `A member asks for your help: ${c.contribution.replace(/_/g, " ")}`,
        context: "You see an anonymized brief. Client details are shared only after you both agree terms.",
        recommendedAction: "Accept, decline, or ask a question",
        urgencyMinutes: DAY,
        href: `/collaborations/${c.id}`,
      });
      continue;
    }
    const terms = await q.query<{ version: number; requester_accepted_at: string | null; specialist_accepted_at: string | null }>(
      "select version, requester_accepted_at, specialist_accepted_at from collaboration_terms where collaboration_id = $1 and superseded_at is null order by version desc limit 1",
      [c.id],
    );
    const t = terms.rows[0];
    if (t && !(c.is_specialist ? t.specialist_accepted_at : t.requester_accepted_at)) {
      out.push({
        key: `collaboration_terms:${c.id}:${t.version}`,
        kind: "collaboration",
        tripId: null,
        title: `Terms v${t.version} are waiting for you`,
        context: "Decision authority, fees and client-detail access, as proposed.",
        recommendedAction: "Accept, or propose a revision",
        urgencyMinutes: DAY,
        href: `/collaborations/${c.id}`,
      });
    }
  }

  // Introductions: the relationship holder decides every time.
  const intros = await q.query<{ id: string; collaboration_id: string }>(
    "select id, collaboration_id from relationship_activations where holder_member_id = $1 and decision = 'pending'",
    [me],
  );
  for (const a of intros.rows) {
    out.push({
      key: `introduction:${a.id}`,
      kind: "introduction",
      tripId: null,
      title: "A member asks you to activate one of your relationships",
      context: "Your relationship, your call — every time.",
      recommendedAction: "Say yes or no",
      urgencyMinutes: DAY,
      href: `/collaborations/${a.collaboration_id}`,
    });
  }

  // Short questions about my own decisions, asked only when the answer materially helps.
  const questions = await q.query<{ id: string; trip_id: string; question: string | null; subject: string | null }>(
    "select id, trip_id, question, subject from decisions where expert_id = $1 and status = 'awaiting_answer' order by decided_at desc limit 5",
    [me],
  );
  for (const d of questions.rows) {
    out.push({
      key: `decision_question:${d.id}`,
      kind: "decision_question",
      tripId: d.trip_id,
      title: d.question ?? `Why ${d.subject ?? "this choice"}?`,
      context: "One tap teaches future drafts the right lesson.",
      recommendedAction: "Answer in a few words, or skip",
      urgencyMinutes: 3 * DAY,
      href: `/judgment/trips/${d.trip_id}`,
    });
  }

  const lessons = await q.query<{ n: number }>("select count(*)::int as n from expert_learnings where expert_id = $1 and status = 'provisional'", [me]);
  if ((lessons.rows[0]?.n ?? 0) > 0) {
    out.push({
      key: "learning:provisional",
      kind: "learning",
      tripId: null,
      title: `${plural(lessons.rows[0]!.n, "lesson", "lessons")} inferred from your choices`,
      context: "Held as provisional until you confirm they reflect your taste.",
      recommendedAction: "Endorse or retract",
      urgencyMinutes: 7 * DAY,
      href: "/judgment",
    });
  }

  // Commitment extraction that failed on a call I hold or am assigned to.
  const failed = await q.query<{ call_task_id: string; purpose: string }>(
    `select e.call_task_id, t.purpose from call_extractions e join call_tasks t on t.id = e.call_task_id
      where e.status = 'failed' and (t.owner_id = $1 or t.assignee_id = $1)`,
    [me],
  );
  for (const f of failed.rows) {
    out.push({
      key: `extraction:${f.call_task_id}`,
      kind: "extraction",
      tripId: null,
      title: `Commitments not extracted: ${f.purpose}`,
      context: "The agent couldn't read this call's commitments. Nothing was filed.",
      recommendedAction: "Re-run, or enter the commitments by hand",
      urgencyMinutes: 6 * 60,
      href: `/calls/${f.call_task_id}`,
    });
  }

  return out;
}

/** Pending approvals the client has accepted on the portal. */
export async function clientAcceptedApprovalIds(q: Queryable): Promise<Set<string>> {
  const { rows } = await q.query<{ approval_id: string }>(
    "select distinct a.approval_id from approval_client_acceptances a join approvals p on p.id = a.approval_id where p.status = 'pending'",
  );
  return new Set(rows.map((r) => r.approval_id));
}
