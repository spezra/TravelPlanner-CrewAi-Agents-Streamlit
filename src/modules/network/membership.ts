/**
 * The curated network: membership, discoverability profiles and search.
 *
 * A poorly matched member consumes expert attention, so membership is
 * curated: a workspace can apply, but only a platform operator admits or
 * removes (admitToNetwork / removeFromNetwork, run as app_system from
 * admit-cli.ts). Nothing here is self-serve admission.
 */
import type { Db, Queryable } from "@/db/client";
import { audit } from "@/db/repo";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import type { ContributionType } from "@/domain/collaboration";
import { DomainError } from "@/domain/common";
import { matchProfiles, type NetworkProfile, type NetworkQuery, type ProfileMatch, type ResponseCapacity } from "@/domain/networkSearch";
import { contactDetailsIn } from "./redact";
import { arr, iso, memberRole, str } from "./util";

export const CONTRIBUTIONS: readonly ContributionType[] = ["answer_question", "review_itinerary", "activate_relationship", "design_segment", "operate_segment"];

export type MembershipStatus = "none" | "applied" | "admitted" | "removed";

export interface Membership {
  status: MembershipStatus;
  requestedAt: string | null;
  admittedAt: string | null;
  removedAt: string | null;
}

export async function membership(q: Queryable): Promise<Membership> {
  const { rows } = await q.query<Record<string, unknown>>("select * from network_members where workspace_id = app_workspace()");
  const r = rows[0];
  if (!r) return { status: "none", requestedAt: null, admittedAt: null, removedAt: null };
  const status: MembershipStatus = r.removed_at ? "removed" : r.admitted_at ? "admitted" : "applied";
  return { status, requestedAt: iso(r.requested_at), admittedAt: iso(r.admitted_at), removedAt: iso(r.removed_at) };
}

/** A workspace owner or admin applies. Admission is decided by the platform, not here. */
export async function applyForMembership(db: Db, tenant: Tenant, note: string | null, now: Date): Promise<void> {
  await withTenant(db, tenant, async (q) => {
    const role = await memberRole(q, tenant.memberId);
    if (role !== "owner" && role !== "admin") throw new DomainError("forbidden", "Only a workspace owner or admin can apply to the network");
    const current = await membership(q);
    if (current.status !== "none") throw new DomainError("already_applied", `This workspace is already ${current.status === "applied" ? "waiting for a decision" : current.status}`);
    await q.query(
      "insert into network_members (workspace_id, requested_at, requested_by, application_note) values ($1, $2, $3, $4)",
      [tenant.workspaceId, now.toISOString(), tenant.memberId, note?.slice(0, 2000) ?? null],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "network.applied", tenant.workspaceId);
  });
}

/** Platform operation: admit a workspace. Idempotent for a current member; re-admits a removed one. */
export async function admitToNetwork(db: Db, workspaceId: string, by: { operator: string; note?: string | null }, now: Date): Promise<void> {
  if (!by.operator.trim()) throw new DomainError("no_operator", "Record which platform operator admitted the workspace");
  await withSystem(db, async (q) => {
    const { rows } = await q.query("select 1 from workspaces where id = $1", [workspaceId]);
    if (!rows.length) throw new DomainError("not_found", `Workspace ${workspaceId} not found`);
    await q.query(
      `insert into network_members (workspace_id, admitted_at, admitted_by, application_note) values ($1, $2, $3, $4)
       on conflict (workspace_id) do update set admitted_at = excluded.admitted_at, admitted_by = excluded.admitted_by,
         removed_at = null, removed_by = null, removal_reason = null
       where network_members.admitted_at is null or network_members.removed_at is not null`,
      [workspaceId, now.toISOString(), by.operator.trim(), by.note ?? null],
    );
    await audit(q, workspaceId, `platform:${by.operator.trim()}`, "network.admitted", workspaceId, { note: by.note ?? null });
  });
}

/**
 * Platform operation: remove a workspace. Its profiles and published network
 * knowledge disappear from other members immediately (RLS checks admission
 * on every read); collaborations already agreed continue under their terms.
 */
export async function removeFromNetwork(db: Db, workspaceId: string, by: { operator: string; reason: string }, now: Date): Promise<void> {
  await withSystem(db, async (q) => {
    const { rows } = await q.query(
      "update network_members set removed_at = $2, removed_by = $3, removal_reason = $4 where workspace_id = $1 and removed_at is null returning workspace_id",
      [workspaceId, now.toISOString(), by.operator.trim(), by.reason],
    );
    if (!rows.length) throw new DomainError("not_member", "That workspace isn't a current network member");
    await audit(q, workspaceId, `platform:${by.operator.trim()}`, "network.removed", workspaceId, { reason: by.reason });
  });
}

