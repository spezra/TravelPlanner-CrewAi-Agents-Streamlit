/**
 * Inbound email: a per-workspace address (in+<token>@<domain>) receives
 * forwarded supplier and client mail through a Postmark-style webhook. Each
 * message is stored encrypted, deduplicated by Message-ID, and parsed by an
 * agent into suggestions. Nothing but "this message arrived" is recorded until
 * a member accepts a suggestion.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "@/db/client";
import { audit, getItem, insertCommitment, updateItemState } from "@/db/repo";
import { withSystem, withTenant, type Tenant } from "@/db/tenant";
import type { Perk } from "@/domain/bookings";
import { DomainError } from "@/domain/common";
import { reviewRouting, type Commitment } from "@/domain/commitments";
import {
  attachConfirmation,
  inboundSuggestions,
  normalizeAddress,
  parseAddress,
  parseAddressList,
  type CandidateItem,
  type ParsedInbound,
  type SuggestionDraft,
} from "@/domain/crmIngest";
import { parseInboundEmail } from "@/agents/confirmationParser";
import type { StructuredLLM } from "@/agents/llm";
import { decryptFor, encryptFor, safeEqual } from "@/server/crypto";
import { enqueue, enqueueAsTenant, PermanentJobError } from "@/server/jobs/queue";
import { log } from "@/server/log";
import type { BlobStore } from "@/server/storage";
import { createPersonTx, getPerson, logLedgerEntryTx, mergeIntoPersonTx } from "./people";

// ---------------------------------------------------------------------------
// Addresses

/** INBOUND_EMAIL_DOMAIN, else the APP_URL host. */
export function inboundDomain(appUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env.INBOUND_EMAIL_DOMAIN || new URL(appUrl).hostname).toLowerCase();
}

export const inboundAddress = (token: string, domain: string) => `in+${token}@${domain}`;
const newRouteToken = () => randomBytes(10).toString("hex");

/** The workspace's route, created on first use. */
export async function ensureInboundRoute(db: Db, tenant: Tenant): Promise<{ token: string; defaultMemberId: string }> {
  return withTenant(db, tenant, async (q) => {
    const existing = await q.query<{ token: string; default_member_id: string }>("select token, default_member_id from inbound_routes");
    if (existing.rows[0]) return { token: existing.rows[0].token, defaultMemberId: existing.rows[0].default_member_id };
    const token = newRouteToken();
    await q.query("insert into inbound_routes (workspace_id, token, default_member_id) values ($1, $2, $3) on conflict (workspace_id) do nothing", [
      tenant.workspaceId,
      token,
      tenant.memberId,
    ]);
    const { rows } = await q.query<{ token: string; default_member_id: string }>("select token, default_member_id from inbound_routes");
    await audit(q, tenant.workspaceId, tenant.memberId, "inbound.route_created", tenant.workspaceId);
    return { token: rows[0]!.token, defaultMemberId: rows[0]!.default_member_id };
  });
}

/** A leaked address is replaced; mail to the old one stops being accepted. */
export function rotateInboundRoute(db: Db, tenant: Tenant, now: Date): Promise<string> {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query<{ role: string }>("select role from members where id = $1", [tenant.memberId]);
    if (rows[0]?.role !== "owner" && rows[0]?.role !== "admin") throw new DomainError("forbidden", "Only workspace owners and admins can change the inbound address");
    const token = newRouteToken();
    const r = await q.query("update inbound_routes set token = $1, rotated_at = $2 returning workspace_id", [token, now.toISOString()]);
    if (!r.rows[0]) throw new DomainError("not_found", "No inbound address yet");
    await audit(q, tenant.workspaceId, tenant.memberId, "inbound.route_rotated", tenant.workspaceId);
    return token;
  });
}

// ---------------------------------------------------------------------------
// Webhook

const PostmarkAddress = z.object({ Email: z.string(), Name: z.string().nullish(), MailboxHash: z.string().nullish() });
export const InboundPayload = z.object({
  From: z.string().min(3),
  FromName: z.string().nullish(),
  FromFull: PostmarkAddress.nullish(),
  To: z.string().nullish(),
  ToFull: z.array(PostmarkAddress).nullish(),
  Cc: z.string().nullish(),
  CcFull: z.array(PostmarkAddress).nullish(),
  OriginalRecipient: z.string().nullish(),
  Subject: z.string().nullish(),
  MessageID: z.string().min(1).max(998),
  Date: z.string().nullish(),
  TextBody: z.string().nullish(),
  HtmlBody: z.string().nullish(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).nullish(),
  Attachments: z
    .array(z.object({ Name: z.string().max(255), Content: z.string(), ContentType: z.string().max(255), ContentLength: z.number().int().nonnegative().optional() }))
    .max(20)
    .nullish(),
});
export type InboundPayload = z.infer<typeof InboundPayload>;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_INBOUND_REQUEST_BYTES = 40 * 1024 * 1024;

