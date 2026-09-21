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
  identically, but that is an assumption. Section 9 exercises a good deal more
  of the People surface under the same grant; campus concepts in the other
  products remain untested.
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
6. **Campus support costs nothing extra - build it on People.** Campuses are
   free, organization-level and unlimited; the church's list comes from the
   service connection and a member's own campus from their own token. Section 9
   has the split and the traps.
7. **Port the diagnostic panel idea**, not the page. Being able to see which
   build is running and what the auth layer decided is worth more than it costs.

---

## 8. Multi-tenancy: churches as tenants

Added by migration `0003`. The model is **(user, organization)**, not user: a
person may belong to several churches, and a church must be registered by one of
its Organization Administrators before its members may link.

Verified live against two real PCO organizations - Hope City Church Charlotte
(where the tester is an ordinary member) and Charlotte Church (where they are an
Organization Administrator).

**Verdict: the model holds.** One Supabase account acts as an owner at one
church and a plain member at another, with four independent Vault secrets, no
cross-tenant leakage, and a registration gate that refuses the right people for
the right reason. Two branches remain untested for want of a third person
(8.10); everything else below was observed, not inferred.

The risk that could have invalidated the design - PCO scoping a Person to an
organization, so the same human has a different `sub` per church - turned out
not to bite, for a reason nobody would predict from the docs (8.2).

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

Verified end to end: an ordinary member forcing `org-register` gets
`403 not_organization_administrator` with `site_administrator: false` recorded
as an actual boolean, and nothing is written to `organizations`.

**`GET /people/v2` is NOT usable as an org-identity cross-check.** Reading the
Organization vertex needs permissions an ordinary person does not have, and PCO
says so plainly:

```
"User with id 152662737 cannot read
 AppGraph::V2026_06_04::Vertices::OrganizationVertex with id 98537"
```

So the endpoint is unavailable for precisely the users the gate exists to
reject. `/people/v2/me` works for everyone and is the one to rely on. Treat a
`/people/v2` refusal as missing evidence, never as a failure - see 8.5.

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

**`/oauth/userinfo` is the ONLY way to learn which church a token belongs to.**
Established three separate ways, so stop looking:

- `auth.identities.identity_data` carries neither `organization_id` nor
  `organization_name` - both null.
- `/people/v2/me` carries no organization id at all. Not in `attributes`, and
  **there is no `meta.parent`** on the response - that envelope appears in
  webhook deliveries, not here. `links.organization` is `null` outright for an
  ordinary member.
- `GET /people/v2` is forbidden to non-admins (8.1).

Do not try to optimize the userinfo round trip away. There is nothing to
optimize it into.

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

### 8.5 Rotation is per connection

Verified with two live connections, one expired by hand and the other left
alone - asserted against the rows, never the response (5.2):

| | Hope City (expired) | Charlotte Church |
|---|---|---|
| `refreshed_at` | 15:55:58 -> **16:01:20** | 15:44:51.357616 -> **identical** |
| `access_token_id` | **unchanged** | unchanged |
| `refresh_token_id` | **unchanged** | unchanged |

Both halves matter. Unchanged secret ids on the rotated row prove
`vault.update_secret` wrote in place rather than minting new secrets (4.8).
An untouched sibling row - identical to the microsecond - proves refreshing one
church's token does not reach into another tenant's. The HTTP response cannot
show you either fact; only the table can.

### 8.6 Two Person attributes that look like permissions and are not

- **`membership`** is free text describing church membership status. The test
  account reads `"Elder"` while `site_administrator` is `false` and
  `people_permissions` is `null`. It is a pastoral label, not an authorization
  signal, and it is the most inviting wrong field on the whole vertex.
- **`resource_permission_flags`** is an undocumented object. Observed shape:
  `{"can_access_workflows": false}`. Single-product and not org-wide; do not
  build a gate on it.

### 8.7 A degraded church must not become an unjoinable one

Disconnecting the only owner's connection correctly degraded the church to
`needs_service_connection` - and then locked the owner out of the only action
that repairs it, because `pco_org_join` refused every status except `active`.
The church was bricked with no path back short of hand-editing a row.

Fixed in `0004`. Two rules worth carrying forward:

- **Only `suspended` bars the door.** `needs_service_connection` means degraded,
  not closed. A status that describes a *capability* the church has lost should
  never be enforced as a *permission* it has forfeited.
- **The repair is the ordinary path, not a special one.** Storing a connection
  for an owner or admin, when the service slot is empty, adopts it and restores
  the church to `active`. There is no recovery flow to discover and nothing to
  remember to run - reconnecting simply works.

The happy path cannot find this: a church with two administrators promotes a
successor on disconnect and never degrades at all. It took disconnecting a
sole owner, which is also the likeliest real-world shape for a small church.

### 8.8 Snags

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

**Order the checks so the cheapest, most-permitted one runs first.** The
original `org-register` cross-checked the organization id before checking admin
rights. That cross-check reads `GET /people/v2`, which a member is forbidden to
do, so a non-admin got a raw PCO 403 instead of
`not_organization_administrator` - and no `tenancy_events` row at all, because
the throw beat the logging. The happy path never showed it: an Organization
Administrator *can* read the vertex, so registering a church you administer
worked perfectly throughout. Only the case the gate exists to reject exposed it.

The rule that falls out: **hard-fail on contradictory evidence, never on
missing evidence.** A mismatch between `userinfo` and `/people/v2` is still a
409. A refusal to answer is recorded and moves on. And note the cross-check was
always belt-and-braces - the org id is derived from the token via
`/oauth/userinfo` and never comes from the request body, so there was no
client-supplied value to distrust in the first place.

**The one-shot provider tokens have to survive the tenancy decision.** The gate
must refuse to store until the church is registered, but registration needs a
token to ask PCO who you are. Storing "pending" tokens defeats the gate, so the
tokens stay in the browser's memory across that round trip. A reload destroys
them and the resulting failure looks exactly like a permissions bug - which is
why the Status panel reports `provider_tokens_in_memory`.

### 8.9 Verified at the boundary

Asserted against rows and against Planning Center - never against our own
responses (5.2, 5.3).

- **The migration landed in place.** After `0003`, the pre-existing connection
  still decrypted through the new org-aware RPC with `refreshed_at` unmoved
  (14:35, well before the migration ran) and its Vault secret ids unchanged.
  Nobody reconnected. An advanced `refreshed_at` would have meant something
  rewrote the tokens.
- **Registration happy path.** An Organization Administrator registered a
  church: `admin_verification_method: "site_administrator"`, `admin_verified_at`
  stamped, owner membership created, and their connection adopted as the
  service connection.
- **Isolation.** `pco_connection_get` returns `[]` for a church the user does
  not belong to **even with the `service_role` key**, and the seven definer
  functions all return `42501` to the anon key.
- **Revocation reaches PCO, and only for that church.** The disconnected
  church's own access token went `200` -> `401` when curled directly at PCO
  before and after, while the other church's token continued to answer `200`.
  Deleting a row is not revoking a token, and only this test knows the
  difference.
- **The self-heal works through the ordinary path.** After a degrade, simply
  reconnecting as the owner restored `is_service` and flipped the church back to
  `active` - no recovery flow, no manual step. Reconnect minted a fresh Vault
  secret pair rather than reusing the deleted one.
- **The Vault invariant held at every checkpoint:**
  `(select count(*) from pco_connections) * 2 = (select count(*) from vault.secrets)`
  was `true` throughout - through registration, refusal, rotation, disconnect
  and reconnect. Any test that leaves it false has leaked or orphaned a secret.

### 8.10 Still not tested

Recorded rather than waved through. Each is blocked on needing another person,
not on effort.

- **The promote branch of service handover.** The *degrade* branch is verified -
  a sole owner disconnecting leaves the church `needs_service_connection` with
  no promotion. Promotion needs a church with two administrators, each holding
  their own connection.
- **The orphan reap itself.** The guard is verified: a user who already belongs
  to one church is **not** deleted when refused at another. The deletion path
  needs a brand-new account at an unregistered church who is *not* an admin -
  and an admin is never reaped, by design.
- **Registering an already-claimed church.** Neither the `409 claimed_by_other`
  path nor the `200 already_owner` idempotent path has been exercised. Both
  need a second Organization Administrator in the same PCO organization. The
  `unique (pco_organization_id)` constraint is the real arbiter, so the risk is
  in how the two functions *report* the conflict, not in whether it is caught.
- **Hope City remains `migrated_unverified`.** It was claimed by the backfill's
  construction and no one who can prove admin rights there has registered it.

---

## 9. Campuses: what the People API exposes, and to whom

Added by `pco-campuses`, a read-only probe that records every outcome instead of
throwing - because at this surface a 403 is the finding, not a failure.

Verified live against the same two organizations as section 8: Hope City Church
Charlotte (ordinary member) and Charlotte Church (Organization Administrator).

**Verdict: campus is usable, but only from one direction.** A product can always
learn *which* campus the signed-in person belongs to. It cannot, from an ordinary
member's token, learn *what campuses exist* - every direct read of the Campus
vertex is refused, including that member's own campus by id. A campus picker
therefore needs the church's service connection; a "your campus" label does not.

Campus scoping of people reads **works** (`where[primary_campus_id]`), though
establishing that took a test designed to exclude rather than to confirm - see
9.4, which is the most transferable lesson in this section.

And campus is **optional per church**, with `total_count` a genuine count at
every value - zero, one, or many (9.3). Nullable everywhere is the correct
assumption, not a defensive one, and only zero needs handling as "standalone".

Nothing here required a scope beyond `openid people`, and 9.8 establishes from
Planning Center's own documentation that nothing should: campuses are an
organization-level Account Settings feature, free and unlimited, and Services
and Calendar have no campus API at all.

### 9.1 Where campus identity actually lives

Six ways to ask, both poles, one request each:

| How you ask | Hope City (member) | Charlotte Church (admin) |
|---|---|---|
| `relationships.primary_campus` on `/people/v2/me` | key present, `{type: "PrimaryCampus", id: "95199"}` | key present, `data: null` (before campuses existed; `127163` after) |
| `/people/v2/me?include=primary_campus` | `included: [{type: "Campus", id: "95199", name: "West"}]` | `included: []` (before; the campus after) |
| `/people/v2/me?fields[Person]=primary_campus_id` | `200`, attribute absent | `200`, attribute absent |
| any Person attribute matching `/campus/i` | none | none |
| `/people/v2/people/{id}/primary_campus` | **403** `CampusVertex with id 95199` | **404** |
| `/people/v2/campuses` | **403** `CampusVertex collection` | **200**, `total_count: 0` |

- **There is no `primary_campus_id` attribute on Person.** Campus is
  relationship-only. Section 8.1 found PCO gates some attributes behind
  `?fields`, so that was asked by name rather than assumed - it is not there
  either. Do not go looking for a campus column on the person.
- **The relationship type is `PrimaryCampus`; the resource type is `Campus`.**
  Same id, two type names in the same document. Key a lookup off the
  relationship's `type` and it will never match the included resource.
