-- Knowledge and network: dated supplier observations with photos, the
-- permission-first publication pipeline, the curated cross-workspace network
-- (membership, discoverability profiles, published knowledge) and
-- collaborations between experts in different workspaces.
--
-- Cross-workspace reads are the exception, and each is written as its own
-- policy so it can be reviewed on its own:
--   published_knowledge / network_profiles  network scope, both workspaces admitted
--   collaborations and their children        the two named parties only
--   collaboration_shares                     the specialist, only after both sides accepted
--                                            the same terms version and until access expires
-- Writes always stay in the writer's own workspace.

-- ---------------------------------------------------------------------------
-- Observations: photos (encrypted blobs) and bookkeeping timestamps.

alter table observations add column if not exists photo_key text;
alter table observations add column if not exists photo_content_type text;
alter table observations add column if not exists created_at timestamptz not null default now();
alter table observations add column if not exists updated_at timestamptz not null default now();
alter table observations add column if not exists created_by uuid references members(id);
create index if not exists observations_supplier on observations (workspace_id, lower(supplier_name));

-- ---------------------------------------------------------------------------
-- Knowledge items: the owner's private source material plus pipeline state.
-- The CRM slice may add needs_review / depends_on_person_id too; either order works.

alter table knowledge_items add column if not exists needs_review boolean not null default false;
alter table knowledge_items add column if not exists depends_on_person_id uuid;
alter table knowledge_items add column if not exists destination text;
alter table knowledge_items add column if not exists source_observation_ids jsonb not null default '[]';
alter table knowledge_items add column if not exists target_scope text check (target_scope in ('workspace', 'network'));
alter table knowledge_items add column if not exists candidate_body text;
alter table knowledge_items add column if not exists redaction_findings jsonb not null default '[]';
alter table knowledge_items add column if not exists review_flags jsonb not null default '[]';
alter table knowledge_items add column if not exists source_check jsonb;
alter table knowledge_items add column if not exists hold_reasons jsonb not null default '[]';
alter table knowledge_items add column if not exists submission_key text;
alter table knowledge_items add column if not exists submitted_at timestamptz;
alter table knowledge_items add column if not exists decided_at timestamptz;
alter table knowledge_items add column if not exists decline_reason text;
alter table knowledge_items add column if not exists created_at timestamptz not null default now();
alter table knowledge_items add column if not exists updated_at timestamptz not null default now();
alter table knowledge_items drop constraint if exists knowledge_items_publication_status_check;
alter table knowledge_items add constraint knowledge_items_publication_status_check
  check (publication_status in ('draft', 'processing', 'awaiting_owner', 'published', 'declined'));

-- Source material is the owner's alone. What colleagues and the network see is the
-- redacted, approved copy in published_knowledge, never the source body.
drop policy if exists tenant on knowledge_items;
create policy tenant on knowledge_items
  using (workspace_id = app_workspace() and owner_id = app_member())
  with check (workspace_id = app_workspace());

-- Standing rules: an owner pre-approves publication for a category up to a scope.
-- Restricted categories can never have one.
create table knowledge_standing_rules (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  category text not null check (category not in ('commercial_terms', 'unpublished_availability', 'relationship_concession')),
  scope text not null check (scope in ('workspace', 'network')),
  created_at timestamptz not null default now(),
  unique (owner_id, category)
);

-- The published, redacted copy. One row per item; scope is the widest it was approved for.
create table published_knowledge (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  item_id uuid not null unique references knowledge_items(id) on delete cascade,
  owner_id uuid not null references members(id),
  category text not null,
  destination text,
  scope text not null check (scope in ('workspace', 'network')),
  body text not null,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  source_fingerprint text not null,
  -- Held back while the source item needs review (e.g. the person it depended on moved).
  held boolean not null default false,
  published_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  -- Defense in depth for the domain rules: restricted categories never publish,
  -- and the network never carries contact details.
  check (category not in ('commercial_terms', 'unpublished_availability', 'relationship_concession')),
  check (scope = 'workspace' or category <> 'contact_details')
);
create index published_knowledge_scope on published_knowledge (scope) where withdrawn_at is null and not held;

-- ---------------------------------------------------------------------------
-- Network membership. Curated: a workspace may apply, only platform operators admit
-- (see src/modules/network/membership.ts admitToNetwork and admit-cli.ts).

create table network_members (
  workspace_id uuid primary key references workspaces(id),
  requested_at timestamptz,
  requested_by uuid references members(id),
  application_note text,
  admitted_at timestamptz,
  admitted_by text,
  removed_at timestamptz,
  removed_by text,
  removal_reason text,
  created_at timestamptz not null default now()
);

