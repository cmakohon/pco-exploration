-- Multi-tenant: churches as tenants.
--
-- Until now the model was one Supabase user <-> one PCO connection, with the
-- organization carried as two nullable denormalized text columns. That cannot
-- express the product's rule - a church owner registers the church, and only
-- then may that church's members link - and it cannot represent a person who
-- belongs to two churches at all.
--
-- Three ideas shape this migration:
--
--   1. Tenancy is (user, organization), not user. Every token, every call,
--      every RPC takes an org.
--   2. The authorization predicate lives INSIDE the decryption query.
--      pco_connection_get joins memberships in the same statement that joins
--      vault.decrypted_secrets, so a forgotten check in an Edge Function
--      returns zero rows instead of leaking a token.
--   3. Identity is not connection. Supabase Auth answers "who is this human";
--      connections answer "which churches may we act for, as them".


-- ---------------------------------------------------------------------------
-- 0. Name collision
--
-- pco_connections.organization_id already holds PCO's id as text, and the new
-- uuid foreign key wants that name. From here on:
--   pco_organization_id = PCO's id (text)
--   organization_id     = our uuid FK
-- ---------------------------------------------------------------------------

alter table public.pco_connections rename column organization_id   to pco_organization_id;
alter table public.pco_connections rename column organization_name to pco_organization_name;


-- ---------------------------------------------------------------------------
-- 1. Tenants
-- ---------------------------------------------------------------------------

create table public.organizations (
  id                        uuid primary key default gen_random_uuid(),
  pco_organization_id       text        not null unique,
  name                      text        not null,
  status                    text        not null default 'active'
    check (status in ('active','suspended','needs_service_connection')),
  join_policy               text        not null default 'open'
    check (join_policy in ('open','approval')),
  admin_verified_at         timestamptz,
  admin_verified_by         uuid references auth.users(id) on delete set null,
  admin_verification_method text
    check (admin_verification_method in
      ('site_administrator','people_manager_override','migrated_unverified','manual')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.organizations is
  'One row per church. The tenant.';
comment on column public.organizations.pco_organization_id is
  'From /oauth/userinfo, cross-checked against GET /people/v2. The UNIQUE here '
  'IS the "one church, one tenant" rule and the source of the 409 in '
  'org-register - do not reimplement that check in application code.';
comment on column public.organizations.admin_verification_method is
  'Which signal authorized the claim. migrated_unverified = created by the 0003 '
  'backfill, meaning the org-admin gate was never run for it.';


create table public.memberships (
  id              uuid        not null primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id)           on delete cascade,
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  role            text        not null default 'member'
    check (role in ('owner','admin','member')),
  status          text        not null default 'active'
    check (status in ('active','pending','suspended','removed')),
  pco_person_id   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, organization_id)
);

comment on table public.memberships is
  'Who belongs to which church, and as what. The unique (user_id, '
  'organization_id) is what makes multi-church membership legal and duplicate '
  'membership impossible.';

create index memberships_org_active_idx
  on public.memberships (organization_id) where status = 'active';

-- One PCO person maps to at most one membership in that church. Blocks two
-- Supabase users both claiming to be the same PCO person - which is exactly
-- what an auth.users split would produce.
create unique index memberships_org_person_idx
  on public.memberships (organization_id, pco_person_id)
  where pco_person_id is not null;


-- Convenience default ONLY. Every Edge Function still takes an explicit
-- organization_id and authorizes from memberships. An ambient tenant is how
-- cross-tenant bugs get written; this must never be the thing that grants
-- access.
create table public.user_settings (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  active_organization_id uuid references public.organizations(id) on delete set null,
  updated_at             timestamptz not null default now()
);


-- Why a tenancy decision went the way it did.
--
-- user_id is ON DELETE SET NULL, deliberately NOT cascade: pco-store-tokens
-- deletes the orphaned auth user immediately after writing one of these rows,
-- and a cascade would erase the very evidence the refusal tests assert on. The
-- surviving email is simultaneously the audit trail and the "we'll tell you
-- when your church signs up" list.
create table public.tenancy_events (
  id                    bigint generated always as identity primary key,
  created_at            timestamptz not null default now(),
  user_id               uuid references auth.users(id) on delete set null,
  email                 text,
  pco_organization_id   text,
  pco_organization_name text,
  decision              text not null,
  reason                text,
  detail                jsonb
);

create index tenancy_events_created_idx on public.tenancy_events (created_at desc);


-- ---------------------------------------------------------------------------
-- 2. Reshape pco_connections into a per-(user, church) table
-- ---------------------------------------------------------------------------

alter table public.pco_connections
  add column id              uuid    not null default gen_random_uuid(),
  add column organization_id uuid    references public.organizations(id) on delete cascade,
  add column is_service      boolean not null default false;

