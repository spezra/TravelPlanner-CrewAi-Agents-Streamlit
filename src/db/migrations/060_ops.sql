-- Ops slice: clients and briefs, judgment capture, response plans and
-- escalation, workspace operations and compliance (exports, data-subject
-- requests, retention, workspace deletion).
--
-- Encrypted columns end in _enc and hold ciphertext from src/server/crypto.ts
-- (context "<table>.<column>:<row id>"), so crypto-shredding the workspace
-- keys makes them unreadable.

-- ---------------------------------------------------------------------------
-- Existing tables

alter table workspaces add column deleted_at timestamptz;
alter table workspaces add column deletion_requested_at timestamptz;
-- Retention limits (days). sourceTextDays: pasted call notes/emails and decision
-- conversations kept for extraction; rawAudioDays: consumed by call capture.
alter table workspaces add column retention jsonb not null default '{"sourceTextDays": 90, "rawAudioDays": 30}';

alter table clients add column email text;
alter table clients add column phone text;
alter table clients add column notes_enc text;
alter table clients add column erased_at timestamptz;
alter table clients add column updated_at timestamptz not null default now();

alter table brief_statements add column outcome_kind text check (outcome_kind in ('enjoyed', 'regretted', 'would_repeat'));
alter table brief_statements add column recorded_by uuid references members(id);
-- Learned from a judgment decision; unique so a re-run job can't file it twice.
alter table brief_statements add column origin_decision_id uuid unique;

-- A decision can concern a trip item or a proposal option (referenced by id from the proposals feature).
alter table decisions add column item_id uuid references trip_items(id) on delete set null;
alter table decisions add column option_ref text;
alter table decisions add column supplier_name text;
alter table decisions add column client_id uuid references clients(id) on delete set null;
alter table decisions add column before_text text;
alter table decisions add column after_text text;
alter table decisions add column conversation_enc text;
alter table decisions add column status text not null default 'recorded'
  check (status in ('recorded', 'classifying', 'awaiting_answer', 'learned', 'unexplained', 'failed'));
alter table decisions add column question text;
alter table decisions add column learning_target text check (learning_target in ('taste_model', 'client_brief', 'supplier_record', 'trip'));
alter table decisions add column answered_at timestamptz;
create index decisions_expert on decisions (expert_id, decided_at desc);

-- ---------------------------------------------------------------------------
-- Clients

create table client_party_members (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  relation text not null default '',
  notes_enc text,
  erased_at timestamptz,
  created_at timestamptz not null default now()
);
create index on client_party_members (client_id);

