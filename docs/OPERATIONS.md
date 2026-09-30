# Operations runbook

## Topology

| Process | Command | Scale | Notes |
|---|---|---|---|
| web | `npm start` (image default) | 2+ behind a load balancer | Stateless. Health `/api/health`, readiness `/api/ready`. |
| worker | `npm run worker` | 1+ | Claims jobs with `FOR UPDATE SKIP LOCKED`; safe to run many. SIGTERM finishes the current job. |
| migrate | `npm run db:migrate` | once per release | Run before starting new web/worker versions. Migrations are forward-only. |
| cron (optional) | `POST /api/cron` with `Authorization: Bearer $CRON_SECRET` | every minute | Only needed where a long-running worker isn't possible. |

Postgres 16+. Blob storage: S3-compatible bucket (`STORAGE_DRIVER=s3`). SMTP for outbound mail.

## Configuration

Validated at startup by `src/server/config.ts`; production refuses to boot without the required values.

| Variable | Required in prod | Purpose |
|---|---|---|
| `APP_URL` | yes (https) | Public base URL; used in email links and OAuth redirects. |
| `DATABASE_URL` | yes | Connect as the **table owner, not a superuser**. Forced RLS then applies to every query. |
| `MASTER_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`). Wraps per-workspace data keys. Store in a secret manager. |
| `SMTP_URL`, `EMAIL_FROM` | yes | Sign-in links, invitations, reminders, escalations. |
| `CRON_SECRET` | yes | Protects `/api/cron`. |
| `STORAGE_DRIVER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | `s3` in prod | Encrypted blobs (audio, exports, photos). |
| `ANTHROPIC_API_KEY` | no | Enables agents. Without it, every feature works on manual input. |
| `DUFFEL_ACCESS_TOKEN`, `DUFFEL_WEBHOOK_SECRET` | per feature | Air booking and airline-change webhooks. |
| `DEEPGRAM_API_KEY` | per feature | Call transcription. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | per feature | Payouts and card vault. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | per feature | Gmail/Calendar import. |
| `INBOUND_EMAIL_SECRET`, `INBOUND_EMAIL_DOMAIN` | per feature | Inbound email webhook. |
| `SESSION_TTL_DAYS`, `LOG_LEVEL` | no | Defaults 30 and `info`. |

`ALLOW_DEV_LOGIN` and `E2E_MAIL_FILE` are test-only; the first is rejected in production.

## Database

- **Roles.** Migrations create `app_user` (tenant, RLS-bound) and `app_system` (platform) and grant both to the connecting owner. Code switches with `SET LOCAL ROLE` inside each transaction (`withTenant` / `withSystem`). The owner itself sees no rows because RLS is forced.
- **First deploy:** create the owner role with `CREATEROLE` (it creates the two NOLOGIN roles), create the database owned by it, run `npm run db:migrate`.
- **Backups.** Enable point-in-time recovery on the managed Postgres; test a restore quarterly. Blobs: enable bucket versioning with a lifecycle rule that matches the workspace retention settings. Backups contain ciphertext for sensitive fields; they are useless without `MASTER_KEY`, so back the key up separately (secret manager with its own recovery).
- **Pooling.** Each process uses a `pg` pool (default 10). With PgBouncer use *session* pooling; `SET LOCAL` requires a transaction on one server connection (transaction pooling also works because every tenant query runs inside an explicit transaction).

## Keys

- **Rotate the master key:** `OLD_MASTER_KEY=<old> MASTER_KEY=<new> DATABASE_URL=... npm run keys:rotate-master`, then deploy `MASTER_KEY=<new>` to all processes. Only data keys are re-wrapped; content is untouched.
- **Rotate a workspace data key:** `rotateWorkspaceKey` (new content uses the new version; old versions keep decrypting).
- **Crypto-shred a workspace:** deleting its rows in `workspace_keys` makes all its encrypted content unreadable (used by workspace deletion).

## Background jobs

- Table `jobs`. Statuses: `queued`, `running`, `done`, `failed`, `dead`. Exponential backoff up to 1 hour; default 8 attempts.
- Dead jobs appear in **Admin → Jobs** for the workspace; platform operators can query `select kind, count(*) from jobs where status = 'dead' group by 1`.
- Stuck `running` jobs (worker crashed) are returned to the queue after 15 minutes.
- Alert on: dead jobs > 0 in the last hour; oldest queued job older than 10 minutes; `/api/ready` failing.

## Webhooks

All inbound webhooks verify signatures (Duffel, Stripe) or a shared secret (inbound email) with constant-time comparison, reject stale timestamps, and dedupe by event id. They return 2xx only after the event is durably recorded; processing happens in jobs.

## Incident notes

- **Suspected session compromise:** revoke with `update sessions set revoked_at = now() where user_id = ...` or have the user use *Settings → Sign out everywhere*.
- **Suspected master key exposure:** rotate the master key immediately (above); rotate data keys for affected workspaces.
- **Supplier outage during booking:** items end in `outcome_unknown`; do not bulk-retry. Reconcile each from the attention queue once the supplier is back.

## Local

- `npm run dev` — embedded Postgres under `.data/`, demo data, dev sign-in when `ALLOW_DEV_LOGIN=1`.
- `docker compose up --build` — production-like stack with Postgres and Mailpit (http://localhost:8025).
- `npm test`, `npm run test:pg` (needs a local Postgres; see CI for setup), `npm run test:e2e` (after `npm run build`).
