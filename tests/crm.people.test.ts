import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { DEMO } from "@/db/seed";
import { withSystem, withTenant } from "@/db/tenant";
import { askTiming, openFavors, preCallBrief } from "@/domain/crmBrief";
import { moveNudge } from "@/domain/crmIngest";
import { drain } from "@/server/jobs/queue";
import { createHandlers } from "@/modules/crm/jobs";
import {
  ChipAdviceError,
  createPerson,
  deletePerson,
  draftNote,
  flagDependentKnowledge,
  getPerson,
  listDrafts,
  listLedger,
  listNotices,
  listPeople,
  logLedgerEntry,
  recordPersonMove,
  setClientTie,
  updatePerson,
} from "@/modules/crm/people";
import { NOW, useDb } from "./helpers/db";
import { assistant, backup, expert, fakeLLM, outsider, seedCrmData } from "./helpers/crm";

const getDb = useDb();
let db: Db;
beforeEach(async () => {
  db = getDb();
  await seedCrmData(db);
});

const approach = { channel: "Email", timeZone: "Europe/Rome", language: "it", boss: "Owner", goingOverTheirHeadAcceptable: false };

describe("people: scope, texture and isolation", () => {
  it("private people are the owner's alone; workspace people are shared without texture", async () => {
    const priv = await createPerson(db, expert, { name: "Giulia Neri", emails: ["giulia@villa.example"], approach, texture: ["Loves orchids; never call before 10"] }, NOW);
    const shared = await createPerson(db, expert, { name: "Marco Bassi", scope: "workspace", approach, texture: ["Hates being rushed"] }, NOW);

    const mine = await withTenant(db, expert, (q) => getPerson(q, expert, priv));
    expect(mine?.textureVisible).toEqual(["Loves orchids; never call before 10"]);

    expect(await withTenant(db, assistant, (q) => getPerson(q, assistant, priv))).toBeNull();
    const seenByAssistant = await withTenant(db, assistant, (q) => getPerson(q, assistant, shared));
    expect(seenByAssistant?.name).toBe("Marco Bassi");
    expect(seenByAssistant?.textureVisible).toBeNull();
    // RLS, not just the service, keeps texture from other members.
    const rows = await withTenant(db, assistant, (q) => q.query("select * from person_texture"));
    expect(rows.rows).toHaveLength(0);

    // Another workspace sees none of it.
    const other = await withTenant(db, outsider, (q) => listPeople(q, outsider));
    expect(other).toHaveLength(0);
    expect((await withTenant(db, outsider, (q) => q.query("select * from person_clients"))).rows).toHaveLength(0);
  });

  it("stores texture as ciphertext and migrates legacy plaintext texture", async () => {
    const id = await createPerson(db, expert, { name: "Giulia Neri", approach, texture: ["Daughter studies in Lyon"] }, NOW);
    const at = await withSystem(db, (q) => q.query<{ sealed: string }>("select sealed from person_texture where person_id = $1", [id]));
    expect(at.rows[0]!.sealed).not.toContain("Lyon");
    const legacy = await withSystem(db, (q) => q.query<{ texture: unknown }>("select texture from people where id = $1", [DEMO.gm]));
    expect(legacy.rows[0]!.texture).toEqual([]);
    const gm = await withTenant(db, expert, (q) => getPerson(q, expert, DEMO.gm));
    expect(gm?.textureVisible).toContain("Dry humor; hates being rushed");
  });

  it("only the holder (or a workspace owner) edits; only the holder writes texture or deletes", async () => {
    const shared = await createPerson(db, expert, { name: "Marco Bassi", scope: "workspace", approach }, NOW);
    await expect(updatePerson(db, assistant, shared, { name: "M", scope: "workspace", approach }, NOW)).rejects.toThrow(/relationship holder/);
    await expect(deletePerson(db, assistant, shared)).rejects.toThrow(/relationship holder/);
    await expect(createPerson(db, assistant, { name: "Dup", emails: ["rafael@haciendatierraroja.example"], approach }, NOW)).resolves.toBeTruthy(); // gm is private: invisible, so not a visible duplicate
    await expect(createPerson(db, expert, { name: "Dup", emails: ["ines.robles@casaalma.example"], approach }, NOW)).rejects.toThrow(/already belongs/);
    await setClientTie(db, expert, { personId: shared, clientId: DEMO.client, note: "Hosted their anniversary" });
    const p = await withTenant(db, expert, (q) => getPerson(q, expert, shared));
    expect(p?.clients.map((c) => c.name)).toEqual(["The Whitfields"]);
    await deletePerson(db, expert, shared);
    expect(await withTenant(db, expert, (q) => getPerson(q, expert, shared))).toBeNull();
  });
});