alter table public.pco_connections drop constraint pco_connections_pkey;
alter table public.pco_connections add  primary key (id);

comment on column public.pco_connections.is_service is
  'This connection is the church''s background/webhook identity. It carries the '
  'owning user''s PCO permissions - if they leave the church or lose admin, '
  'background jobs fail. Exactly one per org (pco_connections_service_idx).';


-- Backfill in place. Same discipline as 0002: the existing Vault secrets are
-- NOT touched - no create_secret, no update_secret - so refreshed_at must not
-- move and nobody has to reconnect.
do $$
declare
  r   record;
  v_org uuid;
begin
  for r in select * from public.pco_connections loop
    -- organization_id was nullable in 0001. A null would abort the SET NOT NULL
    -- below, but dropping the row would strand live tokens. Synthesize a
    -- suspended placeholder instead: the tokens survive, every tenancy path
    -- refuses, and the operator sees exactly one obviously-wrong row telling
    -- them to re-register. Silently inventing an 'active' org would be the bug.
    insert into public.organizations (
      pco_organization_id, name, status,
      admin_verified_at, admin_verified_by, admin_verification_method
    ) values (
      coalesce(r.pco_organization_id, 'unverified-' || r.user_id::text),
      coalesce(r.pco_organization_name, 'Unknown organization'),
      case when r.pco_organization_id is null then 'suspended' else 'active' end,
      -- Deliberately NOT backdated: the admin gate never ran for this row.
      null, r.user_id, 'migrated_unverified'
    )
    -- DO UPDATE rather than DO NOTHING so RETURNING always yields a row, even
    -- when two connections share a church.
    on conflict (pco_organization_id)
      do update set name = excluded.name, updated_at = now()
    returning id into v_org;

    insert into public.memberships (user_id, organization_id, role, status, pco_person_id)
    values (r.user_id, v_org, 'owner', 'active', r.pco_person_id)
    on conflict (user_id, organization_id) do nothing;

    update public.pco_connections
       set organization_id = v_org,
           is_service      = true
     where id = r.id;
  end loop;
end $$;

alter table public.pco_connections alter column organization_id set not null;

alter table public.pco_connections
  add constraint pco_connections_user_org_key unique (user_id, organization_id);

create unique index pco_connections_service_idx
  on public.pco_connections (organization_id) where is_service;

-- Webhook routing will query by org on every inbound delivery.
create index pco_connections_org_idx on public.pco_connections (organization_id);


-- ---------------------------------------------------------------------------
-- 3. updated_at
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger organizations_touch  before update on public.organizations
  for each row execute function public.set_updated_at();
create trigger memberships_touch    before update on public.memberships
  for each row execute function public.set_updated_at();
create trigger user_settings_touch  before update on public.user_settings
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 4. RLS
--
-- pco_connections keeps 0001's deliberate zero-policy deny-all, and
-- tenancy_events joins it: both are service_role only.
--
-- organizations, memberships and user_settings get SELECT-only policies for
-- members. This is a departure from 0001 and the reason is testability: the
-- tenancy boundary should be checkable at the layer that actually enforces it.
-- With these policies, "can church B read church A?" is a two-line browser
-- query against PostgREST that either returns the other church or does not.
-- Funnel everything through Edge Functions and you are testing TypeScript,
-- not isolation.
--
-- No insert/update/delete policies anywhere - every write goes through
-- service_role.
-- ---------------------------------------------------------------------------

alter table public.organizations  enable row level security;
alter table public.memberships    enable row level security;
alter table public.user_settings  enable row level security;
alter table public.tenancy_events enable row level security;

-- (select auth.uid()) rather than bare auth.uid() so the planner caches it as
-- an initplan instead of re-evaluating per row.
create policy memberships_select_own on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy organizations_select_member on public.organizations
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
     where m.organization_id = organizations.id
       and m.user_id = (select auth.uid())
       and m.status  = 'active'
  ));

create policy user_settings_select_own on public.user_settings
  for select to authenticated
  using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- 5. Replace the connection RPCs
--
-- Every one of the four keys on user_id alone and every signature changes.
-- Postgres overloads by signature, so CREATE OR REPLACE with new parameters
-- would leave pco_connection_get(uuid) alive and callable forever - a function
-- that answers "this user's connection" with no org is precisely the footgun
-- this migration exists to remove. Drop them explicitly.
--
-- Deployment note: this breaks the currently deployed Edge Functions the
-- instant it runs. For a one-user spike, db push then functions deploy back to
-- back is fine. In production the sequence is add-new -> deploy -> drop-old.
-- ---------------------------------------------------------------------------

