// Planning Center OAuth + API helpers.
//
// Endpoints below match https://api.planningcenteronline.com/.well-known/openid-configuration
// Key behaviors this module exists to handle:
//   - access tokens expire after 2 hours
//   - refresh tokens ROTATE: every refresh returns a new one that must be stored
//   - PCO returns 403 for any request without a descriptive User-Agent
//
// Multi-tenant note: a connection is now per (user, church), not per user.
// Every helper that used to take a userId takes a resolved connection or an
// (userId, orgId) pair. There is deliberately no way to ask for "this user's
// connection" without naming a church.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const PCO_ISSUER = "https://api.planningcenteronline.com";
export const PCO_TOKEN_URL = `${PCO_ISSUER}/oauth/token`;
export const PCO_REVOKE_URL = `${PCO_ISSUER}/oauth/revoke`;
export const PCO_INTROSPECT_URL = `${PCO_ISSUER}/oauth/introspect`;
export const PCO_USERINFO_URL = `${PCO_ISSUER}/oauth/userinfo`;
export const PCO_API_BASE = PCO_ISSUER;

// Refresh this many seconds before the token actually expires, to absorb clock
// skew and the latency of the call we are about to make.
const EXPIRY_SKEW_SECONDS = 300;

// Read lazily, never at module scope: a throw during module init kills the
// whole worker with an opaque WORKER_ERROR and takes the CORS preflight down
// with it. Reading on use turns a missing secret into a normal 500 with a
// message that says which one.
export const userAgent = () => requireEnv("PCO_USER_AGENT");
const clientId = () => requireEnv("PCO_CLIENT_ID");
const clientSecret = () => requireEnv("PCO_CLIENT_SECRET");

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new HttpError(
      500,
      `Missing secret ${name}. Set it with: supabase secrets set ${name}=...`,
    );
  }
  return value;
}

export interface PcoConnection {
  id: string;
  user_id: string;
  organization_id: string;
  pco_person_id: string;
  pco_organization_id: string | null;
  pco_organization_name: string | null;
  is_service: boolean;
  role: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_at: string;
}

/** Service-role client. Bypasses RLS - only ever construct this server-side. */
export function adminClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/**
 * Resolve the calling Supabase user from the request's bearer token.
 *
 * These functions run with verify_jwt = false so that CORS preflight (which
 * carries no Authorization header) is not rejected by the platform before it
 * reaches us. Authentication is therefore this function's job, and every
 * handler must call it.
 */
export async function requireUser(req: Request, admin: SupabaseClient) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Missing Authorization bearer token");

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid or expired session");
  return data.user;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Identity claims from PCO. Requires the `openid` scope. */
export async function fetchUserInfo(accessToken: string) {
  const res = await fetch(PCO_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": userAgent(),
    },
  });
  if (!res.ok) {
    throw new HttpError(res.status, `PCO userinfo failed: ${await res.text()}`);
  }
  return await res.json() as {
    sub: string;
    name?: string;
    email?: string;
    organization_id?: number | string;
    organization_name?: string;
  };
}

/**
 * PCO's organization_id is an integer in OIDC claims and a string in JSON:API
 * resource ids. Normalize once, here, so nothing downstream has to remember.
 */
