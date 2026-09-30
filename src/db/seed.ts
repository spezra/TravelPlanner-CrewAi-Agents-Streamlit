/**
 * Demo data: one worked trip for a solo founding expert, with items in
 * different states, an open approval, a commitment awaiting review, an
 * outcome-unknown transfer, and a supplier contact with a ledger. All people,
 * properties and clients are fictional.
 */
import { requestApproval } from "@/domain/approvals";
import type { TripItem } from "@/domain/bookings";
import { seedCalls } from "@/modules/calls/seed";
import { seedCrm } from "@/modules/crm/seed";
import type { Db } from "./client";
import { insertApproval, insertCommitment, insertItem } from "./repo";

export const DEMO = {
  workspace: "00000000-0000-4000-8000-000000000001",
  otherWorkspace: "00000000-0000-4000-8000-000000000002",
  expert: "00000000-0000-4000-8000-0000000000a1",
  assistant: "00000000-0000-4000-8000-0000000000a2",
  backup: "00000000-0000-4000-8000-0000000000a3",
  otherExpert: "00000000-0000-4000-8000-0000000000b1",
  client: "00000000-0000-4000-8000-0000000000c1",
  trip: "00000000-0000-4000-8000-0000000000d1",
  privateTrip: "00000000-0000-4000-8000-0000000000d2",
  otherTrip: "00000000-0000-4000-8000-0000000000d9",
  flight: "00000000-0000-4000-8000-0000000000e1",
  hotelCdmx: "00000000-0000-4000-8000-0000000000e2",
  hotelOaxaca: "00000000-0000-4000-8000-0000000000e3",
  transfer: "00000000-0000-4000-8000-0000000000e4",
  dinner: "00000000-0000-4000-8000-0000000000e5",
  approvalOaxaca: "00000000-0000-4000-8000-0000000000f1",
  gm: "00000000-0000-4000-8000-000000000101",
  concierge: "00000000-0000-4000-8000-000000000102",
} as const;

const creds = (over: Partial<NonNullable<TripItem["credentials"]>> = {}): NonNullable<TripItem["credentials"]> => ({
  bookingEntity: "Host agency: Example Travel Collective (IATA 00000000)",
  permittedChannel: "Direct to property",
  program: "Example Preferred Partner",
  rate: "Best flexible rate",
  perks: [
    { name: "Daily breakfast for two", basis: "guaranteed" },
    { name: "USD 100 property credit", basis: "guaranteed" },
    { name: "Room upgrade", basis: "availability_dependent" },
    { name: "Late checkout", basis: "availability_dependent" },
  ],
  servicingOwner: "Marisol Vega",
  servicingActions: ["modify", "cancel", "request_upgrade"],
  commissionRecipient: "Example Travel Collective, 80% to Marisol Vega",
  ...over,
});

