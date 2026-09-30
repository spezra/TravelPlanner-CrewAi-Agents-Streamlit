/**
 * Tokens, hashing and per-workspace envelope encryption.
 *
 * Sensitive content (transcripts, call notes, relationship texture, OAuth
 * tokens, audio) is encrypted with a workspace data key (AES-256-GCM). Data
 * keys are stored wrapped by the platform master key, so rotating the master
 * key means re-wrapping a handful of keys, and deleting a workspace's keys
 * crypto-shreds its encrypted content.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Queryable } from "@/db/client";
import { config } from "./config";

export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Development only: a fixed key so local data survives restarts. config() refuses to start production without MASTER_KEY.
const DEV_MASTER_KEY = Buffer.alloc(32, 7);

function masterKey(): Buffer {
  const k = config().MASTER_KEY;
  if (!k) return DEV_MASTER_KEY;
  const buf = Buffer.from(k, "base64");
  if (buf.length !== 32) throw new Error("MASTER_KEY must be 32 bytes, base64-encoded");
  return buf;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [iv, tag, ct] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !ct) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Per-transaction cache of unwrapped keys. Never persisted. */
const keyCache = new Map<string, Buffer>();

async function dataKey(q: Queryable, workspaceId: string, version?: number): Promise<{ key: Buffer; version: number }> {
  const { rows } = await q.query<{ version: number; wrapped_key: string }>(
    version === undefined
      ? "select version, wrapped_key from workspace_keys where workspace_id = $1 and retired_at is null order by version desc limit 1"
      : "select version, wrapped_key from workspace_keys where workspace_id = $1 and version = $2",
    version === undefined ? [workspaceId] : [workspaceId, version],
  );
  let row = rows[0];
  if (!row) {
    if (version !== undefined) throw new Error(`Data key v${version} for workspace ${workspaceId} not found`);
    const fresh = randomBytes(32);
    const wrapped = seal(masterKey(), fresh, `wk:${workspaceId}:1`);
    await q.query("insert into workspace_keys (workspace_id, version, wrapped_key) values ($1, 1, $2) on conflict do nothing", [workspaceId, wrapped]);
    return dataKey(q, workspaceId, 1);
  }
  // Keyed by the wrapped key itself, so a replaced or re-created key can never be served stale.
  const cacheKey = `${workspaceId}:${row.version}:${row.wrapped_key}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = open(masterKey(), row.wrapped_key, `wk:${workspaceId}:${row.version}`);
    keyCache.set(cacheKey, key);
  }
  return { key, version: row.version };
}

/**
 * Encrypt for a workspace. `context` binds the ciphertext to where it is
 * stored (e.g. "transcript:<id>") so it can't be swapped between records.
 * Works inside withTenant (own workspace only) or withSystem.
 */
export async function encryptFor(q: Queryable, workspaceId: string, context: string, plaintext: string | Buffer): Promise<string> {
  const { key, version } = await dataKey(q, workspaceId);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  return `v${version}.${seal(key, data, `${workspaceId}:${context}`)}`;
}

export async function decryptBytes(q: Queryable, workspaceId: string, context: string, sealed: string): Promise<Buffer> {
  const dot = sealed.indexOf(".");
  const version = Number(sealed.slice(1, dot));
  const { key } = await dataKey(q, workspaceId, version);
  return open(key, sealed.slice(dot + 1), `${workspaceId}:${context}`);
}

export async function decryptFor(q: Queryable, workspaceId: string, context: string, sealed: string): Promise<string> {
  return (await decryptBytes(q, workspaceId, context, sealed)).toString("utf8");
}

/** Crypto-shred: delete every data key for a workspace. Its encrypted content becomes unreadable. */
export async function shredWorkspaceKeys(q: Queryable, workspaceId: string): Promise<void> {
  await q.query("delete from workspace_keys where workspace_id = $1", [workspaceId]);
  for (const k of keyCache.keys()) if (k.startsWith(`${workspaceId}:`)) keyCache.delete(k);
}

/**
 * Master-key rotation: re-wrap every workspace data key under a new master key.
 * Content encrypted with the data keys is untouched. Run inside withSystem.
 */
export async function rewrapAllKeys(q: Queryable, oldMasterB64: string, newMasterB64: string): Promise<number> {
  const oldKey = Buffer.from(oldMasterB64, "base64");
  const newKey = Buffer.from(newMasterB64, "base64");
  if (oldKey.length !== 32 || newKey.length !== 32) throw new Error("Master keys must be 32 bytes, base64-encoded");
  const { rows } = await q.query<{ workspace_id: string; version: number; wrapped_key: string }>("select workspace_id, version, wrapped_key from workspace_keys");
  for (const r of rows) {
    const aad = `wk:${r.workspace_id}:${r.version}`;
    const raw = open(oldKey, r.wrapped_key, aad);
    await q.query("update workspace_keys set wrapped_key = $3 where workspace_id = $1 and version = $2", [r.workspace_id, r.version, seal(newKey, raw, aad)]);
  }
  keyCache.clear();
  return rows.length;
}

/**
 * Data-key rotation for one workspace: new content uses a new key version;
 * older versions stay available for decryption until re-encrypted.
 */
export async function rotateWorkspaceKey(q: Queryable, workspaceId: string): Promise<number> {
  const { rows } = await q.query<{ v: number | null }>("select max(version) as v from workspace_keys where workspace_id = $1", [workspaceId]);
  const version = (rows[0]?.v ?? 0) + 1;
  await q.query("insert into workspace_keys (workspace_id, version, wrapped_key) values ($1, $2, $3)", [
    workspaceId,
    version,
    seal(masterKey(), randomBytes(32), `wk:${workspaceId}:${version}`),
  ]);
  return version;
}
