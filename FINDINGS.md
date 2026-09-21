# Findings: Planning Center + Supabase OAuth

**Purpose.** This repo is a throwaway spike whose only job was to de-risk the
Planning Center connection before a product gets built on top of it. Everything
below was hit, diagnosed, and verified against a real PCO organization and a real
free-tier Supabase project — none of it is from documentation alone.

**Read this before writing any code.** Roughly half of these cost an hour each to
find and take one line to avoid. Section 2 is the setup that works; section 4 is
why each step is written the way it is.

**Status: the whole flow is proven.** Connect → read → refresh/rotate →
disconnect → revoke, with tokens encrypted at rest. See section 6 for what was
*not* tested.

---

## 1. Verdict on the architecture

Planning Center registered as a **Supabase custom OIDC provider**, with the PCO
tokens captured into a Vault-backed table and refreshed by our own code.

This works and is the fastest path. The callback URL costs zero code, and PCO
publishes an OIDC discovery document so Supabase resolves every endpoint and the
JWKS from the issuer URL alone.

The one structural caveat: **Supabase never persists or refreshes provider
tokens.** `provider_token` and `provider_refresh_token` appear in the session
object once, immediately after sign-in, and are gone on the next session refresh.
Any product that calls the PCO API on a user's behalf needs its own token store
and refresh loop regardless of which provider mechanism it uses. Plan for that
from day one; it is not an optimization to add later.

The fallback, never needed: run the authorization-code exchange yourself in two
Edge Functions (`/pco-connect` builds the authorize URL with PKCE + state,
`/pco-callback` exchanges the code). Everything downstream is identical.

---

## 2. Five-minute setup

Ordered so nothing blocks on anything else. Every step encodes a snag from
section 4.

### 2.1 Supabase project
Create a free project. The callback URL is **deterministic from the project ref**,
so you can register it with PCO before configuring anything:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

### 2.2 Register the PCO application
<https://api.planningcenteronline.com/oauth/applications>

- Sign in under **your company's own PCO organization**, not a church's. If you
  don't have one, create a free org — the signup walks you through it as though
  you were a church, and the "church name" can be your company name. This is the
  intended path.
- You must be an **Organization Administrator** of that org.
- **Create exactly one application.** The single client_id/secret is reused for
  every church that connects; churches never create their own.
- The **client secret is displayed once**.

### 2.3 Custom OIDC provider
Dashboard → Authentication → Sign In / Providers → Custom Providers → New →
**OIDC**:

| Field | Value |
|---|---|
| Provider ID | `custom:planning-center` (must start with `custom:`) |
| Issuer | `https://api.planningcenteronline.com` |
| Client ID / Secret | from 2.2 |
| Scopes | `openid people` (add product scopes as needed) |

Free plan allows 3 custom providers.

### 2.4 Two dashboard settings that are easy to miss
Both live on pages *other* than the provider config:

- **Authentication → URL Configuration → Redirect URLs**: add your dev origin
  (e.g. `http://localhost:3000`). Without it, `redirectTo` is silently rejected
  and you land on the Site URL — which looks exactly like a failed OAuth flow.
- **Authentication → Sign In / Providers → Email → Confirm email**: turn **off**
  (see snag 4.9). Note this is project-wide, not per-provider.

### 2.5 Deploy

```sh
supabase link --project-ref <ref>      # non-interactive with </dev/null
supabase db push                       # needs the DB password; prompts
supabase secrets set PCO_CLIENT_ID=... PCO_CLIENT_SECRET=... \
  "PCO_USER_AGENT=Your App (you@example.com)" ALLOWED_ORIGIN=http://localhost:3000
supabase functions deploy pco-store-tokens pco-me pco-disconnect
```