export async function seed(db: Db, now = new Date()): Promise<void> {
  const d = DEMO;
  const plusDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
  const minusDays = (n: number) => plusDays(-n);

  await db.transaction(async (q) => {
    await q.query("set local role app_system");
    await q.query(`insert into workspaces (id, name, book_portability) values ($1, 'Marisol Vega Travel', 'advisor_owns'), ($2, 'Paris Atelier', 'advisor_owns')`, [
      d.workspace,
      d.otherWorkspace,
    ]);
    await q.query(
      `insert into members (id, workspace_id, name, email, role, time_zone) values
        ($1, $5, 'Marisol Vega', 'marisol@example.com', 'owner', 'America/Mexico_City'),
        ($2, $5, 'Diego Ortiz', 'diego@example.com', 'assistant', 'America/Mexico_City'),
        ($3, $5, 'Lena Brandt', 'lena@example.com', 'advisor', 'Europe/Berlin'),
        ($4, $6, 'Camille Roux', 'camille@example.com', 'owner', 'Europe/Paris')`,
      [d.expert, d.assistant, d.backup, d.otherExpert, d.workspace, d.otherWorkspace],
    );
    await q.query(`insert into clients (id, workspace_id, owner_id, name, scope) values ($1, $2, $3, 'The Whitfields', 'workspace')`, [d.client, d.workspace, d.expert]);
    await q.query(
      `insert into trips (id, workspace_id, owner_id, client_id, title, starts_on, ends_on, scope) values
        ($1, $4, $5, $6, 'Mexico City & Oaxaca — 20th anniversary', $7, $8, 'workspace'),
        ($2, $4, $5, null, 'Scouting: Valle de Guadalupe', $9, $10, 'private'),
        ($3, $11, $12, null, 'Loire weekend', $7, $8, 'workspace')`,
      [d.trip, d.privateTrip, d.otherTrip, d.workspace, d.expert, d.client, plusDays(100).slice(0, 10), plusDays(109).slice(0, 10), plusDays(40).slice(0, 10), plusDays(43).slice(0, 10), d.otherWorkspace, d.otherExpert],
    );
    await q.query(`insert into trip_delegations (trip_id, workspace_id, member_id, purpose, expires_at) values ($1, $2, $3, 'backup', $4)`, [
      d.trip,
      d.workspace,
      d.backup,
      plusDays(120),
    ]);
    await q.query(`insert into response_plans (trip_id, workspace_id, plan) values ($1, $2, $3)`, [
      d.trip,
      d.workspace,
      JSON.stringify({
        tripId: d.trip,
        primary: { memberId: d.expert, timeZone: "America/Mexico_City", coverage: [{ days: [1, 2, 3, 4, 5], startHour: 8, endHour: 20 }] },
        backup: { memberId: d.backup, timeZone: "Europe/Berlin", coverage: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 7, endHour: 23 }] },
        ackDeadlineMinutes: 30,
        escalation: [d.assistant],
        clientContactPolicy: "Marisol, or Lena as named backup. Never the system alone for anything the client is unhappy about.",
      }),
    ]);

    const items: TripItem[] = [
      {
        id: d.flight, tripId: d.trip, kind: "flight", title: "JFK → MEX, 2 × business", supplierName: "Airline via Duffel", state: "confirmed",
        price: { amountMinor: 1_840_000, currency: "USD" }, startsAt: plusDays(100), endsAt: plusDays(100),
        credentials: creds({ bookingEntity: "Duffel Managed Content", permittedChannel: "Duffel", program: null, perks: [], rate: "Published fare", servicingActions: ["modify", "cancel"], commissionRecipient: "n/a (net fare + service fee)" }),
        confirmationRef: "PNR X7K2QD",
      },
      {
        id: d.hotelCdmx, tripId: d.trip, kind: "hotel", title: "Casa Alma, Roma Norte — 4 nights, garden suite", supplierName: "Casa Alma", state: "confirmed",
        price: { amountMinor: 1_120_000, currency: "USD" }, startsAt: plusDays(100), endsAt: plusDays(104), credentials: creds(), confirmationRef: "CA-55812",
      },
      {
        id: d.hotelOaxaca, tripId: d.trip, kind: "hotel", title: "Hacienda Tierra Roja, Oaxaca — 5 nights, mezcal-garden casita", supplierName: "Hacienda Tierra Roja", state: "awaiting_approval",
        price: { amountMinor: 1_475_000, currency: "USD" }, startsAt: plusDays(104), endsAt: plusDays(109), credentials: creds(), confirmationRef: null,
      },
      {
        id: d.transfer, tripId: d.trip, kind: "transfer", title: "Private transfer, Oaxaca airport → Hacienda", supplierName: "Valle Transportes (DMC)", state: "outcome_unknown",
        price: { amountMinor: 18_000, currency: "USD" }, startsAt: plusDays(104), endsAt: plusDays(104),
        credentials: creds({ program: null, perks: [], permittedChannel: "Email to DMC", rate: "Net DMC rate", servicingActions: ["modify", "cancel"] }), confirmationRef: null,
      },
      {
        id: d.dinner, tripId: d.trip, kind: "dining", title: "Anniversary dinner — chef's counter", supplierName: null, state: "design",
        price: null, startsAt: plusDays(107), endsAt: null, credentials: null, confirmationRef: null,
      },
    ];
    for (const [i, it] of items.entries()) await insertItem(q, d.workspace, it, i);

    await insertApproval(
      q,
      d.workspace,
      requestApproval({
        id: d.approvalOaxaca,
        tripId: d.trip,
        actions: [
          { kind: "book", itemId: d.hotelOaxaca },
          { kind: "pay", itemId: d.hotelOaxaca },
        ],
        terms: {
          price: { amountMinor: 1_475_000, currency: "USD" },
          offerExpiresAt: plusDays(2),
          cancellationPolicy: "Free cancellation until 21 days before arrival; then first night charged",
          downstreamChanges: ["Airport transfer pickup moves to 15:30 to match check-in"],
          actor: "Booking agent, direct to property under Marisol's preferred-partner booking",
        },
        requestedBy: "agent:booking",
      }),
    );

    await q.query(
      `insert into people (id, workspace_id, owner_id, name, roles, approach, texture, scope) values
        ($1, $3, $4, 'Rafael Montes', $5, $6, $7, 'private'),
        ($2, $3, $4, 'Inés Robles', $8, $9, '[]', 'workspace')`,
      [
        d.gm, d.concierge, d.workspace, d.expert,
        JSON.stringify([
          { organization: "Casa Alma", propertyId: null, title: "Guest Relations Manager", measuredOn: "guest satisfaction scores", from: "2019-03-01", to: "2023-06-30" },
          { organization: "Hacienda Tierra Roja", propertyId: null, title: "General Manager", measuredOn: "occupancy and online reviews", from: "2023-07-01", to: null },
        ]),
        JSON.stringify({ channel: "WhatsApp", timeZone: "America/Mexico_City", language: "es", boss: "Owner family (Robledo)", goingOverTheirHeadAcceptable: false }),
        JSON.stringify(["Dry humor; hates being rushed", "Mention his daughter's ceramics studio"]),
        JSON.stringify([{ organization: "Casa Alma", propertyId: null, title: "Head Concierge", measuredOn: "guest recognition", from: "2021-01-01", to: null }]),
        JSON.stringify({ channel: "Email", timeZone: "America/Mexico_City", language: "es", boss: null, goingOverTheirHeadAcceptable: false }),
      ],
    );
    const ledger: [string, string, string, number, string, string | null, number | null][] = [
      ["00000000-0000-4000-8000-000000000201", d.gm, "favor_asked", 70, "Upgrade to casita for the Parks", "upgrade", null],
      ["00000000-0000-4000-8000-000000000202", d.gm, "favor_granted", 69, "Upgraded the Parks", "upgrade", null],
      ["00000000-0000-4000-8000-000000000203", d.gm, "favor_asked", 40, "Upgrade for the Lius", "upgrade", null],
      ["00000000-0000-4000-8000-000000000204", d.gm, "business_sent", 35, "Lius, 6 nights", null, 6],
      ["00000000-0000-4000-8000-000000000205", d.gm, "favor_asked", 3, "Upgrade + late checkout for the Whitfields", "upgrade", null],
      ["00000000-0000-4000-8000-000000000206", d.concierge, "recognition_given", 20, "Named her in a note to the owner", null, null],
    ];
    for (const [id, person, kind, ago, note, askType, nights] of ledger) {
      await q.query(
        `insert into ledger_entries (id, workspace_id, person_id, kind, at, note, ask_type, room_nights) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, d.workspace, person, kind, minusDays(ago), note, askType, nights],
      );
    }

    await insertCommitment(q, d.workspace, {
      id: "00000000-0000-4000-8000-000000000301", tripId: d.trip, itemId: d.hotelOaxaca, promisor: "Rafael Montes (GM)", promisorPersonId: d.gm,
      promise: "Casita 4 held for the Whitfields and upgraded at no charge", conditions: "If booked by Friday under the preferred-partner rate",
      dueBy: plusDays(2), evidence: "machine_transcript", evidenceRef: "call-2026-09-28", state: "pending", transcriptVerified: false,
      confidence: 0.82, consequential: true, reviewStatus: "needs_review", recapSentAt: null, deliveredToTravelerAt: null,
    });
    await insertCommitment(q, d.workspace, {
      id: "00000000-0000-4000-8000-000000000302", tripId: d.trip, itemId: d.hotelCdmx, promisor: "Inés Robles (Concierge)", promisorPersonId: d.concierge,
      promise: "Anniversary amenity in room on arrival", conditions: null, dueBy: plusDays(100), evidence: "written_confirmation", evidenceRef: "email-4411",
      state: "pending", transcriptVerified: false, confidence: 0.97, consequential: false, reviewStatus: "auto_filed", recapSentAt: minusDays(5), deliveredToTravelerAt: null,
    });
    await q.query(
      `insert into execution_attempts (id, workspace_id, item_id, action, idempotency_key, state, provider, attempts, last_error)
       values ($1, $2, $3, 'book', 'atp_book_demo_transfer', 'outcome_unknown', 'simulated', 1, 'Email sent to DMC; no confirmation received in 48h')`,
      ["00000000-0000-4000-8000-000000000401", d.workspace, d.transfer],
    );

    await q.query(
      `insert into brief_statements (id, workspace_id, client_id, trip_id, dimension, text, evidence, source) values
        ('00000000-0000-4000-8000-000000000501', $1, $2, null, 'desired_experience', 'Prefer intimate properties; dislike visibly formal service', 'expert_inferred', 'three prior trips'),
        ('00000000-0000-4000-8000-000000000502', $1, $2, null, 'practical_constraints', 'Will accept a longer transfer for privacy', 'client_said', 'call 2026-08-14'),
        ('00000000-0000-4000-8000-000000000503', $1, $2, $3, 'desired_experience', 'One unforgettable dinner; otherwise unscheduled evenings', 'client_said', 'call 2026-09-02'),
        ('00000000-0000-4000-8000-000000000504', $1, $2, $3, 'party_dynamics', 'Tom plans; Priya decides on hotels', 'expert_inferred', 'call 2026-09-02')`,
      [d.workspace, d.client, d.trip],
    );

    await q.query(
      `insert into knowledge_items (id, workspace_id, owner_id, category, body, sharing_permission, confidentiality, confidence, published_scope, publication_status) values
        ('00000000-0000-4000-8000-000000000601', $1, $2, 'property_guidance', 'Hacienda Tierra Roja: casitas 3–5 face the mezcal garden and are the quietest; avoid casita 1 (next to the service road).', 'network', 'shareable', 'high', 'private', 'awaiting_owner'),
        ('00000000-0000-4000-8000-000000000602', $1, $2, 'commercial_terms', 'Hacienda Tierra Roja extends 15% off BAR for stays of 5+ nights through Rafael.', 'private', 'restricted', 'high', 'private', 'draft')`,
      [d.workspace, d.expert],
    );

    // Feature modules' demo data, in dependency order.
    await seedCalls(q, now);
    await seedCrm(q, now);
  });
}
