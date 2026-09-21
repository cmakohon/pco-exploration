# Planning Center OAuth on Supabase — exploration spike

A minimal, working example of a **confidential** OAuth 2.0 application that acts
on a user's behalf against the Planning Center API, with Supabase (free tier)
providing both the callback URL and the token store.

## How the Planning Center auth model works

Everything below is confirmed against the
[auth guide](https://api.planningcenteronline.com/docs/overview/authentication)
and the live
[discovery document](https://api.planningcenteronline.com/.well-known/openid-configuration).

| | |
|---|---|
| Issuer | `https://api.planningcenteronline.com` |
| Authorize | `/oauth/authorize` |
| Token | `/oauth/token` |
| Revoke / Introspect | `/oauth/revoke`, `/oauth/introspect` |
| UserInfo | `/oauth/userinfo` |
| JWKS | `/oauth/discovery/keys` |
| Grants | `authorization_code`, `refresh_token`, `client_credentials` |
| Client auth | `client_secret_basic`, `client_secret_post` |
| PKCE | `S256` — recommended for confidential apps, required for public |
| Scopes | `api calendar check_ins giving groups home people publishing registrations resources services openid` |

The behaviors that actually shape an integration:

- **Access tokens expire in 2 hours.** Refreshing is routine, not an edge case.
- **Refresh tokens rotate.** Every refresh returns a *new* refresh token. Fail to
  persist it and the chain breaks on the next call.
- **Refresh tokens are honored 90 days** from the associated access token's
  issuance — measured from issuance, not last use. An app idle that long forces
  re-authorization.
- **A descriptive `User-Agent` is mandatory.** Missing or generic values get a
  bare `403`, which is confusing if you hit it cold.
- **`openid` composes with product scopes.** `openid people` returns an
  `id_token` carrying `sub`, `name`, `email`, `organization_id`,
  `organization_name`, so you learn which church connected without a second call.
- **Permissions are always the connecting user's permissions.** If their PCO
  access changes, your API access changes with it.
- `people/v2/me` needs the `people` scope; `current/v2/me` needs no scope at all.

### Registering the application

- Your company needs **its own PCO organization** to hold the app. It feels odd —
  you sign up as though you were a church — but that is where the app lives.
  Don't put it under a customer's org.
- Only **Organization Administrators** can create OAuth apps, and every org admin
  then co-manages it.
- **Create exactly one application.** The single client_id/secret is reused for
  every church that connects; churches do not create their own.
- The client secret is **displayed once**.

## Architecture

Planning Center is registered as a
[custom OIDC provider](https://supabase.com/docs/guides/auth/custom-oauth-providers)
in Supabase Auth (shipped April 2026; free plan allows 3). Because PCO publishes
discovery, Supabase resolves every endpoint and the JWKS from the issuer URL
alone — so the callback URL costs zero code and you get a real Supabase session.

What Supabase does *not* do is persist or refresh **provider** tokens:
`provider_token` and `provider_refresh_token` appear in the session once,
immediately after sign-in, and are gone on the next session refresh. Acting on a
user's behalf over time therefore needs our own store and refresh loop.

```
Browser ──► signInWithOAuth({ provider: 'custom:planning-center' })
        ──► /oauth/authorize?scope=openid+people&prompt=select_account
        ◄── https://<ref>.supabase.co/auth/v1/callback     ← register THIS with PCO
             (Supabase performs the code exchange with the client_secret)

session.provider_token / provider_refresh_token   (once, never stored by Supabase)
        ──► POST /functions/v1/pco-store-tokens
             introspect for exact exp + scope, userinfo for identity
        ──► pco_connections                        (service-role only, RLS-sealed)

/functions/v1/pco-me ──► lazy refresh if expiring ──► GET /people/v2/me
```

| Path | Purpose |
|---|---|
| `supabase/migrations/0001_pco_connections.sql` | Token table, RLS-sealed to service_role |
| `supabase/functions/_shared/pco.ts` | Endpoints, refresh, rotation-persisting `pcoFetch` |
| `supabase/functions/_shared/http.ts` | CORS preflight + error-to-JSON |
| `supabase/functions/pco-store-tokens/` | Captures the one-shot provider tokens |
| `supabase/functions/pco-me/` | Proves stored credentials work, surfaces rotation |
| `supabase/functions/pco-disconnect/` | Revokes at PCO and deletes the row |
| `web/index.html` | Connect button, go/no-go panel, result dump |

## Setup

**1. Create a free Supabase project.** Note the project ref — the callback URL is
deterministic, so you can register it with PCO before configuring anything:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

**2. Register the PCO application** at
<https://api.planningcenteronline.com/oauth/applications>, signed into your
company's org. Redirect URI = the URL above. Save the client id and secret.

**3. Add the custom OIDC provider** — Dashboard → Authentication → Sign In /
Providers → Custom Providers → New Provider:

| Field | Value |
|---|---|
| Provider ID | `custom:planning-center` |
| Issuer | `https://api.planningcenteronline.com` |
| Client ID / Secret | from step 2 |
| Scopes | `openid people` |

Confirm the read-only Callback URL matches what you registered.

Then, still in the dashboard, go to **Authentication → URL Configuration** and add
`http://localhost:3000` to **Redirect URLs**. Without it the `redirectTo` in
`web/index.html` is rejected and you land on the Site URL instead — which looks
like the OAuth flow failed when it actually succeeded.

**4. Deploy.**

```sh
supabase link --project-ref <project-ref>
supabase db push

cp .env.example .env          # fill in PCO_CLIENT_ID, PCO_CLIENT_SECRET, PCO_USER_AGENT
supabase secrets set --env-file .env

supabase functions deploy pco-store-tokens pco-me pco-disconnect
```

**5. Run the page.**

```sh
cp web/config.example.js web/config.js   # fill in project URL + anon key
npx serve web -l 3000
```

## Verification

1. Click **Connect Planning Center** → PCO consent screen names your app and
   lists People access. Approve.
2. The **Provider token check** panel must read **PASS**. This is the go/no-go:
   if `provider_refresh_token` is null, see *Fallback* below.
3. In the SQL editor: `select user_id, pco_person_id, organization_name,
   expires_at from pco_connections;` — one row, `expires_at` ~2 hours out.
4. Click **Call /people/v2/me** → your own PCO person record.
5. **Force the refresh path** — the single most likely thing to be silently
   broken:
   ```sql
   update pco_connections set expires_at = now() - interval '1 minute';
   ```
   Call `/people/v2/me` again. It must still succeed, and the response's
   `token.refreshed_during_request` must be `true`. Confirm `refresh_token` in
   the row changed — that proves rotation is being persisted.
6. Temporarily drop the `User-Agent` header in `pcoFetch` and watch for the
   `403`. Restore it. Worth seeing once.
7. Click **Disconnect**, then **Call /people/v2/me** → a clean 404
   "No Planning Center connection", not a 500.

## Fallback if the provider refresh token does not come through

Custom OIDC providers are new and passthrough of `provider_refresh_token` is not
explicitly documented. If step 2 fails, run the code exchange yourself: add a
`pco-connect` function that redirects to `/oauth/authorize` with `code_challenge`
(S256), `state`, and `nonce`, and a `pco-callback` function that verifies state
and POSTs to `/oauth/token`. Register
`https://<ref>.supabase.co/functions/v1/pco-callback` with PCO instead. The
table, the refresh logic, and everything downstream are unchanged.

Note that OAuth servers commonly withhold a refresh token when *re*-authorizing
an already-approved app. Revoke the app in your PCO account before concluding
the feature is broken.

## Security notes

- `pco_connections` has RLS enabled with **zero policies**, which denies `anon`
  and `authenticated` outright. Only the service-role key reaches it.
- Functions run `verify_jwt = false` and authenticate manually via
  `requireUser()`. The platform's built-in check runs before the handler and
  rejects the CORS preflight, which carries no `Authorization` header; manual
  verification is equivalent security with a working preflight.
- Tokens are stored in plaintext columns. Fine for a spike; move to Supabase
  Vault before this holds real churches' data.

## Deliberately out of scope

Multi-org handling, webhooks, rate-limit backoff, encryption at rest, and any
actual product feature.