/** HTTP Basic (any username, secret as password) or ?secret=, compared in constant time. */
export function inboundAuthorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const q = new URL(req.url).searchParams.get("secret");
  if (q !== null) return safeEqual(q, secret);
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("basic ")) return false;
  const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 && safeEqual(decoded.slice(colon + 1), secret);
}

/** Pulls the route token out of any recipient `in+<token>@<domain>`. */
export function routeTokens(p: InboundPayload, domain: string | null): string[] {
  const addrs = [
    ...parseAddressList(p.To),
    ...parseAddressList(p.Cc),
    ...parseAddressList(p.OriginalRecipient),
    ...(p.ToFull ?? []).map((a) => ({ email: normalizeAddress(a.Email), name: null })),
    ...(p.CcFull ?? []).map((a) => ({ email: normalizeAddress(a.Email), name: null })),
  ];
  const out = new Set<string>();
  for (const a of addrs) {
    const m = /^in\+([a-z0-9]{8,64})@(.+)$/.exec(a.email);
    if (m && (!domain || m[2] === domain)) out.add(m[1]!);
  }
  return [...out];
}

/** HTML-only mail: keep the words, drop the markup. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type IngestResult = { status: "stored"; id: string } | { status: "duplicate"; id: string } | { status: "unknown_address" };

/**
 * Store an inbound message for the workspace its recipient address names.
 * Runs as a platform step (no member session); it establishes the workspace
 * from the route token and files the message for the forwarding member if the
 * sender is one, else for the route's default member.
 */
export async function ingestInboundEmail(db: Db, payload: InboundPayload, deps: { domain: string | null; blobs: BlobStore; now: Date }): Promise<IngestResult> {
  const tokens = routeTokens(payload, deps.domain);
  if (!tokens.length) return { status: "unknown_address" };
  const from = parseAddress(payload.FromFull?.Email ?? payload.From);
  if (!from) throw new DomainError("bad_payload", "Unreadable From address");
  const fromName = payload.FromFull?.Name || payload.FromName || from.name;
  const uploaded: string[] = [];
  try {
    return await withSystem(db, async (q) => {
      const route = await q.query<{ workspace_id: string; token: string; default_member_id: string }>(
        "select workspace_id, token, default_member_id from inbound_routes where token = any($1::text[]) limit 1",
        [tokens],
      );
      const r = route.rows[0];
      if (!r) return { status: "unknown_address" as const };
      const ws = r.workspace_id;
      const dup = await q.query<{ id: string }>("select id from inbound_messages where workspace_id = $1 and message_id = $2", [ws, payload.MessageID]);
      if (dup.rows[0]) return { status: "duplicate" as const, id: dup.rows[0].id };

      const forwarder = await q.query<{ id: string }>("select id from members where workspace_id = $1 and lower(email) = $2 and disabled_at is null", [ws, from.email]);
      const ownerId = forwarder.rows[0]?.id ?? r.default_member_id;
      const id = randomUUID();
      const text = payload.TextBody?.trim() ? payload.TextBody : payload.HtmlBody ? htmlToText(payload.HtmlBody) : "";
      const parsedDate = payload.Date ? new Date(payload.Date) : null;
      const receivedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : deps.now;

      const attachments: { name: string; contentType: string; size: number; key: string | null; skipped?: string }[] = [];
      let total = 0;
      for (const [i, a] of (payload.Attachments ?? []).entries()) {
        const bytes = Buffer.from(a.Content, "base64");
        total += bytes.length;
        if (bytes.length > MAX_ATTACHMENT_BYTES || total > MAX_TOTAL_ATTACHMENT_BYTES) {
          attachments.push({ name: a.Name, contentType: a.ContentType, size: bytes.length, key: null, skipped: "too large" });
          continue;
        }
        const key = `inbound/${ws}/${id}/${i}`;
        const sealed = await encryptFor(q, ws, `blob:${key}`, bytes);
        await deps.blobs.put(key, Buffer.from(sealed, "utf8"), "application/octet-stream");
        uploaded.push(key);
        attachments.push({ name: a.Name, contentType: a.ContentType, size: bytes.length, key });
      }

      const ins = await q.query<{ id: string }>(
        `insert into inbound_messages (id, workspace_id, owner_id, scope, message_id, from_address, from_name, to_address, received_at,
           subject_sealed, body_sealed, attachments, parse_status)
         values ($1,$2,$3,'workspace',$4,$5,$6,$7,$8,$9,$10,$11,'queued')
         on conflict (workspace_id, message_id) do nothing returning id`,
        [
          id, ws, ownerId, payload.MessageID, from.email, fromName ?? null, inboundAddress(r.token, deps.domain ?? "unknown"), receivedAt.toISOString(),
          await encryptFor(q, ws, `inbound_subject:${id}`, payload.Subject ?? ""),
          await encryptFor(q, ws, `inbound_body:${id}`, text),
          JSON.stringify(attachments),
        ],
      );
      if (!ins.rows[0]) {
        const again = await q.query<{ id: string }>("select id from inbound_messages where workspace_id = $1 and message_id = $2", [ws, payload.MessageID]);
        for (const k of uploaded.splice(0)) await deps.blobs.delete(k).catch(() => undefined);
        return { status: "duplicate" as const, id: again.rows[0]?.id ?? "" };
      }
      await enqueue(q, { kind: "crm.parse_inbound", payload: { messageId: id }, tenant: { workspaceId: ws, memberId: ownerId }, dedupeKey: `crm.parse_inbound:${id}` });
      await audit(q, ws, "system:inbound_email", "inbound.received", id, { attachments: attachments.length });
      return { status: "stored" as const, id };
    });
  } catch (err) {
    for (const k of uploaded) await deps.blobs.delete(k).catch(() => undefined);
    throw err;
  }
}

