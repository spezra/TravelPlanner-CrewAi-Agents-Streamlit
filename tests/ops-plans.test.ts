import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import * as repo from "@/db/repo";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import type { ResponsePlan } from "@/domain/responsePlan";
import { acknowledgeEscalation, planEditor, raiseUnhappyClient, resolveEscalation, runEscalations, saveResponsePlan } from "@/modules/ops/responsePlans";
import { MemoryMailer, SYSTEM_FOOTER, type Mailer } from "@/server/mail";
import { NOW, useDb } from "./helpers/db";
import { assistant, backup, expert } from "./helpers/ops";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const getDb = useDb();
let db: Db;
let mail: MemoryMailer;
beforeEach(() => {
  db = getDb();
  mail = new MemoryMailer();
});

const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000);
const emailOf: Record<string, string> = { [DEMO.expert]: "marisol@example.com", [DEMO.backup]: "lena@example.com", [DEMO.assistant]: "diego@example.com" };

const plan = (over: Partial<ResponsePlan> = {}): ResponsePlan => ({
  tripId: DEMO.privateTrip,
  primary: { memberId: DEMO.expert, timeZone: "America/Mexico_City", coverage: [{ days: [1, 2, 3, 4, 5], startHour: 8, endHour: 20 }] },
  backup: { memberId: DEMO.backup, timeZone: "Europe/Berlin", coverage: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 7, endHour: 23 }] },
  ackDeadlineMinutes: 30,
  escalation: [DEMO.assistant],
  clientContactPolicy: "Marisol, or Lena as named backup.",
  ...over,
});

async function delegation(tripId: string, memberId: string) {
  return (
    await withSystem(db, (q) => q.query<{ purpose: string; expires_at: unknown }>("select purpose, expires_at from trip_delegations where trip_id = $1 and member_id = $2", [tripId, memberId]))
  ).rows[0];
}
const isoOf = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

describe("response plan editor", () => {
  it("naming a backup grants scoped trip access until a week after the trip ends", async () => {
    expect((await withTenant(db, backup, (q) => repo.listTrips(q))).map((t) => t.id)).not.toContain(DEMO.privateTrip);
    await saveResponsePlan(db, expert, plan());
    const trip = (await withTenant(db, expert, (q) => repo.getTrip(q, DEMO.privateTrip)))!;
    const d = await delegation(DEMO.privateTrip, DEMO.backup);
    expect(d?.purpose).toBe("backup");
    expect(isoOf(d!.expires_at)).toBe(new Date(new Date(`${trip.endsOn}T23:59:59Z`).getTime() + 7 * 86_400_000).toISOString());
    // The backup now sees the private trip and its plan.
    expect((await withTenant(db, backup, (q) => repo.listTrips(q))).map((t) => t.id)).toContain(DEMO.privateTrip);
    expect((await planEditor(db, backup, DEMO.privateTrip))!.plan!.backup!.memberId).toBe(DEMO.backup);
    // An assistant who can't see the trip can't edit its plan.
    await expect(saveResponsePlan(db, assistant, plan())).rejects.toThrow(/not found/);
  });

  it("extends but never shortens existing access, and replacing the backup revokes the old one", async () => {
    // Seeded: Lena's backup access to the anniversary trip runs past trip end + 7 days.
    const before = await delegation(DEMO.trip, DEMO.backup);
    await saveResponsePlan(db, expert, plan({ tripId: DEMO.trip }));
    expect(isoOf((await delegation(DEMO.trip, DEMO.backup))!.expires_at)).toBe(isoOf(before!.expires_at));

    await saveResponsePlan(db, expert, plan({ tripId: DEMO.trip, backup: { ...plan().backup!, memberId: DEMO.assistant }, escalation: [DEMO.backup] }));
    expect(await delegation(DEMO.trip, DEMO.backup)).toBeUndefined();
    expect((await delegation(DEMO.trip, DEMO.assistant))?.purpose).toBe("backup");
    const audits = await withSystem(db, (q) => q.query<{ data: { delegationRevoked: string[] } }>("select data from audit_events where action = 'response_plan.saved' order by id desc limit 1"));
    expect(audits.rows[0]!.data.delegationRevoked).toEqual([DEMO.backup]);
  });

  it("validates the plan", async () => {
    await expect(saveResponsePlan(db, expert, plan({ backup: { ...plan().backup!, memberId: DEMO.expert } }))).rejects.toThrow(/someone other than the primary/);
    await expect(saveResponsePlan(db, expert, plan({ ackDeadlineMinutes: 1 }))).rejects.toThrow(/between 5 minutes/);
    await expect(saveResponsePlan(db, expert, plan({ primary: { ...plan().primary, timeZone: "Mars/Olympus" } }))).rejects.toThrow(/Unknown time zone/);
    await expect(saveResponsePlan(db, expert, plan({ escalation: [DEMO.otherExpert] }))).rejects.toThrow(/active member/);
    await withSystem(db, (q) => q.query("update trips set ends_on = null where id = $1", [DEMO.privateTrip]));
    await expect(saveResponsePlan(db, expert, plan())).rejects.toThrow(/end date/);
  });
});

