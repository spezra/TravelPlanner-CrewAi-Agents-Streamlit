import { describe, expect, it } from "vitest";
import { DEMO } from "@/db/seed";
import { withSystem } from "@/db/tenant";
import { attentionQueue } from "@/services/operations";
import { NOW, useDb } from "./helpers/db";

const getDb = useDb();
const members = {
  expert: { workspaceId: DEMO.workspace, memberId: DEMO.expert },
  assistant: { workspaceId: DEMO.workspace, memberId: DEMO.assistant },
  backup: { workspaceId: DEMO.workspace, memberId: DEMO.backup },
  camille: { workspaceId: DEMO.otherWorkspace, memberId: DEMO.otherExpert },
};

describe("Today pulls decisions from every area", () => {
  it("every source runs under row-level security for every kind of member", async () => {
    for (const t of Object.values(members)) await expect(attentionQueue(getDb(), t, NOW)).resolves.toBeInstanceOf(Array);
  });

  it("shows the expert their inbox suggestions and the specialist their collaboration request", async () => {
    const expert = await attentionQueue(getDb(), members.expert, NOW);
    expect(expert.find((i) => i.kind === "inbox")).toMatchObject({ href: "/inbox" });
    const camille = await attentionQueue(getDb(), members.camille, NOW);
    expect(camille.some((i) => i.kind === "collaboration" && i.href?.startsWith("/collaborations/"))).toBe(true);
    // Nothing from another workspace leaks into anyone's queue.
    expect(camille.some((i) => i.tripId === DEMO.trip)).toBe(false);
  });

  it("an unhappy client comes first and a client-accepted approval jumps the queue", async () => {
    const db = getDb();
    await withSystem(db, async (q) => {
      await q.query(
        "insert into escalations (id, workspace_id, trip_id, source_key, kind, title, detail, raised_at, raised_by) values (gen_random_uuid(), $1, $2, 'unhappy:1', 'unhappy_client', 'The Whitfields are unhappy with the transfer', '', $3, 'member')",
        [DEMO.workspace, DEMO.trip, NOW.toISOString()],
      );
      await q.query(
        "insert into approval_client_acceptances (id, workspace_id, approval_id, trip_id, accepted_name, terms_fingerprint, price_minor, currency, accepted_at) values (gen_random_uuid(), $1, $2, $3, 'Priya Whitfield', 'fp', 1475000, 'USD', $4)",
        [DEMO.workspace, DEMO.approvalOaxaca, DEMO.trip, NOW.toISOString()],
      );
    });
    const q = await attentionQueue(db, members.expert, NOW);
    expect(q.filter((i) => i.urgencyMinutes === 0).map((i) => i.kind)).toEqual(expect.arrayContaining(["unhappy_client", "approval"]));
    expect(q.find((i) => i.kind === "approval")!.context).toMatch(/client has accepted/);
  });

  it("payout approvals reach owners only", async () => {
    const db = getDb();
    await withSystem(db, (q) => q.query("insert into money_payout_batches (workspace_id, currency, prepared_by) values ($1, 'USD', $2)", [DEMO.workspace, DEMO.assistant]));
    expect((await attentionQueue(db, members.expert, NOW)).some((i) => i.kind === "payout")).toBe(true);
    expect((await attentionQueue(db, members.assistant, NOW)).some((i) => i.kind === "payout")).toBe(false);
  });
});

describe("retention has one source of truth", () => {
  it("raw-audio retention saved in admin is what the calls purge enforces, and vice versa", async () => {
    const { getSettings, updateSettings } = await import("@/modules/ops/admin");
    const { getCallSettings } = await import("@/modules/calls/settings");
    const { withTenant } = await import("@/db/tenant");
    const db = getDb();
    const s = await getSettings(db, members.expert);
    await updateSettings(db, members.expert, { name: s.name, dataRegion: s.dataRegion, bookPortability: s.bookPortability, retention: { ...s.retention, rawAudioDays: 12 } });
    const calls = await withTenant(db, members.expert, (q) => getCallSettings(q));
    expect(calls.audioRetentionDays).toBe(12);
    await withSystem(db, (q) => q.query("update call_settings set audio_retention_days = 45 where workspace_id = $1", [DEMO.workspace]));
    expect((await getSettings(db, members.expert)).retention.rawAudioDays).toBe(45);
  });
});