/** The route handler's logic, framework-free so tests can call it with a Request. */
export async function handleInboundWebhook(req: Request, deps: { db: Db; secret: string | undefined; domain: string | null; blobs: BlobStore; now: Date }): Promise<Response> {
  if (!deps.secret) return new Response("Inbound email is not configured", { status: 503 });
  if (!inboundAuthorized(req, deps.secret)) return new Response("Unauthorized", { status: 401 });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_INBOUND_REQUEST_BYTES) return new Response("Payload too large", { status: 413 });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const parsed = InboundPayload.safeParse(json);
  if (!parsed.success) return new Response("Invalid payload", { status: 400 });
  try {
    const r = await ingestInboundEmail(deps.db, parsed.data, deps);
    if (r.status === "unknown_address") return new Response("Unknown recipient", { status: 404 });
    // 200 for duplicates too, so the sender stops retrying.
    return Response.json(r);
  } catch (err) {
    if (err instanceof DomainError) return new Response(err.message, { status: 400 });
    log.error({ err: err instanceof Error ? err.message : String(err) }, "inbound email failed");
    return new Response("Error", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Parsing

export interface InboundMessage {
  id: string;
  ownerId: string;
  messageId: string;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string;
  subject: string;
  body: string;
  attachments: { name: string; contentType: string; size: number; key: string | null; skipped?: string }[];
  parseStatus: "queued" | "parsed" | "manual" | "failed";
  classification: ParsedInbound["classification"] | null;
  parseError: string | null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

async function mapMessage(q: Queryable, workspaceId: string, r: Record<string, unknown>, withBody: boolean): Promise<InboundMessage> {
  const id = String(r.id);
  return {
    id,
    ownerId: String(r.owner_id),
    messageId: String(r.message_id),
    fromAddress: String(r.from_address),
    fromName: (r.from_name as string | null) ?? null,
    receivedAt: iso(r.received_at),
    subject: await decryptFor(q, workspaceId, `inbound_subject:${id}`, String(r.subject_sealed)),
    body: withBody ? await decryptFor(q, workspaceId, `inbound_body:${id}`, String(r.body_sealed)) : "",
    attachments: (r.attachments as InboundMessage["attachments"]) ?? [],
    parseStatus: r.parse_status as InboundMessage["parseStatus"],
    classification: (r.classification as InboundMessage["classification"]) ?? null,
    parseError: (r.parse_error as string | null) ?? null,
  };
}

export async function listInbound(q: Queryable, tenant: Tenant, limit = 50): Promise<InboundMessage[]> {
  const { rows } = await q.query<Record<string, unknown>>("select * from inbound_messages order by received_at desc limit $1", [limit]);
  const out: InboundMessage[] = [];
  for (const r of rows) out.push(await mapMessage(q, tenant.workspaceId, r, false));
  return out;
}

export async function getInbound(q: Queryable, tenant: Tenant, id: string): Promise<InboundMessage | null> {
  const { rows } = await q.query<Record<string, unknown>>("select * from inbound_messages where id = $1", [id]);
  return rows[0] ? mapMessage(q, tenant.workspaceId, rows[0], true) : null;
}

async function candidateItems(q: Queryable): Promise<CandidateItem[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select i.id, i.trip_id, t.title as trip_title, i.title, i.supplier_name, i.state, i.starts_at, i.confirmation_ref
       from trip_items i join trips t on t.id = i.trip_id
      where i.state in ('booking', 'outcome_unknown', 'confirmed') order by i.starts_at nulls last limit 500`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    tripId: String(r.trip_id),
    tripTitle: String(r.trip_title),
    title: String(r.title),
    supplierName: (r.supplier_name as string | null) ?? null,
    state: r.state as CandidateItem["state"],
    startsAt: r.starts_at == null ? null : iso(r.starts_at),
    confirmationRef: (r.confirmation_ref as string | null) ?? null,
  }));
}

export async function insertSuggestions(
  q: Queryable,
  tenant: Tenant,
  meta: { ownerId: string; scope: "private" | "workspace"; source: "inbound_email" | "google_import"; messageId: string | null },
  drafts: readonly SuggestionDraft[],
  opts: { refreshPending?: boolean } = {},
): Promise<number> {
  let n = 0;
  for (const d of drafts) {
    const { rows } = await q.query<{ id: string }>(
      `insert into crm_suggestions (id, workspace_id, owner_id, scope, source, message_id, kind, payload, dedupe_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (workspace_id, dedupe_key) do ${opts.refreshPending ? "update set payload = excluded.payload, updated_at = now() where crm_suggestions.status = 'pending'" : "nothing"}
       returning id`,
      [randomUUID(), tenant.workspaceId, meta.ownerId, meta.scope, meta.source, meta.messageId, d.kind, JSON.stringify(d.payload), d.dedupeKey],
    );
    n += rows.length;
  }
  return n;
}

/**
 * crm.parse_inbound. Idempotent: a message already parsed is left alone, and
 * suggestions are keyed per message so a re-run inserts nothing twice. With no
 * agent configured the message is marked for manual handling and only the
 * sender-based suggestions are made.
 */
export async function parseInboundJob(db: Db, tenant: Tenant, messageId: string, llm: StructuredLLM | null, now: Date): Promise<void> {
  const msg = await withTenant(db, tenant, async (q) => {
    const m = await getInbound(q, tenant, messageId);
    if (!m) throw new PermanentJobError(`Inbound message ${messageId} not visible`);
    return m;
  });
  if (msg.parseStatus === "parsed" || msg.parseStatus === "manual") return;

  let parsed: ParsedInbound | null = null;
  let parseError: string | null = null;
  if (llm) {
    const r = await parseInboundEmail(llm, { from: msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress, subject: msg.subject, body: msg.body });
    if (r.ok) parsed = r.parsed;
    else parseError = r.error;
  }

  await withTenant(db, tenant, async (q) => {
    const members = await q.query<{ email: string }>("select email from members");
    const people = await q.query<{ id: string; name: string; emails: string[] }>("select id, name, emails from people");
    const drafts = inboundSuggestions({
      messageId: msg.id,
      sender: { email: msg.fromAddress, name: msg.fromName },
      receivedAt: msg.receivedAt,
      subject: msg.subject,
      parsed,
      memberEmails: members.rows.map((m) => m.email),
      people: people.rows.map((p) => ({ id: p.id, name: p.name, emails: p.emails ?? [] })),
      items: await candidateItems(q),
    });
    // Built from the owner's own view (their private trips and contacts included), so only the owner sees them.
    const created = await insertSuggestions(q, tenant, { ownerId: msg.ownerId, scope: "private", source: "inbound_email", messageId: msg.id }, drafts);
    const status = parsed ? "parsed" : llm ? "failed" : "manual";
    await q.query("update inbound_messages set parse_status = $2, classification = $3, parse_error = $4, parsed_at = $5 where id = $1", [
      msg.id,
      status,
      parsed?.classification ?? null,
      parseError,
      now.toISOString(),
    ]);
    await audit(q, tenant.workspaceId, "agent:inbound_parser", "inbound.parsed", msg.id, { status, classification: parsed?.classification ?? null, suggestions: created });
  });
}

/** Re-run parsing for a message whose parse failed (e.g. the agent was unavailable). */
export function requeueParse(db: Db, tenant: Tenant, messageId: string, now: Date): Promise<void> {
  return withTenant(db, tenant, async (q) => {
    const r = await q.query("update inbound_messages set parse_status = 'queued', parse_error = null where id = $1 and parse_status in ('failed', 'manual') returning id", [messageId]);
    if (!r.rows[0]) throw new DomainError("not_found", "Nothing to re-parse");
    await enqueueAsTenant(q, { kind: "crm.parse_inbound", payload: { messageId }, dedupeKey: `crm.parse_inbound:${messageId}:${now.getTime()}` });
  });
}

// ---------------------------------------------------------------------------
// Suggestions

export interface Suggestion {
  id: string;
  ownerId: string;
  source: "inbound_email" | "google_import";
  messageId: string | null;
  kind: SuggestionDraft["kind"];
  payload: Record<string, unknown>;
  status: "pending" | "accepted" | "dismissed";
  result: Record<string, unknown> | null;
  createdAt: string;
}

function mapSuggestion(r: Record<string, unknown>): Suggestion {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    source: r.source as Suggestion["source"],
    messageId: r.message_id ? String(r.message_id) : null,
    kind: r.kind as Suggestion["kind"],
    payload: (r.payload ?? {}) as Record<string, unknown>,
    status: r.status as Suggestion["status"],
    result: (r.result as Record<string, unknown> | null) ?? null,
    createdAt: iso(r.created_at),
  };
}

export async function listSuggestions(q: Queryable, filter: { source?: Suggestion["source"]; status?: Suggestion["status"]; messageId?: string; limit?: number } = {}): Promise<Suggestion[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.source) where.push(`source = $${params.push(filter.source)}`);
  if (filter.status) where.push(`status = $${params.push(filter.status)}`);
  if (filter.messageId) where.push(`message_id = $${params.push(filter.messageId)}`);
  const { rows } = await q.query<Record<string, unknown>>(
    `select * from crm_suggestions ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc, kind limit ${Math.min(filter.limit ?? 200, 1000)}`,
    params,
  );
  return rows.map(mapSuggestion);
}

export const AcceptChoice = z.object({
  itemId: z.string().uuid().nullish(),
  personId: z.string().uuid().nullish(),
});

async function personByEmail(q: Queryable, email: string): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>("select id from people where $1 = any(emails) limit 1", [normalizeAddress(email)]);
  return rows[0]?.id ?? null;
}

/**
 * A member accepts a suggestion. Each kind applies through the same rules as
 * a manual change: the item state machine, the people and ledger services.
 */
export async function acceptSuggestionTx(q: Queryable, tenant: Tenant, id: string, rawChoice: z.input<typeof AcceptChoice>, now: Date): Promise<Record<string, unknown>> {
  const choice = AcceptChoice.parse(rawChoice);
  const { rows } = await q.query<Record<string, unknown>>("select * from crm_suggestions where id = $1", [id]);
  if (!rows[0]) throw new DomainError("not_found", "Suggestion not found");
  const s = mapSuggestion(rows[0]);
  if (s.status !== "pending") throw new DomainError("already_decided", `Suggestion already ${s.status}`);
  const p = s.payload;
  let result: Record<string, unknown>;

  switch (s.kind) {
    case "attach_confirmation": {
      const itemId = choice.itemId ?? ((p.candidates as { itemId: string }[] | undefined)?.[0]?.itemId ?? null);
      if (!itemId) throw new DomainError("choose_item", "Choose the booking this confirmation belongs to");
      const item = await getItem(q, itemId);
      if (!item) throw new DomainError("not_found", "Booking not found");
      // Inbound email is unauthenticated: settling a booking on its word is the trip owner's (or a workspace owner's) call.
      const authority = await q.query<{ ok: boolean }>(
        "select (t.owner_id = app_member() or exists (select 1 from members m where m.id = app_member() and m.role = 'owner')) as ok from trips t where t.id = $1",
        [item.tripId],
      );
      if (!authority.rows[0]?.ok) throw new DomainError("forbidden", "Only the trip owner or a workspace owner can confirm a booking from an email");
      if (s.messageId) {
        const sender = (await q.query<{ from_address: string }>("select from_address from inbound_messages where id = $1", [s.messageId])).rows[0]?.from_address;
        if (sender && !(await personByEmail(q, sender)) && !choice.itemId) {
          throw new DomainError("unknown_sender", `${sender} isn't a known supplier contact. Check the confirmation, then pick the booking explicitly to accept.`);
        }
      }
      const conf = p.confirmation as { confirmationNumber: string };
      const next = attachConfirmation(item, conf.confirmationNumber);
      await updateItemState(q, next);
      if (item.state === "outcome_unknown") {
        // Written confirmation from the supplier resolves the unknown outcome: the attempt succeeded.
        await q.query(
          "update execution_attempts set state = 'succeeded', provider_ref = $2, last_error = null, updated_at = now() where item_id = $1 and state = 'outcome_unknown'",
          [item.id, next.confirmationRef],
        );
      }
      await audit(q, tenant.workspaceId, tenant.memberId, "booking.confirmation_attached", item.id, {
        from: item.state,
        to: next.state,
        confirmationRef: next.confirmationRef,
        messageId: s.messageId,
      });
      result = { itemId: item.id, from: item.state, to: next.state };
      break;
    }
    case "file_commitment": {
      const itemId = choice.itemId ?? null;
      const item = itemId ? await getItem(q, itemId) : null;
      if (itemId && !item) throw new DomainError("not_found", "Booking not found");
      const msgFrom = s.messageId ? (await q.query<{ from_address: string }>("select from_address from inbound_messages where id = $1", [s.messageId])).rows[0] : undefined;
      const base = {
        consequential: Boolean(p.consequential),
        confidence: 0.9,
        evidence: "written_confirmation" as const,
        transcriptVerified: false,
      };
      const c: Commitment = {
        id: randomUUID(),
        tripId: item?.tripId ?? null,
        itemId: item?.id ?? null,
        promisor: String(p.promisor ?? "Supplier"),
        promisorPersonId: choice.personId ?? (msgFrom ? await personByEmail(q, msgFrom.from_address) : null),
        promise: String(p.promise),
        conditions: (p.conditions as string | null) ?? null,
        dueBy: (p.dueBy as string | null) && !Number.isNaN(Date.parse(String(p.dueBy))) ? new Date(String(p.dueBy)).toISOString() : null,
        evidenceRef: s.messageId ? `email:${s.messageId}` : null,
        state: "pending",
        // A member read and accepted it; routing only records whether it would have needed review.
        reviewStatus: reviewRouting(base) === "needs_review" ? "reviewed" : "auto_filed",
        recapSentAt: null,
        deliveredToTravelerAt: null,
        ...base,
      };
      await insertCommitment(q, tenant.workspaceId, c);
      await audit(q, tenant.workspaceId, tenant.memberId, "commitment.filed_from_email", c.id, { messageId: s.messageId });
      result = { commitmentId: c.id };
      break;
    }
    case "upsert_person": {
      const email = String(p.email);
      // A name match is only a hint shown to the member; merging needs their explicit choice.
      const mergeInto = choice.personId ?? null;
      let personId: string;
      if (mergeInto) {
        await mergeIntoPersonTx(q, tenant, mergeInto, { emails: [email] }, now);
        personId = mergeInto;
      } else {
        const existing = await personByEmail(q, email);
        if (existing) throw new DomainError("duplicate_email", "Someone you can see already has this email; merge into them instead");
        const org = (p.organization as string | null) ?? null;
        const title = (p.title as string | null) ?? null;
        personId = await createPersonTx(
          q,
          tenant,
          {
            name: String(p.name ?? email),
            emails: [email],
            scope: "private",
            approach: { channel: "Email", timeZone: null, language: null, boss: null, goingOverTheirHeadAcceptable: false },
            role: org ? { organization: org, title: title ?? "Contact", measuredOn: null, from: String(p.firstTouch ?? now.toISOString()).slice(0, 10) } : null,
          },
          { source: s.source, now },
        );
      }
      if (s.source === "google_import" && p.lastTouch) {
        await logLedgerEntryTx(
          q,
          tenant,
          {
            personId,
            kind: "touch",
            at: String(p.lastTouch),
            note: `From your email and calendar: ${Number(p.sentCount ?? 0)} sent, ${Number(p.receivedCount ?? 0)} received, ${Number(p.meetingCount ?? 0)} meetings since ${String(p.firstTouch ?? "").slice(0, 10)}`,
          },
          now,
          { source: "google_import", sourceRef: `g:${tenant.memberId}:${email}` },
        );
      }
      // The same message's touch suggestion can now point at this person.
      if (s.messageId) {
        await q.query(
          `update crm_suggestions set payload = jsonb_set(payload, '{personId}', to_jsonb($2::text)), updated_at = now()
            where message_id = $1 and kind = 'log_touch' and status = 'pending'`,
          [s.messageId, personId],
        );
      }
      result = { personId, merged: Boolean(mergeInto) };
      break;
    }
    case "log_touch": {
      const personId = choice.personId ?? ((p.personId as string | null) || (await personByEmail(q, String(p.email))));
      if (!personId) throw new DomainError("choose_person", "Add or choose the person first");
      if (!(await getPerson(q, tenant, personId))) throw new DomainError("not_found", "Person not found");
      const r = await logLedgerEntryTx(q, tenant, { personId, kind: "touch", at: String(p.at), note: String(p.note ?? "Email") }, now, {
        source: "inbound_email",
        sourceRef: s.messageId ? `in:${s.messageId}` : `sugg:${s.id}`,
      });
      result = { personId, entryId: r.id, duplicate: r.duplicate };
      break;
    }
  }

  const upd = await q.query(
    "update crm_suggestions set status = 'accepted', decided_by = $2, decided_at = $3, result = $4, updated_at = $3 where id = $1 and status = 'pending' returning id",
    [id, tenant.memberId, now.toISOString(), JSON.stringify(result)],
  );
  if (!upd.rows[0]) throw new DomainError("already_decided", "Suggestion was decided by someone else");
  await audit(q, tenant.workspaceId, tenant.memberId, "crm.suggestion_accepted", id, { kind: s.kind, source: s.source });
  return result;
}