Secret names **may not begin with `SUPABASE_`** — those are injected
automatically (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`).

### 2.6 Client config that is not optional

```js
createClient(url, anonKey, { auth: { flowType: "pkce" } })
```

See snag 4.1. The default is `implicit`, which puts credentials in the URL.

---

## 3. Verified reference

All confirmed live, not read from docs.

### Planning Center

| | |
|---|---|
| Issuer | `https://api.planningcenteronline.com` |
| Authorize / Token | `/oauth/authorize`, `/oauth/token` |
| Revoke / Introspect | `/oauth/revoke`, `/oauth/introspect` |
| UserInfo / JWKS | `/oauth/userinfo`, `/oauth/discovery/keys` |
| Discovery | `/.well-known/openid-configuration` |
| Grants | `authorization_code`, `refresh_token`, `client_credentials` |
| Client auth | `client_secret_basic`, `client_secret_post` |
| PKCE | `S256`. Recommended for confidential, required for public |
| Scopes | `api calendar check_ins giving groups home people publishing registrations resources services openid` |
| Claims | `iss sub aud exp iat name email organization_id organization_name` |

- **Access tokens: 2 hours** (`expires_in: 7200`).
- **Refresh tokens rotate.** Every refresh returns a new one. Persist it or the
  chain breaks on the next call.
- **Refresh tokens are honored 90 days from the access token's issuance** — not
  from last use. An idle connection strands silently. See section 6.
- **`User-Agent` is mandatory** on every request. Missing or generic gets a bare
  `403` with no explanation.
- `openid` composes with product scopes and yields an `id_token` carrying the
  org identity, so you learn *which church* connected without a second call.
- `people/v2/me` needs the `people` scope. `current/v2/me` needs **no scope**.
- Permissions are always the connecting user's. Their PCO access changing changes
  your API access.
- Revoking the **refresh** token also invalidates its access token — verified:
  the access token went 200 → 401 immediately.

### Supabase

- Custom OAuth/OIDC providers shipped **April 2026**. Free plan: 3 per project.
- `provider_token` / `provider_refresh_token` are **returned once and never
  stored**. Both *did* come through for PCO — the go/no-go passed.
- `supabase` CLI 2.75 has **no `functions logs`** subcommand. Build your own
  diagnostics into the page (section 5).

---

## 4. Snags

Each cost real time. Symptom first, since that's how you'll meet them again.

### 4.1 supabase-js defaults to the implicit flow, not PKCE
*Cost: the longest single detour — four failed attempts at a related fix.*

**Symptom.** OAuth completes, a session exists, but the page never sees `?code=`
in the URL. Any logic keyed to the authorization code silently never runs.

**Cause.** `DEFAULT_OPTIONS` in `@supabase/auth-js` `GoTrueClient.js` sets
`flowType: 'implicit'`. The implicit flow returns everything in the **URL
fragment** and never sets `?code=`.

**Fix.** `createClient(url, key, { auth: { flowType: "pkce" } })`.

**Why it matters beyond the bug.** Under implicit, the Supabase access token *and
both PCO provider tokens* come back in the URL fragment, where they persist in
browser history and are readable by anything on the page. This is a
credential-handling problem, not a cosmetic one. Fix it even if nothing in your
code reads `?code=`.

Commit `ea73455`.

### 4.2 `SIGNED_IN` does not mean "just signed in"
**Symptom.** Code gated on `SIGNED_IN` runs on every page load and every tab
focus.

**Cause.** supabase-js persists the session to localStorage and re-emits
`SIGNED_IN` when it recovers one. `INITIAL_SESSION` also fires on load. Neither
event distinguishes a fresh OAuth return. The reference docs do not specify the
trigger conditions.

**Fix.** Detect the OAuth return from the URL instead, read synchronously at
module load before supabase-js consumes and strips it — and check **both**
shapes:

```js
const qs   = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
const isOAuthReturn = qs.has("code")            // pkce
  || hash.has("access_token") || hash.has("provider_token");  // implicit
```

Commits `5c99737` (wrong), `efa9fb9` (incomplete), `ea73455` (correct).

### 4.3 Re-storing tokens on every page load
**Symptom.** `refreshed_at` advances on page loads where nothing refreshed. Two
redundant PCO API calls per load. Worse: it masks refresh testing (see 5.2).

**Cause.** Consequence of 4.2 — a capture gated on either auth event re-runs
forever, because the persisted session still carries the provider tokens.

**Fix.** Gate on the OAuth return per 4.2.

### 4.4 Reading secrets at module scope kills the worker
**Symptom.** Every request to an Edge Function returns
`500 {"code":"WORKER_ERROR"}` with no detail — including the CORS preflight.

**Cause.** A `throw` during module initialization (e.g. a `requireEnv` helper
assigned to a top-level `const`) takes down the whole worker before any handler
runs.

**Fix.** Read env lazily, inside the functions that use it. A missing secret then
produces a normal 500 naming the variable.

Commit `d848b0e`.

### 4.5 `verify_jwt = true` rejects the CORS preflight
**Symptom.** Browser calls to an Edge Function fail at the preflight; curl with
an `Authorization` header works fine.

**Cause.** The platform validates the JWT *before* your handler. A CORS preflight
carries no `Authorization` header, so it is rejected before your `OPTIONS`
branch runs.

**Fix.** `verify_jwt = false` in `config.toml` **plus** explicit authentication in
every handler:

```ts
const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
const { data, error } = await admin.auth.getUser(token);
if (error || !data.user) throw new HttpError(401, "Invalid or expired session");
```

Equivalent security, working preflight. Do not skip the manual check.

### 4.6 `SECURITY DEFINER` + PostgreSQL's default `PUBLIC` grant
*The most dangerous item here.*

**Symptom.** None. It fails open and looks fine.

**Cause.** PostgreSQL grants `EXECUTE` on new functions to `PUBLIC` by default.
A `SECURITY DEFINER` function that decrypts secrets therefore hands every user's
tokens to any caller who can reach PostgREST.

**Fix.** Revoke explicitly, then grant narrowly:

```sql
revoke all on function public.pco_connection_get(uuid) from public, anon, authenticated;
grant execute on function public.pco_connection_get(uuid) to service_role;
```

**Verify it, don't assume it.** Call the RPC with the anon key; it must return
`42501 permission denied for function`. Without the revoke, moving tokens into
the Vault is *worse* than plaintext columns — those were at least sealed by RLS.

Commit `621b473`.

### 4.7 The Vault schema is not reachable through PostgREST
**Symptom.** `/rest/v1/decrypted_secrets` returns 404; Edge Functions cannot read
secrets directly.

**Fix.** Wrap all access in `SECURITY DEFINER` RPCs in the `public` schema (see
`supabase/migrations/0002_tokens_into_vault.sql`). Four are enough: get, upsert,
rotate, delete. Keep **rotate separate from upsert** — a refresh response carries
no identity or scope, so folding them together overwrites those with nulls.

### 4.8 Rotation must update Vault secrets in place
**Symptom.** None initially. The vault grows by two secrets per refresh, per
user — roughly 24 orphans per user per day.

**Fix.** `vault.update_secret(existing_id, new_value)`, never
`vault.create_secret` on refresh. Likewise, deleting a connection must delete
both secrets, not just the row.

**Verify:** after a refresh the token values must differ while the two
`vault.secrets` ids are **unchanged**.

### 4.9 Supabase emails its own confirmation link on first sign-in
**Symptom.** Sign-in appears to succeed but the session doesn't work until a
"Supabase Auth" email is confirmed.

**Cause.** PCO's discovery document advertises no `email_verified` claim.
Supabase will not treat a provider email as verified unless the provider asserts
it, so it falls back to its own confirmation.

**Fix.** Turn off **Confirm email** (Authentication → Sign In / Providers →
Email).

**Product decision, not just a toggle.** Otherwise every church user
authenticates with Planning Center and is *then* asked to confirm an address PCO
already verified. Defensible to disable because the address arrives in an OIDC
token rather than from user input — but the setting is **project-wide**. If you
later add email/password or magic-link sign-in, those would also skip
confirmation, and there the address *is* user input, which is a real
account-squatting risk. Revisit if a second sign-in method is ever added.

Commit `3023461`.

### 4.10 Smaller ones

- **Redirect URLs live on a different dashboard page** than the provider config.
  Missing entry ⇒ silent bounce to Site URL that looks like a failed flow.
- **Use `/oauth/introspect` for expiry.** When Supabase performs the code
  exchange you don't know the issuance time. Introspection returns the exact
  `exp` *and* the granted `scope`. Better than assuming `now + 7200`.
- **PostgREST refuses unfiltered `PATCH`/`DELETE`.** Add an explicit filter. Good
  safety default; surprising the first time.
- **`supabase link` works non-interactively** with `< /dev/null`. `db push` still
  needs the database password.

---

## 5. How to test without fooling yourself

Two of these produced false passes during this spike.

### 5.1 Build a diagnostic panel before debugging anything
A cached page and a logic bug are **indistinguishable** from the database side.
`web/index.html` renders a build marker, the last auth event, and the storage
decision. Bump the marker on every edit and confirm it changed before drawing any
conclusion. This should have been the first thing built, not the third.

Give each distinct outcome its own panel. A capture failure written into a shared
"result" pane gets overwritten by the next call, and then presents later as an
unrelated "no connection" error. Commit `9a968d9`.

### 5.2 The refresh test is easy to fake
Refresh is the highest-risk path — it can look healthy for two hours and then
break for everyone at once.

```sql
update pco_connections set expires_at = now() - interval '1 minute';
```

Then call the API **without reloading first**, and confirm
`refreshed_during_request: true`.

**The trap:** if the page re-stores on load (4.3), reloading between the update
and the call resets `expires_at` to PCO's real `exp`. The request then finds a
live token, skips the refresh, and reports success. It reads like a pass.

**Verify against the row, not the response:** both token values must differ from
their previous ones, `refreshed_at` must advance, and the `vault.secrets` ids
must not change.

### 5.3 Verify revocation at PCO, not just locally
A disconnect that deletes the row but leaves the token valid at PCO is a silent
failure. Snapshot the access token first, then after disconnecting confirm it
goes **200 → 401** against `/people/v2/me`.

---

## 6. Not tested / known limits

- **The 90-day refresh ceiling is unaddressed.** It runs from token issuance, not
  last use, so lazy refresh cannot cover it and an idle connection strands with
  no signal. Add a weekly `pg_cron` + `pg_net` keepalive (both available on free
  tier) before real churches depend on this.
- ~~**Single organization, single user.**~~ Now exercised - see section 8. Two
  churches, two roles, one account. Webhook-driven org switching is still
  untested.
- **No webhooks, no rate-limit handling.** PCO publishes rate limits; nothing here
  backs off or retries.
- **Tokens are decryptable by anything holding the `service_role` key.** Vault
  protects data at rest — dumps, backups, the table editor — and nothing more.
- **Only `openid` and `people` scopes exercised.** Others should compose
  identically, but that is an assumption.
- The deliberate `User-Agent` 403 check was never run.

---

## 7. Recommendations for the product build

1. **Treat the token store as core infrastructure**, not glue. Supabase will not
   manage provider tokens for you, 2-hour expiry makes refresh a hot path, and
   rotation means a dropped write costs the user a reconnect.
2. **Keep `flowType: "pkce"` and the manual `getUser()` check** in whatever
   framework replaces this page. Both are easy to lose in a rewrite and both are
   security-relevant.
3. **Decide the email-confirmation question deliberately** (4.9) before churches
   see the flow.
4. **Add the `pg_cron` keepalive** with the first real user.
5. **Reuse `supabase/functions/_shared/pco.ts` as-is.** Endpoints, rotation
   persistence, the mandatory `User-Agent`, and lazy env reads are all encoded
   there and all of them were earned.
6. **Port the diagnostic panel idea**, not the page. Being able to see which
   build is running and what the auth layer decided is worth more than it costs.

---

## 8. Multi-tenancy: churches as tenants

Added by migration `0003`. The model is **(user, organization)**, not user: a
person may belong to several churches, and a church must be registered by one of
its Organization Administrators before its members may link.

Verified live against two real PCO organizations - Hope City Church Charlotte
(where the tester is an ordinary member) and Charlotte Church (where they are an
Organization Administrator).

### 8.1 The admin gate

**Assert on `data.attributes.site_administrator` from `/people/v2/me`. Nothing
else.** PCO's UI calls the role "Organization Administrator"; the API kept the
legacy name. There is no `organization_administrator` field - looking for one is
a dead end.

Both poles observed, which is what makes it a gate rather than a formality:

| | Hope City (member) | Charlotte Church (admin) |
|---|---|---|
| `site_administrator` | `false` | `true` |
| `people_permissions` | `null` | `"Manager"` |
| `accounting_administrator` | `false` | `true` |
| `directory_status` | `"no_access"` | - |

- `site_administrator` **is present in the default payload** (`source: "default"`),
  so the `?fields[Person]=...` retry is a fallback, not the normal path.
- It reads `false` for a non-admin rather than being **absent**. A field that is
  never `false` would not be a gate at all - test both poles or you have
  verified nothing.
- **`people_permissions` came back `null`**, not one of the documented
  `Manager`/`Editor`/`Viewer`/`No access` strings. Do not assert on it. It is
  also People-app scoped rather than org-wide: a People Manager is a volunteer
  database admin, not the person who signs a church up for a vendor.
- Confirmed `?fields`-gated, i.e. absent from the default payload:
  `mfa_configured`, `directory_shared_info`, `stripe_account_identifier`,
  `stripe_customer_identifier`.

Ambiguity **fails closed**: a `null` signal returns `403 admin_signal_unavailable`
and logs the full attribute list PCO actually returned, so a wrong field name is
a thirty-second fix rather than an hour.

### 8.2 One human, two churches - Supabase links them for you

This was the open risk that could have invalidated the whole model, and the
answer is better than expected.

**PCO's `sub` is the Person id, and a Person is scoped to an organization**, so
the same human has a different `sub` per church - confirmed: `152662737` at Hope
City, `202345396` at Charlotte Church.

**Supabase attached both to a single `auth.users` row anyway, on a plain
sign-in.** No `linkIdentity()` call was needed or made:

```
819fc9ed-...  custom:planning-center  sub=152662737  14:06:33
819fc9ed-...  custom:planning-center  sub=202345396  15:37:04
```

Two consequences:

- **GoTrue permits two identities from the same provider on one user**, provided
  the `sub` values differ. `auth.identities` is unique on `(provider,
  provider_id)`, not `(user_id, provider)`. The widespread "you cannot link the
  same provider twice" answer is describing the same-`sub` case and does not
  apply.
- **The link happened because the email matched.** PCO asserts no
  `email_verified` claim (4.9) and Confirm-email is off project-wide, so two
  identities were merged into one account on the strength of an unverified email
  string. Convenient here; load-bearing in production. This is 4.9's
  account-squatting risk in a new costume and it should be revisited before real
  churches depend on it.

**`auth.identities.identity_data` does NOT carry the org claims** - `organization_id`
and `organization_name` are both null there. `/oauth/userinfo` is the only
source. There is no cheaper path; do not try to optimize it away.

### 8.3 Authorization belongs inside the decryption query

`pco_connection_get` joins `memberships` in the same statement that joins
`vault.decrypted_secrets`. A caller who is not an active member of an active
church gets **zero rows instead of a token**.

Verified: asking for a church the user does not belong to returns `[]` **even
with the `service_role` key**. The guarantee lives in SQL, not in TypeScript, so
a forgotten check in an Edge Function cannot leak. The `requireMembership()` call
in the handlers is defence in depth and a clearer error - not the boundary.

### 8.4 Permissions change and nothing tells you

Demoting the tester from `owner` to `member` - to match what PCO actually says -
immediately broke the church's background identity, because
`pco_connection_get_service` joins `role in ('owner','admin')`:

| | |
|---|---|
| `pco_connection_get` (own connection) | still resolves |
| `pco_connection_get_service` | **0 rows - background work dead** |
| `pco_connections.is_service` | still `true` |
| `organizations.status` | still `active` |

**Nothing detected the inconsistency.** PCO never notifies you when a person's
permissions change, and the service connection carries one human's permissions.
Fold an admin re-check into the `pg_cron` keepalive (§6) rather than trusting the
claim made at registration time.

### 8.5 Snags

**Every connection RPC signature changed, and Postgres overloads by signature.**
`CREATE OR REPLACE` with new parameters leaves the old
`pco_connection_get(uuid)` alive and callable forever - a function answering
"this user's connection" with no church named is exactly the footgun the
migration exists to remove. Drop the old signatures explicitly, and repeat the
`revoke ... from public, anon, authenticated` loop (4.6) for every new one, since
dropping resets grants.

**Testing the revoke with the wrong arguments passes for the wrong reason.**
Calling an RPC with `{}` returns `PGRST202` ("no matching signature") without
ever reaching the permission check. Call with the **real argument names** and
require `42501`. All seven functions verified this way.

**`onAuthStateChange` fires several times per sign-in** - `INITIAL_SESSION`, then
`SIGNED_IN`, then again on a token refresh - and the OAuth-return flag stays true
for the life of the page. Without a latch the tenancy decision is re-made on
every event: three identical `tenancy_events` rows and three PCO round trips per
sign-in. This is 4.3 wearing a different hat, and the rewrite reintroduced it
after v5 had already fixed it. The UI looked correct throughout; only the rows
showed it.

**The one-shot provider tokens have to survive the tenancy decision.** The gate
must refuse to store until the church is registered, but registration needs a
token to ask PCO who you are. Storing "pending" tokens defeats the gate, so the
tokens stay in the browser's memory across that round trip. A reload destroys
them and the resulting failure looks exactly like a permissions bug - which is
why the Status panel reports `provider_tokens_in_memory`.

### 8.6 Still not tested

- The orphan reap itself. The guard was verified (a user who already belongs to
  one church is **not** deleted when refused at another), but the deletion path
  needs a brand-new account at an unregistered church who is *not* an admin -
  and an admin is never reaped, by design.
- Rotation isolation between two connections; service-connection handover on
  disconnect; the non-admin registration refusal.
- Hope City remains `migrated_unverified`: it was claimed by the backfill's
  construction and no one who can prove admin rights there has registered it.
