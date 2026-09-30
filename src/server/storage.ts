/**
 * Blob storage for audio, attachments and exports. Content is encrypted with
 * the workspace data key before it leaves the process, so the bucket only
 * ever holds ciphertext.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export interface BlobStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalStore implements BlobStore {
  constructor(private readonly dir: string) {}
  private file(key: string) {
    if (key.includes("..")) throw new Error("Invalid key");
    return path.join(this.dir, key);
  }
  async put(key: string, data: Buffer) {
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await writeFile(this.file(key), data);
  }
  async get(key: string) {
    return readFile(this.file(key));
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

class S3Store implements BlobStore {
  private client = import("@aws-sdk/client-s3").then((m) => ({
    m,
    c: new m.S3Client({ region: config().S3_REGION, endpoint: config().S3_ENDPOINT, forcePathStyle: Boolean(config().S3_ENDPOINT) }),
  }));
  constructor(private readonly bucket: string) {}
  async put(key: string, data: Buffer, contentType: string) {
    const { m, c } = await this.client;
    await c.send(new m.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string) {
    const { m, c } = await this.client;
    const out = await c.send(new m.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  async delete(key: string) {
    const { m, c } = await this.client;
    await c.send(new m.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

const g = globalThis as unknown as { __blobs?: BlobStore };

export function blobs(): BlobStore {
  if (!g.__blobs) {
    const c = config();
    g.__blobs = c.STORAGE_DRIVER === "s3" ? new S3Store(c.S3_BUCKET!) : new LocalStore(c.STORAGE_LOCAL_DIR);
  }
  return g.__blobs;
}

export function setBlobStore(s: BlobStore): void {
  g.__blobs = s;
}

export class MemoryStore implements BlobStore {
  readonly items = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.items.set(key, data);
  }
  async get(key: string) {
    const v = this.items.get(key);
    if (!v) throw new Error(`No blob ${key}`);
    return v;
  }
  async delete(key: string) {
    this.items.delete(key);
  }
}
