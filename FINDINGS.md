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
- **Whether another product's campus endpoint bypasses the People 403.** 9.8
  establishes that Groups, Giving and Registrations publish the same org-level
  campus list behind *different* permission models. If an ordinary member has
  Groups access, `GET /groups/v2/campuses` may answer where People refuses. This
  is the single highest-value untested hypothesis here, and it needs only the
  `groups` scope and a reconnect. Note it is a fallback by nature: those products
  are optional to a church in a way People is not.
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