- **`relationships.primary_campus` is present-and-null when unassigned**, not
  absent. Charlotte Church proves the key exists even in an organization with no
  campuses anywhere. Presence of the key and truthiness of the value answer
  different questions; collapsing them is a false pass in both directions.
- `Person.relationships` carries exactly one key on the default payload:
  `primary_campus`.

### 9.2 The include is the only door a member has

This is the finding that changes how the product should be written. Same token,
same campus id, four requests:

| Request | Result |
|---|---|
| `/people/v2/campuses` | `403` - "cannot read `CampusVertex` collection" |
| `/people/v2/campuses/95199` | `403` - "cannot read `CampusVertex` with id 95199" |
| `/people/v2/people/152662737/primary_campus` | `403` - same vertex, same id |
| `/people/v2/me?include=primary_campus` | **`200`, campus id and name returned** |

An `include` is not subject to the vertex permission that the direct read
enforces. The member cannot fetch campus `95199` by any address, and is
nonetheless told it is called "West".

**Ask for a campus through the person, not through the campus.** And do not
build on this being deliberate - it is observed behavior on a permission surface
PCO does not document. Product code that depends on it should degrade to "campus
unknown" rather than break.

The parallel to 8.1 is exact: the obvious endpoint is forbidden to precisely the
users who most need the answer, and a different endpoint answers for everyone.

### 9.3 `total_count` is a real count, including zero

The same church was read three times as its campus configuration was changed
underneath it, by an Organization Administrator each time:

| Campuses configured in Account Settings | `/people/v2/campuses` |
|---|---|
| none | `200`, `total_count: 0`, `[]` |
| two ("West", "North") | `200`, `total_count: 2` |
| one, after deleting "North" | `200`, `total_count: 1`, `["West"]` |

**All three values are real and distinguishable.** Zero means no campuses are
configured, one means one, and the number is a count at every value.

