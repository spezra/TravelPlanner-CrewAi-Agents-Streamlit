# Security model

**Tenancy.** Every tenant row carries `workspace_id`. Row-level security is enabled and *forced* on every table, so even the table owner sees nothing. Application code reaches data only as `app_user` (bound to one workspace and member via `SET LOCAL` settings) or `app_system` (platform services such as sign-in and webhook routing). Private-scope records (relationships, texture notes, private trips, knowledge) are further limited to their owner and named, expiring delegates. Cross-workspace network data is readable only by admitted network workspaces and only at network scope.

**Authentication.** Passwordless email links: 256-bit random tokens, stored as SHA-256 hashes, single-use, 15-minute expiry, consumed by POST (link scanners can't burn them), rate-limited per email and IP, no account enumeration. Sessions are random tokens stored hashed, `__Host-` cookies (HttpOnly, Secure, SameSite=Lax), 30-day expiry, revocable individually or everywhere. Disabling a member detaches their sessions from the workspace immediately.

**Authorization.** Roles: owner, advisor, assistant, admin. Money and irreversible actions are human-gated: only the trip owner or a workspace owner approves spend; assistants prepare. Agents act on behalf of a specific member and never hold more access than that member.

**Encryption.** TLS in transit (HSTS in production). Sensitive content (transcripts, notes, message bodies, OAuth tokens, texture notes, audio, exports) is encrypted with per-workspace AES-256-GCM data keys bound to their storage context; data keys are wrapped by a master key held outside the database. Workspace deletion crypto-shreds its keys. Card numbers never touch the platform (Stripe-hosted collection; only token metadata stored).

**AI.** Model output is schema-validated and routed by deterministic code; models never write to the database or act on suppliers directly. Messages the system sends are labeled as automated; the AI never signs as a person.

**Web.** Strict CSP, `frame-ancestors 'none'`, nosniff, referrer policy, permissions policy. Server actions are same-origin POSTs (Next.js origin checks) with SameSite cookies. Webhooks verify signatures with constant-time comparison, reject stale timestamps and replays.

**Compliance.** Consent rules for call recording are enforced per call with the stricter rule on uncertainty; the shipped jurisdiction table is configuration, not legal advice. Seller-of-travel registration, GDPR basis and transfers, PCI scope and payout structure must be confirmed with counsel before launch (see the spec's compliance section).

**Reporting.** Report vulnerabilities privately to the maintainers; do not open public issues for security problems.