drop function if exists public.pco_connection_get(uuid);
drop function if exists public.pco_connection_upsert(uuid,text,text,text,text,text,text,timestamptz);
drop function if exists public.pco_connection_rotate(uuid,text,text,timestamptz);
drop function if exists public.pco_connection_delete(uuid);


-- Read one connection with both tokens decrypted.
--
-- The joins to memberships and organizations are the point. Suspend a member
-- or a church and every token path for them goes dark in one statement, with
-- no Edge Function redeploy and no possibility of a handler having forgotten.
create or replace function public.pco_connection_get(p_user_id uuid, p_org_id uuid)
returns table (
  id                    uuid,
  user_id               uuid,
  organization_id       uuid,
  pco_person_id         text,
  pco_organization_id   text,
  pco_organization_name text,
  is_service            boolean,
  role                  text,
  scope                 text,
  expires_at            timestamptz,
  refreshed_at          timestamptz,
  access_token          text,
  refresh_token         text
)
language sql
security definer
set search_path = ''
as $$
  select c.id, c.user_id, c.organization_id, c.pco_person_id,
         c.pco_organization_id, c.pco_organization_name, c.is_service,
         m.role, c.scope, c.expires_at, c.refreshed_at,
         a.decrypted_secret, r.decrypted_secret
    from public.pco_connections c
    join public.memberships m
      on  m.user_id         = c.user_id
      and m.organization_id = c.organization_id
      and m.status          = 'active'
    join public.organizations o
      on  o.id = c.organization_id
      and o.status <> 'suspended'
    join vault.decrypted_secrets a on a.id = c.access_token_id
    join vault.decrypted_secrets r on r.id = c.refresh_token_id
   where c.user_id = p_user_id
     and c.organization_id = p_org_id;
$$;


-- The church's background identity. There is no user in a webhook, so this
-- keys on the org alone. The role join means demoting the service user to
-- 'member' disables background access immediately - deliberate.
create or replace function public.pco_connection_get_service(p_org_id uuid)
returns table (
  id                    uuid,
  user_id               uuid,
  organization_id       uuid,
  pco_person_id         text,
  pco_organization_id   text,
  pco_organization_name text,
  is_service            boolean,
  role                  text,
  scope                 text,
  expires_at            timestamptz,
  refreshed_at          timestamptz,
  access_token          text,
  refresh_token         text
)
language sql
security definer
set search_path = ''
as $$
  select c.id, c.user_id, c.organization_id, c.pco_person_id,
         c.pco_organization_id, c.pco_organization_name, c.is_service,
         m.role, c.scope, c.expires_at, c.refreshed_at,
         a.decrypted_secret, r.decrypted_secret
    from public.pco_connections c
    join public.memberships m
      on  m.user_id         = c.user_id
      and m.organization_id = c.organization_id
      and m.status          = 'active'
      and m.role in ('owner','admin')
    join public.organizations o
      on o.id = c.organization_id and o.status = 'active'
    join vault.decrypted_secrets a on a.id = c.access_token_id
    join vault.decrypted_secrets r on r.id = c.refresh_token_id
   where c.organization_id = p_org_id
     and c.is_service;
$$;


-- Create or replace a connection. Reuses the existing secret rows on update so
-- the vault does not accumulate an entry per sign-in (0002, snag 4.8).
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
begin
  -- Membership is a PRECONDITION for holding a token, not a check performed
  -- somewhere else later.
  if not exists (
    select 1 from public.memberships m
     where m.user_id = p_user_id
       and m.organization_id = p_org_id
       and m.status = 'active'
  ) then
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
    return v_existing.id;
  end if;

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

  return v_id;
end $$;