describe("escalation job", () => {
  // Seeded: the Oaxaca transfer is outcome-unknown on the anniversary trip, whose plan has
  // Marisol (Mexico City, weekdays 8–20) as primary, Lena (Berlin, 7–23) as backup, a 30-minute
  // deadline and Diego next. At NOW (Thu 12:00 UTC) Mexico City is 06:00 and Berlin 14:00.
  const sentTo = () => mail.sent.map((m) => m.to);

  it("notifies the on-duty responder first, then one more responder per missed deadline, once each", async () => {
    let r = await runEscalations(db, mail, NOW);
    expect(r.raised).toBe(1);
    expect(sentTo()).toEqual([emailOf[DEMO.backup]]);
    expect(mail.sent[0]!.subject).toMatch(/Needs a response: Outcome unknown: Private transfer/);
    expect(mail.sent[0]!.text).toContain(SYSTEM_FOOTER.trim());
    expect(mail.sent[0]!.text).toContain(`/trips/${DEMO.trip}/plan`);

    await runEscalations(db, mail, at(10));
    await runEscalations(db, mail, at(29));
    expect(sentTo()).toHaveLength(1);

    r = await runEscalations(db, mail, at(31));
    expect(r.notified).toEqual([expect.objectContaining({ memberId: DEMO.expert, step: 1 })]);
    await runEscalations(db, mail, at(35));
    expect(sentTo()).toEqual([emailOf[DEMO.backup], emailOf[DEMO.expert]]);

    await runEscalations(db, mail, at(62));
    expect(sentTo()).toEqual([emailOf[DEMO.backup], emailOf[DEMO.expert], emailOf[DEMO.assistant]]);
    // Chain exhausted: nobody is emailed twice.
    await runEscalations(db, mail, at(200));
    expect(sentTo()).toHaveLength(3);

    const e = (await planEditor(db, expert, DEMO.trip))!.escalations[0]!;
    expect(e).toMatchObject({ kind: "reconcile", step: 2, tried: [DEMO.backup, DEMO.expert, DEMO.assistant] });
    const notes = await withSystem(db, (q) => q.query("select * from escalation_notifications where sent_at is not null"));
    expect(notes.rows).toHaveLength(3);
  });

  it("acknowledging stops the escalation", async () => {
    await runEscalations(db, mail, NOW);
    const e = (await planEditor(db, backup, DEMO.trip))!.escalations[0]!;
    await acknowledgeEscalation(db, backup, e.id, at(5));
    await runEscalations(db, mail, at(31));
    await runEscalations(db, mail, at(120));
    expect(sentTo()).toEqual([emailOf[DEMO.backup]]);
    const audit = await withSystem(db, (q) => q.query("select * from audit_events where action = 'escalation.acknowledged'"));
    expect(audit.rows).toHaveLength(1);
  });

  it("the system closes an operational event once its cause clears", async () => {
    await runEscalations(db, mail, NOW);
    await withSystem(db, (q) => q.query("update trip_items set state = 'confirmed' where id = $1", [DEMO.transfer]));
    const r = await runEscalations(db, mail, at(31));
    expect(r.autoResolved).toBe(1);
    expect(sentTo()).toHaveLength(1);
    expect((await planEditor(db, expert, DEMO.trip))!.escalations[0]).toMatchObject({ resolvedBy: "system" });
  });

  it("an email that fails to send is retried on the next run, not lost", async () => {
    let fail = true;
    const flaky: Mailer = { send: async (m) => (fail ? Promise.reject(new Error("smtp down")) : mail.send(m)) };
    await runEscalations(db, flaky, NOW);
    fail = false;
    await runEscalations(db, flaky, at(1));
    expect(sentTo()).toEqual([emailOf[DEMO.backup]]);
  });

  it("an unhappy client is never closed by the system, and only by the advisor or named backup", async () => {
    const id = await raiseUnhappyClient(db, assistant, DEMO.trip, "Priya called: the Casa Alma room faces the street", NOW);
    await runEscalations(db, mail, NOW);
    expect(mail.sent.some((m) => m.text.includes("The system will not reply to them"))).toBe(true);
    await runEscalations(db, mail, at(500));
    const open = (await planEditor(db, expert, DEMO.trip))!.escalations.find((e) => e.id === id)!;
    expect(open.resolvedAt).toBeNull();
    await expect(resolveEscalation(db, assistant, id, "Moved them", at(501))).rejects.toThrow(/advisor or the named backup/);
    await expect(resolveEscalation(db, backup, id, "", at(501))).rejects.toThrow(/how the client was answered/);
    await resolveEscalation(db, backup, id, "Called Priya; moved to a garden suite", at(502));
    expect((await planEditor(db, expert, DEMO.trip))!.escalations.find((e) => e.id === id)).toMatchObject({ resolvedBy: DEMO.backup });
  });

  it("trips without a plan escalate to their owner only", async () => {
    await withSystem(db, (q) => q.query("delete from response_plans where trip_id = $1", [DEMO.trip]));
    await runEscalations(db, mail, NOW);
    await runEscalations(db, mail, at(500));
    expect(sentTo()).toEqual([emailOf[DEMO.expert]]);
  });
});
