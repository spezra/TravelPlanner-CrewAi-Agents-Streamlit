/**
 * Demo CRM data on top of the main seed (fictional people and suppliers only):
 * contact emails, encrypted texture, a client tie, knowledge that depends on a
 * contact, the workspace inbound address, and one parsed supplier confirmation
 * waiting in the Inbox for the outcome-unknown transfer.
 */
import type { Queryable } from "@/db/client";
import { DEMO } from "@/db/seed";
import { encryptFor } from "@/server/crypto";

export const CRM_DEMO = {
  inboundToken: "demo0inbound0token0",
  message: "00000000-0000-4000-8000-000000000701",
  suggestionConfirmation: "00000000-0000-4000-8000-000000000711",
  suggestionPerson: "00000000-0000-4000-8000-000000000712",
  suggestionTouch: "00000000-0000-4000-8000-000000000713",
} as const;

export async function seedCrm(q: Queryable, now: Date): Promise<void> {
  const d = DEMO;
  const ws = d.workspace;

  await q.query("update people set emails = $2 where id = $1", [d.gm, ["rafael@haciendatierraroja.example"]]);
  await q.query("update people set emails = $2 where id = $1", [d.concierge, ["ines.robles@casaalma.example"]]);

  // Texture moves out of the plaintext column into the owner-only encrypted table.
  const { rows } = await q.query<{ id: string; owner_id: string; texture: unknown }>(
    "select id, owner_id, texture from people where workspace_id = $1 and jsonb_array_length(texture) > 0",
    [ws],
  );
  for (const r of rows) {
    await q.query(
      "insert into person_texture (person_id, workspace_id, owner_id, sealed) values ($1, $2, $3, $4) on conflict (person_id) do nothing",
      [r.id, ws, r.owner_id, await encryptFor(q, ws, `person_texture:${r.id}`, JSON.stringify(r.texture))],
    );
    await q.query("update people set texture = '[]'::jsonb where id = $1", [r.id]);
  }

  await q.query(
    "insert into person_clients (person_id, client_id, workspace_id, note) values ($1, $2, $3, 'Looked after them at Casa Alma in 2024') on conflict do nothing",
    [d.concierge, d.client, ws],
  );
  await q.query("update knowledge_items set depends_on_person_id = $1 where id in ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000602')", [d.gm]);

  await q.query("insert into inbound_routes (workspace_id, token, default_member_id) values ($1, $2, $3) on conflict do nothing", [ws, CRM_DEMO.inboundToken, d.expert]);

  const m = CRM_DEMO.message;
  const receivedAt = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const subject = "Confirmación de traslado VT-20931 / Transfer confirmation";
  const body = [
    "Estimada Marisol,",
    "",
    "We confirm the private transfer for the Whitfield party, Oaxaca airport to Hacienda Tierra Roja.",
    "Confirmation number: VT-20931",
    "Pickup: 15:30 on arrival day. Vehicle: Suburban, bilingual driver.",
    "Total: USD 180.00. Free cancellation up to 48 hours before pickup.",
    "",
    "Saludos,",
    "Paola Díaz",
    "Reservations, Valle Transportes",
  ].join("\n");
  await q.query(
    `insert into inbound_messages (id, workspace_id, owner_id, scope, message_id, from_address, from_name, to_address, received_at,
       subject_sealed, body_sealed, attachments, parse_status, classification, parsed_at)
     values ($1, $2, $3, 'workspace', '<vt-20931@valletransportes.example>', 'reservas@valletransportes.example', 'Paola Díaz',
       $4, $5, $6, $7, '[]', 'parsed', 'supplier_confirmation', $5)
     on conflict do nothing`,
    [
      m, ws, d.expert, `in+${CRM_DEMO.inboundToken}@localhost`, receivedAt,
      await encryptFor(q, ws, `inbound_subject:${m}`, subject),
      await encryptFor(q, ws, `inbound_body:${m}`, body),
    ],
  );
  const confirmation = {
    supplier: "Valle Transportes",
    confirmationNumber: "VT-20931",
    startsOn: null,
    endsOn: null,
    service: "Private transfer, Oaxaca airport to Hacienda Tierra Roja, 15:30 pickup",
    priceMinor: 18_000,
    currency: "USD",
    perks: [],
    cancellationTerms: "Free cancellation up to 48 hours before pickup",
  };
  const suggestions: [string, string, unknown, string][] = [
    [
      CRM_DEMO.suggestionConfirmation,
      "attach_confirmation",
      { confirmation, candidates: [{ itemId: d.transfer, score: 5, label: "Mexico City & Oaxaca — 20th anniversary · Private transfer, Oaxaca airport → Hacienda (outcome unknown)" }] },
      `in:${m}:confirmation`,
    ],
    [
      CRM_DEMO.suggestionPerson,
      "upsert_person",
      { email: "reservas@valletransportes.example", name: "Paola Díaz", organization: "Valle Transportes", title: "Reservations", mergeIntoPersonId: null, mergeIntoName: null },
      `in:${m}:person`,
    ],
    [
      CRM_DEMO.suggestionTouch,
      "log_touch",
      { personId: null, email: "reservas@valletransportes.example", at: receivedAt, note: `Email: ${subject}` },
      `in:${m}:touch`,
    ],
  ];
  for (const [id, kind, payload, key] of suggestions) {
    await q.query(
      `insert into crm_suggestions (id, workspace_id, owner_id, scope, source, message_id, kind, payload, dedupe_key)
       values ($1, $2, $3, 'workspace', 'inbound_email', $4, $5, $6, $7) on conflict do nothing`,
      [id, ws, d.expert, m, kind, JSON.stringify(payload), key],
    );
  }
}