-- Persist a rotated token pair. Still separate from upsert because a refresh
-- response carries no identity, org, or scope, and folding them would null
-- those out (snag 4.7). Keys on connection id - the caller already holds the
-- row from _get.
create or replace function public.pco_connection_rotate(
  p_connection_id uuid,
  p_access        text,
  p_refresh       text,
  p_expires_at    timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v public.pco_connections%rowtype;
begin
  select * into v from public.pco_connections where id = p_connection_id;
  if not found then
    raise exception 'No PCO connection %', p_connection_id;
  end if;

  perform vault.update_secret(v.access_token_id,  p_access);
  perform vault.update_secret(v.refresh_token_id, p_refresh);

  update public.pco_connections
     set expires_at = p_expires_at, refreshed_at = now()
   where id = p_connection_id;
end $$;


-- Delete the connection AND its vault secrets, then hand over the service role
-- if this was it.
--
-- Auto-promote rather than refuse the disconnect: refusing would hold a user's
-- tokens hostage to our background jobs, which is the wrong trade. If no
-- eligible successor exists, degrade the org visibly instead of silently.
create or replace function public.pco_connection_delete(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v     public.pco_connections%rowtype;
  v_new uuid;
begin
  select * into v from public.pco_connections where id = p_connection_id;
  if not found then
    return jsonb_build_object('deleted', false);
  end if;

  delete from public.pco_connections where id = v.id;
  delete from vault.secrets
   where id in (v.access_token_id, v.refresh_token_id);

  if v.is_service then
    select c.id into v_new
      from public.pco_connections c
      join public.memberships m
        on  m.user_id         = c.user_id
        and m.organization_id = c.organization_id
     where c.organization_id = v.organization_id
       and m.status = 'active'
       and m.role in ('owner','admin')
     order by (m.role = 'owner') desc, c.refreshed_at desc
     limit 1;

    if v_new is not null then
      update public.pco_connections set is_service = true where id = v_new;
    else
      update public.organizations
         set status = 'needs_service_connection'
       where id = v.organization_id;
    end if;
  end if;

  return jsonb_build_object(
    'deleted', true,
    'was_service', v.is_service,
    'promoted_connection_id', v_new
  );
end $$;


-- ---------------------------------------------------------------------------
-- 6. Tenancy RPCs
--
-- These are SECURITY INVOKER, not DEFINER. They exist for transactionality
-- across three tables (PostgREST has no transactions), not to reach the vault,
-- and the caller is service_role which already bypasses RLS. Keep the definer
-- set as small as it can be: every definer function is another snag 4.6
-- waiting to happen.
-- ---------------------------------------------------------------------------

create or replace function public.pco_org_register(
  p_user_id      uuid,
  p_pco_org_id   text,
  p_pco_org_name text,
  p_person_id    text,
  p_method       text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_org public.organizations%rowtype;
begin
  select * into v_org from public.organizations
   where pco_organization_id = p_pco_org_id;

  if found then
    if exists (
      select 1 from public.memberships m
       where m.organization_id = v_org.id
         and m.user_id = p_user_id
         and m.role    = 'owner'
         and m.status  = 'active'
    ) then
      -- Idempotent: re-registering your own church is a 200, not a 409.
      return jsonb_build_object('status','already_owner','organization_id',v_org.id);
    end if;
    return jsonb_build_object('status','claimed_by_other','organization_id',v_org.id);
  end if;

  insert into public.organizations (
    pco_organization_id, name, status,
    admin_verified_at, admin_verified_by, admin_verification_method
  ) values (
    p_pco_org_id, p_pco_org_name, 'active', now(), p_user_id, p_method
  ) returning * into v_org;

  insert into public.memberships (user_id, organization_id, role, status, pco_person_id)
  values (p_user_id, v_org.id, 'owner', 'active', p_person_id)
  on conflict (user_id, organization_id) do update
    set role          = 'owner',
        status        = 'active',
        pco_person_id = excluded.pco_person_id,
        updated_at    = now();

  return jsonb_build_object('status','created','organization_id',v_org.id);

exception when unique_violation then
  -- Two Organization Administrators registered the same church concurrently.
  -- The unique index is the real arbiter; the SELECT above is only a fast path.
  select * into v_org from public.organizations
   where pco_organization_id = p_pco_org_id;
  return jsonb_build_object('status','claimed_by_other','organization_id',v_org.id);
end $$;


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

  if v_org.status <> 'active' then
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
          -- Never re-activate a suspended member by signing in again.
          status = case when m.status = 'suspended' then m.status else excluded.status end,
          updated_at = now()
    returning * into v_m;
  exception when unique_violation then
    -- memberships_org_person_idx: this PCO person already belongs to a
    -- different Supabase user in this church.
    return jsonb_build_object('status','person_already_claimed','organization_id',v_org.id);
  end;

  return jsonb_build_object(
    'status', case when v_m.status = 'active' then 'joined' else v_m.status end,
    'organization_id', v_org.id,
    'membership_status', v_m.status,
    'role', v_m.role
  );
end $$;


-- ---------------------------------------------------------------------------
-- 7. Grants (snag 4.6)
--
-- PostgreSQL grants EXECUTE to PUBLIC by default. On a SECURITY DEFINER
-- function that would let any authenticated caller decrypt every church's
-- tokens, and it fails OPEN - nothing looks wrong. Dropping and recreating a
-- function also resets its grants, so this must be repeated in full.
--
-- This array is the thing that drifts. The verification step calls every
-- signature here with the anon key and requires 42501.
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.pco_connection_get(uuid,uuid)',
    'public.pco_connection_get_service(uuid)',
    'public.pco_connection_upsert(uuid,uuid,text,text,text,text,text,text,timestamptz)',
    'public.pco_connection_rotate(uuid,text,text,timestamptz)',
    'public.pco_connection_delete(uuid)',
    'public.pco_org_register(uuid,text,text,text,text)',
    'public.pco_org_join(uuid,text,text)',
    'public.set_updated_at()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