/** Platform view: applications waiting for a decision. */
export async function listApplications(db: Db): Promise<{ workspaceId: string; name: string; requestedAt: string | null; note: string | null }[]> {
  return withSystem(db, async (q) => {
    const { rows } = await q.query<Record<string, unknown>>(
      `select nm.workspace_id, w.name, nm.requested_at, nm.application_note from network_members nm join workspaces w on w.id = nm.workspace_id
        where nm.admitted_at is null and nm.removed_at is null order by nm.requested_at`,
    );
    return rows.map((r) => ({ workspaceId: String(r.workspace_id), name: String(r.name), requestedAt: iso(r.requested_at), note: str(r.application_note) }));
  });
}

// ---------------------------------------------------------------------------
// Profiles

export interface ProfileInput {
  displayName: string;
  headline: string | null;
  destinations: string[];
  capabilities: ContributionType[];
  languages: string[];
  responseCapacity: ResponseCapacity;
  discoverable: boolean;
}

function mapProfile(r: Record<string, unknown>): NetworkProfile & { discoverable: boolean; updatedAt: string | null } {
  return {
    memberId: String(r.member_id),
    workspaceId: String(r.workspace_id),
    displayName: String(r.display_name),
    headline: str(r.headline),
    destinations: arr(r.destinations),
    capabilities: arr<ContributionType>(r.capabilities),
    languages: arr(r.languages),
    responseCapacity: r.response_capacity as ResponseCapacity,
    discoverable: Boolean(r.discoverable),
    updatedAt: iso(r.updated_at),
  };
}

export async function myProfile(q: Queryable): Promise<ReturnType<typeof mapProfile> | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from network_profiles where member_id = app_member()");
  return rows[0] ? mapProfile(rows[0]) : null;
}

/** Discoverability carries no contact details or methods: they're refused, not silently stripped. */
export async function saveProfile(db: Db, tenant: Tenant, input: ProfileInput, now: Date): Promise<void> {
  const name = input.displayName.trim();
  if (!name) throw new DomainError("no_name", "Choose a display name");
  const contact = [name, input.headline ?? "", ...input.destinations, ...input.languages].flatMap((t) => contactDetailsIn(t));
  if (contact.length) throw new DomainError("contact_details", "Profiles can't include contact details, links or phone numbers; requests reach you through the platform");
  if (input.capabilities.some((c) => !CONTRIBUTIONS.includes(c))) throw new DomainError("bad_capability", "Unknown contribution type");
  await withTenant(db, tenant, async (q) => {
    await q.query(
      `insert into network_profiles (member_id, workspace_id, display_name, headline, destinations, capabilities, languages, response_capacity, discoverable, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (member_id) do update set display_name = excluded.display_name, headline = excluded.headline, destinations = excluded.destinations,
         capabilities = excluded.capabilities, languages = excluded.languages, response_capacity = excluded.response_capacity,
         discoverable = excluded.discoverable, updated_at = excluded.updated_at`,
      [
        tenant.memberId, tenant.workspaceId, name.slice(0, 120), input.headline?.trim().slice(0, 280) || null, JSON.stringify(input.destinations),
        JSON.stringify(input.capabilities), JSON.stringify(input.languages), input.responseCapacity, input.discoverable, now.toISOString(),
      ],
    );
    await audit(q, tenant.workspaceId, tenant.memberId, "network.profile_saved", tenant.memberId, { discoverable: input.discoverable });
  });
}

/** Profiles of other network members this workspace may see (RLS: both admitted, discoverable). */
export async function listNetworkProfiles(q: Queryable): Promise<NetworkProfile[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    "select * from network_profiles where workspace_id <> app_workspace() and discoverable order by display_name limit 500",
  );
  return rows.map(mapProfile);
}

export async function getNetworkProfile(q: Queryable, memberId: string): Promise<NetworkProfile | null> {
  const { rows } = await q.query<Record<string, unknown>>(
    "select * from network_profiles where member_id = $1 and workspace_id <> app_workspace() and discoverable",
    [memberId],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function searchNetwork(q: Queryable, query: NetworkQuery): Promise<ProfileMatch[]> {
  return matchProfiles(await listNetworkProfiles(q), query);
}
