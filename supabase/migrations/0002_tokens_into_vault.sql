-- Move the PCO tokens out of plaintext columns and into Supabase Vault.
--
-- Vault encrypts secrets with a key held outside the database, so a database
-- dump, a backup leak, or a browse through the table editor no longer exposes
-- usable tokens. It does NOT defend against a leaked service_role key - that
-- can still call the accessors below. The threat it removes is data-at-rest.
--
-- The vault schema is not reachable through PostgREST, so the Edge Functions go
-- through SECURITY DEFINER RPCs instead of selecting the table directly.

create extension if not exists supabase_vault with schema vault cascade;

alter table public.pco_connections
  add column access_token_id  uuid,
  add column refresh_token_id uuid;

-- Migrate any existing plaintext rows in place rather than forcing a reconnect.
do $$
declare r record;
begin
  for r in select user_id, access_token, refresh_token from public.pco_connections loop
    update public.pco_connections
       set access_token_id  = vault.create_secret(r.access_token),
           refresh_token_id = vault.create_secret(r.refresh_token)
     where user_id = r.user_id;
  end loop;
end $$;

alter table public.pco_connections
  drop column access_token,
  drop column refresh_token;

alter table public.pco_connections
  alter column access_token_id  set not null,
  alter column refresh_token_id set not null;

comment on column public.pco_connections.access_token_id is
  'vault.secrets id. Decrypt via pco_connection_get, never by joining directly.';
comment on column public.pco_connections.refresh_token_id is
  'vault.secrets id. Rotates in place on every refresh via pco_connection_rotate.';


-- Read the connection with both tokens decrypted.
create or replace function public.pco_connection_get(p_user_id uuid)
returns table (
  user_id           uuid,
  pco_person_id     text,
  organization_id   text,
  organization_name text,
  scope             text,
  expires_at        timestamptz,
  refreshed_at      timestamptz,
  access_token      text,
  refresh_token     text
)
language sql
security definer
set search_path = ''
as $$
  select c.user_id, c.pco_person_id, c.organization_id, c.organization_name,
         c.scope, c.expires_at, c.refreshed_at,
         a.decrypted_secret, r.decrypted_secret
    from public.pco_connections c
    join vault.decrypted_secrets a on a.id = c.access_token_id
    join vault.decrypted_secrets r on r.id = c.refresh_token_id
   where c.user_id = p_user_id;
$$;


-- Create or replace a connection. Reuses the existing secret rows on update so
-- the vault does not accumulate an entry per sign-in.
create or replace function public.pco_connection_upsert(
  p_user_id    uuid,
  p_person_id  text,
  p_org_id     text,
  p_org_name   text,
  p_access     text,
  p_refresh    text,
  p_scope      text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.pco_connections%rowtype;
  v_access_id  uuid;
  v_refresh_id uuid;
begin
  select * into v_existing from public.pco_connections where user_id = p_user_id;

  if found then
    perform vault.update_secret(v_existing.access_token_id,  p_access);
    perform vault.update_secret(v_existing.refresh_token_id, p_refresh);
    update public.pco_connections
       set pco_person_id     = p_person_id,
           organization_id   = p_org_id,
           organization_name = p_org_name,
           scope             = p_scope,
           expires_at        = p_expires_at,
           refreshed_at      = now()
     where user_id = p_user_id;
  else
    v_access_id  := vault.create_secret(p_access);
    v_refresh_id := vault.create_secret(p_refresh);
    insert into public.pco_connections (
      user_id, pco_person_id, organization_id, organization_name,
      access_token_id, refresh_token_id, scope, expires_at, refreshed_at
    ) values (
      p_user_id, p_person_id, p_org_id, p_org_name,
      v_access_id, v_refresh_id, p_scope, p_expires_at, now()
    );
  end if;
end;
$$;


-- Persist a rotated token pair. Separate from upsert because refresh returns no
-- identity or scope, and overwriting those with nulls would silently lose them.
create or replace function public.pco_connection_rotate(
  p_user_id    uuid,
  p_access     text,
  p_refresh    text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.pco_connections%rowtype;
begin
  select * into v_existing from public.pco_connections where user_id = p_user_id;
  if not found then
    raise exception 'No PCO connection for user %', p_user_id;
  end if;

  perform vault.update_secret(v_existing.access_token_id,  p_access);
  perform vault.update_secret(v_existing.refresh_token_id, p_refresh);

  update public.pco_connections
     set expires_at   = p_expires_at,
         refreshed_at = now()
   where user_id = p_user_id;
end;
$$;


-- Delete the connection AND its vault secrets. Dropping only the row would leak
-- two orphaned secrets per disconnect.
create or replace function public.pco_connection_delete(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.pco_connections%rowtype;
begin
  select * into v_existing from public.pco_connections where user_id = p_user_id;
  if not found then return; end if;

  delete from public.pco_connections where user_id = p_user_id;
  delete from vault.secrets
   where id in (v_existing.access_token_id, v_existing.refresh_token_id);
end;
$$;


-- These decrypt secrets, so they are service_role only. PUBLIC must be revoked
-- explicitly: execute is granted to PUBLIC by default, which on a SECURITY
-- DEFINER function would let any authenticated caller read every user's tokens.
do $$
declare f text;
begin
  foreach f in array array[
    'public.pco_connection_get(uuid)',
    'public.pco_connection_upsert(uuid,text,text,text,text,text,text,timestamptz)',
    'public.pco_connection_rotate(uuid,text,text,timestamptz)',
    'public.pco_connection_delete(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
