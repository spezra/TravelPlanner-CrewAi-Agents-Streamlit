-- Relationship CRM and email/calendar ingestion.
--
-- People keep their role history on the existing people table. Everything the
-- owner alone should see (texture notes, drafted notes, Google tokens and the
-- contacts mined from their mailbox) lives in owner-only tables. Message
-- subjects and bodies, texture and OAuth tokens are stored encrypted with the
-- workspace data key (src/server/crypto.ts), never as plaintext.

-- ---------------------------------------------------------------------------
-- People

alter table people add column emails text[] not null default '{}';
alter table people add column source text not null default 'manual' check (source in ('manual', 'inbound_email', 'google_import'));
alter table people add column created_at timestamptz not null default now();
alter table people add column updated_at timestamptz not null default now();
create index people_emails on people using gin (emails);

-- The owner's own notes ("dry humor, hates being rushed"), encrypted, visible to the relationship holder only.
create table person_texture (
  person_id uuid primary key references people(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  sealed text not null,
  updated_at timestamptz not null default now()
);

-- Client ties: which clients a contact knows, so the family is greeted by name.
create table person_clients (
  person_id uuid not null references people(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  note text not null default '',
  created_at timestamptz not null default now(),
  primary key (person_id, client_id)
);
create index on person_clients (client_id);

-- Reciprocity ledger: how important an ask was, who logged it, and where it came from.
alter table ledger_entries add column importance text check (importance in ('routine', 'important', 'critical'));
alter table ledger_entries add column source text not null default 'manual' check (source in ('manual', 'inbound_email', 'google_import'));
alter table ledger_entries add column source_ref text;
alter table ledger_entries add column logged_by uuid references members(id);
alter table ledger_entries add column created_at timestamptz not null default now();
create unique index ledger_entries_source_ref on ledger_entries (workspace_id, source_ref) where source_ref is not null;
create index on ledger_entries (person_id, at desc);

-- Knowledge that depended on a person is flagged for review when they move.
alter table knowledge_items add column depends_on_person_id uuid references people(id) on delete set null;
alter table knowledge_items add column needs_review boolean not null default false;
alter table knowledge_items add column review_reason text;
alter table knowledge_items add column review_flagged_at timestamptz;
create index on knowledge_items (depends_on_person_id) where depends_on_person_id is not null;

-- Things the system surfaces to one member: a new door opened by a move, knowledge to review, a disconnected integration.
create table crm_notices (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  member_id uuid not null references members(id),
  person_id uuid references people(id) on delete cascade,
  kind text not null check (kind in ('new_door', 'knowledge_review', 'integration_disconnected', 'import_ready')),
  message text not null,
  data jsonb not null default '{}',
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  dismissed_at timestamptz,
  unique (workspace_id, dedupe_key)
);
create index on crm_notices (member_id, created_at desc) where dismissed_at is null;

-- Notes the agent drafted for the owner to edit and send from their own mail client.
create table crm_note_drafts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  person_id uuid not null references people(id) on delete cascade,
  nudge_kind text not null,
  subject text not null,
  body_sealed text not null,
  drafted_by text not null check (drafted_by in ('agent', 'template')),
  created_at timestamptz not null default now()
);
create index on crm_note_drafts (person_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Inbound email

-- One inbound address per workspace: in+<token>@<INBOUND_EMAIL_DOMAIN>.
create table inbound_routes (
  workspace_id uuid primary key references workspaces(id),
  token text not null unique,
  -- Messages that aren't forwarded by a recognizable member are filed for this member.
  default_member_id uuid not null references members(id),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table inbound_messages (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  scope text not null default 'workspace' check (scope in ('private', 'workspace')),
  message_id text not null,
  from_address text not null,
  from_name text,
  to_address text not null,
  received_at timestamptz not null,
  subject_sealed text not null,
  body_sealed text not null,
  attachments jsonb not null default '[]',
  parse_status text not null default 'queued' check (parse_status in ('queued', 'parsed', 'manual', 'failed')),
  classification text check (classification in ('supplier_confirmation', 'supplier_commitment', 'client_message', 'other')),
  parse_error text,
  parsed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, message_id)
);
create index on inbound_messages (workspace_id, received_at desc);

-- Suggestions from inbound email and Google import. Nothing is applied until a member accepts it.
create table crm_suggestions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  scope text not null default 'private' check (scope in ('private', 'workspace')),
  source text not null check (source in ('inbound_email', 'google_import')),
  message_id uuid references inbound_messages(id) on delete cascade,
  kind text not null check (kind in ('attach_confirmation', 'file_commitment', 'upsert_person', 'log_touch')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  dedupe_key text not null,
  decided_by uuid references members(id),
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
create index on crm_suggestions (workspace_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Google (Gmail + Calendar), private to the member who connected it

create table google_oauth_states (
  state_hash text primary key,
  workspace_id uuid not null references workspaces(id),
  member_id uuid not null references members(id) on delete cascade,
  verifier_sealed text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table google_integrations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  member_id uuid not null references members(id) on delete cascade,
  google_email text not null,
  scopes text[] not null default '{}',
  access_token_sealed text,
  refresh_token_sealed text,
  access_expires_at timestamptz,
  status text not null check (status in ('connected', 'disconnected')),
  status_reason text,
  import_status text not null default 'pending' check (import_status in ('pending', 'running', 'complete', 'failed')),
  -- Resumable cursor for the initial import (page tokens, phase); holds no message content.
  import_cursor jsonb not null default '{}',
  gmail_history_id text,
  calendar_sync_token text,
  import_completed_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id)
);

-- Per-address aggregates built from message metadata and calendar attendees.
create table google_contacts (
  integration_id uuid not null references google_integrations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  member_id uuid not null references members(id) on delete cascade,
  email text not null,
  name text,
  organization text,
  first_touch timestamptz not null,
  last_touch timestamptz not null,
  sent_count int not null default 0,
  received_count int not null default 0,
  meeting_count int not null default 0,
  primary key (integration_id, email)
);

-- Messages and events already counted, so a retried page never double-counts.
create table google_seen (
  integration_id uuid not null references google_integrations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  member_id uuid not null references members(id) on delete cascade,
  source text not null check (source in ('gmail', 'calendar')),
  external_id text not null,
  primary key (integration_id, source, external_id)
);

-- ---------------------------------------------------------------------------
-- Row-level security

do $$
declare t text;
begin
  foreach t in array array['person_texture','person_clients','crm_notices','crm_note_drafts','inbound_routes','inbound_messages',
    'crm_suggestions','google_oauth_states','google_integrations','google_contacts','google_seen']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_user, app_system', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;

-- Owner-only: texture, drafted notes, notices and everything Google.
do $$
declare t text;
begin
  foreach t in array array['person_texture','crm_note_drafts']
  loop
    execute format('create policy tenant on %I to app_user using (workspace_id = app_workspace() and owner_id = app_member()) with check (workspace_id = app_workspace() and owner_id = app_member())', t);
  end loop;
  foreach t in array array['crm_notices','google_oauth_states','google_integrations','google_contacts','google_seen']
  loop
    execute format('create policy tenant on %I to app_user using (workspace_id = app_workspace() and member_id = app_member()) with check (workspace_id = app_workspace() and member_id = app_member())', t);
  end loop;
end $$;

-- A client tie is visible when both the person and the client are.
create policy tenant on person_clients to app_user
  using (workspace_id = app_workspace()
         and exists (select 1 from people p where p.id = person_id)
         and exists (select 1 from clients c where c.id = client_id))
  with check (workspace_id = app_workspace());

create policy tenant on inbound_routes to app_user using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());

create policy tenant on inbound_messages to app_user
  using (workspace_id = app_workspace() and (scope = 'workspace' or owner_id = app_member()))
  with check (workspace_id = app_workspace());

create policy tenant on crm_suggestions to app_user
  using (workspace_id = app_workspace() and (scope = 'workspace' or owner_id = app_member()))
  with check (workspace_id = app_workspace());
