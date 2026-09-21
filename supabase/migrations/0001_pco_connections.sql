-- Planning Center OAuth connections.
--
-- One row per Supabase user holding the PCO tokens we act with on their behalf.
-- PCO access tokens live 2 hours and refresh tokens ROTATE on every use, so
-- refresh_token is rewritten constantly and must always be persisted.

create table public.pco_connections (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  pco_person_id     text        not null,
  organization_id   text,
  organization_name text,
  access_token      text        not null,
  refresh_token     text        not null,
  scope             text        not null,
  expires_at        timestamptz not null,
  refreshed_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

comment on table public.pco_connections is
  'PCO OAuth tokens per user. Service-role access only - never exposed to the browser.';
comment on column public.pco_connections.expires_at is
  'Exact expiry, taken from the exp claim returned by PCO /oauth/introspect.';
comment on column public.pco_connections.refresh_token is
  'Rotates on every refresh. PCO honors it for 90 days from token issuance.';

alter table public.pco_connections enable row level security;

-- Deliberately NO policies. RLS enabled with zero policies denies the anon and
-- authenticated roles outright; only the service_role key (used by the Edge
-- Functions) bypasses RLS. Tokens therefore never reach the browser after the
-- initial capture handoff.