-- Discoverability: that someone can help with a need. No contact details or methods.
create table network_profiles (
  member_id uuid primary key references members(id),
  workspace_id uuid not null references workspaces(id),
  display_name text not null,
  headline text,
  destinations jsonb not null default '[]',
  capabilities jsonb not null default '[]',
  languages jsonb not null default '[]',
  response_capacity text not null default 'available' check (response_capacity in ('available', 'limited', 'unavailable')),
  discoverable boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Membership checks run as the definer so a tenant can ask "are we both admitted?"
-- without being able to list the membership table.
create or replace function network_admitted(ws uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from network_members nm where nm.workspace_id = ws and nm.admitted_at is not null and nm.removed_at is null)
$$;
create or replace function network_visible(ws uuid) returns boolean language sql stable security definer set search_path = public as $$
  select network_admitted(app_workspace()) and network_admitted(ws)
$$;
revoke all on function network_admitted(uuid) from public;
revoke all on function network_visible(uuid) from public;
grant execute on function network_admitted(uuid) to app_system;
grant execute on function network_visible(uuid) to app_user, app_system;

-- Names the redactor must remove: every person, client and member of the caller's
-- workspace, including private relationship records the caller can't open.
-- Returns names only, into server memory; never shown.
create or replace function redaction_names() returns table (name text, kind text) language sql stable security definer set search_path = public as $$
  select p.name, 'person' from people p where p.workspace_id = app_workspace()
  union all select c.name, 'client' from clients c where c.workspace_id = app_workspace()
  union all select m.name, 'member' from members m where m.workspace_id = app_workspace()
$$;
revoke all on function redaction_names() from public;
grant execute on function redaction_names() to app_user, app_system;

-- When a relationship changes, any member of the workspace (or the CRM's jobs) can flag
-- knowledge that depended on that person, even items they can't read.
create or replace function flag_knowledge_for_person(p_person uuid) returns int language sql volatile security definer set search_path = public as $$
  with flagged as (
    update knowledge_items set needs_review = true, updated_at = now()
     where workspace_id = app_workspace() and depends_on_person_id = p_person and not needs_review
    returning id
  ) select count(*)::int from flagged
$$;
revoke all on function flag_knowledge_for_person(uuid) from public;
grant execute on function flag_knowledge_for_person(uuid) to app_user, app_system;

-- Keep the published copy held while its source needs review, whoever set the flag.
create or replace function knowledge_hold_sync() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update published_knowledge set held = new.needs_review where item_id = new.id and held is distinct from new.needs_review;
  return new;
end $$;
drop trigger if exists knowledge_hold_sync on knowledge_items;
create trigger knowledge_hold_sync after update of needs_review on knowledge_items
  for each row execute function knowledge_hold_sync();

-- ---------------------------------------------------------------------------
-- Collaborations. workspace_id is the requester's workspace.

create table collaborations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  requester_member_id uuid not null references members(id),
  specialist_workspace_id uuid not null references workspaces(id),
  specialist_member_id uuid not null references members(id),
  -- Display names as each party chose to appear (network profile), snapshotted at request time.
  requester_name text not null,
  specialist_name text not null,
  trip_id uuid references trips(id) on delete set null,
  contribution text not null check (contribution in ('answer_question', 'review_itinerary', 'activate_relationship', 'design_segment', 'operate_segment')),
  state text not null check (state in ('requested', 'brief_shared', 'terms_agreed', 'active', 'completed', 'declined', 'withdrawn')),
  destination text,
  -- Anonymized: exactly what the specialist sees before terms.
  brief jsonb not null,
  agreed_terms_version int,
  client_access_expires_at timestamptz,
  access_expiry_logged_at timestamptz,
  decline_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (workspace_id <> specialist_workspace_id)
);
create index on collaborations (specialist_workspace_id, specialist_member_id);
create index on collaborations (workspace_id);

create table collaboration_terms (
  id uuid primary key,
  collaboration_id uuid not null references collaborations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id), -- proposer's workspace
  version int not null,
  proposed_by uuid not null references members(id),
  proposed_by_side text not null check (proposed_by_side in ('requester', 'specialist')),
  terms jsonb not null,
  fingerprint text not null,
  requester_accepted_at timestamptz,
  requester_accepted_by uuid references members(id),
  specialist_accepted_at timestamptz,
  specialist_accepted_by uuid references members(id),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (collaboration_id, version)
);

