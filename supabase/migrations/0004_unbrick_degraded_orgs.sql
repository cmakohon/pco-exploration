-- A church that loses its service connection must not become unjoinable.
--
-- 0003 degraded an organization to 'needs_service_connection' when its service
-- connection was disconnected with no eligible successor. But pco_org_join
-- refused any status other than 'active', so the owner - the one person who
-- could restore the connection - was locked out, and the church was bricked
-- with no path back short of hand-editing the row.
--
-- Found by disconnecting the only owner's connection and then trying to
-- reconnect. The happy path never touches this: an org with two admins promotes
-- a successor and stays 'active'.
--
-- Two changes:
--   1. Only 'suspended' blocks a join. needs_service_connection is degraded,
--      not closed.
--   2. Storing a connection for an owner or admin, when the church has no
--      service connection, adopts it as the service connection and restores the
--      church to 'active'. The repair is the ordinary reconnect - there is no
--      separate recovery flow to discover, and nothing to remember to run.


-- Membership is a precondition for holding a token. Unchanged from 0003 except
-- for the self-healing block at the end.
create or replace function public.pco_connection_upsert(
  p_user_id      uuid,
  p_org_id       uuid,
  p_person_id    text,
  p_pco_org_id   text,
  p_pco_org_name text,
  p_access       text,
  p_refresh      text,
  p_scope        text,
  p_expires_at   timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing   public.pco_connections%rowtype;
  v_access_id  uuid;
  v_refresh_id uuid;
  v_id         uuid;
  v_role       text;
begin
  select m.role into v_role
    from public.memberships m
   where m.user_id = p_user_id
     and m.organization_id = p_org_id
     and m.status = 'active';

  if v_role is null then
    raise exception 'No active membership for user % in organization %',
      p_user_id, p_org_id using errcode = '42501';
  end if;

  select * into v_existing
    from public.pco_connections
   where user_id = p_user_id and organization_id = p_org_id;

  if found then
    perform vault.update_secret(v_existing.access_token_id,  p_access);
    perform vault.update_secret(v_existing.refresh_token_id, p_refresh);
    update public.pco_connections
       set pco_person_id         = p_person_id,
           pco_organization_id   = p_pco_org_id,
           pco_organization_name = p_pco_org_name,
           scope                 = p_scope,
           expires_at            = p_expires_at,
           refreshed_at          = now()
     where id = v_existing.id;
    v_id := v_existing.id;
  else
    v_access_id  := vault.create_secret(p_access);
    v_refresh_id := vault.create_secret(p_refresh);

    insert into public.pco_connections (
      user_id, organization_id, pco_person_id,
      pco_organization_id, pco_organization_name,
      access_token_id, refresh_token_id, scope, expires_at, refreshed_at
    ) values (
      p_user_id, p_org_id, p_person_id,
      p_pco_org_id, p_pco_org_name,
      v_access_id, v_refresh_id, p_scope, p_expires_at, now()
    ) returning id into v_id;
  end if;

  -- Self-heal. A church with no service connection cannot do background work,
  -- and only an owner or admin may carry that identity (see
  -- pco_connection_get_service). If this connection qualifies and the slot is
  -- empty, adopt it and undo the degrade.
  if v_role in ('owner','admin')
     and not exists (
       select 1 from public.pco_connections
        where organization_id = p_org_id and is_service
     )
  then
    update public.pco_connections set is_service = true where id = v_id;
    update public.organizations
       set status = 'active'
     where id = p_org_id and status = 'needs_service_connection';
  end if;

  return v_id;
end $$;


-- Only 'suspended' bars the door.
create or replace function public.pco_org_join(
  p_user_id    uuid,
  p_pco_org_id text,
  p_person_id  text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org    public.organizations%rowtype;
  v_m      public.memberships%rowtype;
  v_status text;
begin
  select * into v_org from public.organizations
   where pco_organization_id = p_pco_org_id;

  if not found then
    return jsonb_build_object('status','org_not_registered');
  end if;

  -- needs_service_connection is degraded, not closed. Blocking it here locked
  -- the owner out of the only action that repairs it.
  if v_org.status = 'suspended' then
    return jsonb_build_object('status','org_inactive',
                              'org_status', v_org.status,
                              'organization_id', v_org.id);
  end if;

  select * into v_m from public.memberships
   where user_id = p_user_id and organization_id = v_org.id;

  if found and v_m.status = 'removed' then
    return jsonb_build_object('status','membership_removed','organization_id',v_org.id);
  end if;

  v_status := case when v_org.join_policy = 'approval' then 'pending' else 'active' end;

  begin
    insert into public.memberships as m
      (user_id, organization_id, role, status, pco_person_id)
    values (p_user_id, v_org.id, 'member', v_status, p_person_id)
    on conflict (user_id, organization_id) do update
      set pco_person_id = excluded.pco_person_id,
          -- Never re-activate a suspended member, and never demote an existing
          -- owner or admin back to member by signing in again.
          status = case when m.status = 'suspended' then m.status else excluded.status end,
          updated_at = now()
    returning * into v_m;
  exception when unique_violation then
    return jsonb_build_object('status','person_already_claimed','organization_id',v_org.id);
  end;

  return jsonb_build_object(
    'status', case when v_m.status = 'active' then 'joined' else v_m.status end,
    'organization_id', v_org.id,
    'membership_status', v_m.status,
    'role', v_m.role,
    'org_status', v_org.status
  );
end $$;


-- CREATE OR REPLACE preserves grants when the signature is unchanged, so this
-- is belt-and-braces. 4.6 is only safe as a habit, never as a judgement call.
do $$
declare f text;
begin
  foreach f in array array[
    'public.pco_connection_upsert(uuid,uuid,text,text,text,text,text,text,timestamptz)',
    'public.pco_org_join(uuid,text,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