export function acceptSuggestion(db: Db, tenant: Tenant, id: string, choice: z.input<typeof AcceptChoice>, now: Date) {
  return withTenant(db, tenant, (q) => acceptSuggestionTx(q, tenant, id, choice, now));
}

/** Bulk accept (Google candidates). Each in its own transaction so one conflict doesn't sink the rest. */
export async function acceptSuggestions(db: Db, tenant: Tenant, ids: readonly string[], now: Date): Promise<{ accepted: number; failed: { id: string; reason: string }[] }> {
  let accepted = 0;
  const failed: { id: string; reason: string }[] = [];
  for (const id of ids) {
    try {
      await acceptSuggestion(db, tenant, id, {}, now);
      accepted++;
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      failed.push({ id, reason: err.message });
    }
  }
  return { accepted, failed };
}

export function dismissSuggestions(db: Db, tenant: Tenant, ids: readonly string[], now: Date): Promise<number> {
  return withTenant(db, tenant, async (q) => {
    const { rows } = await q.query(
      "update crm_suggestions set status = 'dismissed', decided_by = $2, decided_at = $3, updated_at = $3 where id = any($1::uuid[]) and status = 'pending' returning id",
      [ids, tenant.memberId, now.toISOString()],
    );
    if (rows.length) await audit(q, tenant.workspaceId, tenant.memberId, "crm.suggestions_dismissed", String(rows.length));
    return rows.length;
  });
}

/** Items a member can attach a confirmation to, with the perks we hold for them (to compare against the supplier's). */
export async function confirmableItems(q: Queryable): Promise<{ id: string; label: string; perks: Perk[] }[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select i.id, i.title, i.state, i.credentials, t.title as trip_title
       from trip_items i join trips t on t.id = i.trip_id
      where i.state in ('booking', 'outcome_unknown', 'confirmed') order by t.title, i.position`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    label: `${String(r.trip_title)} · ${String(r.title)} (${String(r.state).replace("_", " ")})`,
    perks: ((r.credentials as { perks?: Perk[] } | null)?.perks ?? []) as Perk[],
  }));
}
