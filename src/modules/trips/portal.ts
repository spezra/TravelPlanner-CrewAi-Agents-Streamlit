/**
 * Client portal links. The trip owner creates a revocable, expiring link for
 * the client; only the sha256 of the token is stored. A request with the
 * token is resolved as the platform (app_system) to find which trip it opens,
 * then everything is read as the trip owner (app_user, RLS-bound) and passed
 * through the portal allow-list in src/domain/portal.ts.
 */
import { randomUUID } from "node:crypto";
import { DomainError } from "@/domain/common";
import { buildPortalView, type PortalView } from "@/domain/portal";
import { latestSentProposal } from "@/modules/proposals/service";
import type { Db } from "@/db/client";
import * as coreRepo from "@/db/repo";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import { config } from "@/server/config";
import { newToken, sha256 } from "@/server/crypto";
import { hit } from "@/server/rateLimit";
import * as repo from "./repo";

export const MAX_PORTAL_DAYS = 180;

/** Cookie that carries a new link to the owner's page once (the token is never stored in clear). */
export const PORTAL_FLASH_COOKIE = "portal_link_once";

export function portalUrl(token: string): string {
  return `${config().APP_URL.replace(/\/$/, "")}/portal/${token}`;
}

export function createPortalLink(
  db: Db,
  tenant: Tenant,
  input: { tripId: string; label: string | null; days: number },
  now: Date,
): Promise<{ token: string; url: string; expiresAt: string }> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_PORTAL_DAYS) {
    throw new DomainError("bad_input", `Links last between 1 and ${MAX_PORTAL_DAYS} days`);
  }
  return withTenant(db, tenant, async (q) => {
    const trip = await coreRepo.getTrip(q, input.tripId);
    if (!trip) throw new DomainError("not_found", "Trip not found");
    if (trip.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the trip owner can share the trip with the client");
    if (!trip.clientId) throw new DomainError("no_client", "Add the client to the trip before sharing it");
    const token = newToken();
    const expiresAt = new Date(now.getTime() + input.days * 86_400_000).toISOString();
    const id = randomUUID();
    await repo.insertPortalLink(q, tenant.workspaceId, { id, tripId: trip.id, tokenHash: sha256(token), createdBy: tenant.memberId, label: input.label?.trim() || null, expiresAt });
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "portal.link_created", trip.id, { linkId: id, expiresAt });
    return { token, url: portalUrl(token), expiresAt };
  });
}

export function revokePortalLink(db: Db, tenant: Tenant, tripId: string, linkId: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const trip = await coreRepo.getTrip(q, tripId);
    if (!trip) throw new DomainError("not_found", "Trip not found");
    if (trip.ownerId !== tenant.memberId) throw new DomainError("forbidden", "Only the trip owner can revoke client links");
    if (!(await repo.revokePortalLink(q, tripId, linkId, now))) throw new DomainError("not_found", "Link not found or already revoked");
    await coreRepo.audit(q, tenant.workspaceId, tenant.memberId, "portal.link_revoked", tripId, { linkId });
  });
}

export interface PortalAccess {
  linkId: string;
  tripId: string;
  /** The trip owner; portal reads run with exactly their visibility. */
  owner: Tenant;
}

/**
 * Resolve a token to a trip. Null for unknown, revoked or expired tokens, and
 * for links whose creator no longer owns the trip or has left the workspace.
 */
export async function resolvePortalToken(db: Db, token: string, now: Date): Promise<PortalAccess | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return withSystem(db, async (q) => {
    const link = await repo.findPortalLinkSystem(q, sha256(token));
    if (!link || link.revokedAt || new Date(link.expiresAt) <= now) return null;
    const { rows } = await q.query<{ owner_id: string }>(
      `select t.owner_id from trips t join members m on m.id = t.owner_id
        where t.id = $1 and t.workspace_id = $2 and m.disabled_at is null`,
      [link.tripId, link.workspaceId],
    );
    if (!rows[0] || String(rows[0].owner_id) !== link.createdBy) return null;
    await repo.touchPortalLinkSystem(q, link.id, now);
    return { linkId: link.id, tripId: link.tripId, owner: { workspaceId: link.workspaceId, memberId: link.createdBy } };
  });
}

/** Per-IP limit on portal requests, so tokens can't be probed at volume. */
export async function portalRateLimit(db: Db, ip: string | null, now: Date): Promise<boolean> {
  if (!ip) return true;
  return withSystem(db, (q) => hit(q, `portal:${ip}`, 120, 60, now));
}

export async function loadPortal(db: Db, token: string, now: Date): Promise<{ access: PortalAccess; view: PortalView } | null> {
  const access = await resolvePortalToken(db, token, now);
  if (!access) return null;
  const view = await withTenant(db, access.owner, async (q) => {
    const trip = await coreRepo.getTrip(q, access.tripId);
    if (!trip) return null;
    const [items, approvals, acceptances] = await Promise.all([
      coreRepo.listItems(q, trip.id),
      coreRepo.listApprovals(q, { tripId: trip.id }),
      repo.listAcceptances(q, trip.id),
    ]);
    const { rows: ws } = await q.query<{ name: string }>("select name from workspaces where id = $1", [access.owner.workspaceId]);
    const advisor = await repo.getMember(q, trip.ownerId);
    return buildPortalView({
      trip,
      agencyName: ws[0]?.name ?? "Your travel advisor",
      advisor: { name: advisor?.name ?? trip.ownerName, email: advisor?.email ?? "" },
      items,
      approvals,
      acceptances,
      document: await latestSentProposal(q, trip.id),
      now,
    });
  });
  return view ? { access, view } : null;
}

/**
 * The client accepts a proposal. This records their go-ahead against the exact
 * terms shown; it does not approve spend. The expert's approval is still what
 * lets anything be booked or charged.
 */
export async function acceptProposal(db: Db, token: string, input: { approvalId: string; acceptedName: string }, now: Date): Promise<void> {
  const name = input.acceptedName.trim();
  if (name.length < 2 || name.length > 120) throw new DomainError("bad_input", "Type your full name to accept");
  const access = await resolvePortalToken(db, token, now);
  if (!access) throw new DomainError("link_invalid", "This link is no longer valid. Please ask your advisor for a new one.");
  const allowed = await withSystem(db, (q) => hit(q, `portal_accept:${access.linkId}`, 20, 3600, now));
  if (!allowed) throw new DomainError("rate_limited", "Too many attempts. Please try again later.");
  await withTenant(db, access.owner, async (q) => {
    const a = await coreRepo.getApproval(q, input.approvalId);
    if (!a || a.tripId !== access.tripId) throw new DomainError("not_found", "That proposal isn't part of this trip");
    if (a.status !== "pending") throw new DomainError("not_open", "That proposal is no longer open");
    if (new Date(a.terms.offerExpiresAt) <= now) throw new DomainError("offer_expired", "That offer has expired. Your advisor will send an updated one.");
    const inserted = await repo.insertAcceptance(q, access.owner.workspaceId, {
      id: randomUUID(),
      approvalId: a.id,
      tripId: a.tripId,
      portalLinkId: access.linkId,
      acceptedName: name,
      termsFingerprint: a.termsFingerprint,
      priceMinor: a.terms.price.amountMinor,
      currency: a.terms.price.currency,
      now,
    });
    if (!inserted) throw new DomainError("already_accepted", "You've already accepted this proposal");
    await coreRepo.audit(q, access.owner.workspaceId, "client:portal", "approval.client_accepted", a.id, { linkId: access.linkId, price: a.terms.price });
  });
}
