-- Client proposals: versioned editorial documents drafted by agents and edited by the expert.
create table proposals (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  trip_id uuid not null references trips(id) on delete cascade,
  version int not null,
  status text not null check (status in ('draft', 'ready', 'sent', 'accepted', 'superseded')),
  title text not null,
  intro text not null,
  sections jsonb not null,
  closing text not null,
  created_by text not null,
  edited_by_expert boolean not null default false,
  sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (trip_id, version)
);

-- Samples of the expert's own writing, used to draft in their voice.
create table style_samples (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references members(id),
  body text not null,
  created_at timestamptz not null default now()
);

alter table proposals enable row level security;
alter table proposals force row level security;
alter table style_samples enable row level security;
alter table style_samples force row level security;
grant select, insert, update, delete on proposals, style_samples to app_user, app_system;
create policy tenant on proposals to app_user
  using (workspace_id = app_workspace() and exists (select 1 from trips t where t.id = trip_id))
  with check (workspace_id = app_workspace());
create policy system_all on proposals to app_system using (true) with check (true);
create policy tenant on style_samples to app_user
  using (workspace_id = app_workspace() and owner_id = app_member())
  with check (workspace_id = app_workspace() and owner_id = app_member());
create policy system_all on style_samples to app_system using (true) with check (true);
