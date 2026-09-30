/**
 * Demo data for the ops module (fictional): the Whitfields' party, one
 * learned decision per destination record, and a short endorsement history.
 * Runs as app_system inside the main seed transaction.
 */
import type { Queryable } from "@/db/client";
import { DEMO } from "@/db/seed";

export const OPS_DEMO = {
  partyTom: "00000000-0000-4000-8000-000000000701",
  partyPriya: "00000000-0000-4000-8000-000000000702",
  decisionTaste: "00000000-0000-4000-8000-000000000711",
  decisionSupplier: "00000000-0000-4000-8000-000000000712",
  decisionUnexplained: "00000000-0000-4000-8000-000000000713",
} as const;

export async function seedOps(q: Queryable, now: Date): Promise<void> {
  const d = DEMO;
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  await q.query("update clients set email = 'whitfields@example.com' where id = $1", [d.client]);
  await q.query(
    `insert into client_party_members (id, workspace_id, client_id, name, relation) values
      ($1, $3, $4, 'Tom Whitfield', 'Plans the logistics'),
      ($2, $3, $4, 'Priya Whitfield', 'Decides on hotels')`,
    [OPS_DEMO.partyTom, OPS_DEMO.partyPriya, d.workspace, d.client],
  );

  await q.query(
    `insert into decisions (id, workspace_id, expert_id, trip_id, kind, subject, reason, learning, decided_at, supplier_name, client_id, status, learning_target) values
      ($1, $4, $5, $6, 'reject', 'Gran Hotel Zócalo', $7, $8, $9, 'Gran Hotel Zócalo', $10, 'learned', 'taste_model'),
      ($2, $4, $5, $6, 'reject', 'Casa Alma rooftop dinner', $11, $12, $13, 'Casa Alma', $10, 'learned', 'supplier_record'),
      ($3, $4, $5, $6, 'reject', 'Private transfer, Oaxaca airport → Hacienda', null, null, $14, 'Valle Transportes (DMC)', $10, 'awaiting_answer', null)`,
    [
      OPS_DEMO.decisionTaste,
      OPS_DEMO.decisionSupplier,
      OPS_DEMO.decisionUnexplained,
      d.workspace,
      d.expert,
      d.trip,
      JSON.stringify({ category: "expert_taste", text: "Lobby theatre over warmth; service feels staged", origin: "conversation", validUntil: null }),
      JSON.stringify({ target: "taste_model", decisionId: OPS_DEMO.decisionTaste, recordId: d.expert, summary: "Rejected Gran Hotel Zócalo: Lobby theatre over warmth; service feels staged", observedAt: ago(12), validUntil: null, provisional: false }),
      ago(12),
      d.client,
      JSON.stringify({ category: "supplier_condition", text: "Rooftop closed for resurfacing", origin: "conversation", validUntil: new Date(now.getTime() + 60 * 86_400_000).toISOString().slice(0, 10) }),
      JSON.stringify({ target: "supplier_record", decisionId: OPS_DEMO.decisionSupplier, recordId: "Casa Alma", summary: "Rejected Casa Alma rooftop dinner: Rooftop closed for resurfacing", observedAt: ago(5), validUntil: null, provisional: false }),
      ago(5),
      ago(1),
    ],
  );
  await q.query("update decisions set question = 'Why did you pass on the Valle Transportes transfer?' where id = $1", [OPS_DEMO.decisionUnexplained]);
  await q.query(
    `insert into expert_learnings (id, workspace_id, expert_id, decision_id, kind, subject, summary, status, observed_at) values
      ('00000000-0000-4000-8000-000000000721', $1, $2, $3, 'reject', 'Gran Hotel Zócalo', 'Rejected Gran Hotel Zócalo: Lobby theatre over warmth; service feels staged', 'provisional', $4)`,
    [d.workspace, d.expert, OPS_DEMO.decisionTaste, ago(12)],
  );
  await q.query(
    `insert into supplier_conditions (id, workspace_id, owner_id, supplier_name, condition, observed_at, valid_until, provisional, decision_id) values
      ('00000000-0000-4000-8000-000000000731', $1, $2, 'Casa Alma', 'Rooftop closed for resurfacing', $3, $4, false, $5)`,
    [d.workspace, d.expert, ago(5), new Date(now.getTime() + 60 * 86_400_000).toISOString().slice(0, 10), OPS_DEMO.decisionSupplier],
  );
  const outcomes: [string, string, number][] = [
    ["itinerary draft v1", "endorsed_with_edits", 30],
    ["Oaxaca hotel shortlist", "endorsed_unchanged", 20],
    ["dinner options", "rejected", 10],
    ["transfer plan", "endorsed_unchanged", 3],
  ];
  for (const [i, [ref, outcome, days]] of outcomes.entries()) {
    await q.query("insert into draft_outcomes (id, workspace_id, expert_id, trip_id, draft_ref, outcome, recorded_at) values ($1, $2, $3, $4, $5, $6, $7)", [
      `00000000-0000-4000-8000-00000000074${i}`,
      d.workspace,
      d.expert,
      d.trip,
      ref,
      outcome,
      ago(days),
    ]);
  }
}