export function normalizeOrgId(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * Ask PCO about a token. Returns the exact `exp` and granted `scope`, which is
 * better than assuming now + 7200 when we did not perform the exchange
 * ourselves (Supabase Auth did).
 */
export async function introspect(token: string) {
  const res = await fetch(PCO_INTROSPECT_URL, {
    method: "POST",
    headers: { "User-Agent": userAgent() },
    body: formBody({
      token,
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `PCO introspect failed: ${await res.text()}`);
  }
  return await res.json() as {
    active: boolean;
    scope?: string;
    exp?: number;
    iat?: number;
  };
}

/** Exact expiry from an introspection result, or a conservative fallback. */
export function expiresAtFrom(info: { exp?: number }): string {
  return info.exp
    ? new Date(info.exp * 1000).toISOString()
    : new Date(Date.now() + 7200 * 1000).toISOString();
}

/**
 * Exchange a refresh token for a fresh pair.
 *
 * The returned refresh_token is NEW - the caller must persist it, or the chain
 * breaks and the user has to re-authorize.
 */
export async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(PCO_TOKEN_URL, {
    method: "POST",
    headers: { "User-Agent": userAgent() },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
  if (!res.ok) {
    // A 400/401 here usually means the refresh token was revoked or is past the
    // 90-day window. Either way the user must reconnect.
    throw new HttpError(401, `PCO token refresh failed: ${await res.text()}`);
  }
  return await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    created_at: number;
    token_type: string;
  };
}

/** Revoke a token. PCO returns 200 even for already-invalid tokens. */
export async function revokeToken(
  token: string,
  hint: "access_token" | "refresh_token",
) {
  await fetch(PCO_REVOKE_URL, {
    method: "POST",
    headers: { "User-Agent": userAgent() },
    body: formBody({
      token,
      token_type_hint: hint,
      client_id: clientId(),
      client_secret: clientSecret(),
    }),
  });
}

/**
 * Read one church's connection for one user, tokens decrypted.
 *
 * The RPC joins memberships and organizations inside the same statement that
 * joins vault.decrypted_secrets, so a caller who is not an active member of an
 * active church gets zero rows rather than a token. That is the authorization
 * boundary; this function is not it.
 */
export async function getConnection(
  admin: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<PcoConnection> {
  const { data, error } = await admin
    .rpc("pco_connection_get", { p_user_id: userId, p_org_id: orgId })
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) {
    throw new HttpError(404, "No Planning Center connection for this user and church");
  }
  return data as PcoConnection;
}

/** The church's background identity. There is no user in a webhook. */
export async function getServiceConnection(
  admin: SupabaseClient,
  orgId: string,
): Promise<PcoConnection> {
  const { data, error } = await admin
    .rpc("pco_connection_get_service", { p_org_id: orgId })
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) {
    throw new HttpError(409, `Church ${orgId} has no usable service connection`);
  }
  return data as PcoConnection;
}

/**
 * Return a valid access token for a connection, refreshing and persisting
 * first if the stored one is expired or about to be.
 */
export async function validAccessToken(
  admin: SupabaseClient,
  conn: PcoConnection,
): Promise<string> {
  const expiresAt = new Date(conn.expires_at).getTime();
  const threshold = Date.now() + EXPIRY_SKEW_SECONDS * 1000;
  if (expiresAt > threshold) return conn.access_token;

  const fresh = await refreshAccessToken(conn.refresh_token);

  // Writes both rotated secrets into Vault in place, keyed on the connection -
  // not the user, who may hold several. The refresh token is rotated; failing
  // to persist it breaks the chain.
  const { error } = await admin.rpc("pco_connection_rotate", {
    p_connection_id: conn.id,
    p_access: fresh.access_token,
    p_refresh: fresh.refresh_token,
    p_expires_at: new Date((fresh.created_at + fresh.expires_in) * 1000).toISOString(),
  });
  if (error) {
    throw new HttpError(500, `Failed to persist refreshed token: ${error.message}`);
  }

  return fresh.access_token;
}

/**
 * One PCO request, recorded rather than thrown.
 *
 * A probe exists to find out what PCO will and will not answer for a given
 * person, and a 403 is the answer, not a failure. The rule from 8.8 - hard-fail
 * on contradictory evidence, never on missing evidence - only works if a
 * refusal can be written down instead of raised.
 */
export interface PcoProbe {
  path: string;
  ok: boolean;
  status: number;
  /** Parsed JSON on success. */
  body?: unknown;
  /** PCO's own message on failure, truncated. It names the vertex it refused. */
  error?: string;
}

/**
 * The one place the mandatory User-Agent is attached.
 *
 * Everything that talks to the PCO API goes through here. Omit the header and
 * PCO answers a bare 403 with no explanation, so it must not be possible to add
 * a second call path that forgets it.
 */
async function pcoRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(`${PCO_API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": userAgent(),
    },
  });
}

/**
 * Call the PCO API with a bare access token.
 *
 * Needed by the registration path, which must ask PCO whether the caller is an
 * Organization Administrator BEFORE any token has been stored. Every other
 * caller should go through pcoFetch so refresh is handled.
 */
export async function pcoFetchWithToken(
  accessToken: string,
  path: string,
  init: RequestInit = {},
) {
  const res = await pcoRequest(accessToken, path, init);
  if (!res.ok) {
    throw new HttpError(res.status, `PCO ${path} failed: ${await res.text()}`);
  }
  return await res.json();
}

/**
 * Ask PCO a question and record whatever comes back, refusals included.
 *
 * Never throws. Use this where the shape of the answer is the thing being
 * discovered. pcoFetchWithToken remains correct anywhere a non-200 means the
 * request cannot continue - do not replace it with this.
 */
export async function pcoProbeWithToken(
  accessToken: string,
  path: string,
): Promise<PcoProbe> {
  let res: Response;
  try {
    res = await pcoRequest(accessToken, path);
  } catch (err) {
    // A network-level failure has no status, but it is still evidence rather
    // than a reason to abandon the remaining probes. The prefix matters: a
    // transport failure must never be read as a refusal by PCO.
    return {
      path,
      ok: false,
      status: 0,
      error: `fetch_failed: ${String(err).slice(0, 480)}`,
    };
  }

  if (!res.ok) {
    return {
      path,
      ok: false,
      status: res.status,
      error: (await res.text()).slice(0, 500),
    };
  }
  return { path, ok: true, status: res.status, body: await res.json() };
}

/** Read `meta.total_count` off a probe body, or null. */
// deno-lint-ignore no-explicit-any
export function totalCountOf(probe: PcoProbe | null): number | null {
  const body = probe?.body as any;
  return body?.meta?.total_count ?? null;
}

/**
 * Judge a filter by a request that should have returned NOTHING.
 *
 * Lives here, not in a probe, because it has now been forgotten twice.
 * pco-campuses carried this logic as `negative_filter` from section 9;
 * pco-groups and pco-calendar were each written without it and each produced
 * confidently wrong filter verdicts that survived a commit (13.7).
 *
 * The reasoning it encodes: PCO discards `where[]` keys it does not recognise
 * rather than rejecting them (9.4, 10.5, 13.1), so a filter whose criteria
 * MATCH the data returns the same count whether it was honoured or thrown
 * away. Only a filter that should exclude everything can tell them apart, and
 * it is decisive even at a one-row church - which is the size of church this
 * spike actually has.
 *
 * `baseline` must be the unfiltered `total_count` of the same collection.
 * Zero is not a usable baseline: excluding everything from an empty collection
 * returns zero whether the key bit or not.
 */
export function negativeFilterVerdict(
  probe: PcoProbe | null,
  baseline: number | null,
):
  | "not_attempted"
  | "param_rejected"
  | "inconclusive"
  | "inconclusive_empty_baseline"
  | "honoured"
  | "discarded"
  | "partially_effective"
  | `refused_${number}` {
  if (!probe) return "not_attempted";
  if (probe.status === 400) return "param_rejected";
  if (!probe.ok) return `refused_${probe.status}`;
  if (baseline === null) return "inconclusive";
  if (baseline === 0) return "inconclusive_empty_baseline";
  const t = totalCountOf(probe);
  if (t === null) return "inconclusive";
  if (t === 0) return "honoured";
  if (t === baseline) return "discarded";
  return "partially_effective";
}

/** Call the PCO API on a connection's behalf. Handles refresh transparently. */
export async function pcoFetch(
  admin: SupabaseClient,
  conn: PcoConnection,
  path: string,
  init: RequestInit = {},
) {
  const accessToken = await validAccessToken(admin, conn);
  return await pcoFetchWithToken(accessToken, path, init);
}

/** Call the PCO API as a church's service identity, for background work. */
export async function pcoFetchAsService(
  admin: SupabaseClient,
  orgId: string,
  path: string,
  init: RequestInit = {},
) {
  const conn = await getServiceConnection(admin, orgId);
  return await pcoFetch(admin, conn, path, init);
}

function formBody(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}
