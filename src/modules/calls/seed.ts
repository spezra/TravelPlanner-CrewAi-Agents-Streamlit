/**
 * Demo call tasks on the worked trip. Fictional people and properties only.
 * Runs as app_system inside the main seed transaction.
 */
import type { Queryable } from "@/db/client";
import { DEMO } from "@/db/seed";
import { EXAMPLE_CONSENT_TABLE } from "@/domain/calls";

export const CALLS_DEMO = {
  gmCall: "00000000-0000-4000-8000-000000000701",
  conciergeCall: "00000000-0000-4000-8000-000000000702",
  gmCallExpert: "00000000-0000-4000-8000-000000000711",
  gmCallGm: "00000000-0000-4000-8000-000000000712",
  conciergeCallBackup: "00000000-0000-4000-8000-000000000713",
  conciergeCallConcierge: "00000000-0000-4000-8000-000000000714",
} as const;

export async function seedCalls(q: Queryable, now: Date): Promise<void> {
  const d = DEMO;
  const c = CALLS_DEMO;
  await q.query("insert into call_settings (workspace_id, consent_table, audio_retention_days, updated_by) values ($1, $2, 30, $3)", [
    d.workspace,
    JSON.stringify(EXAMPLE_CONSENT_TABLE),
    d.expert,
  ]);
  await q.query(
    `insert into call_tasks (id, workspace_id, owner_id, created_by, trip_id, person_id, purpose, ask, leverage, fallback, done_when,
       spends_relationship_capital, importance, automation_permitted, route, assignee_id, disclosure, scope, created_at) values
     ($1, $3, $4, $4, $6, $7, 'Secure casita 4 for the Whitfields'' anniversary',
      'Hold casita 4 and upgrade at no charge under the preferred-partner rate',
      'Six nights for the Lius in August; anniversary stay; a named review afterwards',
      'Casita 3 with late checkout guaranteed in writing',
      'Rafael confirms casita 4 and the upgrade in writing', true, 'important', false, 'relationship_holder', $4, null, 'private', $9),
     ($2, $3, $4, $5, $6, $8, 'Confirm the anniversary amenity at Casa Alma',
      'Confirm the amenity will be in the suite on arrival', null, 'Ask the front office to note it on the reservation',
      'Inés confirms by email', false, 'routine', false, 'delegate', $10, null, 'workspace', $9)`,
    [c.gmCall, c.conciergeCall, d.workspace, d.expert, d.assistant, d.trip, d.gm, d.concierge, now.toISOString(), d.backup],
  );
  await q.query(
    `insert into call_parties (id, workspace_id, call_task_id, name, jurisdiction, side, position) values
      ($1, $5, $6, 'Marisol Vega', 'MX', 'ours', 0),
      ($2, $5, $6, 'Rafael Montes', 'MX', 'theirs', 1),
      ($3, $5, $7, 'Lena Brandt', 'DE', 'ours', 0),
      ($4, $5, $7, 'Inés Robles', 'MX', 'theirs', 1)`,
    [c.gmCallExpert, c.gmCallGm, c.conciergeCallBackup, c.conciergeCallConcierge, d.workspace, c.gmCall, c.conciergeCall],
  );
}