describe("moves", () => {
  it("closes the stint, opens the new door and flags dependent knowledge across owners", async () => {
    // A colleague's private note that also depends on Rafael.
    await withSystem(db, (q) =>
      q.query(
        `insert into knowledge_items (id, workspace_id, owner_id, category, body, sharing_permission, confidentiality, confidence, depends_on_person_id)
         values ('00000000-0000-4000-8000-000000000699', $1, $2, 'property_guidance', 'Ask Rafael for casita 4', 'private', 'confidential', 'medium', $3)`,
        [DEMO.workspace, DEMO.backup, DEMO.gm],
      ),
    );
    const r = await recordPersonMove(db, expert, DEMO.gm, { organization: "Posada del Río", title: "General Manager", measuredOn: "RevPAR", from: "2026-09-15" }, NOW);
    expect(r.flagged).toBe(3);
    expect(r.newDoor).toMatch(/Posada del Río.*previously General Manager at Hacienda Tierra Roja/);

    const gm = (await withTenant(db, expert, (q) => getPerson(q, expert, DEMO.gm)))!;
    expect(gm.roles.filter((s) => s.to === null)).toEqual([expect.objectContaining({ organization: "Posada del Río", title: "General Manager" })]);
    expect(gm.roles.find((s) => s.organization === "Hacienda Tierra Roja")?.to).toBe("2026-09-15");
    expect(moveNudge(gm, NOW)?.kind).toBe("moved_role");

    const flagged = await withSystem(db, (q) => q.query<{ id: string }>("select id from knowledge_items where needs_review order by id"));
    expect(flagged.rows).toHaveLength(3);
    const expertNotices = await withTenant(db, expert, listNotices);
    expect(expertNotices.map((n) => n.kind).sort()).toEqual(["knowledge_review", "new_door"]);
    const backupNotices = await withTenant(db, backup, listNotices);
    expect(backupNotices.map((n) => n.kind)).toEqual(["knowledge_review"]);

    // The queued safety-net job re-runs the same move: nothing new is flagged or announced.
    expect(await drain(db, createHandlers({ llm: () => null, now: () => NOW }))).toBe(1);
    expect(await withTenant(db, expert, listNotices)).toHaveLength(2);
    const again = await flagDependentKnowledge(db, { workspaceId: DEMO.workspace, personId: DEMO.gm, moveId: "other", newDoor: "x", now: NOW });
    expect(again).toEqual([]);
  });

  it("refuses a move that starts before the current role, and hides private people from others", async () => {
    await expect(recordPersonMove(db, expert, DEMO.gm, { organization: "X", title: "GM", from: "2020-01-01" }, NOW)).rejects.toThrow(/must start after/);
    await expect(recordPersonMove(db, assistant, DEMO.gm, { organization: "X", title: "GM", from: "2026-09-01" }, NOW)).rejects.toThrow(/not found/);
  });
});

