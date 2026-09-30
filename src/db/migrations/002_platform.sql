-- Platform foundations: identity, sessions, invitations, background jobs,
-- per-workspace encryption keys and rate limiting.
--
-- Two database roles carry all application access:
--   app_user   tenant-bound, subject to the row-level security policies in 001.
--   app_system platform services (sign-in, job dispatch, webhooks). Sees every
--              row through explicit per-role policies; used only by server code
--              that has already established who it is acting for.
-- The connecting login owns the tables but, because RLS is forced, sees nothing
-- itself: every query must go through withTenant or withSystem.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_system') then
    create role app_system nologin;
  end if;
end $$;
do $$ begin
  execute format('grant app_system to %I', current_user);
exception when others then null;
end $$;
grant usage on schema public to app_system;

-- Tenant tables: app_system gets full access through a role-targeted policy.
do $$
declare t text;
begin
  foreach t in array array['workspaces','members','clients','trips','trip_delegations','response_plans','trip_items','approvals',
    'execution_attempts','people','ledger_entries','commitments','observations','knowledge_items','decisions','brief_statements','audit_events']
  loop
    execute format('grant select, insert, update, delete on %I to app_system', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;
grant usage, select on sequence audit_events_id_seq to app_system;
grant execute on function app_workspace(), app_member() to app_system;

create table users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

alter table members add column user_id uuid references users(id);
alter table members add column disabled_at timestamptz;
create unique index members_user_workspace on members (workspace_id, user_id) where user_id is not null;

create table login_tokens (
  token_hash text primary key,
  email text not null,
  purpose text not null check (purpose in ('login', 'signup')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key,
  token_hash text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  member_id uuid references members(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index on sessions (user_id);

create table invitations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'advisor', 'assistant', 'admin')),
  token_hash text not null unique,
  invited_by uuid not null references members(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);

-- Background work. Handlers must be idempotent: a job can run more than once.
create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  workspace_id uuid references workspaces(id) on delete cascade,
  -- The member on whose behalf the job acts; agents never hold more access than that person.
  member_id uuid references members(id) on delete cascade,
  dedupe_key text unique,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 8,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_ready on jobs (run_at) where status = 'queued';

-- Envelope encryption: each workspace has data keys wrapped by the platform master key.
create table workspace_keys (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  version int not null,
  wrapped_key text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  primary key (workspace_id, version)
);

do $$
declare t text;
begin
  foreach t in array array['users','login_tokens','sessions','invitations','rate_limits','jobs','workspace_keys']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_system', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;
grant usage, select on sequence jobs_id_seq to app_system;

-- Members can see their own workspace's invitations (for the settings page).
grant select on invitations to app_user;
create policy tenant on invitations to app_user using (workspace_id = app_workspace());

-- Wrapped data keys are useless without the master key, so tenant code may read
-- (and lazily create) its own workspace's keys; that keeps encryption inside withTenant.
grant select, insert on workspace_keys to app_user;
create policy tenant on workspace_keys to app_user using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());

-- Tenant code enqueues work for its own workspace, acting as the current member.
create or replace function enqueue_job(p_kind text, p_payload jsonb, p_dedupe text, p_run_at timestamptz, p_max int)
returns void language sql security definer set search_path = public as $$
  insert into jobs (kind, payload, workspace_id, member_id, dedupe_key, run_at, max_attempts)
  values (p_kind, p_payload, app_workspace(), app_member(), p_dedupe, p_run_at, p_max)
  on conflict (dedupe_key) do nothing
$$;
revoke all on function enqueue_job(text, jsonb, text, timestamptz, int) from public;
grant execute on function enqueue_job(text, jsonb, text, timestamptz, int) to app_user, app_system;
