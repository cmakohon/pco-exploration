// Planning Center OAuth + API helpers.
//
// Endpoints below match https://api.planningcenteronline.com/.well-known/openid-configuration
// Key behaviors this module exists to handle:
//   - access tokens expire after 2 hours
//   - refresh tokens ROTATE: every refresh returns a new one that must be stored
//   - PCO returns 403 for any request without a descriptive User-Agent

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

export const USER_AGENT = requireEnv("PCO_USER_AGENT");
const CLIENT_ID = requireEnv("PCO_CLIENT_ID");
const CLIENT_SECRET = requireEnv("PCO_CLIENT_SECRET");

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `Missing secret ${name}. Set it with: supabase secrets set ${name}=...`,
    );
  }
  return value;
}

export interface PcoConnection {
  user_id: string;
  pco_person_id: string;
  organization_id: string | null;
  organization_name: string | null;
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
      "User-Agent": USER_AGENT,
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
 * Ask PCO about a token. Returns the exact `exp` and granted `scope`, which is
 * better than assuming now + 7200 when we did not perform the exchange
 * ourselves (Supabase Auth did).
 */
export async function introspect(token: string) {
  const res = await fetch(PCO_INTROSPECT_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: formBody({
      token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
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

/**
 * Exchange a refresh token for a fresh pair.
 *
 * The returned refresh_token is NEW - the caller must persist it, or the chain
 * breaks and the user has to re-authorize.
 */
export async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(PCO_TOKEN_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
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
    headers: { "User-Agent": USER_AGENT },
    body: formBody({
      token,
      token_type_hint: hint,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
}

export async function getConnection(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin
    .from("pco_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "No Planning Center connection for this user");
  return data as PcoConnection;
}

/**
 * Return a valid access token for the user, refreshing and persisting first if
 * the stored one is expired or about to be.
 */
export async function validAccessToken(
  admin: SupabaseClient,
  userId: string,
): Promise<string> {
  const conn = await getConnection(admin, userId);

  const expiresAt = new Date(conn.expires_at).getTime();
  const threshold = Date.now() + EXPIRY_SKEW_SECONDS * 1000;
  if (expiresAt > threshold) return conn.access_token;

  const fresh = await refreshAccessToken(conn.refresh_token);

  const { error } = await admin
    .from("pco_connections")
    .update({
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token, // rotated - must be written back
      expires_at: new Date((fresh.created_at + fresh.expires_in) * 1000).toISOString(),
      refreshed_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (error) throw new HttpError(500, `Failed to persist refreshed token: ${error.message}`);

  return fresh.access_token;
}

/** Call the PCO API on a user's behalf. Handles refresh transparently. */
export async function pcoFetch(
  admin: SupabaseClient,
  userId: string,
  path: string,
  init: RequestInit = {},
) {
  const accessToken = await validAccessToken(admin, userId);

  const res = await fetch(`${PCO_API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT, // omit this and PCO answers 403
    },
  });

  if (!res.ok) {
    throw new HttpError(res.status, `PCO ${path} failed: ${await res.text()}`);
  }
  return await res.json();
}

function formBody(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}
