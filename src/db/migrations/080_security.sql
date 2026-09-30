-- Security hardening from the pre-launch review.

-- 1. The connecting owner may SET ROLE to app_user/app_system but must not
--    inherit their privileges or policies, so the owner itself sees no rows.
--    (Postgres 16+ grant options.)
do $$ begin
  execute format('revoke app_user from %I', current_user);
  execute format('revoke app_system from %I', current_user);
  execute format('grant app_user to %I with inherit false, set true', current_user);
  execute format('grant app_system to %I with inherit false, set true', current_user);
exception when others then
  -- A superuser connection (PGlite, local dev) bypasses RLS anyway; keep going.
  raise notice 'role grant adjustment skipped: %', sqlerrm;
end $$;

-- 2. Security-definer functions: temp tables must never shadow the tables they read.
-- ALTER ... OWNER needs the new owner to hold CREATE on the schema; grant it only for this step.
grant create on schema public to app_system;
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
  loop
    execute format('alter function %s set search_path = pg_catalog, public, pg_temp', f.sig);
    -- Definer functions run with the platform role's policies, not the (policy-less) owner's.
    execute format('alter function %s owner to app_system', f.sig);
  end loop;
end $$;
revoke create on schema public from app_system;
do $$ begin
  execute format('revoke temporary on database %I from public', current_database());
exception when others then
  raise notice 'revoke temporary skipped: %', sqlerrm;
end $$;

-- 3. Members: identity and roles change only through platform code (sign-in, invitations, owners).
revoke insert, update, delete on members from app_user;

-- 4. Audit events are append-only for tenants.
revoke update, delete on audit_events from app_user;

-- 5. Trip delegations grant access to private trips: only the trip owner or a workspace owner/admin manages them.
drop policy tenant on trip_delegations;
create policy tenant_read on trip_delegations for select to app_user using (workspace_id = app_workspace());
create policy tenant_manage on trip_delegations for insert to app_user
  with check (workspace_id = app_workspace()
              and (app_is_admin() or exists (select 1 from trips t where t.id = trip_id and t.owner_id = app_member())));
create policy tenant_update on trip_delegations for update to app_user
  using (workspace_id = app_workspace() and (app_is_admin() or exists (select 1 from trips t where t.id = trip_id and t.owner_id = app_member())))
  with check (workspace_id = app_workspace());
create policy tenant_delete on trip_delegations for delete to app_user
  using (workspace_id = app_workspace() and (app_is_admin() or exists (select 1 from trips t where t.id = trip_id and t.owner_id = app_member())));

-- 6. Collaborations cross workspaces, so each side may only do its own side's part.
create or replace function collab_side(p_workspace uuid, p_requester uuid, p_spec_workspace uuid, p_specialist uuid) returns text
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select case
    when p_workspace = app_workspace() and p_requester = app_member() then 'requester'
    when p_spec_workspace = app_workspace() and p_specialist = app_member() then 'specialist'
    else null end
$$;

create or replace function collaborations_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare side text; t record;
begin
  if current_user <> 'app_user' then return new; end if;
  side := collab_side(old.workspace_id, old.requester_member_id, old.specialist_workspace_id, old.specialist_member_id);
  if side is null then raise exception 'not a party to this collaboration' using errcode = '42501'; end if;
  if (new.workspace_id, new.requester_member_id, new.specialist_workspace_id, new.specialist_member_id, new.contribution)
     is distinct from (old.workspace_id, old.requester_member_id, old.specialist_workspace_id, old.specialist_member_id, old.contribution) then
    raise exception 'collaboration parties and contribution are fixed' using errcode = '42501';
  end if;
  if new.trip_id is distinct from old.trip_id and side <> 'requester' then
    raise exception 'only the requester links a trip' using errcode = '42501';
  end if;
  if new.state = 'declined' and old.state <> 'declined' and side <> 'specialist' then
    raise exception 'only the specialist declines' using errcode = '42501';
  end if;
  if new.agreed_terms_version is distinct from old.agreed_terms_version
     or new.client_access_expires_at is distinct from old.client_access_expires_at
     or (new.state in ('terms_agreed', 'active') and old.state not in ('terms_agreed', 'active')) then
    select * into t from collaboration_terms where collaboration_id = new.id and version = new.agreed_terms_version;
    if not found or t.requester_accepted_at is null or t.specialist_accepted_at is null then
      raise exception 'terms must be accepted by both sides' using errcode = '42501';
    end if;
    if new.client_access_expires_at is distinct from (t.terms ->> 'clientAccessExpiresAt')::timestamptz then
      raise exception 'client-detail access must match the agreed terms' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger collaborations_guard before update on collaborations for each row execute function collaborations_guard();

create or replace function collaboration_terms_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare side text; c record;
begin
  if current_user <> 'app_user' then return new; end if;
  select * into c from collaborations where id = new.collaboration_id;
  side := collab_side(c.workspace_id, c.requester_member_id, c.specialist_workspace_id, c.specialist_member_id);
  if side is null then raise exception 'not a party to this collaboration' using errcode = '42501'; end if;
  if tg_op = 'INSERT' then
    -- The proposer accepts their own proposal; never the other side's acceptance.
    if new.proposed_by_side <> side
       or (side = 'requester' and (new.specialist_accepted_at is not null or (new.requester_accepted_at is not null and new.requester_accepted_by is distinct from app_member())))
       or (side = 'specialist' and (new.requester_accepted_at is not null or (new.specialist_accepted_at is not null and new.specialist_accepted_by is distinct from app_member()))) then
      raise exception 'terms are proposed and accepted only by your own side' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.collaboration_id, new.workspace_id, new.version, new.proposed_by, new.proposed_by_side, new.terms, new.fingerprint, new.created_at)
     is distinct from (old.collaboration_id, old.workspace_id, old.version, old.proposed_by, old.proposed_by_side, old.terms, old.fingerprint, old.created_at) then
    raise exception 'proposed terms are immutable; propose a new version' using errcode = '42501';
  end if;
  if (new.requester_accepted_at, new.requester_accepted_by) is distinct from (old.requester_accepted_at, old.requester_accepted_by)
     and (side <> 'requester' or old.requester_accepted_at is not null or new.requester_accepted_by is distinct from app_member()) then
    raise exception 'only the requester accepts for the requester' using errcode = '42501';
  end if;
  if (new.specialist_accepted_at, new.specialist_accepted_by) is distinct from (old.specialist_accepted_at, old.specialist_accepted_by)
     and (side <> 'specialist' or old.specialist_accepted_at is not null or new.specialist_accepted_by is distinct from app_member()) then
    raise exception 'only the specialist accepts for the specialist' using errcode = '42501';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'superseded terms stay superseded' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger collaboration_terms_guard before insert or update on collaboration_terms for each row execute function collaboration_terms_guard();

-- The contribution log records who did what: a party writes only its own side's entries.
drop policy append on collaboration_log;
create policy append on collaboration_log for insert to app_user
  with check (workspace_id = app_workspace() and actor_member_id = app_member()
              and exists (select 1 from collaborations c where c.id = collaboration_id
                          and collab_side(c.workspace_id, c.requester_member_id, c.specialist_workspace_id, c.specialist_member_id) = actor_side));