**A correction, and the reason this file prefers observation to documentation.**
Planning Center's help pages state that campus information surfaces across
products "only if more than one campus is added" in Account Settings
(<https://help.planningcenter.com/en/136812-multiple-accounts-or-multiple-campuses-.html>).
Reading that across to the API, this section previously argued that
`total_count: 0` might really mean "at most one campus" and that a single-campus
church would be invisible. **That was wrong.** The hide-until-two rule describes
*product UI surfacing*; the People campus collection counts honestly. A church
with one campus reports `1`, and the original `0` was a genuine zero.

The transferable part is not the campus detail. It is that a documented UI
behavior was reasoned across to an API boundary, sounded entirely plausible, and
did not transfer. One deletion settled what no amount of re-reading the help
page would have.

For the product this is the simpler outcome: `0`, `1` and `n` mean what they
say, and only `0` needs treating as "standalone church".

A second thing changed when the campuses were created. The administrator's own
Person had `relationships.primary_campus: null` beforehand and
`{type: "PrimaryCampus", id: "127163"}` afterwards. Whether PCO assigned that
automatically or it was set in the UI during setup was not isolated, so it is
recorded as an observation, not a mechanism.

**`200 []` and `403` are the same `data.length === 0`.** Only the status
separates "this church has no campuses" from "this person may not see them", and
a helper that throws on non-2xx destroys the distinction before the caller sees
it. That is 8.8's rule - hard-fail on contradictory evidence, never on missing
evidence - applied to a new surface, and it is why `pcoProbeWithToken` exists.

At the administrator pole the empty list is trustworthy, and it is worth being
precise about why: PCO's refusal at Hope City is a *vertex permission* check
that fires on the collection before any content is considered. A `200` therefore
means the permission passed, not that the church happens to have nothing to
hide. At the member pole an empty list never occurs; you get the 403 instead.

The weaker half of the claim: the administrator's `200` was on an empty
collection, so "an administrator can enumerate campuses" is established by the
permission check passing rather than by campuses actually being returned. See
9.8.

Campus collection metadata, from the pole permitted to see it:

| | |
|---|---|
| `can_query_by` | `created_at`, `updated_at`, `id` |
| `can_order_by` | `name`, `created_at`, `updated_at` |
| `can_include` | `lists`, `service_times` |

**You cannot look a campus up by name** - it is orderable but not queryable.
Match on id, and cache the id, not the name.

### 9.4 Campus scoping works - but the obvious test for it is worthless

`meta.can_query_by` on `/people/v2/people` includes **`primary_campus_id`**, and
the filter is **effective**: verified against Charlotte Church once it had two
campuses.

The trap first, because it nearly produced the opposite finding. A control probe
sending a deliberately meaningless filter - `where[zz_not_a_real_field]=1` -
returned **`200` with the same `total_count` as the unfiltered read**. PCO
silently ignores `where[]` keys it does not recognize. A campus-filtered read
coming back with rows therefore proves nothing: a working filter and an ignored
one are the same response.

Worse, the natural way to test it is also worthless. Filtering by **your own**
campus returns you whether the filter works or not:

| Query | `total_count` |
|---|---|
| unfiltered baseline | 1 |
| `where[zz_not_a_real_field]=1` (control) | 1 - ignored |
| `where[primary_campus_id]=127163` - the caller's own campus | 1 |
| `where[primary_campus_id]=127164` - **a campus the caller is not in** | **0** |

The first three are identical. Only the fourth separates the hypotheses, and it
does so in a church with **one** person in it.

**The rule: test a filter with a value you expect to EXCLUDE the thing you can
see.** A filter that returns what you expected is compatible with there being no
filter at all. This generalizes past campuses to every `where[]` PCO accepts.

Two campuses is therefore the minimum useful fixture for this question, and it
is why 9.9 no longer lists the filter as untested.

### 9.5 `directory_status` is a third attribute that looks like permissions and is not

Extending 8.6. **Both** poles read `directory_status: "no_access"` - and the
Charlotte administrator then read `/people/v2/people` successfully while the
Hope City member was refused. It describes Church Center directory visibility,
not API permission. It is the most plausible wrong gate on this vertex now that
`membership` and `resource_permission_flags` have been ruled out.

The real gate is the vertex permission, and PCO names it in the refusal:

```
"User with id 152662737 cannot read
 AppGraph::V2026_06_04::Vertices::PersonVertex collection."
```

Read the `meta.description` of a PCO 403. It names the vertex and the id, which
turns "something is forbidden" into a precise fact.

### 9.6 Snags

- **404 and 403 mean different things on the edge endpoint.**
  `/people/v2/people/{id}/primary_campus` routes correctly: the administrator
  with no campus got `404`, the member who is forbidden got `403`. Had only the
  member been tested, that `403` would have read as "`/me` aliases do not
  support sub-paths" and the endpoint would have been written off.
- **A throwing HTTP helper cannot express this section.** Every load-bearing
  result above is a non-2xx. `pcoProbeWithToken` returns
  `{path, ok, status, body, error}` and never throws; `pcoFetchWithToken` is
  unchanged and still throws, for the callers where a non-200 means stop. Both
  share one `pcoRequest`, so the mandatory `User-Agent` has exactly one
  definition.
- **`status: -1` means the request was never sent**, and `fetch_failed:` prefixes
  a transport error (`status: 0`). "We did not ask", "the network broke" and
  "PCO refused" are three findings; a missing line in the probe list reads as
  none of them.
- **The probe writes nothing - deliberately, including `tenancy_events`.**
  Section 8.9 counts and reads those rows as an assertion target. A diagnostic
  that pollutes the evidence it is measured against is worse than no diagnostic.
- **Nine PCO calls in a single request**, the first burst this spike has
  produced. No `429` at either pole, but nothing here backs off if there were.

### 9.7 Scope refusals and permission refusals differ, and the scope check wins

Two different noes, and the product must tell them apart - one means "this
church has not granted us that product", the other means "this person may not".

| Request | Status | PCO says |
|---|---|---|
| `/people/v2/campuses` (in scope, no permission) | **403** | `cannot read CampusVertex collection`, naming the user and the vertex |
| `/services/v2/campuses` (out of scope) | **401** | `{"code": "bad_scope", "title": "Request outside authenticated scope"}` |
| `/current/v2/me` (needs no scope) | **200** | - |

`errors[0].code === "bad_scope"` is machine-readable and unambiguous. Branch on
it rather than on the status alone.

**The scope check runs before routing, so you cannot map PCO's surface from
outside the scope.** A sweep of fifteen campus-shaped paths across six products
on an `openid people` token returned `401 bad_scope` for every one - including
`/publishing/v2/campuses` and `/resources/v2/campuses`, which very likely do not
exist. An endpoint that is absent and an endpoint that is merely unscoped are
indistinguishable.

The rule that falls out: **a question about another product's API can only be
answered by granting that scope.** Fifteen requests produced one bit of
information. Do not try to discover the surface; grant the scope and look, or
leave the question open and say so.

> **Extended by 11.2.** Granting the scope answers the question but does not
> guarantee the answer is yes. There is a third refusal below this one - a
> granted, live, introspected scope that PCO still refuses with a *different*
> 401 (11.1). A scope is a ceiling on what the app may ask for, not a statement
> of what this person may read.

Run it with the console escape hatch:
`__pco.call("pco-campuses", {organization_id, sweep: true})`.

### 9.8 What Planning Center's documentation says

Everything above this subsection was observed. **This subsection is
documentation, not observation** - it is kept separate on purpose, because the
rest of this file earns its authority by not being read off a docs page. Sources
are linked so each claim can be re-checked or falsified.

**Campuses are an organization-level Account Settings feature, not a product
feature.** They are configured once under Account settings -> Church Campuses
and mirrored outward into the products; no product owns them. Planning Center
states it "does not limit the number of campuses you can have"
(<https://help.planningcenter.com/en/136809-add-campus-information.html>), and
the pricing page carries no campus line item, tier, or add-on
(<https://www.planningcenter.com/pricing>). Per-product metering is by rooms,
team members, attendees, donations, check-ins and group members - never by
campus.

**This settles the architectural question: multi-campus does not require a paid
product.** People is free and unlimited, campuses are free and unlimited, and a
campus list is reachable on the `people` scope alone. No paid product needs to
be a pillar for campus support.

**Services and Calendar have no campus API at all.** Grepping both published
vertex indexes for "campus" returns nothing. In Services, campus is a tagging
and folder-naming convention; in Calendar it is auto-created Tags. A product
cannot read campuses from either.

**Four apps expose the same central campus list**, each behind its own
product's permission model:

| Endpoint | |
|---|---|
| `GET /people/v2/campuses` | the one used here |
| `GET /groups/v2/campuses` | also `/groups/v2/campuses/{id}/groups` |
| `GET /giving/v2/campuses` | also `/giving/v2/people/{id}/primary_campus` |
| `GET /registrations/v2/campuses` | |

Check-Ins models campus in its UI and exposes `/check-ins/v2/events/{id}/campuses`,
but has no documented Campus vertex.

**The 403 in 9.2 is undocumented behavior.** The People Campus docs annotate
`POST`, `PATCH` and `DELETE` with "Must be an Organization Administrator" and
annotate `GET` with **nothing at all**
(<https://api.planningcenteronline.com/docs/apps/people/versions/2026-06-04/vertices/campus>).
The read permission is not published anywhere, and a search of the
planningcenter/developers issue tracker for `CampusVertex` returns nothing. What
9.2 records is therefore new information, not a restatement of the manual.

Account Settings itself has exactly two permission levels - organization
administrator and billing manager - and there is **no campus-scoped
administrator role** in PCO
(<https://help.planningcenter.com/en/136856-permissions-in-account-settings.html>).
Within People the levels are Manager / Editor / Viewer, and the published
permissions table marks "Edit campus" for Manager and Editor but not Viewer
(<https://help.planningcenter.com/en/136861-permissions-in-people.html>). Whether
People Editor is enough for `GET /people/v2/campuses` is **not documented and
not tested** - see 9.9.

**The Campus schema, now confirmed against live data.** The reference below was
read from the docs before any populated campus list existed; once Charlotte
Church had two campuses, `/people/v2/campuses` returned exactly these attribute
keys - with the single exception of `time_zone_raw`, which the docs mark as
`?fields`-gated and which duly did not appear. The docs' `include` values
(`lists`, `service_times`) and order-by values (`name`, `created_at`,
`updated_at`) also matched the live `meta`. The published reference is accurate:

```
church_center_enabled  city          contact_email_address  country
created_at             date_format   description            geolocation_set_manually
id                     latitude      longitude              name
phone_number           state         street                 time_zone
time_zone_raw          twenty_four_hour_time                updated_at
website                zip
```

`time_zone_raw` is `?fields`-gated - the same pattern as `mfa_configured` in
8.1. The only relationship is `organization` (to_one). Note what is *absent*: a
campus carries no person count, no parent-campus link, and no ordering weight.

**Method note, correcting an assumption made while planning this work.**
`developer.planning.center` is a client-rendered SPA and cannot be fetched. But
`https://api.planningcenteronline.com/docs/apps/{app}/versions/{version}/vertices/{vertex}`
is **server-rendered and greppable with plain curl** (follow redirects with
`-L`). Every API claim above came from there. Do not conclude PCO's reference is
unreadable just because the pretty one is.

### 9.9 What this means for the product build

Two reads, two identities. Neither needs a scope beyond `openid people`.

| What | Whose token | How |
|---|---|---|
| The church's campus list | the **service connection** (an Organization Administrator, already adopted at registration - section 8) | `GET /people/v2/campuses`, cached locally |
| This user's campus | the **member's own** connection | `/people/v2/me?include=primary_campus` |

**A member cannot self-select a campus from their own token.** They are
forbidden the campus collection (9.2), so a "which campus do you attend?" screen
built on the member's connection has nothing to populate itself with. Serve the
options from the cached list instead - the member never needs the PCO permission
at all. This is the whole reason the split above matters; get it wrong and the
feature looks impossible rather than merely indirect.

**A member has a campus only if someone assigned them one in PCO.** The
`primary_campus` relationship is always present on the Person and frequently
points at nothing. Treat `null` as "campus unknown" and degrade; never as an
error, and never as "this church has no campuses" - those are different
questions answered by different requests.

**Decision taken for this build: no write-back.** Campus assignment stays in
Planning Center, and the product reads it. Whether the service connection
*could* PATCH a Person's `primary_campus` is untested - it is a Person write
rather than a Campus write, so the "must be an Organization Administrator" note
in 9.8 does not settle it either way. Recorded as untested rather than assumed
impossible (9.10).

**Do not reach for another product.** Campuses are free, organization-level and
unlimited, and Services and Calendar expose no campus API at all (9.8). A
campus feature built on People alone works for every church that can use the
product at all.

**Interpretation is literal.** `total_count` is `0`, `1` or `n` exactly (9.3);
only `0` needs handling, as "standalone church". And a campus record carries no
person count and no parent link, so any rollup is yours to compute.

**Assume staleness.** Nothing notifies you when a person's campus changes - the
same silence as 8.4's permission changes. Whatever caches the campus list or a
person's campus needs a refresh path.

### 9.10 Still not tested

- **Hope City's campus count.** A member cannot enumerate, so only the name of
  their own campus ("West") is known. The plural is inferred from the name, not
  observed.
- **Whether the include workaround (9.2) generalizes** to other People endpoints,
  or is specific to `/people/v2/me`.
- ~~**Whether another product's campus endpoint bypasses the People 403.**~~
  **Answered in 10.1: it does.** The same member who gets `403` from
  `/people/v2/campuses` gets `200` and three campuses from
  `/groups/v2/campuses`. The caveat written here still holds and is the subject
  of 10.7 - Groups is optional to a church in a way People is not, so this is a
  fallback and not a replacement. It also settles the first item above: Hope
  City runs three campuses, North, West and East.
- **Whether People Editor or Manager can list campuses.** Undocumented (9.8).
  Needs a second person, or a role change at a church where the tester is an
  administrator.
- **Writing a person's `primary_campus`.** Deliberately not attempted (9.9). It
  is a Person write, not a Campus write, so 9.8's Organization-Administrator note
  on campus writes does not answer it.
- **Campus reassignment.** PCO does not notify you when someone's primary campus
  changes - the same silence as 8.4's permission changes. Any cached campus
  scoping goes stale with no signal, which is one more reason for the `pg_cron`
  job in section 6.

---

## 10. Groups: a second permission domain, and the churches that do not have it

Added by `pco-groups`, built to the same rules as `pco-campuses` - read-only,
non-fatal, every outcome recorded because at this surface a refusal is the
finding.

Verified live against Hope City Church Charlotte on an **ordinary member's**
token carrying `openid people groups`. Seventeen probes, **zero refusals**.

**Verdict: Groups answers almost everything People refuses, and belongs to a
different permission model entirely.** The same person who is
`directory_status: "no_access"` in People - forbidden the directory, forbidden
the campus collection, forbidden their own campus by id (9.2) - can read their
group's full 55-person roster from Groups, with email addresses, phone numbers
and postal addresses attached. Nothing was negotiated for this; it is simply a
different product with different rules.

The catch is in the section title. **People is guaranteed and Groups is not.**
Every PCO church has People, free and unlimited, and cannot use the platform
without it. Groups is optional, metered, and may hold nothing at all. Section
10.7 is the line between the two, and it is the section to read if you are
deciding what to build.

This section also closes the highest-value hypothesis left open by 9.10.

### 10.1 The same token, the two products

| Read | People | Groups |
|---|---|---|
| Other people at this church | **403** - directory forbidden (8.1) | **200** - 55 rows, contact details included |
| The church's campus list | **403** - `CampusVertex` collection (9.2) | **200** - North, West, East |
| One campus by id | **403** - same vertex, by id (9.2) | not attempted - the list answered |
| Structural taxonomy | n/a | **200**, and **empty** (10.6) |

One person, one token, one request apart. 9.2 concluded that a campus picker
needs the church's service connection; for a church that uses Groups, that is
now false - `GET /groups/v2/campuses` answers it directly.

This is exactly the fallback 9.10 predicted and 9.7 said could only be settled
by granting the scope. It was, and it does. It also incidentally answers the
first item in 9.10: **Hope City runs three campuses** - North, West and East -
a fact a member could not previously learn from their own token.

**Do not read this as "Groups is the way around People's permissions."** It is
a way around them at churches that use Groups. That is a smaller set, and 10.7
is the whole reason this section exists.

### 10.2 `/groups/v2/groups` is not the church's groups

```
"total_count": 2,
"list": [
  { "id": "2583839", "name": "West Men's Breakfast",  "memberships_count": 55, "mine": true },
  { "id": "2771136", "name": "Coulwood Dinner Group", "memberships_count": 12, "mine": true }
]
```

A three-campus church does not run two groups, and both rows are the caller's
own. **The top-level collection is implicitly scoped to the caller's
memberships** - it is a fourth door to "my groups", not a church directory.

Stated as near-certain rather than proven: the alternative reading is a church
with exactly two groups, both of which the tester happens to belong to. One run
from an administrator's row settles it and has not been done (10.10).

The consequence either way is the same, and it is the important one:
**a member's token cannot enumerate the church's groups.** Any discovery
feature - browse groups, find a group near me, which groups need help - needs
the service connection.

### 10.3 Four doors open to "the groups I am in"

Six candidates probed, all `200`, four yielding group ids:

| Request | Returned | Group ids |
|---|---|---|
| `/groups/v2/me` | `Person` | 0 |
| `/groups/v2/me/groups` | `Group` | **2** |
| `/groups/v2/people/{id}` | `Person` | 0 |
| `/groups/v2/people/{id}/groups` | `Group` | **2** |
| `/groups/v2/people/{id}/memberships` | `Membership` | **2** |
| `/groups/v2/memberships?where[person_id]={id}` | `Membership` | **2** |

- **`/me` sub-paths route here.** They do not in People - 9.6 records
  `/people/v2/people/{id}/primary_campus` answering `403` where the `include`
  answered `200`. Another way the two products differ.
- **A `200` that yields no group ids is still a finding.** `/groups/v2/me`
  returns a `Person`: the door exists and is not the one you want. Recording the
  returned `type` is what separates that from an empty result.
- **The fourth row proves nothing yet.** 10.5 establishes that Groups *ignores*
  unknown `where[]` keys. If `person_id` is not a real query key on
  `/groups/v2/memberships`, that collection is answering "your memberships"
  regardless of the id in the URL - and passing a stranger's id would return
  your groups, not theirs. Untested, and it is the one open question here with a
  security shape (10.10).

  > **Answered in 14.1, and the guess above was too kind.** The filter is
  > discarded and the collection returns every membership the caller may see -
  > two, at a church where the named person holds one. Use the path form,
  > `/groups/v2/people/{id}/memberships`.

Use `/groups/v2/me/groups`. It is the cheapest, it needs no person id, and it
returns `Group` rather than a join row.

### 10.4 The roster is readable, and it carries contact details

`GET /groups/v2/groups/2583839/memberships?per_page=25&include=person`

```
"total_count": 55,
"attribute_keys":   ["joined_at", "role"],
"can_include":      ["person"],
"included_types":   ["Person"],
"person_attribute_keys": [
  "addresses", "avatar_url", "created_at", "email_addresses",
  "first_name", "gender", "last_name", "permissions", "phone_numbers"
]
```

**This is the finding the product turns on.** A member token can read who is in
their group and how to reach them. No service connection, no administrator, no
directory permission - the same token that People answers `no_access` to.

Three qualifications, none of them small:

- **Keys are not values.** The probe records attribute names only, by design -
  this file is in git and a roster is not evidence. Whether
  `email_addresses` and `phone_numbers` are populated or empty arrays is
  **unverified** (10.10). It changes the product if they are empty.
- **Contact details on the Person here are nested arrays**, not the separate
  `/people/v2/emails` resources People uses. Do not carry a People-shaped reader
  across.
- **`members_are_confidential` exists and must be honoured** (10.6). PCO already
  maintains the flag that says this roster is not for showing.

`includes_caller: false` in the probe output **is a defect, not a finding** -
it was computed from the five-row redacted sample rather than the twenty-five
returned, and twenty-five of fifty-five could not settle it either. Ignore the
field; it is fixed in 10.9.

### 10.5 A group has no campus, and the filter that appears to work does not

Three independent signals, all agreeing:

| Signal | Value |
|---|---|
| `relationships` on Group | `["group_type", "location"]` - **no `campus` key at all** |
| `meta.can_include` | `["enrollment", "group_type", "location"]` - no campus |
| `meta.can_query_by` | `["archive_status", "name"]` - campus not filterable |

`where[campus_id]=10192` returned `200` and the unchanged baseline, which on its
own proves nothing - and this is 9.4's lesson arriving in a second product. The
control probe settles it:

```
baseline               /groups/v2/groups                            → total_count 2
control  /groups/v2/groups?where[zz_not_a_real_field]=1             → total_count 2
filtered /groups/v2/groups?where[campus_id]=10192                   → total_count 2
```

**Groups ignores unknown `where[]` keys, exactly as People does** (9.4). An
ignored filter and an effective one return the same `200`, so the filtered count
is uninterpretable without the control. `can_query_by` says the same thing more
cheaply and should be consulted first.

Note the baseline here is `2` - the caller's own groups (10.2) - so the count
comparison was degenerate regardless. `can_query_by` is the load-bearing
evidence, not the arithmetic.

**So campuses and groups are both visible to a member and nothing joins them.**
Campus-local routing cannot come from Groups. It has to come from
`Person.primary_campus_id` - which 9.2 found only through the `include` door -
or from the group's `location`, which is a physical address rather than a campus
id. Never from the name, however much "West Men's Breakfast" invites it.

Whether the campus edge is absent from the *API* or merely unset at *this
church* is not settled by key absence alone at one organization (10.10) - though
`can_include` omitting campus is the stronger of the two signals, since that
list is PCO's, not the church's.

### 10.6 What a Group carries, and which of it is a product decision

Full attribute set from `/groups/v2/groups/2583839`:

```
archived_at            chat_enabled              contact_email
created_at             description               description_as_plain_text
direct_messages_enabled  events_listed           events_visibility
header_image           leaders_can_search_people_database
listed                 location_type_preference  members_are_confidential
memberships_count      name                      public_church_center_web_url
schedule               virtual_location_url
```

Five of those are decisions rather than data:

- **`members_are_confidential`** (`false` here). The roster flag. Recovery
  groups, care groups, anything where membership is itself sensitive. Whether
  setting it actually *blocks* the read of 10.4 or is merely advisory is
  **untested and is the most important open question in this section** (10.10).
  If advisory, honouring it is our responsibility, and it belongs in the schema
  rather than in a template.
- **`chat_enabled`** and **`direct_messages_enabled`** (both `true`). PCO Groups
  already ships group chat and direct messages. Do not build chat.
- **`public_church_center_web_url`**
  (`hopecityclt.churchcenter.com/groups/groups/west-men-s-breakfast`). A
  per-group deep link into Church Center. The bridge runs both directions and
  costs nothing.
- **`listed`**, **`events_listed`**, **`events_visibility`** (`"members"`).
  Visibility is per-group and already modelled; mirror it rather than inventing
  a second scheme that can disagree with PCO's.
- **`schedule`** is **free text** - `"Meets monthly on the second Saturday from
  9-11am"`. Unparseable. Anything time-aware must use
  `/groups/v2/groups/{id}/events`, which is structured (`starts_at`, `ends_at`,
  `repeating`, `canceled`, `attendance_requests_enabled`) and readable by a
  member.

**`/groups/v2/group_types` returned `200` with an empty list.** A church cannot
have zero group types, so this is 9.3's ambiguity in a new place - except that
here the generous reading is clearly wrong. The likely explanation is 9.2
repeating itself: the taxonomy is org structure, the collection is shut to a
member, and `can_include: ["group_type"]` is the only door. Untested (10.10),
and it decides whether "your group" can distinguish a small group from a serving
team from a class.

### 10.7 People vs Groups: what every church is guaranteed

The distinction that decides product scope. **People is a floor; Groups is an
assumption.**

Pricing below is **documentation, not observation** - read off Planning Center's
pricing page, and kept separate for the same reason 9.8 is.

| | People | Groups |
|---|---|---|
| Cost | "Free unlimited database and reporting included" | free tier, metered at **15 group members** |
| Can a church skip it? | **No.** It is the platform's spine | **Yes**, entirely |
| Can it be empty? | No - every person is in it | **Yes** - installed with no groups configured |
| Member's read access | severely limited; `directory_status` gates it (8.6, 9.5) | broad, within their own groups (10.4) |
| Enumerate the church | never, from a member token | never, from a member token (10.2) |
| Campus | the authority - `primary_campus` (9.1) | campuses listed, but **not linked to groups** (10.5) |

Four conditions have to hold before a Groups feature has anything to work with,
and they fail independently:

1. The church uses Groups at all.
2. Someone has configured groups in it.
3. **This member is in one.** A church with 200 groups gives a member who joined
   none exactly the same empty screen as a church with none.
4. The group is not `members_are_confidential`, or we honour it and behave as
   though it were empty.

Condition 3 is the one that gets missed. Group adoption is a per-person fact,
not a per-church one, and the per-church check passes for people the feature
cannot serve.

**The rule this produces, and it is the same shape as 8.7:** a Groups feature
degrades to a People feature, never to an error. A church that has not adopted
Groups is not a broken church, and a member in no group is not a broken member.
Both must get a product, and neither may be shown a spinner or a 403.

A practical corollary for anything cached: **Groups availability is a
three-state answer** - has groups / has none / we may not see them - and 10.2
means a member's token cannot distinguish the second from the third. Only the
service connection can. Store which one you learned and from whose token.

**Every Groups observation in this section comes from a church that pays for
Groups** - a 55-member group is four times the free-tier allowance. No free-tier
Groups church has been observed at all, and whether the 15-member meter is per
group or per organization is not established (10.10). Either way, a 55-person
meal train is a paid feature at the church that needs it most.

### 10.8 What this means for the product build

The tiers separate cleanly, and not the way section 9 assumed:

| Tier | Member's own token? | Needs |
|---|---|---|
| **My group** - roster, contact, meeting rhythm | **Yes, completely** | `groups` scope and one connection |
| **My campus** - anything campus-local | No | `primary_campus` via include (9.2) + the cached list (9.9) |
| **The church** - discovery, every group | No | the service connection |

**Group-tier features survive a lapsed service connection.** That is worth more
than it first appears. Section 8.7 established that a church whose service
connection degrades must not become unjoinable; this says the core of a
group-scoped feature does not even notice. The church's identity is needed for
discovery and campus work, not for a member reading the group they are already
in.

**Whatever ships first should be group-scoped.** The API and the adoption
argument agree: the group tier needs one scope, one token, no background
identity, and no campus derivation - and it is the tier where the roster is
small enough to act.

**Campus-local work moves further out** than section 9 implied. 9.9 planned for
the service connection to serve a campus list; that stands, but 10.5 means
nothing in Groups can be scoped by campus, so any "at the North campus" feature
must derive locality from the *person*, one include at a time, or from a group's
physical `location`.

**Do not build chat, and do not build a group directory.** PCO ships both, free,
inside the app members already have (10.6).

**Mirror PCO's visibility flags; never invent a parallel scheme.** `listed`,
`events_visibility` and `members_are_confidential` already encode what a church
decided. A second scheme that can disagree with the first is a privacy incident
with a changelog.

### 10.9 Snags

- **The client's `scopes` option silently overrides the dashboard.** Adding
  `groups` to the provider's Scopes field in Supabase changed nothing:
  `web/index.html` passed `scopes: "openid people"` to both `signInWithOAuth`
  and `linkIdentity`, and supabase-js sends what the call says. PCO then issues a
  token for exactly what was asked, so the failure is **silent** - every
  `/groups/v2` call returns `401 bad_scope` and reads as a permissions problem
  rather than as a scope never requested. Now one `PCO_SCOPES` constant, because
  there are two authorize paths and a scope that differs between them is a bug
  you find at the second church, weeks later.
- **Widening the scope does not touch tokens already issued.** An existing
  connection keeps its grant until the user reconnects. `pco_connection_upsert`
  takes `p_scope` from introspection, so a plain reconnect updates it in place -
  no disconnect, no revoke. The probe reports the stored scope **before** probing
  anything for this reason: "PCO refused us" and "we never asked" are different
  findings that produce identical 401s.
- **Re-authorizing an already-approved app can withhold the refresh token.**
  Already handled by `pco-store-tokens`' 400, and the remedy is still to revoke
  the app at Planning Center first. Widening a scope is the case most likely to
  hit it.
- **`includes_caller` was computed from the redacted sample**, not the returned
  rows, and reported `false` for a caller who is a member of the group. A field
  derived from a deliberately-truncated sample cannot answer a question about the
  whole set. Fixed by computing it over all returned rows and reporting
  `returned`/`total_count` alongside, so a `false` from page one is legible as
  inconclusive rather than negative.
- **The door probes do not record `total_count`**, which is what leaves 10.3's
  fourth row open. A collection that is implicitly self-scoped and one that
  honours a filter are the same two rows at this church; only the count over an
  unfiltered read separates them.
- **Seventeen PCO calls in one request**, up from nine in 9.6. Still no `429`,
  still nothing backing off if there were.

### 10.10 Still not tested

Ranked by how much the answer changes the design.

- **Whether `members_are_confidential: true` actually blocks the roster read.**
  If it is advisory, enforcing PCO's privacy intent becomes our responsibility
  rather than the platform's. Needs a confidential group to test against.
- **Whether the contact arrays are populated.** `email_addresses` and
  `phone_numbers` are present as *keys*; whether they carry values on a group
  roster is unverified, and the group tier is a different product if they are
  empty.
- ~~**Whether `/groups/v2/memberships?where[person_id]=<a stranger>` leaks.**~~
  **Answered in 14.1:** the filter is discarded and the collection is not
  self-scoped. It does not leak past the row filter of 13.5, but it answers a
  larger question than it was asked, with a `200`.
- **`group_type` through the `include` door.** The collection is empty (10.6);
  `can_include` offers it. If the include answers, 9.2's rule generalizes across
  products and the taxonomy is usable.
- ~~**The administrator's row.**~~ **Fully answered in 13.5:** an administrator
  reads a group with `mine: false`, so the collection is row-filtered by
  permission rather than scoped to the caller. The original half-answer, kept
  because the mechanism it identified was right: *run in 12.5,* Both poles
  agree that `/groups/v2/group_types` returns `200` with **0 rows to a member
  and 1 to an administrator** - so Groups enforces permission by removing rows
  rather than refusing, which is strong corroboration for 10.2. But Charlotte
  Church has **zero groups**, so whether an administrator sees the church's full
  group list from `/groups/v2/groups` is still open, and needs a church that is
  both populated and administrable (12.6).
- **A church with Groups installed and no groups configured**, and **a free-tier
  Groups church.** 10.7's degradation rule is reasoned, not observed; both
  states are asserted and neither has been seen.
- **Whether the campus edge is absent from the Groups API or unset at this
  church.** `can_include` omitting campus is PCO's own statement and is the
  stronger signal, but one organization is one data point.
- **Whether a member may read events for a group they are not in**, given
  `events_visibility: "members"`. Only the caller's own groups were touched.
- **Writes of any kind.** Nothing in this spike has ever PATCHed or POSTed to
  PCO. Whether a member token can join a group, or a leader can add a member,
  is entirely unknown.

---

## 11. Calendar: a third kind of no

Added by `pco-calendar`. Same rules as the two probes before it, with one
change: the sweep runs **by default**. 9.7 cuts both ways - outside a scope
every path returns an identical 401 and a sweep is worthless, but inside the
scope a 404 is finally a real answer. Calendar was unmapped and this was the
cheap chance to map it.

Verified live against Hope City Church Charlotte on an ordinary member's token
carrying `openid people groups calendar`. **Thirty-one requests to
`/calendar/v2`. Thirty-one 401s.** `/people/v2/me` answered `200` in the middle
of them, on the same token, in the same request.

**Verdict: a member's token cannot read Calendar at all**, and the reason is a
refusal shape this spike had not seen. Not the 403 vertex wall of 9.2, not the
`bad_scope` 401 of 9.7 - a third thing, which says the request "could not be
authenticated" about a token that demonstrably was.

The section title is the finding. There are three ways PCO says no, they are
not distinguishable by status code, and one of them is indistinguishable from a
dead token.

### 11.1 Three refusals, one token, one request

The evidence, taken simultaneously rather than compared against a remembered
sample from an earlier run:

| Path | Condition | Status | `errors[0].code` | PCO's words |
|---|---|---|---|---|
| `/calendar/v2` | in scope, granted | **401** | `unauthorized` | "This request could not be authenticated. Error Code Hint: (TRASH_PANDA)" |
| `/giving/v2` | **not** in scope | **401** | `bad_scope` | "The API credentials do not have access to the application giving" |
| `/people/v2/campuses` | in scope, no permission | **403** | *(none)* | "User with id 152662737 cannot read ... `CampusVertex` collection" |

Read the three details rather than the three statuses. `bad_scope` makes a claim
about **the API credentials**. The 403 makes a claim about **the user**, and
names the vertex. Calendar makes a claim about **the request**, and it is false.

`giving` is deliberately absent from `PCO_SCOPES` and **must stay absent**. It
is the control. Granting it would destroy the only unambiguous `bad_scope`
sample obtainable without un-granting something else.

**The ordering trap.** `"bad_scope"` contains the substring `"scope"`. A
classifier that tests for `scope` before testing for `bad_scope` collapses the
two 401s into one and erases this entire section. Test the specific code first.

### 11.2 A scope grant is not access

9.7 concluded that the scope check runs first and wins. That still holds, and it
now needs a companion, because a granted scope was assumed to imply reachability
and it does not:

> **The scope is a ceiling on what the app may ask for, not a statement of what
> this person may read.**

Every cheap explanation was eliminated before this was written down:

| Suspect | How it was killed |
|---|---|
| The scope never reached PCO (10.9's snag, in a new costume) | `/oauth/introspect` on the token **in hand**: `active: true`, scope `openid people groups calendar` |
| The stored column echoes what we asked for rather than what was granted | `agrees_with_stored: true` - the live and remembered values match exactly |
| The token is expired or broken | `/people/v2/me` returned `200` four probes later, same token |
| Out of scope, i.e. the same error as `/giving/v2` | Different `code`, different `title`, different `detail` (11.1) |
| The church has not activated Calendar | **Hope City's Church Center app has a Calendar tab showing events** |

That last row is observation by a human in the Church Center app rather than by
probe - a third category, and flagged as such. It is decisive anyway, and it is
the most uncomfortable line in this file:

> **Church Center shows this member calendar events that the member's own API
> token cannot read.**

Church Center does not run on member OAuth permissions. It is a privileged
first-party surface, and on Calendar there is no parity available to anything
built on the public API.

### 11.3 The Person vertex cannot tell you which products you can reach

8.6 established that PCO models per-product permission **on the Person**:
`people_permissions` is People-app scoped and carries Manager / Editor / Viewer
/ No access. The obvious next move is to look for `calendar_permissions` and
pre-flight the whole problem.

It is not there. Ten fields asked for by name, 8.1's rule applied because PCO
gates some attributes behind `?fields`:

```
asked:    calendar_permissions, calendar_permission, services_permissions,
          check_ins_permissions, giving_permissions, groups_permissions,
          registrations_permissions, publishing_permissions,
          people_permissions, site_administrator
answered: people_permissions, site_administrator
```

**`people_permissions` and `site_administrator` are the positive control**, and
they answered. Without them the silence of the other eight would mean nothing -
an unsupported sparse read and a non-existent attribute produce the identical
empty payload, which is 9.4's lesson wearing different clothes.

So: **PCO surfaces a per-product permission on the Person for exactly one
product, People.** The rule that falls out and that the product build has to
absorb:

> **Capability detection is a probe, not a lookup.** The only way to learn
> whether a connection can reach a product is to call that product and read
> `errors[0].code`. There is no attribute to check first, and there is no
> cheaper path.

Cache the answer per connection, because the alternative is a wasted round trip
on every page load - and re-probe it, because 8.4 already established that PCO
notifies you of nothing when permissions change.

**`people_permissions` was `null`**, not `"No access"`. 8.6 recorded four
values; `null` is a fifth, and it is not the same as the string. Anything
branching on that attribute needs a null arm.

### 11.4 401 cannot mean "the token is dead"

The consequence with teeth. `TRASH_PANDA` arrives on a valid token that is
refused a product. `BABOON` - the same `unauthorized` code, the same "we can't
authenticate this request" - is [reported by developers hitting genuine
refresh-token failures][pc602]. PCO overloads one bucket across unrelated
causes and documents none of the animals.

[pc602]: https://github.com/planningcenter/developers/issues/602

Therefore:

- **Never branch on `401` to decide whether to force re-authorization.** A
  church that does not use one product would log its members out.
- **`code: "unauthorized"` is not enough either**, because real token death
  produces it too. The only reliable signal that a refresh is needed is a
  failure of the **token endpoint**, which `refreshAccessToken` already owns.
- `pcoFetchWithToken` throws `HttpError(res.status, ...)`, so a Calendar 401
  propagates to the browser as a 401. The demo page survives this only because
  it signs out on an explicit `action: "sign_out"` from the server and never on
  a status - which is correct by accident rather than by design, and is the
  shape the product must keep deliberately.

### 11.5 What the Person actually carries

The full default attribute list, recorded because a wrong field name should cost
thirty seconds and because five of these matter more to the product than
Calendar does:

```
accounting_administrator  anniversary            avatar
birthdate                 can_create_forms       can_email_lists
child                     created_at             demographic_avatar_url
directory_status          first_name             gender
given_name                grade                  graduation_year
inactivated_at            last_name              login_identifier
medical_notes             membership             middle_name
name                      nickname               passed_background_check
people_permissions        remote_id              resource_permission_flags
school_type               site_administrator     status
updated_at
```

- **`child`** - the minors gate. Every safety question in a member-to-member
  product runs through it, and it is free, on People, for every church.
- **`passed_background_check`** - sits on the Person, for every church, and is
  exactly what any volunteering feature needs before it matches an adult to a
  task involving children.
- **`medical_notes`** - present on the Person vertex. Something to design *away*
  from deliberately; it must never be read, cached or logged.
- **`resource_permission_flags`** - a nested capability bag,
  `{can_access_workflows: false}`, and a **second and different shape** of
  permission modelling alongside `people_permissions`. One flag today. Worth
  watching rather than building on.
- **`membership`** and **`status`** - the church's own categorisation, and
  `status: "active"` is not the same question as `directory_status` (9.5) or
  `people_permissions`. Three attributes that look like permissions and are not,
  now: 8.6 found two, 9.5 found the third, and this is the fourth family.

### 11.6 The free-vs-paid axis was the wrong axis

Calendar was chosen for this spike because Planning Center's pricing page
advertises **"Unlimited events, pay for facilities management"** - free tier one
room. Section 10.7 had just drawn the line between what every church is
guaranteed and what it merely might have, and Calendar looked like the same line
drawn inside one product: events free and unlimited, rooms metered.

The probe measures both halves. **Neither half was ever reachable.** The room
count that would have told us whether this church pays returned 401, like
everything else.

So 10.7's model needs a third column, and it is the one that actually decides
product scope:

| | Free for the church? | Every church has it? | **Reachable on a member's token?** |
|---|---|---|---|
| **People** | yes, unlimited | **yes, mandatory** | yes, narrowly - `/me` and what you are part of |
| **Groups** | free to 15 members | no, optional | **yes, broadly** - own groups, full rosters, contact (10.4) |
| **Calendar** | yes, unlimited events | yes, activated here | **no. Nothing. 401 on every path** |

**Free for the church and reachable by us are orthogonal**, and the pricing page
speaks only to the first. Calendar is the counter-example that proves they are
independent axes: the most generously-priced product in the catalogue is the
least reachable one we have found.

Groups - optional, metered, skippable - gives a member far more than Calendar,
which is free, unlimited and activated. **Adoption and pricing predict nothing
about API reachability. Only a probe does** (11.3).

### 11.7 What this means for the product build

**No member-facing calendar feature can be built on member tokens.** This holds
under both surviving explanations (11.9), which is why it is safe to write down
while the cause is still open.

**If a calendar feature is wanted, it runs on the service connection alone** -
and that is strictly worse than the group tier. 10.8 recorded that group-scoped
features survive a lapsed service connection because the member reads their own
group directly. A calendar feature has no such fallback: when the church's
background identity degrades, it goes dark completely. Whether the service
connection can even read Calendar is **untested** (11.9) and must be settled
before anything is designed on top of it.

**Campus-local routing is still homeless.** 10.5 found Groups carries no campus
edge; Calendar was the next place to look and it refused the question. 9.8's
documentation claim that Calendar exposes no campus API remains unverified by
observation - we never got far enough to check. `Person.primary_campus` through
the include door (9.2), plus the service connection's campus list (9.9), remains
the only mechanism this spike has found.

**Do not chase Church Center parity.** 11.2 shows Church Center reading data the
member's own token cannot. Any roadmap item phrased as "Church Center does X, so
we should do X" needs this check first - some of what it does is not available
to anyone outside Planning Center.

**Rank products by probe result, never by pricing page.** The one-line version
of 11.6, and the most transferable thing in this section.

### 11.8 Snags

- **`"bad_scope"` contains `"scope"`.** Classify the specific code before the
  general one or the two 401s merge (11.1).
- **A remembered control is not a control.** 9.7's `bad_scope` sample came from
  a different token on a different day. Two 401s from two runs cannot be
  compared; the probe now takes all three refusals in the request that is trying
  to tell them apart.
- **`introspect` was already in `_shared/pco.ts`** and is the answer to "is this
  column telling the truth". A stored scope is written once, at store time,
  against a token that has since rotated - it is a remembered value and belongs
  on the suspect list whenever a scope-shaped failure appears.
- **A guessed field name that does not exist and a real one that is null return
  the same empty payload.** Every sparse-fields probe needs a known-real field
  alongside the guesses, or its silence proves nothing (11.3).
- **Thirty-one PCO requests in one invocation**, up from seventeen in 10.9. No
  `429` yet at any point in this spike, and still nothing backing off. The
  default-on sweep is most of it; `{sweep: false}` skips it.
- **The probe returns event names verbatim.** Unlike the campus and group
  probes, its output cannot be pasted into git unread - an event name is free
  text a human typed, and "Premarital counseling - the Ruizes" is a name. It
  reads no person resource, which is a different guarantee from returning no
  personal data.
- **Church Center answered the decisive question and no HTTP client could.**
  `hopecityclt.churchcenter.com/calendar` is a JS-rendered SPA and fetches as
  `Loading...`. The tester opening the app settled in five seconds what three
  probe runs could not.

### 11.9 Still not tested

- ~~**Whether the refusal is per-person or per-application.**~~ **Answered in
  12.1: per-person.** An Organization Administrator gets `200` from
  `/calendar/v2` on the same application, same client id, same scope string.
  The original reasoning, kept because it was right: two explanations
  survived: this member holds no Calendar permission in PCO, or **our OAuth
  application** is not permitted Calendar regardless of who holds the token. The
  second is the less likely - PCO answered `bad_scope` for an unrequested
  product and something *different* here, which suggests the scope was honoured
  and something downstream refused - but it is not excluded. **One run of
  `pco-calendar` from the Charlotte Church row separates them:** a `200` for an
  Organization Administrator means per-person; an identical `TRASH_PANDA` with
  Calendar activated there means per-application, and that is a support ticket
  rather than a design constraint.
- **Whether the service connection can read Calendar at all.** 11.7 makes it the
  only possible path for a calendar feature and nothing has tested it. If an
  Organization Administrator is also refused, Calendar is closed to this
  integration entirely.
- **Every measurement the probe was built to take.** Event attributes and
  `visible_in_church_center`, event instances and whether recurrence is
  structured, date filtering by bracket syntax or `filter=future`, whether
  Calendar validates unknown `where[]` keys or ignores them like People (9.4)
  and Groups (10.5), the room count and therefore the paid-tier signal, tags,
  and whether an event carries a campus (9.8's unverified documentation claim).
  All of it returned 401. The code is written and will run the moment a token
  gets past the door.
- **What `resource_permission_flags` grows into.** One flag today
  (`can_access_workflows`), a different shape from `people_permissions`, and no
  documentation found for either.
- **Whether `TRASH_PANDA` and `BABOON` are distinguishable causes** or one
  bucket with a random animal. Only Planning Center can answer that, and 11.4's
  rule is written to be correct either way.

---

## 12. The administrator's row: what changes, and what does not

Sections 9, 10 and 11 each ended by asking for the same thing - the second
pole. Both probes run at Charlotte Church, where the tester is an Organization
Administrator holding the church's service connection (`role: owner`,
`is_service: true`, `site_administrator: true`, `people_permissions: Manager`).

**Verdict: Calendar is gated per person, and the gate is the only thing between
us and the whole product.** `/calendar/v2` answered `200` for an administrator
on the same OAuth application whose token was refused thirty-one times as a
member. That closes 11.9's leading question, and it means the Calendar surface
can finally be mapped - which it now is, including the first `404`s this spike
has ever been able to trust.

It also produced a finding nobody went looking for: **campus ids are not the
same number in every product** (12.3).

And it is a reminder that an empty church answers fewer questions than a real
one (12.6). Charlotte Church has no groups, no events and no resources, so
several things 10.10 and 11.9 asked for are still open - and two probe defects
that only a zero-row church could expose are fixed in 12.8.

### 12.1 Calendar is per-person, not per-application

| | Hope City (member) | Charlotte Church (administrator) |
|---|---|---|
| `/calendar/v2` | **401** `unauthorized` / TRASH_PANDA | **200** |
| `/people/v2/campuses` | **403** `CampusVertex` collection | **200** |
| `/giving/v2` (control) | **401** `bad_scope` | **401** `bad_scope` |
| `site_administrator` | `false` | `true` |
| `people_permissions` | `null` | `Manager` |

Same OAuth application, same client id, same scope string, same code path. The
only variable is the person. **11.9's second hypothesis is dead:** the
application is permitted Calendar, and 11.2's rule survives intact - a granted
scope is a ceiling on what the app may ask for, not a statement of what this
person may read.

The `bad_scope` control answering identically at both poles is what makes that
readable. Without it, "the admin got 200" would be compatible with the member's
connection simply being broken.

**Note the administrator's `directory_status` is also `no_access`** - and they
read `/people/v2/campuses` anyway. 9.5 recorded `directory_status` as a third
attribute that looks like permissions and is not; this is that finding at the
opposite pole, and it is now hard to state more plainly. Do not gate anything
on it.

**And there is still no `calendar_permissions` attribute** - the same ten-field
sparse read, the same two known-real controls answering, the same eight guesses
absent, for an Organization Administrator. 11.3's rule holds at both poles:
**capability detection is a probe, not a lookup.**

### 12.2 The Calendar surface, finally mapped

The first sweep in this spike that carried information. 9.7 established that
outside a scope every path returns an identical `401` and a sweep is worthless;
inside the scope, with permission, `404` and `200` finally mean different things.

**Five of the eighteen guessed nouns do not exist:**

```
404  /calendar/v2/event_times          404  /calendar/v2/event_connections
404  /calendar/v2/required_approvals   404  /calendar/v2/resource_suggestions
404  /calendar/v2/reports
```

**Thirteen do**, including `conflicts`, `feeds`, `attachments`, `room_setups`,
`resource_bookings`, `event_resource_requests`, `resource_approval_groups`,
`resource_questions` and `job_statuses`.

`event_times` is the instructive one: **`404` as a collection, but present in
`can_include` on an event instance.** A noun can be sideloadable without being
addressable. Do not infer a collection from an include, or an include from a
collection.

What PCO says it will let you filter and sideload - the part that decides
whether a product is buildable:

| Collection | `can_query_by` | `can_include` |
|---|---|---|
| `events` | `approval_status`, `created_at`, `featured`, `link_only`, `name`, `feed_id`, `percent_approved`, `percent_rejected`, `updated_at`, **`visible_in_church_center`** | `attachments`, `calendar`, `feed`, `owner`, `tags` |
| `event_instances` | `calendar_ids`, `created_at`, `ends_at`, **`event_name`**, `kind`, **`starts_at`**, **`tag_ids`**, `updated_at` | `event`, `event_times`, `resource_bookings`, `tags` |

Three of those matter more than the rest:

- **`visible_in_church_center` is a query key.** The church has already decided
  which events are for the congregation; that decision is filterable, not just
  readable. A member-facing calendar does not have to guess, and must not.
- **`starts_at` and `ends_at` are query keys.** Date windows work, so nothing
  needs to pull a whole calendar to render a week.
- **`events.can_order_by` came back `null`.** Ordering is not offered on events
  the way it is on groups (10.2). Sort locally, or work through instances.

### 12.3 A campus is not the same id in every product

Charlotte Church has exactly one campus, named West. Asked three ways:

| Asked | Campus id |
|---|---|
| `/people/v2/me` → `primary_campus` (9.1) | `127163` |
| `/groups/v2/campuses` | `127163` |
| `/calendar/v2/campuses` | **`100405`** |

One campus. One name. Two different ids, in the same church, in the same
request window.

Cross-checked at the other pole, which agrees: at Hope City the member's
`primary_campus` from People is `95199` "West" (9.1), and `/groups/v2/campuses`
lists `95199` "West" (10.1). **People and Groups share a campus id space.
Calendar does not.**

The consequence is worse than it first looks, because of 9.4 and 10.5:

> A campus id cached from People, used to filter a Calendar read, does not
> error. Unknown `where[]` keys are **ignored**, so it returns the unfiltered
> set and looks like it worked.

**Key every cached campus by `(product, id)`, never by id alone**, and never
carry an id across a product boundary without a translation. The only stable
join between them observed so far is the campus *name*, which is a string a
human typed and is not a key.

Stated with its limit: one church, one campus, one comparison. But the two
products disagreeing at all is the finding, and a single unambiguous
disagreement is enough to forbid the assumption.

### 12.4 Calendar has campuses; Calendar events have no campus

9.8 recorded, from documentation, that "Services and Calendar expose no campus
API at all". Observation splits that claim in half:

- **False for the collection.** `/calendar/v2/campuses` exists and answers.
- **True for the linkage.** `events.can_include` is `attachments`, `calendar`,
  `feed`, `owner`, `tags` - no campus. Neither `events.can_query_by` nor
  `event_instances.can_query_by` offers a campus key. There is nothing to join
  an event to a campus with.

So 10.5's conclusion extends rather than reverses: **Groups has no campus edge,
and neither does Calendar.** Three products now expose a campus list and only
People links a *person* to one.

The grouping dimensions Calendar actually offers are **`calendar_ids`** and
**`tag_ids`**, both queryable on instances. Any campus locality in a church's
calendar is therefore a per-church *convention* expressed through sub-calendars
or tags - not a platform feature, not guaranteed, and not discoverable without
asking that church. Charlotte Church's single tag is in fact named "West",
which is suggestive and nothing more: it is a test organization and the tester
made the tag.

**Campus-local routing remains homeless after three products.**
`Person.primary_campus` through the include door (9.2) plus the service
connection's cached list (9.9) is still the only mechanism this spike has found.

### 12.5 Groups filters rows silently; it does not refuse

10.6 flagged `/groups/v2/group_types` returning `200` with an empty list as
9.3's ambiguity in a new place, and guessed the taxonomy was shut to a member.
The second pole confirms it:

| | Hope City (member) | Charlotte Church (administrator) |
|---|---|---|
| `/groups/v2/group_types` | `200`, **0 rows** | `200`, **1 row** |

Both `200`. Neither a `403`. **Groups enforces permission by removing rows, not
by refusing the request** - which is a fundamentally different mechanism from
the People vertex wall of 9.2, and far more dangerous to read casually:

> In Groups, an empty collection and a forbidden one are **the same response**.
> There is no error to branch on, no vertex named in a message, and nothing in
> the payload that distinguishes "this church has none" from "you may not see
> them". Only comparing two callers tells them apart.

That is strong corroboration for 10.2's reading of `/groups/v2/groups`
returning only the caller's own groups - the same silent row filter, on a
sibling collection. It is corroboration and not proof, because Charlotte Church
has zero groups (12.6).

The group type itself: **`id: "unique"`, a string, not a number** - PCO's
built-in bucket for groups belonging to no type. Attribute keys are
`church_center_map_visible`, `church_center_visible`, `color`,
`default_group_settings`, `description`, `name`, `position`,
`public_church_center_web_url`. Note `church_center_visible: false` on it, and
`default_group_settings` - a per-type default that presumably seeds
`members_are_confidential` and friends (10.6).

### 12.6 An empty church cannot answer a question about rows

> **Answered in section 13.** One group and one event were added to Charlotte
> Church, making it the first organization here that is both administrable and
> non-empty. Every item below was settled by that run except the ones needing a
> group with *members*, which are carried forward to 13.8.

Charlotte Church has **0 groups, 0 events, 0 event instances, 0 resources**. It
is the right pole for permission questions and the wrong one for behaviour
questions, and the distinction is worth stating because the probes did not make
it and reported nonsense twice (12.8).

Still open *because the church is empty*, not because anything refused:

- **Whether `/groups/v2/groups` is caller-scoped** (10.2). Zero rows are
  consistent with every hypothesis.
- **Whether Calendar's date filters bite.** `can_query_by` lists `starts_at`
  and `ends_at`, which is PCO's own statement and is the load-bearing evidence
  (10.5's lesson). The count arithmetic was `0 < 0` and proves nothing.
- **Whether Calendar ignores unknown `where[]` keys** like People (9.4) and
  Groups (10.5). Control returned `0` against a baseline of `0`.
- **Every event attribute**, including whatever `visible_in_church_center`
  looks like on a real record, and whether an event carries anything
  group-shaped (10.6's unparseable `schedule` having a structured twin).

**The rule: permission questions go to the administrator's row; behaviour
questions go to the church with data in it.** Neither pole answers both, and
this spike has no church that is both real and administrable.

One suggestive scrap worth chasing: **`/calendar/v2/people` returned
`total_count: 1`** at a church where exactly one person has Calendar access. If
that collection enumerates people *with Calendar permission*, it is the
capability lookup 11.3 says does not exist - just on the product side rather
than the Person side. One data point, and the trivial reading (the church has
one person) fits equally well. Untested (12.9).

### 12.7 What this means for the product build

**Calendar is a service-connection surface. Members never touch it.** 11.7 said
this while the cause was open; 12.1 settles the cause without changing the
conclusion. Every calendar feature therefore depends on the church's background
identity staying healthy, with **no member-token fallback** - strictly worse
than the group tier, which 10.8 found survives a lapsed service connection
because the member reads their own group directly.

**But the shape of a good calendar feature is now visible**, and it is better
than expected:

```
GET /calendar/v2/events?where[visible_in_church_center]=true
GET /calendar/v2/event_instances?where[starts_at][gte]=…&where[starts_at][lte]=…
```

The church has already decided what the congregation should see, that decision
is a query key, and date windows are a query key too. A "what's on" surface can
pull exactly the published subset for exactly the week in question, on the
service connection, and **mirror the church's own visibility decision rather
than inventing a second one** - which is 10.8's rule about `listed` and
`members_are_confidential`, arriving independently in a third product.

**Never join campus ids across products** (12.3). This is the single most
expensive mistake available right now, because it fails silently rather than
loudly.

**Never read an empty Groups collection as "none"** (12.5). Groups removes rows
instead of refusing, so a member's empty group-type list, empty group list, or
empty anything is indistinguishable from a permission boundary. Where the
difference matters, the service connection is the only second opinion.

**The product tiering from 11.6 stands, with Calendar's row now measured rather
than inferred:**

| | Free for the church? | Every church has it? | Reachable on a member's token? | Reachable on the service connection? |
|---|---|---|---|---|
| **People** | yes, unlimited | yes, mandatory | narrowly - `/me` and what you are part of | broadly |
| **Groups** | free to 15 members | no, optional | **broadly** - own groups, rosters, contact | untested |
| **Calendar** | yes, unlimited events | yes | **no** | **yes, confirmed** |

### 12.8 Snags

- **A zero baseline decides nothing, and the probe said otherwise.** With zero
  event instances, `0 === 0` made the control report `unknown_where_keys_ignored:
  true`, and the date-filter verdict read `ignored` for `starts_at` - a key PCO
  itself lists in `can_query_by`. Two wrong answers stated confidently. Fixed:
  the control returns `null` on an empty collection, and the verdict consults
  `can_query_by` **before** any arithmetic and returns
  `inconclusive_empty_collection` when the baseline is zero. This is 10.5's
  lesson - `can_query_by` outranks counting - learned a second time because the
  first version only used it as a tiebreak.
- **`!memProbe?.ok` is `true` when `memProbe` is `null`.** The Groups probe
  reported `groups_visible_roster_forbidden` at a church with no groups, for a
  roster it never requested. Optional chaining turns "not attempted" into
  "failed" silently. Fixed by testing `memProbe && !memProbe.ok`, with a
  distinct verdict for a church that has nothing to probe. Same family as
  10.9's `includes_caller` defect: a value derived from an absent measurement
  presented as a measurement.
- **Both defects needed an empty church to surface.** Neither was reachable at
  Hope City, and both had been shipped and committed. A second pole is a test
  environment, not only a permissions comparison.
- **`can_order_by` is `null` on events** and a populated array on groups. Absent
  and empty are different, and a null here is PCO declining to offer ordering
  rather than offering none.

### 12.9 Still not tested

- ~~**Everything in 12.6**~~ **Answered in section 13** - one group and one
  event at Charlotte Church closed the behaviour questions. What survives is
  narrower and listed in 13.8: a group with actual *members*, which is the last
  unexercised path at the administrator pole.
- **Whether `/calendar/v2/people` enumerates Calendar-permitted people.** If it
  does, capability detection gets a cheap answer after all (12.6).
- **Whether the service connection can read Groups.** 12.7's table has an
  untested cell: Charlotte Church's zero groups means the administrator's Groups
  reach was never exercised against real rows.
- **Which Calendar permission level is the threshold.** The administrator tested
  is an Organization Administrator, the maximum. Whether a Calendar Viewer or
  Editor - or any non-administrator with an explicit Calendar role - also gets
  `200` is unknown, and it decides whether "the church's service connection"
  must be an Organization Administrator forever or can be a lesser account.
- **Whether campus ids differ across products at a second church**, and whether
  Giving, Registrations and Check-Ins each have their own space again (12.3).
- **Whether `default_group_settings` on a group type seeds
  `members_are_confidential`** (12.5), which would make the confidentiality flag
  10.10 flagged as critical a per-type default rather than a per-group choice.

---

## 13. Filters that exclude, and what a calendar event actually is

Charlotte Church with one group and one event in it - the first organization in
this spike that is both administrable and non-empty. 12.6 predicted that would
be the unlock and it was.

**Verdict: `can_query_by` is a complete and trustworthy contract**, proven in
both directions for the first time (13.1). Which makes the member-facing
Calendar query real rather than hoped-for: `visible_in_church_center` and
`starts_at` both bite (13.2). And an Event turns out to carry no time at all -
every date lives on the instance, which PCO materializes, so recurrence never
needs parsing (13.3).

One thing arrived unasked and is the most operationally dangerous finding here:
**`updated_at` did not advance when a returned field changed** (13.4).

### 13.1 Declared keys are honoured; undeclared keys are discarded

9.4 and 10.5 established the dangerous half - PCO ignores `where[]` keys it does
not recognise rather than rejecting them, so a filtered count proves nothing.
Neither ever established the safe half, and without it "campus_id is ignored"
was indistinguishable from "no `where` clause does anything at all".

Three filters designed to return **nothing**, each decisive at a church with one
row:

| Product | Filter | Declared in `can_query_by`? | Baseline | Result | Verdict |
|---|---|---|---|---|---|
| Groups | `where[name]=zzz_no_such_group_zzz` | **yes** | 1 | **0** | honoured |
| Groups | `where[campus_id]=127163` | no | 1 | 1 | discarded |
| Calendar | `where[starts_at][gte]=2099-01-01` | **yes** | 1 | **0** | honoured |
| Calendar | `where[visible_in_church_center]=false` | **yes** | 1 | **0** | honoured |
| Calendar | `where[zz_not_a_real_field]=1` | no | 1 | 1 | discarded |

> **`meta.can_query_by` is the contract. Keys in it work. Keys not in it are
> thrown away silently, and the response is a 200 carrying the unfiltered
> set.** Read it at runtime, and never send a `where` key it does not list.

That is now proven in two products, in both directions, with a non-degenerate
baseline. It is the single most useful operational rule in this file, and it is
also the most dangerous thing to get wrong: the failure is not an error, it is a
larger answer than you asked for.

**The positive window proves nothing and the probe now says so.** The window
`[yesterday, +30 days]` contains the one event, so an honoured filter and a
discarded one both return 1. Only a filter that should exclude everything can
separate them - 9.4's lesson, which `pco-campuses` carried as `negative_filter`
and which both later probes were written without (13.7).

### 13.2 The member-facing calendar query is real

`visible_in_church_center` is not merely an attribute to read after the fact. It
is a query key, and it bites:

```
GET /calendar/v2/events?where[visible_in_church_center]=false   → total_count 0
GET /calendar/v2/events                                          → total_count 1
```

The one event is `visible_in_church_center: true`, so asking for `false` correctly
returned nothing. Combined with 13.1, the shape of a workable feature:

```
GET /calendar/v2/events?where[visible_in_church_center]=true
GET /calendar/v2/event_instances?where[starts_at][gte]=…&where[starts_at][lte]=…
```

**The church has already decided what the congregation should see, and that
decision is filterable.** Mirror it; do not invent a second one. Same rule as
10.8's `listed` and `members_are_confidential`, arriving independently in a
third product.

**`visible_in_church_center` is not sufficient on its own.** Calendar runs an
approval workflow: `approval_status` (`"A"` here), plus `percent_approved` and
`percent_rejected`, and `approval_status` is itself a query key. A pending event
flagged visible is still not ready to show anyone. Filter on both.

Also on the event and worth knowing before building a feed: **`description` is
HTML** (`"<div>\n  This is a public description…\n</div>\n"`) and **`summary` is
its plain-text twin**. Use the twin, or sanitize. `featured` and `link_only` are
further display hints, both queryable. `registration_url` is where Registrations
shows through.

### 13.3 An Event has no time; the instance has two

The Event's complete attribute set:

```
approval_status  created_at   description  featured    image_url  link_only
name             percent_approved          percent_rejected       registration_url
summary          updated_at   visible_in_church_center
```

**No `starts_at`. No `ends_at`. No date of any kind.** An Event is the series and
its description; every time lives on `EventInstance`:

```
all_day_event  church_center_url  compact_recurrence_description  created_at
ends_at        location           name       published_ends_at
published_starts_at              recurrence  recurrence_description
starts_at      updated_at
```

Four things follow.

**PCO materializes instances, so recurrence never needs parsing.** `recurrence`
is `"None"`, `recurrence_description` is the English sentence `"Saturday,
September 26, 2026 from 3:30pm to 4:30pm"`, and `compact_recurrence_description`
is `"Does not repeat"`. All three are for display. There is no RRULE and none is
needed - you iterate instances and filter by `starts_at`.

This is the **direct opposite of Groups**, where 10.6 found `schedule` is
unparseable free text (`"Meets monthly on the second Saturday from 9-11am"`)
with no materialized twin. A group's rhythm cannot be computed; a calendar
event's can simply be read. If a feature needs to know when something actually
happens, Calendar is the product that can answer and Groups is not - which is
awkward, because Calendar is the one a member cannot reach (12.1).

**Two time pairs exist and the difference is unobserved.** `starts_at` and
`published_starts_at` are byte-identical here (`2026-09-26T19:30:00Z`), so
`published_differs_from_actual` is `false`. The natural reading is that
`starts_at` is the reserved block including setup and teardown while `published_*`
is what the congregation is shown - but this is a test event with no setup time
configured, and **that reading is inference, not observation** (13.8). Until it
is settled, read `published_*` for anything member-facing: if the two never
differ it costs nothing, and if they do, it is the correct one.

**`location` is free text, and this church put the campus name in it** - `"West
- 2225 Freedom Dr #4, Charlotte, NC 28208"`. 12.4 concluded that campus locality
in Calendar can only be a per-church convention, since no campus field, include
or query key exists. Here is one such convention, in the wild-ish: a campus name
prefixed onto an address string. It is a test organization the tester configured,
so it evidences the *mechanism churches are left with* rather than what churches
typically do. Do not parse it.

**`church_center_url` is per instance** -
`charlotte-church-544011.churchcenter.com/calendar/event/237390596`. The same
bridge Groups offers per group (10.6), at instance granularity.

### 13.4 `updated_at` is not a complete change signal

Two runs of the same probe against the same untouched event, minutes apart:

| | Run A | Run B |
|---|---|---|
| `approval_status` | `"A"` | `"A"` |
| `percent_approved` | **`0`** | **`100`** |
| `updated_at` | `2026-09-21T19:10:51Z` | `2026-09-21T19:10:51Z` |

**A returned field changed and `updated_at` did not move.** Nobody edited the
event between runs; `percent_approved` is computed, and it settled
asynchronously after creation.

Whether that is a semantic guarantee PCO is breaking or ordinary eventual
consistency does not matter to us - the operational consequence is identical:

> **A sync strategy of "poll `where[updated_at][gte]=<last seen>`" will miss
> changes.** It is the obvious design, `updated_at` is a query key on both
> events and instances, and it is not sufficient on its own.

Anything caching PCO data needs a periodic full reconcile, not only a watermark
poll - which is the same conclusion 8.4 and 9.9 reached from a different
direction, PCO notifying you of nothing when permissions or campuses change.
Three independent reasons for the same `pg_cron` job now.

### 13.5 The group list is permission-filtered, not caller-scoped

10.2 read `/groups/v2/groups` returning exactly the caller's own two groups as
"implicitly scoped to the caller", and flagged it as near-certain rather than
proven. The administrator's row settles it in the other direction:

```
"list": [{ "id": "3242172", "name": "Test group", "memberships_count": 0, "mine": false }]
```

**An administrator reading a group they are not a member of.** So the collection
is not hardcoded to "my groups" - it is row-filtered by permission, and for an
ordinary member that filter happens to yield only their own. Exactly the
mechanism 12.5 found on `group_types`, now confirmed on the collection that
matters.

The practical rule is unchanged from 10.2 and now rests on evidence: **a
member's token cannot enumerate the church's groups**, so discovery needs the
service connection. What changes is the reason - not a special-case endpoint,
but the same silent row filter Groups applies everywhere.

### 13.6 What this means for the product build

**The Calendar feature is buildable and its query is now known.** Service
connection only (12.1), filtered to `visible_in_church_center=true` and an
approved `approval_status`, windowed on `starts_at`, reading `published_*` for
display and `summary` rather than `description`. That is a complete
specification, which is more than this spike has for anything else.

**Read `can_query_by` at runtime and treat it as the contract** (13.1). A
hardcoded filter key that PCO later stops declaring does not start failing - it
starts returning everything. Assert the key is present before sending it, and
fail loudly if it is missing rather than sending it anyway.

**Never trust a filter test whose filter matches all the data.** Every filter
this spike has validated needed a case that should return zero. Build that into
how the product's own integration tests are written, not only into probes.

**Budget for a full reconcile** (13.4). Watermark polling on `updated_at` is
insufficient, and that is now the third independent reason for scheduled
reconciliation alongside permission drift (8.4) and campus drift (9.9).

**The rhythm problem is inverted.** Calendar can tell you exactly when things
happen and members cannot read it; Groups is readable by members and its
schedule is unparseable prose. A feature that wants "your group meets Tuesday"
has no clean source: the group's own events (`/groups/v2/groups/{id}/events`,
readable by a member per 10.6) are the only candidate, and at this church there
were none to inspect.

### 13.7 Snags

- **Both later probes shipped without a negative filter.** `pco-campuses` has
  carried `negative_filter` since section 9 precisely because a filter matching
  your own data proves nothing, and neither `pco-groups` nor `pco-calendar`
  ported it. Three filter verdicts were confidently wrong across two commits as
  a result. The lesson is not "remember the negative case" - it is that a probe
  pattern which has already earned its place belongs in the shared module, not
  re-derived per probe.
- **`inconclusive_filter_matches_all` is now a verdict**, because "the filter
  returned everything and everything matched" had been rendering as `ignored`.
  A test that cannot fail must say so rather than reporting a pass.
- **Guard the negative probes on a non-zero baseline.** Excluding everything
  from an empty collection returns zero either way; the fix in 12.8 for the
  degenerate baseline applies to the negative case too.
- **The second run changed a value nobody edited** (13.4), which means probe
  output is not reproducible even against frozen data. Worth knowing before
  treating any single run as authoritative.

### 13.8 Still not tested

- **Whether `published_starts_at` ever differs from `starts_at`** (13.3). Needs
  an event with setup or teardown time configured. Until then the
  member-facing rule is "use `published_*`" on the strength of its name alone.
- **A group with actual members**, which is the last unexercised path in
  `pco-groups` at the administrator pole: the roster read, `include=person`, and
  whether `/groups/v2/memberships?where[person_id]=<a stranger>` leaks (10.3).
  Charlotte Church's one group has zero members, so all three are still open -
  and the leak question is the only one in this file with a security shape.
- **Whether `/groups/v2/groups/{id}/events` returns anything useful**, now the
  only candidate source for a group's real meeting times (13.6). Zero events at
  this church.
- **`resource_bookings` and the paid tier.** Still zero resources; 11.6's
  metered half of Calendar has never been observed with data in it.
- **Whether `approval_status` values beyond `"A"` behave as expected** in the
  query, and what the other codes are. One event, one status.
- **Whether `percent_approved` settling is the only field that moves without
  `updated_at`** (13.4), or whether others do too. One observation, one field.

---

## 14. A filter that does not filter, on the data where it matters

Two people added to Charlotte Church's test group - the last unexercised path at
the administrator pole (13.8).

**Verdict: `/groups/v2/memberships?where[person_id]=…` returns every membership
the caller can see, not that person's.** The filter is discarded, the response
is a `200`, and the count is larger than the question asked for. 10.3 flagged
this as the only open question in this file with a security shape; it is
answered, and the answer is the bad one.

The roster path itself is confirmed at both poles, and the two probe defects
from 10.9 and 12.8 are verified fixed by the run that could finally exercise
them.

### 14.1 The membership filter is discarded

The test group holds two memberships: the administrator and one other person.
Asked two ways, in the same request:

| Request | `total_count` | What it means |
|---|---|---|
| `/groups/v2/people/202345396/memberships` | **1** | correct - this person's membership |
| `/groups/v2/memberships?where[person_id]=202345396` | **2** | every membership in the church |

`person_id` is not a key the collection declares, so 13.1's rule applies
unchanged: **PCO discards it and answers the unfiltered question.** This is the
concrete instance of "the failure mode is a larger answer rather than an error",
landing on the one table in Groups that maps people to each other.

**It is not a permission leak.** The row filter of 13.5 and 12.5 still applies -
the administrator sees two because there are two and they may see both. A member
would get the memberships within their own groups and no further. Nothing
crosses a tenant or a visibility boundary.

**It is worse than it sounds anyway**, because the caller cannot tell. An app
that asks for one person's memberships and renders the answer will render
everyone's, having received a `200` that says it asked correctly. At Hope City
the same request returned rows spanning two groups totalling 67 memberships; the
probe did not record `total_count` at the time (10.9's second defect), so what
that member actually received was never measured.

**Use the path form.** `/groups/v2/people/{id}/memberships` is scoped by the URL
rather than by a query key, and query keys are the thing that silently fail.
The rule generalises past this endpoint:

> **Prefer a scoped path over a `where` clause whenever both exist.** A path
> that does not exist returns `404`. A `where` key that does not exist returns
> everything.

10.3 recommended `/groups/v2/me/groups` for the "my groups" question on grounds
of cheapness. That recommendation is now on firmer ground: of the four doors
that work, the two path-scoped ones (`/me/groups`,
`/people/{id}/memberships`) are correct, and the query-scoped one is not.

### 14.2 The roster, confirmed at the administrator pole

`GET /groups/v2/groups/3242172/memberships?per_page=25&include=person`

```
total_count: 2   returned: 2   page_is_whole_collection: true
includes_caller: true   includes_caller_conclusive: true
person_attribute_keys: addresses, avatar_url, created_at, email_addresses,
                       first_name, gender, last_name, permissions, phone_numbers
```

Identical attribute set to Hope City's 55-person roster (10.4), from the
opposite pole. The roster read is not a member-only affordance or an
administrator-only one; it is the same shape for both.

**Both probe defects are verified fixed by this run**, and neither could have
been checked before it. `includes_caller` is now computed over every returned
row rather than the five-row redacted sample (10.9), and it reports `true` with
`includes_caller_conclusive: true` because `page_is_whole_collection` holds -
two of two. The empty-church verdict bug from 12.8 is gone: the probe reports
`own_groups_and_roster_readable` rather than claiming a forbidden roster.

**`memberships_count` on the group tracks reality** - `0`, then `2`, across
runs. It is the cheap density signal 10.6 hoped it was.

**Contact population is still unmeasured**, and it is now the last thing
standing between this spike and a decision about the group tier. 10.4 recorded
the attribute *names*; whether `email_addresses` and `phone_numbers` carry
values has never been observed, and a roster you can see but cannot reach is a
list of strangers. The probe now counts them - people with at least one entry,
never a value, never a partial one - but the count must be taken at a **real**
church. Two accounts the tester created at a test organization would answer the
wrong question (14.3).

### 14.3 Still not tested

- **Whether the contact arrays carry values at a real church.** The measurement
  exists now; it needs one run of `pco-groups` at Hope City, whose 55-person
  roster is the only real data available. This is the single remaining question
  that changes whether the group tier is a product.
- **Whether `/groups/v2/memberships` declares any usable query key.** 14.1
  proves `person_id` is discarded but the probe never captured that collection's
  `meta.can_query_by`. If it declares `group_id`, the collection becomes useful
  rather than merely dangerous.
- **What a member sees from `/groups/v2/memberships`.** 14.1 reasons it is the
  memberships within their own groups, from 13.5's row filter. Reasoned, not
  observed, and the `total_count` that would have shown it was not recorded at
  the time.
- **A group with a leader.** Both Charlotte memberships came back `role:
  "member"`; Hope City's roster showed `leader`, but only in the five-row
  sample. Whether `role` is queryable, and what values exist, is unknown - and
  routing care to a group's *leader* is an obvious product need.
- **`/groups/v2/groups/{id}/events`.** Still zero events at Charlotte Church,
  so the only candidate source for a group's real meeting times (13.6) remains
  unexercised at either pole.
- **Everything carried forward from 13.8** that this run did not touch:
  `published_starts_at` versus `starts_at`, resource bookings and the paid
  tier, and the `approval_status` value set.
