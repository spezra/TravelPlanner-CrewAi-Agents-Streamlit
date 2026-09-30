/**
 * Demo data for knowledge and the network (fictional). Both demo workspaces
 * are admitted network members with discoverability profiles; Marisol has
 * dated observations of the Oaxaca hacienda (including a failed upgrade ask);
 * Camille has published one piece of Paris guidance to the network; and
 * Marisol has an open request to Camille. Idempotent.
 */
import type { Queryable } from "@/db/client";
import { DEMO } from "@/db/seed";

export const NETWORK_DEMO = {
  obsInspected: "00000000-0000-4000-8000-000000000701",
  obsLateCheckout: "00000000-0000-4000-8000-000000000702",
  obsUpgradeGranted: "00000000-0000-4000-8000-000000000703",
  obsUpgradeDenied: "00000000-0000-4000-8000-000000000704",
  obsWrittenCdmx: "00000000-0000-4000-8000-000000000705",
  parisItem: "00000000-0000-4000-8000-000000000711",
  parisPublished: "00000000-0000-4000-8000-000000000712",
  collaboration: "00000000-0000-4000-8000-000000000721",
} as const;

export async function seedNetwork(q: Queryable, now: Date): Promise<void> {
  const d = DEMO;
  const n = NETWORK_DEMO;
  const daysAgo = (k: number) => new Date(now.getTime() - k * 86_400_000).toISOString();

  await q.query(
    `insert into network_members (workspace_id, requested_at, admitted_at, admitted_by, application_note) values
       ($1, $3, $3, 'seed', 'Founding expert'), ($2, $3, $3, 'seed', 'Founding expert')
     on conflict (workspace_id) do nothing`,
    [d.workspace, d.otherWorkspace, daysAgo(200)],
  );
  await q.query(
    `insert into network_profiles (member_id, workspace_id, display_name, headline, destinations, capabilities, languages, response_capacity) values
       ($1, $2, 'Marisol Vega', 'Mexico City and Oaxaca: food-led, design-minded, private', $5, $6, '["Spanish","English"]', 'limited'),
       ($3, $4, 'Camille Roux', 'Paris and the Loire, for travelers who want the city as residents know it', $7, $8, '["French","English"]', 'available')
     on conflict (member_id) do nothing`,
    [
      d.expert, d.workspace, d.otherExpert, d.otherWorkspace,
      JSON.stringify(["Mexico City", "Oaxaca", "Valle de Guadalupe"]),
      JSON.stringify(["answer_question", "review_itinerary", "activate_relationship", "design_segment"]),
      JSON.stringify(["Paris", "Loire Valley", "Champagne"]),
      JSON.stringify(["answer_question", "review_itinerary", "activate_relationship", "design_segment", "operate_segment"]),
    ],
  );

  const obs: [string, number, string, boolean, string, object, string | null, string | null, string | null, string][] = [
    [n.obsInspected, 120, "firsthand", true, "Casitas on the mezcal-garden side are the quietest; the ones by the service road hear early deliveries.",
      { program: null, roomCategory: "Casita", season: "Spring", relationshipInvolved: false }, null, null, null, "Hacienda Tierra Roja"],
    [n.obsLateCheckout, 30, "supplier_claim", false, "Reservations says late checkout to 2pm is usually possible outside festival weeks.",
      { program: "Example Preferred Partner", roomCategory: null, season: "Autumn", relationshipInvolved: false }, "late_checkout", "granted", null, "Hacienda Tierra Roja"],
    [n.obsUpgradeGranted, 69, "firsthand", true, "Upgraded to a garden casita on arrival.",
      { program: "Example Preferred Partner", roomCategory: "Casita", season: "Summer", relationshipInvolved: true }, "upgrade", "granted", null, "Hacienda Tierra Roja"],
    [n.obsUpgradeDenied, 40, "firsthand", false, "Upgrade request declined: fully booked for Guelaguetza.",
      { program: "Example Preferred Partner", roomCategory: "Casita", season: "Summer", relationshipInvolved: true }, "upgrade", "denied", null, "Hacienda Tierra Roja"],
    [n.obsWrittenCdmx, 5, "written_confirmation", false, "Anniversary amenity confirmed in writing for arrival.",
      { program: "Example Preferred Partner", roomCategory: "Garden suite", season: "Winter", relationshipInvolved: false }, "amenity", "granted", "CA-55812", "Casa Alma"],
  ];
  for (const [id, ago, source, inspected, statement, applicability, request, outcome, bookingRef, supplier] of obs) {
    await q.query(
      `insert into observations (id, workspace_id, owner_id, created_by, supplier_name, observed_at, source, personally_inspected, statement, applicability,
         request, outcome, booking_ref, scope, created_at, updated_at)
       values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'workspace',$13,$13) on conflict (id) do nothing`,
      [id, d.workspace, d.expert, supplier, daysAgo(ago).slice(0, 10), source, inspected, statement, JSON.stringify(applicability), request, outcome, bookingRef, daysAgo(ago)],
    );
  }

  const parisBody =
    "Hôtel des Tilleuls (Marais): courtyard rooms are far quieter than the street side; the breakfast room is crowded 8:30–9:30 on weekends, so book in-room breakfast for early starts.";
  await q.query(
    `insert into knowledge_items (id, workspace_id, owner_id, category, body, sharing_permission, confidentiality, confidence, published_scope, publication_status,
       destination, target_scope, candidate_body, submitted_at, decided_at)
     values ($1, $2, $3, 'property_guidance', $4, 'network', 'shareable', 'high', 'network', 'published', 'Paris', 'network', $4, $5, $5)
     on conflict (id) do nothing`,
    [n.parisItem, d.otherWorkspace, d.otherExpert, parisBody, daysAgo(12)],
  );
  await q.query(
    `insert into published_knowledge (id, workspace_id, item_id, owner_id, category, destination, scope, body, confidence, source_fingerprint, published_at)
     values ($1, $2, $3, $4, 'property_guidance', 'Paris', 'network', $5, 'high', 'seed', $6) on conflict (item_id) do nothing`,
    [n.parisPublished, d.otherWorkspace, n.parisItem, d.otherExpert, parisBody, daysAgo(12)],
  );

  await q.query(
    `insert into collaborations (id, workspace_id, requester_member_id, specialist_workspace_id, specialist_member_id, requester_name, specialist_name,
       trip_id, contribution, state, destination, brief, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'Marisol Vega', 'Camille Roux', null, 'review_itinerary', 'requested', 'Paris', $6, $7, $7)
     on conflict (id) do nothing`,
    [
      n.collaboration, d.workspace, d.expert, d.otherWorkspace, d.otherExpert,
      JSON.stringify({
        text: "A couple celebrating a milestone anniversary wants three nights in Paris after Mexico. They prefer intimate properties and dislike visibly formal service; one exceptional dinner, otherwise unscheduled evenings. Could you review the draft hotel and dinner choices?",
        partySize: 2,
        budgetBand: "Upper luxury",
        dates: "Late January, 3 nights",
        redactions: 1,
      }),
      daysAgo(1),
    ],
  );
  await q.query(
    `insert into collaboration_log (id, collaboration_id, workspace_id, actor_member_id, actor_side, kind, detail, at)
     values ('00000000-0000-4000-8000-000000000722', $1, $2, $3, 'requester', 'requested', '{"contribution":"review_itinerary"}', $4)
     on conflict (id) do nothing`,
    [n.collaboration, d.workspace, d.expert, daysAgo(1)],
  );
}