describe("workspace export covers every area", () => {
  it("decrypts every encrypted field the requester can see and never exports credentials", async () => {
    const { buildWorkspaceExport } = await import("@/modules/ops/exports");
    const { withTenant } = await import("@/db/tenant");
    const db = getDb();
    const data = await withTenant(db, members.expert, (q) => buildWorkspaceExport(q, DEMO.workspace));
    const unreadable: string[] = [];
    for (const [table, rows] of Object.entries(data)) {
      for (const row of rows) for (const [col, v] of Object.entries(row)) if (v && typeof v === "object" && (v as { readable?: boolean }).readable === false) unreadable.push(`${table}.${col}`);
    }
    expect(unreadable).toEqual([]);
    expect(data.person_texture?.length).toBeGreaterThan(0);
    expect(String(data.person_texture![0]!.content)).toMatch(/hates being rushed|humor/i);
    expect(data.inbound_messages?.every((m) => typeof m.body === "string")).toBe(true);
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/access_token|refresh_token|wrapped_key|token_hash/);
  });
});

describe("erasure reaches every area", () => {
  it("erasing a supplier contact removes their CRM texture, drafts, emails and client ties", async () => {
    const { recordRequest, fulfilDeletion } = await import("@/modules/ops/privacy");
    const { MemoryStore } = await import("@/server/storage");
    const db = getDb();
    const before = await withSystem(db, (q) => q.query<{ n: number }>("select count(*)::int as n from person_texture where person_id = $1", [DEMO.gm]));
    expect(before.rows[0]!.n).toBe(1);
    const id = await recordRequest(db, members.expert, { subjectType: "person", subjectId: DEMO.gm, kind: "deletion", receivedAt: NOW.toISOString(), note: null });
    const counts = await fulfilDeletion(db, new MemoryStore(), members.expert, id, NOW);
    expect(counts).toMatchObject({ person: 1, texture: 1 });
    const left = await withSystem(db, async (q) => ({
      texture: (await q.query("select 1 from person_texture where person_id = $1", [DEMO.gm])).rows.length,
      ties: (await q.query("select 1 from person_clients where person_id = $1", [DEMO.gm])).rows.length,
      emails: (await q.query<{ emails: string[] }>("select emails from people where id = $1", [DEMO.gm])).rows[0]!.emails,
      ledgerRows: (await q.query("select 1 from ledger_entries where person_id = $1", [DEMO.gm])).rows.length,
    }));
    expect(left).toMatchObject({ texture: 0, ties: 0, emails: [] });
    expect(left.ledgerRows).toBeGreaterThan(0); // amounts and kinds stay so totals are unchanged
  });
});

describe("agreed collaboration fees flow into money", () => {
  it("records the agreed fee lines as the booking's draft split, for the requester only", async () => {
    const collab = await import("@/modules/network/collaborations");
    const { recordCollaborationSplit } = await import("@/modules/integration/collaborationMoney");
    const { NETWORK_DEMO } = await import("@/modules/network/seed");
    const { MONEY_DEMO } = await import("@/modules/money/seed");
    const { withTenant } = await import("@/db/tenant");
    const db = getDb();
    const id = NETWORK_DEMO.collaboration;
    await withSystem(db, (q) => q.query("update collaborations set trip_id = $2 where id = $1", [id, DEMO.trip]));
    await collab.respondToRequest(db, members.camille, id, "accept", null, NOW);
    await collab.proposeTerms(
      db,
      members.expert,
      id,
      {
        finalRecommendationOwner: "requester",
        delegatedDecisions: [],
        changesRequiringSpecialistReview: [],
        deliveryOwners: [],
        attributionRule: "never",
        specialistVisibleToClient: false,
        fees: [{ kind: "commission_split", payee: "specialist", amount: null, commissionShareBps: 2500, bookingItemIds: [DEMO.hotelOaxaca] }],
        nonSolicit: true,
        clientAccessExpiresAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
        reversalLossBearer: "requester",
        notes: null,
      },
      NOW,
    );
    const v = (await withTenant(db, members.camille, (q) => collab.listTerms(q, id))).at(-1)!;
    await collab.acceptTerms(db, members.camille, id, v.version, v.fingerprint, NOW);

    const input = { collaborationId: id, itemId: DEMO.hotelOaxaca, specialistRecipientId: MONEY_DEMO.specialistRecipient, hostRulesOurs: "permitted" as const, hostRulesTheirs: "permitted" as const };
    await expect(recordCollaborationSplit(db, members.camille, input)).rejects.toThrow(/requesting workspace/);
    const split = await recordCollaborationSplit(db, members.expert, input);
    expect(split).toMatchObject({ status: "draft", reversalLossBearer: "owner_workspace" });
    expect(split.shares).toEqual(expect.arrayContaining([expect.objectContaining({ recipientId: MONEY_DEMO.specialistRecipient, bps: 2500 })]));
    await expect(recordCollaborationSplit(db, members.expert, { ...input, itemId: DEMO.hotelCdmx })).rejects.toThrow(/no fee lines for this booking/);
  });
});