-- Pasted call notes or emails submitted for brief extraction. The source is encrypted and purged by retention.
create table brief_extractions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  client_id uuid not null references clients(id) on delete cascade,
  trip_id uuid references trips(id) on delete cascade,
  source_label text not null,
  source_enc text,
  status text not null check (status in ('queued', 'done', 'failed')),
  error text,
  requested_by uuid not null references members(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Agent-extracted statements awaiting the expert. Accepting one files a brief statement; evidence stays as extracted.
create table brief_suggestions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  extraction_id uuid not null references brief_extractions(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  trip_id uuid references trips(id) on delete cascade,
  dimension text not null check (dimension in ('desired_experience', 'practical_constraints', 'party_dynamics', 'outcomes')),
  text text not null,
  evidence text not null check (evidence in ('client_said', 'expert_inferred', 'agent_inferred')),
  -- The source ties it to one trip; if the extraction had no trip, the expert picks one on accept.
  trip_specific boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  statement_id uuid,
  decided_by uuid references members(id),
  decided_at timestamptz,
  position int not null default 0
);
create index on brief_suggestions (client_id, status);

-- ---------------------------------------------------------------------------
-- Judgment: where each kind of reason is learned

-- The expert's taste model. Agent-derived learnings are provisional until the expert endorses them.
create table expert_learnings (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  expert_id uuid not null references members(id),
  decision_id uuid unique references decisions(id) on delete set null,
  kind text not null check (kind in ('select', 'reject', 'edit')),
  subject text not null,
  summary text not null,
  status text not null check (status in ('provisional', 'endorsed', 'retracted')),
  observed_at timestamptz not null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on expert_learnings (expert_id, status);

-- The supplier record, dated. Conditions expire (construction, closures, a departed chef).
create table supplier_conditions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  supplier_name text not null,
  condition text not null,
  observed_at timestamptz not null,
  valid_until date,
  provisional boolean not null default false,
  decision_id uuid unique references decisions(id) on delete set null,
  scope text not null default 'private' check (scope in ('private', 'workspace')),
  created_at timestamptz not null default now()
);
create index on supplier_conditions (workspace_id, lower(supplier_name));

-- Lessons that apply to this trip only.
create table trip_notes (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  decision_id uuid unique references decisions(id) on delete cascade,
  text text not null,
  created_by uuid references members(id),
  created_at timestamptz not null default now()
);

-- Whether the expert endorsed an agent draft: the measure of whether drafts converge on their taste.
create table draft_outcomes (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  expert_id uuid not null references members(id),
  trip_id uuid references trips(id) on delete set null,
  draft_ref text not null,
  outcome text not null check (outcome in ('endorsed_unchanged', 'endorsed_with_edits', 'rejected')),
  note text,
  recorded_at timestamptz not null default now()
);
create index on draft_outcomes (expert_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- Response and escalation

create table escalations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  -- Attention-queue key (e.g. "reconcile:<item id>") so one open event exists per condition.
  source_key text not null,
  kind text not null check (kind in ('reconcile', 'disruption', 'commitment_overdue', 'unhappy_client')),
  title text not null,
  detail text not null default '',
  raised_at timestamptz not null,
  raised_by text not null,
  step int not null default 0,
  tried jsonb not null default '[]',
  last_notified_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references members(id),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text
);
create unique index escalations_open_key on escalations (workspace_id, source_key) where resolved_at is null;
create index escalations_open on escalations (raised_at) where resolved_at is null and acknowledged_at is null;

-- One row per responder tried: the dedupe for "notify once per step". sent_at is set after the email goes.
create table escalation_notifications (
  escalation_id uuid not null references escalations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  member_id uuid not null references members(id),
  step int not null,
  role text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (escalation_id, member_id)
);

-- ---------------------------------------------------------------------------
-- Compliance

create table workspace_exports (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  requested_by uuid not null references members(id),
  subject_type text check (subject_type in ('client', 'party_member', 'person')),
  subject_id uuid,
  request_id uuid,
  status text not null check (status in ('queued', 'ready', 'downloaded', 'expired', 'failed')),
  blob_key text,
  bytes int,
  error text,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  downloaded_at timestamptz,
  expires_at timestamptz not null
);

create table data_subject_requests (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  subject_type text not null check (subject_type in ('client', 'party_member', 'person')),
  subject_id uuid not null,
  -- Non-identifying label kept after erasure, e.g. "client 3f2a…".
  subject_ref text not null,
  kind text not null check (kind in ('access', 'deletion')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'completed', 'rejected')),
  requested_by uuid not null references members(id),
  received_at timestamptz not null,
  note text,
  export_id uuid references workspace_exports(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references members(id)
);

-- What was erased, when and under which request. Holds no personal data.
create table erasure_tombstones (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  subject_type text not null,
  subject_id uuid not null,
  request_id uuid references data_subject_requests(id),
  erased_at timestamptz not null,
  erased_by uuid references members(id),
  fields jsonb not null default '{}'
);

-- ---------------------------------------------------------------------------
-- Row-level security

do $$
declare t text;
begin
  foreach t in array array['client_party_members','brief_extractions','brief_suggestions','expert_learnings','supplier_conditions',
    'trip_notes','draft_outcomes','escalations','escalation_notifications','workspace_exports','data_subject_requests','erasure_tombstones']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_user, app_system', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;

-- Owners and admins of the current workspace (compliance records are theirs).
create or replace function app_is_admin() returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from members where id = app_member() and workspace_id = app_workspace()
                    and role in ('owner', 'admin') and disabled_at is null) $$;
revoke all on function app_is_admin() from public;
grant execute on function app_is_admin() to app_user, app_system;

-- Client children are visible exactly when the client is (private clients stay with their owner).
create policy tenant on client_party_members to app_user
  using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id))
  with check (workspace_id = app_workspace());
-- Extraction material also follows the trip it was captured for.
create policy tenant on brief_extractions to app_user
  using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id)
         and (trip_id is null or exists (select 1 from trips t where t.id = trip_id)))
  with check (workspace_id = app_workspace());
create policy tenant on brief_suggestions to app_user
  using (workspace_id = app_workspace() and exists (select 1 from clients c where c.id = client_id)
         and (trip_id is null or exists (select 1 from trips t where t.id = trip_id)))
  with check (workspace_id = app_workspace());

-- The taste model and endorsement record belong to the expert alone.
create policy tenant on expert_learnings to app_user
  using (workspace_id = app_workspace() and expert_id = app_member())
  with check (workspace_id = app_workspace() and expert_id = app_member());
create policy tenant on draft_outcomes to app_user
  using (workspace_id = app_workspace() and expert_id = app_member())
  with check (workspace_id = app_workspace() and expert_id = app_member());

-- Learned supplier conditions land in the private store first.
create policy tenant on supplier_conditions to app_user
  using (workspace_id = app_workspace() and (scope = 'workspace' or owner_id = app_member()))
  with check (workspace_id = app_workspace());

do $$
declare t text;
begin
  foreach t in array array['trip_notes','escalations']
  loop
    execute format('create policy tenant on %I to app_user using (workspace_id = app_workspace() and exists (select 1 from trips t where t.id = trip_id)) with check (workspace_id = app_workspace())', t);
  end loop;
end $$;
create policy tenant on escalation_notifications to app_user
  using (workspace_id = app_workspace() and exists (select 1 from escalations e where e.id = escalation_id))
  with check (workspace_id = app_workspace());

-- An export is readable (and downloadable) only by the member who requested it.
create policy tenant on workspace_exports to app_user
  using (workspace_id = app_workspace() and requested_by = app_member())
  with check (workspace_id = app_workspace() and requested_by = app_member());

create policy tenant on data_subject_requests to app_user
  using (workspace_id = app_workspace() and app_is_admin())
  with check (workspace_id = app_workspace() and app_is_admin());
create policy tenant on erasure_tombstones to app_user
  using (workspace_id = app_workspace() and app_is_admin())
  with check (workspace_id = app_workspace() and app_is_admin());
