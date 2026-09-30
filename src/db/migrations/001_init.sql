-- Multi-tenant schema. Every tenant table carries workspace_id and is guarded
-- by row-level security keyed on the session settings app.workspace_id and
-- app.member_id, which the application sets per transaction (see src/db/tenant.ts).
-- Private-scope rows are further limited to their owner and named delegates.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

-- Lets the connecting login switch to app_user inside a transaction (SET LOCAL ROLE).
do $$ begin
  execute format('grant app_user to %I', current_user);
exception when others then null;
end $$;

-- Don't rely on the default PUBLIC grant on the schema (absent on hardened or recreated schemas).
grant usage on schema public to app_user;

create or replace function app_workspace() returns uuid language sql stable as
  $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;
create or replace function app_member() returns uuid language sql stable as
  $$ select nullif(current_setting('app.member_id', true), '')::uuid $$;

create table workspaces (
  id uuid primary key,
  name text not null,
  -- Independent advisors expect to take their book; agencies often claim it. Agreed at signup, not at exit.
  book_portability text not null check (book_portability in ('advisor_owns', 'agency_owns', 'shared')),
  data_region text not null default 'us' check (data_region in ('us', 'eu')),
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  email text not null,
  role text not null check (role in ('owner', 'advisor', 'assistant', 'admin')),
  time_zone text not null default 'UTC',
  unique (workspace_id, email)
);

create table clients (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  name text not null,
  scope text not null default 'private' check (scope in ('private', 'workspace')),
  created_at timestamptz not null default now()
);

create table trips (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  client_id uuid references clients(id),
  title text not null,
  starts_on date,
  ends_on date,
  scope text not null default 'workspace' check (scope in ('private', 'workspace')),
  created_at timestamptz not null default now()
);

-- Scoped, pre-authorized access for a named backup or collaborator. Expires.
create table trip_delegations (
  trip_id uuid not null references trips(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  member_id uuid not null references members(id),
  purpose text not null check (purpose in ('backup', 'assistant', 'collaboration')),
  expires_at timestamptz,
  primary key (trip_id, member_id)
);

create table response_plans (
  trip_id uuid primary key references trips(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  plan jsonb not null
);

create table trip_items (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  kind text not null,
  title text not null,
  supplier_name text,
  state text not null,
  price_minor bigint,
  currency text,
  starts_at timestamptz,
  ends_at timestamptz,
  credentials jsonb,
  confirmation_ref text,
  position int not null default 0
);
create index on trip_items (trip_id);

create table approvals (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  actions jsonb not null,
  terms jsonb not null,
  terms_fingerprint text not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by text not null,
  decided_by uuid references members(id),
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

create table execution_attempts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  item_id uuid not null references trip_items(id),
  action text not null,
  idempotency_key text not null,
  state text not null,
  provider text not null,
  provider_ref text,
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table people (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  name text not null,
  roles jsonb not null default '[]',
  approach jsonb not null default '{}',
  texture jsonb not null default '[]',
  scope text not null default 'private' check (scope in ('private', 'workspace'))
);

create table ledger_entries (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  person_id uuid not null references people(id) on delete cascade,
  kind text not null,
  at timestamptz not null,
  note text not null default '',
  ask_type text,
  room_nights int,
  revenue_minor bigint
);

create table commitments (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid references trips(id) on delete cascade,
  item_id uuid references trip_items(id),
  promisor text not null,
  promisor_person_id uuid references people(id),
  promise text not null,
  conditions text,
  due_by timestamptz,
  evidence text not null check (evidence in ('verbal_statement', 'machine_transcript', 'expert_notes', 'written_confirmation')),
  evidence_ref text,
  state text not null check (state in ('pending', 'fulfilled', 'disputed', 'superseded', 'canceled')),
  transcript_verified boolean not null default false,
  confidence real not null,
  consequential boolean not null,
  review_status text not null check (review_status in ('auto_filed', 'needs_review', 'reviewed')),
  recap_sent_at timestamptz,
  delivered_to_traveler_at timestamptz
);

create table observations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  supplier_name text not null,
  observed_at date not null,
  source text not null check (source in ('firsthand', 'supplier_claim', 'secondhand', 'written_confirmation')),
  personally_inspected boolean not null,
  statement text not null,
  applicability jsonb not null,
  request text,
  outcome text,
  booking_ref text,
  scope text not null default 'private' check (scope in ('private', 'workspace'))
);

create table knowledge_items (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  category text not null,
  body text not null,
  sharing_permission text not null check (sharing_permission in ('private', 'workspace', 'network')),
  confidentiality text not null check (confidentiality in ('shareable', 'confidential', 'restricted')),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  published_scope text not null default 'private' check (published_scope in ('private', 'workspace', 'network')),
  publication_status text not null default 'draft' check (publication_status in ('draft', 'awaiting_owner', 'published', 'declined'))
);

create table decisions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  expert_id uuid not null references members(id),
  trip_id uuid not null references trips(id) on delete cascade,
  kind text not null check (kind in ('select', 'reject', 'edit')),
  subject text not null,
  reason jsonb,
  learning jsonb,
  decided_at timestamptz not null default now()
);

create table brief_statements (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  client_id uuid not null references clients(id) on delete cascade,
  trip_id uuid references trips(id) on delete cascade,
  dimension text not null,
  text text not null,
  evidence text not null check (evidence in ('client_said', 'expert_inferred', 'agent_inferred')),
  source text not null,
  recorded_at timestamptz not null default now(),
  superseded_by uuid
);

-- Append-only record of every consequential action and who took it.
create table audit_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id),
  actor text not null,
  action text not null,
  subject text not null,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security



