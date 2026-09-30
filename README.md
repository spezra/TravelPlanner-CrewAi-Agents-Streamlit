# Agentic Travel Platform

An operating environment for luxury travel tastemakers. Agents do the research, preparation, booking, coordination and follow-up; the expert keeps the taste decisions, the relationships and every money decision.

This repository is the first build against the *Agentic Travel Platform — Working Spec* (Sep 30, 2026). It replaces the earlier CrewAI + Streamlit itinerary generator.

## What is here

| Spec principle | Where it lives |
|---|---|
| Every booking, request, approval and commitment keeps its own state | `src/domain/bookings.ts` (item state machine, trip stage derived from items) |
| Credentials are not one thing: booking entity, channel, program/rate, guaranteed vs. availability-dependent perks, servicing owner, commission recipient | `src/domain/bookings.ts` (`BookingCredentials`, `describePerksForTraveler` never overstates perks) |
| Executable approvals: one approval covers a set of actions and lapses only when material terms change | `src/domain/approvals.ts` |
| Acting is a separate test: evidence + permission + current conditions | `src/domain/actionGate.ts` |
| Reliable execution: idempotency keys, outcome-unknown state, reconcile before retry | `src/domain/execution.ts`, `src/services/operations.ts` (`bookItem`, `reconcileItem`) |
| Separate taste from circumstance; ask why only when it matters | `src/domain/judgment.ts`, `src/agents/reasonClassifier.ts` |
| Client brief: enduring vs. this trip, said vs. inferred | `src/domain/brief.ts`, `src/agents/briefExtractor.ts` |
| Knowing, permission and current terms are separate (retain / recommend / commit) | `src/domain/knowledge.ts` (`trustTier`, `provenance`, `requestTrackRecord`) |
| Permission-first publication pipeline; restricted categories never leave | `src/domain/knowledge.ts` (`publish`) |
| Commitments: evidence type separate from operational state; uncertain items go to the expert | `src/domain/commitments.ts`, `src/agents/commitmentExtractor.ts` |
| Call consent: stricter rule when jurisdiction is unclear or parties change; notes mode processes no audio | `src/domain/calls.ts` |
| Relationship CRM: people not properties, reciprocity ledger, warmth as evidence, chip management, nudges | `src/domain/crm.ts` |
| Collaboration: anonymized brief, terms before client details, expiring access, decision authority, lapsing endorsements | `src/domain/collaboration.ts` |
| Receivables ledger: adjustments before splits, exact allocation, payout only on funded paths | `src/domain/ledger.ts` |
| Per-trip response plan with a named backup | `src/domain/responsePlan.ts` |
| Protect human attention: only consequential decisions, with a recommended action | `src/domain/attention.ts`, the **Today** page |
| Multi-tenant Postgres with row-level security; private / workspace scopes; expiring delegation | `src/db/migrations/001_init.sql`, `src/db/tenant.ts` |

### Layout

```
src/domain/     Pure business rules. No I/O, no clock, no model calls. Most of the spec is enforced here.
src/db/         SQL migrations (with RLS), tenant-bound transactions, repositories, demo seed.
src/services/   Operations that combine domain rules with persistence and audit events.
src/agents/     Claude-powered extraction and classification. Output is schema-validated, then
                routed by domain code; agents never write to the database or act on suppliers directly.
src/providers/  Supplier/booking-rail adapters. Only a simulated supplier exists so far.
src/app/        Next.js UI: Today (attention queue), Trips, Trip detail, Relationships.
tests/          Domain, database/RLS and agent tests.
```

## Running it

Requires Node 22+.

```bash
npm install
npm run dev          # http://localhost:3000
```

With no `DATABASE_URL`, the app uses an embedded Postgres (PGlite) under `.data/` and seeds a fictional worked trip on first run. Use the **Dev sign-in** switcher to see the same data as the expert, their assistant, the named backup, or a member of another workspace; row-level security decides what each one sees. Delete `.data/` to reset.

To use a real Postgres, set `DATABASE_URL` (see `.env.example`) and run `npm run db:migrate` (and optionally `npm run db:seed`). The migration creates an `app_user` role that every tenant query runs as, so RLS applies even when the app connects as the table owner.

The agent layer uses `ANTHROPIC_API_KEY` (model `claude-opus-5-5`, structured outputs, server-side refusal fallback). Without credentials, the UI and all domain rules still work on manual input.

```bash
npm run typecheck
npm test             # domain rules, RLS isolation, booking reconciliation, agents (with a fake model)
npm run build
```

## Not built yet

Deliberately out of this first cut, in rough priority order:

- **Real authentication.** The dev sign-in is a cookie switcher for demonstrating RLS. Nothing here is safe to expose publicly until it is replaced.
- **Real booking rails.** Duffel for air, direct/GDS for hotels. Adapters implement `ProviderAdapter` in `src/domain/execution.ts`; the simulated supplier shows the contract, including timeouts after acceptance.
- **Inbound capture:** email/calendar sync to build CRM records from history, confirmation parsing, and the call capture stack (recorded vs. notes mode, voice debriefs). The agents that consume those inputs exist; the ingestion pipeline and event queue don't.
- **UI for the rest of the domain:** booking and reconciliation actions, decision capture, knowledge publication review, collaboration terms, the receivables ledger.
- **Per-workspace encryption keys, EU residency, retention rules for raw audio**, card vault via a PCI provider, and Stripe payouts. All need counsel's input on the spec's compliance section before being built.

The consent table in `src/domain/calls.ts` is illustrative configuration, not legal advice.
