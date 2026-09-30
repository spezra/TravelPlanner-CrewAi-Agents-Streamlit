-- Calls and commitments: call tasks routed by relationship, per-party consent,
-- capture (recorded audio, voice debriefs, notes), encrypted transcripts,
-- commitment extraction bookkeeping, recaps, reminders and audio retention.
--
-- Call tasks are private to the relationship holder by default: a private task
-- is visible to its owner, its creator, its assignee, and members authorized on
-- its trip (the trip owner or an unexpired delegate). Everything hanging off a
-- task (parties, recordings, transcripts, notes, extractions, recaps) is visible
-- exactly when the task is.

-- Per-workspace call configuration. The consent table is illustrative, not legal
-- advice; owners and admins edit it. No row means the defaults (see src/modules/calls/settings.ts).
create table call_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  consent_table jsonb not null,
  audio_retention_days int not null default 30 check (audio_retention_days between 1 and 3650),
  updated_by uuid references members(id),
  updated_at timestamptz not null default now()
);

create table call_tasks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  -- The relationship holder (the person's owner), or the creator when no person is attached.
  owner_id uuid not null references members(id),
  created_by uuid not null references members(id),
  trip_id uuid references trips(id) on delete cascade,
  person_id uuid references people(id) on delete set null,
  purpose text not null,
  ask text not null,
  leverage text,
  fallback text,
  done_when text not null,
  spends_relationship_capital boolean not null,
  importance text not null default 'routine' check (importance in ('routine', 'important', 'critical')),
  automation_permitted boolean not null default false,
  route text not null check (route in ('relationship_holder', 'delegate', 'automated')),
  assignee_id uuid references members(id),
  disclosure text,
  capture_mode text not null default 'notes' check (capture_mode in ('notes', 'recorded')),
  status text not null default 'open' check (status in ('open', 'done', 'canceled')),
  outcome text,
  scope text not null default 'private' check (scope in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index on call_tasks (workspace_id, status);
create index on call_tasks (trip_id);

create table call_parties (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  call_task_id uuid not null references call_tasks(id) on delete cascade,
  name text not null,
  -- e.g. 'US-CA', 'FR'. null when unknown: the stricter rule applies.
  jurisdiction text,
  side text not null check (side in ('ours', 'theirs')),
  joined_reason text not null default 'initial' check (joined_reason in ('initial', 'joined', 'transferred')),
  consent_logged_at timestamptz,
  consent_logged_by uuid references members(id),
  -- How the expert disclosed the recording ("said so at the start", "email beforehand"). The expert chooses.
  consent_method text,
  left_at timestamptz,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index on call_parties (call_task_id);

create table call_recordings (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  call_task_id uuid not null references call_tasks(id) on delete cascade,
  kind text not null check (kind in ('call_audio', 'voice_debrief')),
  -- Blob holds workspace-key ciphertext only; null once purged.
  blob_key text,
  content_type text not null,
  byte_size int not null,
  uploaded_by uuid not null references members(id),
  uploaded_at timestamptz not null default now(),
  status text not null default 'stored' check (status in ('stored', 'transcribed', 'failed', 'purged')),
  transcribe_attempt int not null default 1,
  last_error text,
  purged_at timestamptz
);
create index on call_recordings (call_task_id);
create index call_recordings_unpurged on call_recordings (uploaded_at) where purged_at is null;

create table call_transcripts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  call_task_id uuid not null references call_tasks(id) on delete cascade,
  recording_id uuid references call_recordings(id) on delete set null,
  source text not null check (source in ('call_audio', 'voice_debrief')),
  -- Encrypted JSON array of speaker-labeled segments.
  body_enc text not null,
  provider text not null,
  -- Machine-transcribed until a person checks names, amounts, dates and speakers.
  verified_at timestamptz,
  verified_by uuid references members(id),
  created_at timestamptz not null default now()
);
-- One transcript per recording, so a re-run transcription job can't file twice.
create unique index call_transcripts_recording on call_transcripts (recording_id) where recording_id is not null;
create index on call_transcripts (call_task_id);

-- Notes mode: no audio processed. The expert completes a template pre-filled from the task.
create table call_notes (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  call_task_id uuid not null references call_tasks(id) on delete cascade,
  author_id uuid not null references members(id),
  body_enc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Filed notes are immutable: commitments were extracted from exactly this text.
  filed_at timestamptz
);
create index on call_notes (call_task_id);

-- One row per source (transcript or filed note): makes extraction idempotent and shows its outcome.
create table call_extractions (
  workspace_id uuid not null references workspaces(id),
  source_ref text not null,
  call_task_id uuid not null references call_tasks(id) on delete cascade,
  status text not null check (status in ('done', 'manual', 'failed')),
  filed_count int not null default 0,
  -- Encrypted JSON list of names/amounts/dates a person should check.
  unclear_enc text,
  detail text,
  attempt int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, source_ref)
);

-- Written recaps of our understanding, as sent.
create table call_recaps (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  call_task_id uuid references call_tasks(id) on delete cascade,
  commitment_ids uuid[] not null,
  to_email text not null,
  subject text not null,
  body_enc text not null,
  sent_by uuid not null references members(id),
  sent_at timestamptz not null default now()
);

-- A reminder goes out once per commitment per condition.
create table commitment_reminders (
  workspace_id uuid not null references workspaces(id),
  commitment_id uuid not null references commitments(id) on delete cascade,
  kind text not null check (kind in ('due_soon', 'overdue')),
  sent_to uuid references members(id),
  sent_at timestamptz not null default now(),
  primary key (commitment_id, kind)
);

alter table commitments add column call_task_id uuid references call_tasks(id) on delete set null;
create index on commitments (call_task_id);
create index commitments_evidence_ref on commitments (workspace_id, evidence_ref);

-- ---------------------------------------------------------------------------
-- Row-level security

do $$
declare t text;
begin
  foreach t in array array['call_settings','call_tasks','call_parties','call_recordings','call_transcripts','call_notes',
    'call_extractions','call_recaps','commitment_reminders']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_user, app_system', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;

-- Everyone in the workspace reads the settings; only owners and admins change them.
create policy tenant_read on call_settings for select to app_user using (workspace_id = app_workspace());
create policy tenant_write on call_settings for all to app_user
  using (workspace_id = app_workspace()
         and exists (select 1 from members m where m.id = app_member() and m.role in ('owner', 'admin') and m.disabled_at is null))
  with check (workspace_id = app_workspace()
         and exists (select 1 from members m where m.id = app_member() and m.role in ('owner', 'admin') and m.disabled_at is null));

create policy tenant on call_tasks to app_user
  using (workspace_id = app_workspace()
         and (trip_id is null or exists (select 1 from trips t where t.id = trip_id))
         and (scope = 'workspace' or owner_id = app_member() or created_by = app_member() or assignee_id = app_member()
              or exists (select 1 from trips t
                          where t.id = trip_id
                            and (t.owner_id = app_member()
                                 or exists (select 1 from trip_delegations d
                                             where d.trip_id = t.id and d.member_id = app_member()
                                               and (d.expires_at is null or d.expires_at > now()))))))
  with check (workspace_id = app_workspace());

do $$
declare t text;
begin
  foreach t in array array['call_parties','call_recordings','call_transcripts','call_notes','call_extractions']
  loop
    execute format('create policy tenant on %I to app_user using (workspace_id = app_workspace() and exists (select 1 from call_tasks c where c.id = call_task_id)) with check (workspace_id = app_workspace())', t);
  end loop;
end $$;

create policy tenant on call_recaps to app_user
  using (workspace_id = app_workspace() and (call_task_id is null or exists (select 1 from call_tasks c where c.id = call_task_id)))
  with check (workspace_id = app_workspace());
create policy tenant on commitment_reminders to app_user
  using (workspace_id = app_workspace() and exists (select 1 from commitments c where c.id = commitment_id))
  with check (workspace_id = app_workspace());

-- Commitments that came from a call are as private as the call.
create policy calls_private on commitments as restrictive to app_user
  using (call_task_id is null or exists (select 1 from call_tasks c where c.id = call_task_id));
