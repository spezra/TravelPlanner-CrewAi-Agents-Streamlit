/**
 * Demo data for the trips slice, layered on the core seed (fictional only):
 *  - the outcome-unknown DMC transfer becomes a manual confirmation task, so
 *    the team can record what the DMC says;
 *  - the confirmed flight is linked to its (fictional) Duffel order, so an
 *    airline-initiated change webhook can find it.
 * Runs as app_system inside the main seed transaction. Idempotent.
 */
import type { Queryable } from "@/db/client";
import { DEMO } from "@/db/seed";

export const TRIPS_DEMO = {
  flightOrder: "ord_0000demoX7K2QD",
  flightAttempt: "00000000-0000-4000-8000-000000000411",
  transferTask: "00000000-0000-4000-8000-000000000421",
} as const;

export async function seedTrips(q: Queryable, now: Date): Promise<void> {
  const exists = await q.query("select 1 from trip_items where id = $1", [DEMO.transfer]);
  if (exists.rows.length === 0) return; // core seed not present

  // The DMC transfer was requested by email: the reservation is outcome-unknown until the DMC answers.
  await q.query("update execution_attempts set provider = 'manual' where workspace_id = $1 and idempotency_key = 'atp_book_demo_transfer' and provider = 'simulated'", [
    DEMO.workspace,
  ]);
  await q.query("update trip_items set provider = 'manual' where id = $1 and provider is null", [DEMO.transfer]);
  await q.query(
    `insert into manual_confirmations (id, workspace_id, trip_id, item_id, action, attempt_key, status, channel, supplier_name, created_at)
     values ($1, $2, $3, $4, 'book', 'atp_book_demo_transfer', 'pending', 'Email to DMC', 'Valle Transportes (DMC)', $5)
     on conflict do nothing`,
    [TRIPS_DEMO.transferTask, DEMO.workspace, DEMO.trip, DEMO.transfer, new Date(now.getTime() - 2 * 86_400_000).toISOString()],
  );

  // The flight was booked through Duffel.
  await q.query("update trip_items set provider = 'duffel', provider_ref = $2 where id = $1 and provider_ref is null", [DEMO.flight, TRIPS_DEMO.flightOrder]);
  await q.query(
    `insert into execution_attempts (id, workspace_id, item_id, action, idempotency_key, state, provider, provider_ref, attempts)
     values ($1, $2, $3, 'book', 'atp_book_demo_flight', 'succeeded', 'duffel', $4, 1)
     on conflict do nothing`,
    [TRIPS_DEMO.flightAttempt, DEMO.workspace, DEMO.flight, TRIPS_DEMO.flightOrder],
  );
}