-- Client details the work needs, snapshotted by the requester. workspace_id is the requester's.
create table collaboration_shares (
  id uuid primary key,
  collaboration_id uuid not null references collaborations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  kind text not null check (kind in ('client', 'trip_item', 'brief_statement', 'note')),
  source_id uuid,
  label text not null,
  content jsonb not null,
  content_fingerprint text not null,
  shared_by uuid not null references members(id),
  shared_at timestamptz not null default now(),
  refreshed_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create unique index collaboration_shares_source on collaboration_shares (collaboration_id, kind, source_id) where source_id is not null;

-- workspace_id is the specialist's.
create table collaboration_endorsements (
  id uuid primary key,
  collaboration_id uuid not null references collaborations(id) on delete cascade,
  share_id uuid not null references collaboration_shares(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  specialist_member_id uuid not null references members(id),
  reviewed_fingerprint text not null,
  note text,
  endorsed_at timestamptz not null default now(),
  withdrawn_at timestamptz
);

-- Every activation is a separate ask to the relationship holder, decided by them alone.
-- workspace_id is the requester's.
create table relationship_activations (
  id uuid primary key,
  collaboration_id uuid not null references collaborations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  requested_by uuid not null references members(id),
  holder_workspace_id uuid not null references workspaces(id),
  holder_member_id uuid not null references members(id),
  relationship_hint text not null,
  ask text not null,
  decision text not null default 'pending' check (decision in ('pending', 'yes', 'no')),
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- Append-only record of who did what, when. Supports amendments and disputes.
-- workspace_id is the actor's workspace.
create table collaboration_log (
  id uuid primary key,
  seq bigserial not null,
  collaboration_id uuid not null references collaborations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id),
  actor_member_id uuid references members(id),
  actor_side text not null check (actor_side in ('requester', 'specialist', 'system')),
  kind text not null,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index on collaboration_log (collaboration_id, seq);

-- ---------------------------------------------------------------------------
-- Row-level security

do $$
declare t text;
begin
  foreach t in array array['knowledge_standing_rules','published_knowledge','network_members','network_profiles','collaborations',
    'collaboration_terms','collaboration_shares','collaboration_endorsements','relationship_activations','collaboration_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('grant select, insert, update, delete on %I to app_system', t);
    execute format('create policy system_all on %I to app_system using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert, update, delete on knowledge_standing_rules, published_knowledge, network_profiles, collaborations,
  collaboration_terms, collaboration_shares, collaboration_endorsements, relationship_activations to app_user;
-- Membership: read your own row and apply; admission is platform-only.
grant select, insert on network_members to app_user;
-- The contribution log is append-only for tenants.
grant select, insert on collaboration_log to app_user;
grant usage, select on sequence collaboration_log_seq_seq to app_user, app_system;

create policy tenant on knowledge_standing_rules to app_user
  using (workspace_id = app_workspace() and owner_id = app_member())
  with check (workspace_id = app_workspace() and owner_id = app_member());

-- Published knowledge: the whole workspace reads its own live rows (owners also see held
-- and withdrawn ones); only the owner writes.
create policy tenant_read on published_knowledge for select to app_user
  using (workspace_id = app_workspace() and ((withdrawn_at is null and not held) or owner_id = app_member()));
create policy tenant_insert on published_knowledge for insert to app_user
  with check (workspace_id = app_workspace() and owner_id = app_member());
create policy tenant_update on published_knowledge for update to app_user
  using (workspace_id = app_workspace() and owner_id = app_member())
  with check (workspace_id = app_workspace() and owner_id = app_member());
create policy tenant_delete on published_knowledge for delete to app_user
  using (workspace_id = app_workspace() and owner_id = app_member());
-- Cross-workspace: network-scoped, live, and both workspaces admitted.
create policy network_read on published_knowledge for select to app_user
  using (scope = 'network' and withdrawn_at is null and not held and network_visible(workspace_id));

create policy tenant on network_members for select to app_user using (workspace_id = app_workspace());
create policy tenant_apply on network_members for insert to app_user
  with check (workspace_id = app_workspace() and requested_by = app_member()
              and admitted_at is null and admitted_by is null and removed_at is null);

create policy tenant_read on network_profiles for select to app_user using (workspace_id = app_workspace());
create policy tenant_write on network_profiles for insert to app_user
  with check (workspace_id = app_workspace() and member_id = app_member());
create policy tenant_update on network_profiles for update to app_user
  using (workspace_id = app_workspace() and member_id = app_member())
  with check (workspace_id = app_workspace() and member_id = app_member());
create policy tenant_delete on network_profiles for delete to app_user
  using (workspace_id = app_workspace() and member_id = app_member());
create policy network_read on network_profiles for select to app_user
  using (discoverable and network_visible(workspace_id));

-- Collaborations: the requester (and members who can see its trip) and the named specialist.
create policy parties on collaborations for select to app_user
  using ((workspace_id = app_workspace()
          and (requester_member_id = app_member() or (trip_id is not null and exists (select 1 from trips t where t.id = trip_id))))
         or (specialist_workspace_id = app_workspace() and specialist_member_id = app_member()));
create policy request on collaborations for insert to app_user
  with check (workspace_id = app_workspace() and requester_member_id = app_member() and state = 'requested'
              and network_visible(specialist_workspace_id));
create policy parties_update on collaborations for update to app_user
  using ((workspace_id = app_workspace() and requester_member_id = app_member())
         or (specialist_workspace_id = app_workspace() and specialist_member_id = app_member()))
  with check ((workspace_id = app_workspace() and requester_member_id = app_member())
              or (specialist_workspace_id = app_workspace() and specialist_member_id = app_member()));

-- Children of a collaboration are visible exactly when the collaboration is
-- (the subquery is itself filtered by the collaborations policy).
create policy parties on collaboration_terms for select to app_user
  using (exists (select 1 from collaborations c where c.id = collaboration_id));
create policy propose on collaboration_terms for insert to app_user
  with check (workspace_id = app_workspace() and proposed_by = app_member()
              and exists (select 1 from collaborations c where c.id = collaboration_id));
create policy parties_update on collaboration_terms for update to app_user
  using (exists (select 1 from collaborations c where c.id = collaboration_id))
  with check (exists (select 1 from collaborations c where c.id = collaboration_id));

create policy requester on collaboration_shares to app_user
  using (workspace_id = app_workspace()
         and exists (select 1 from collaborations c where c.id = collaboration_id and c.workspace_id = app_workspace() and c.requester_member_id = app_member()))
  with check (workspace_id = app_workspace()
              and exists (select 1 from collaborations c where c.id = collaboration_id and c.workspace_id = app_workspace() and c.requester_member_id = app_member()));
-- Cross-workspace: the named specialist, after terms were agreed by both sides, until access expires.
create policy specialist_read on collaboration_shares for select to app_user
  using (revoked_at is null and (expires_at is null or expires_at > now())
         and exists (select 1 from collaborations c
                      where c.id = collaboration_id
                        and c.specialist_workspace_id = app_workspace() and c.specialist_member_id = app_member()
                        and c.state in ('terms_agreed', 'active') and c.agreed_terms_version is not null
                        and c.client_access_expires_at > now()));

create policy parties on collaboration_endorsements for select to app_user
  using (exists (select 1 from collaborations c where c.id = collaboration_id));
create policy specialist on collaboration_endorsements for insert to app_user
  with check (workspace_id = app_workspace() and specialist_member_id = app_member()
              and exists (select 1 from collaborations c where c.id = collaboration_id and c.specialist_member_id = app_member()));
create policy specialist_update on collaboration_endorsements for update to app_user
  using (workspace_id = app_workspace() and specialist_member_id = app_member())
  with check (workspace_id = app_workspace() and specialist_member_id = app_member());

create policy parties on relationship_activations for select to app_user
  using (exists (select 1 from collaborations c where c.id = collaboration_id));
create policy request on relationship_activations for insert to app_user
  with check (workspace_id = app_workspace() and requested_by = app_member() and decision = 'pending'
              and exists (select 1 from collaborations c
                           where c.id = collaboration_id and c.workspace_id = app_workspace() and c.requester_member_id = app_member()
                             and c.specialist_member_id = holder_member_id and c.specialist_workspace_id = holder_workspace_id));
-- Only the holder decides, and only once.
create policy holder_decides on relationship_activations for update to app_user
  using (holder_workspace_id = app_workspace() and holder_member_id = app_member() and decision = 'pending')
  with check (holder_workspace_id = app_workspace() and holder_member_id = app_member());

create policy parties on collaboration_log for select to app_user
  using (exists (select 1 from collaborations c where c.id = collaboration_id));
create policy append on collaboration_log for insert to app_user
  with check (workspace_id = app_workspace() and actor_member_id = app_member()
              and exists (select 1 from collaborations c where c.id = collaboration_id));