describe("reciprocity ledger", () => {
  it("checks the ledger before an ask and records overrides", async () => {
    // Seed: three upgrade asks to Rafael in 90 days and no recognition.
    await expect(logLedgerEntry(db, expert, { personId: DEMO.gm, kind: "favor_asked", at: NOW.toISOString(), askType: "upgrade", importance: "routine" }, NOW)).rejects.toBeInstanceOf(
      ChipAdviceError,
    );
    await expect(
      logLedgerEntry(db, expert, { personId: DEMO.gm, kind: "favor_asked", at: NOW.toISOString(), askType: "upgrade", importance: "routine" }, NOW),
    ).rejects.toMatchObject({ advice: { advice: "give_first" } });
    const critical = await logLedgerEntry(db, expert, { personId: DEMO.gm, kind: "favor_asked", at: NOW.toISOString(), askType: "sold_out_table", importance: "critical" }, NOW);
    expect(critical.advice?.advice).toBe("ask");
    const override = await logLedgerEntry(
      db,
      expert,
      { personId: DEMO.gm, kind: "favor_asked", at: NOW.toISOString(), askType: "late_checkout", importance: "important", acknowledgeAdvice: true },
      NOW,
    );
    expect(override.advice?.advice).toBe("give_first");
    const audits = await withSystem(db, (q) => q.query<{ data: { overrodeAdvice: boolean } }>("select data from audit_events where action = 'ledger.favor_asked' order by id"));
    expect(audits.rows.map((r) => r.data.overrodeAdvice)).toEqual([false, true]);

    await logLedgerEntry(db, expert, { personId: DEMO.gm, kind: "recognition_given", at: NOW.toISOString(), note: "Review naming Rafael" }, NOW);
    await logLedgerEntry(db, expert, { personId: DEMO.gm, kind: "business_sent", at: NOW.toISOString(), note: "Whitfields", roomNights: 5, revenueMinor: 1_475_000 }, NOW);
    const entries = await withTenant(db, expert, (q) => listLedger(q, DEMO.gm));
    expect(entries.find((e) => e.kind === "business_sent")).toMatchObject({ roomNights: 5, revenueMinor: 1_475_000 });
    await expect(logLedgerEntry(db, expert, { personId: DEMO.gm, kind: "favor_asked", at: NOW.toISOString() }, NOW)).rejects.toThrow(/matters/);
  });

  it("pre-call brief: open favors, mention/avoid from texture, ask timing", async () => {
    const gm = (await withTenant(db, expert, (q) => getPerson(q, expert, DEMO.gm)))!;
    const entries = await withTenant(db, expert, (q) => listLedger(q, DEMO.gm));
    const open = openFavors(entries, NOW);
    expect(open.map((o) => o.entry.note)).toEqual(["Upgrade for the Lius", "Upgrade + late checkout for the Whitfields"]);
    const brief = preCallBrief(gm, entries, NOW, { texture: gm.textureVisible, clientNames: [] });
    expect(brief.avoid).toContain("Dry humor; hates being rushed");
    expect(brief.mention).toContain("Mention his daughter's ceramics studio");
    expect(brief.avoid.some((a) => /over their head/.test(a))).toBe(true);
    expect(brief.askTiming.tooSoon).toBe(true);
    expect(askTiming(entries, NOW, "critical").tooSoon).toBe(false);
    // Without texture (not the owner) nothing personal leaks into the brief.
    const other = preCallBrief(gm, entries, NOW, { texture: null, clientNames: [] });
    expect(other.mention.join(" ")).not.toMatch(/ceramics/);
  });
});

describe("nudge drafts", () => {
  it("drafts with the agent (or a template), encrypted, for the owner only", async () => {
    const llm = fakeLLM({ subject: "Gracias, Rafael", body: "Querido Rafael, gracias por todo. Marisol" });
    const id = await draftNote(db, expert, DEMO.gm, "recognition_overdue", llm, NOW);
    const drafts = await withTenant(db, expert, (q) => listDrafts(q, expert, DEMO.gm));
    expect(drafts[0]).toMatchObject({ id, subject: "Gracias, Rafael", draftedBy: "agent" });
    const raw = await withSystem(db, (q) => q.query<{ body_sealed: string }>("select body_sealed from crm_note_drafts"));
    expect(raw.rows[0]!.body_sealed).not.toContain("gracias");
    await draftNote(db, expert, DEMO.gm, "going_cold", null, new Date(NOW.getTime() + 1000));
    expect((await withTenant(db, expert, (q) => listDrafts(q, expert, DEMO.gm)))[0]!.draftedBy).toBe("template");
    await expect(draftNote(db, backup, DEMO.concierge, "going_cold", null, NOW)).rejects.toThrow(/relationship holder/);
  });
});