do $$
declare t text;
begin
  foreach t in array array['workspaces','members','clients','trips','trip_delegations','response_plans','trip_items','approvals',
    'execution_attempts','people','ledger_entries','commitments','observations','knowledge_items','decisions','brief_statements','audit_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;
grant usage, select on sequence audit_events_id_seq to app_user;
grant execute on function app_workspace(), app_member() to app_user;

create policy tenant on workspaces using (id = app_workspace());
create policy tenant on members using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());

create policy tenant on clients
  using (workspace_id = app_workspace() and (scope = 'workspace' or owner_id = app_member()))
  with check (workspace_id = app_workspace());
create policy tenant on people
  using (workspace_id = app_workspace() and (scope = 'workspace' or owner_id = app_member()))
  with check (workspace_id = app_workspace());
create policy tenant on observations
  using (workspace_id = app_workspace() and (scope = 'workspace' or owner_id = app_member()))
  with check (workspace_id = app_workspace());
create policy tenant on knowledge_items
  using (workspace_id = app_workspace() and (published_scope <> 'private' or owner_id = app_member()))
  with check (workspace_id = app_workspace());

-- Trips: shared within the workspace, or private to the owner and named, unexpired delegates.
create policy tenant on trips
  using (workspace_id = app_workspace()
         and (scope = 'workspace' or owner_id = app_member()
              or exists (select 1 from trip_delegations d
                         where d.trip_id = trips.id and d.member_id = app_member()
                           and (d.expires_at is null or d.expires_at > now()))))
  with check (workspace_id = app_workspace());
-- Delegations are visible within the workspace (they grant access, they don't hold content).
create policy tenant on trip_delegations using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
-- Everything hanging off a trip is visible exactly when the trip is (the subquery is itself filtered by the trips policy).
do $$
declare t text;
begin
  foreach t in array array['response_plans','trip_items','approvals','decisions']
  loop
    execute format('create policy tenant on %I using (workspace_id = app_workspace() and exists (select 1 from trips t where t.id = trip_id)) with check (workspace_id = app_workspace())', t);
  end loop;
end $$;
create policy tenant on commitments
  using (workspace_id = app_workspace() and (trip_id is null or exists (select 1 from trips t where t.id = trip_id)))
  with check (workspace_id = app_workspace());
create policy tenant on brief_statements
  using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id))
  with check (workspace_id = app_workspace());
create policy tenant on ledger_entries
  using (workspace_id = app_workspace() and exists (select 1 from people p where p.id = person_id))
  with check (workspace_id = app_workspace());
create policy tenant on execution_attempts using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
create policy tenant on audit_events using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
