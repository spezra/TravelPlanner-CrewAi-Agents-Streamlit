/**
 * Environment configuration, validated once at startup. Production refuses to
 * start with missing secrets rather than falling back to development defaults.
 */
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().optional(),
  /** base64-encoded 32-byte key that wraps per-workspace data keys. */
  MASTER_KEY: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Development and e2e only: allows one-click sign-in as a seeded demo member. */
  ALLOW_DEV_LOGIN: z.enum(["0", "1"]).default("0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("Travel Platform <no-reply@localhost>"),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/blobs"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  DUFFEL_ACCESS_TOKEN: z.string().optional(),
  DUFFEL_WEBHOOK_SECRET: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  INBOUND_EMAIL_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;

export function config(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached && env === process.env) return cached;
  const parsed = Env.parse(env);
  if (parsed.NODE_ENV === "production") {
    const missing = (["DATABASE_URL", "MASTER_KEY", "SMTP_URL", "CRON_SECRET"] as const).filter((k) => !parsed[k]);
    if (parsed.STORAGE_DRIVER === "s3" && !parsed.S3_BUCKET) missing.push("S3_BUCKET" as never);
    if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
    if (parsed.ALLOW_DEV_LOGIN === "1") throw new Error("ALLOW_DEV_LOGIN must not be enabled in production");
    if (!parsed.APP_URL.startsWith("https://")) throw new Error("APP_URL must be https in production");
  }
  if (env === process.env) cached = parsed;
  return parsed;
}

export const isProduction = () => config().NODE_ENV === "production";
