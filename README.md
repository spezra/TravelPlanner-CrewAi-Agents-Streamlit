# Agentic Travel Platform

An operating environment for luxury travel tastemakers. Agents do the research, preparation, booking, coordination, documents, monitoring and follow-up; the expert keeps the taste decisions, the relationships and every money decision. Built against the *Agentic Travel Platform — Working Spec* (Sep 30, 2026).

## What it does

| Area | What the expert gets |
|---|---|
| **Today** | Only the decisions that need them — approvals, unknown booking outcomes, disruptions, commitments to check, inbox suggestions, unhappy clients, payouts, collaboration requests, introductions — each with context and a recommended action. |
| **Trips** | Every booking keeps its own state and credentials (booking entity, channel, program/rate, guaranteed vs. availability-dependent perks, servicing owner, commission recipient). Executable approvals that lapse when material terms change. Booking through Duffel (air) or a manual supplier-confirmation flow; idempotent execution; outcome-unknown reconciliation; airline-change webhooks. |
| **Client portal** | A revocable link showing one itinerary in traveler language, the sent proposal, and open approvals with price, expiry, cancellation terms and what else changes. Perks are never overstated. |
| **Proposals** | Agents draft in the expert's voice from their own taste notes, dated observations and the client brief; a deterministic review blocks promised-but-not-guaranteed perks. An option scout shortlists from the expert's own knowledge and says when to ask the network instead. |
| **Clients & briefs** | Enduring preferences kept separate from a trip's needs; what the client said vs. what was inferred; post-trip outcomes. |
| **Taste model** | Select/reject/edit decisions with reasons routed to the right record (expert taste, client brief, dated supplier condition, trip only); short questions only when they matter; endorsement rate of agent drafts. |
| **Calls & commitments** | Consent enforced per party (stricter rule when unclear), recorded or notes mode, encrypted audio and transcripts (Deepgram), commitment extraction, labelled recaps, reminders, audio retention. |
| **Relationships** | People not properties: role history that follows moves, reciprocity ledger, warmth as evidence, chip advice, nudges drafted for the expert to send. Inbox turns forwarded supplier email into suggestions; Gmail/Calendar import builds records with no manual entry. |
| **Knowledge & network** | Observations with provenance and trust tier (retain / recommend / commit). Permission-first publication with redaction and source checks; standing rules. A curated cross-workspace network; collaborations with anonymized briefs, agreed terms, expiring client-detail access and lapsing endorsements; relationship activation decided by the holder every time. |
| **Money** | Commission receivables per booking line, host-statement import and matching, adjustments before splits, exact allocation, owner-approved payouts via Stripe Connect where funded or settlement instructions otherwise, card vault via Stripe (token metadata only). |
| **Admin** | Team and invitations, per-trip response plans with escalation, audit log, failed jobs, retention, encrypted workspace export, data-subject access and erasure, workspace deletion (crypto-shred). |

## Architecture

```
src/domain/       Pure business rules (no I/O, no clock). Most of the spec is enforced here.
src/db/           Migrations with forced row-level security, tenant/system transactions, core repositories, demo seed.
src/server/       Config, auth (passwordless + sessions), job queue and worker, envelope encryption, storage, mail, logging.
src/modules/      Feature modules: trips, calls, crm, network, money, ops, proposals, attention, integration.
src/agents/       Claude-powered extraction, classification, drafting and review. Output is schema-validated and routed by
                  domain code; agents never write to the database or act on suppliers directly.
src/providers/    Duffel, Deepgram, Stripe, Google adapters (injectable fetch), plus a simulated supplier.
src/app/          Next.js App Router UI, client portal, webhooks, health/readiness, cron.
tests/            Unit, integration and RLS tests (embedded Postgres and real Postgres).
e2e/              Playwright journeys against a production build.
```

- **Tenancy:** every query runs as `app_user` (bound to one workspace and member) or `app_system` (platform services). RLS is forced, so the table owner sees nothing. See [SECURITY.md](SECURITY.md).
- **Agents:** `claude-opus-5-5` with structured outputs and server-side refusal fallback. Without `ANTHROPIC_API_KEY` every feature works on manual input.
- **Background work:** Postgres job queue with a worker process (or the cron endpoint), idempotent handlers, backoff and dead-lettering.

## Running it

Requires Node 22+.

```bash
npm install
ALLOW_DEV_LOGIN=1 npm run dev   # http://localhost:3000, embedded Postgres + demo data under .data/
npm run worker                  # in another terminal, for background jobs
```

Sign in with the development buttons (or a real magic link: in development the email is printed to the console). Delete `.data/` to reset.

Production-like stack: `MASTER_KEY=$(openssl rand -base64 32) docker compose up --build` (Postgres, migrations, web, worker, Mailpit at http://localhost:8025).

Deploying for real: see [docs/OPERATIONS.md](docs/OPERATIONS.md) for configuration, roles, migrations, webhooks, integrations, keys, backups and incident notes.

## Checks

```bash
npm run typecheck
npm test            # embedded Postgres
npm run test:pg     # real Postgres as a non-superuser owner (needs a local server; see CI)
npm run build && npm run test:e2e
```

CI runs all of these on every pull request, including e2e against a real Postgres.

## Before launch

The software is built to run in production; these are decisions and setup outside the code:

- **Counsel:** call-recording consent rules (the shipped table is configuration, not legal advice), seller-of-travel registration, GDPR basis and transfers, PCI scope, commission-sharing and payout structure. See the spec's compliance section.
- **Accounts and keys:** Anthropic, Duffel (Managed Content or your own IATA), Deepgram, Stripe Connect, Google OAuth app (verification for Gmail scopes), SMTP, inbound email provider, S3-compatible storage.
- **Credentials of the experts themselves:** host agency / IATA numbers, consortium and preferred-partner programs are entered per booking; the platform routes each booking through them but cannot supply them.
- **Name:** set `NEXT_PUBLIC_BRAND_NAME` once the product name is decided.
