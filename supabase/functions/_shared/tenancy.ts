// Tenancy: deciding which church a PCO token belongs to, whether that church is
// ours to act for, and whether the person in front of us may claim it.
//
// The product rule this file enforces: a church owner registers the church
// first, and only then may that church's members link their accounts.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HttpError, pcoFetchWithToken } from "./pco.ts";

// ---------------------------------------------------------------------------
// The org-admin signal
// ---------------------------------------------------------------------------

/**
 * What PCO told us about the connecting person's permissions.
 *
 * `site_administrator` is the field that matters. PCO's UI calls the role
 * "Organization Administrator"; the API kept the legacy name. There is no
 * `organization_administrator` attribute - looking for one is a dead end.
 *
 * Note `people_permissions` is deliberately NOT an admin signal. It is
 * People-app scoped (Manager/Editor/Viewer/No access), so a People Manager is
 * a volunteer database admin - not the person who signs a church up for a
 * vendor and designates a service token. Different roles in PCO's own model;
 * different roles here.
 */
export interface AdminSignal {
  site_administrator: boolean | null;
  people_permissions: string | null;
  accounting_administrator: boolean | null;
  can_create_forms: boolean | null;
  pco_person_id: string | null;
  /** Exactly what PCO returned. Logged so a wrong field name is a 30-second fix. */
  attribute_keys: string[];
  source: "default" | "sparse_fields";
}

export type AdminVerdict =
  | { ok: true; method: "site_administrator" | "people_manager_override" }
  | { ok: false; reason: "not_organization_administrator" | "admin_signal_unavailable" };

export async function fetchAdminSignal(accessToken: string): Promise<AdminSignal> {
  let doc = await pcoFetchWithToken(accessToken, "/people/v2/me");
  let attrs = (doc?.data?.attributes ?? {}) as Record<string, unknown>;
  let source: AdminSignal["source"] = "default";

  // PCO gates at least one Person attribute (mfa_configured) behind ?fields, so
  // absence from the default payload is not proof of absence. Ask for it by
  // name once before concluding anything.
  if (!("site_administrator" in attrs)) {
    doc = await pcoFetchWithToken(
      accessToken,
      "/people/v2/me?fields[Person]=site_administrator,people_permissions," +
        "accounting_administrator,can_create_forms",
    );
    attrs = (doc?.data?.attributes ?? {}) as Record<string, unknown>;
    source = "sparse_fields";
  }

  const bool = (k: string) => (typeof attrs[k] === "boolean" ? attrs[k] as boolean : null);

  return {
    site_administrator: bool("site_administrator"),
    people_permissions: typeof attrs.people_permissions === "string"
      ? attrs.people_permissions
      : null,
    accounting_administrator: bool("accounting_administrator"),
    can_create_forms: bool("can_create_forms"),
    pco_person_id: doc?.data?.id ? String(doc.data.id) : null,
    attribute_keys: Object.keys(attrs).sort(),
    source,
  };
}

/**
 * Fail closed on ambiguity.
 *
 * `site_administrator === null` means PCO did not answer the question. Never
 * treat silence as consent for an action that claims an entire church as a
 * tenant. The refusal carries `admin_signal_unavailable` and the caller logs
 * the attribute list PCO actually returned.
 */
export function judgeOrgAdmin(sig: AdminSignal): AdminVerdict {
  if (sig.site_administrator === true) {
    return { ok: true, method: "site_administrator" };
  }
  if (sig.site_administrator === false) {
    return { ok: false, reason: "not_organization_administrator" };
  }

  // Testing-only escape hatch. It stamps a weaker verification method on the
  // organization so the softer claim stays permanently visible in the audit
  // columns. The real unblock path is admin_verification_method = 'manual',
  // set by hand after a human confirms.
  if (
    Deno.env.get("ORG_ADMIN_ALLOW_PEOPLE_MANAGER") === "true" &&
    sig.people_permissions === "Manager"
  ) {
    return { ok: true, method: "people_manager_override" };
  }

  return { ok: false, reason: "admin_signal_unavailable" };
}

/**
 * Never trust a client-supplied organization id. Derive it from the token two
 * ways and require agreement before claiming a church on its behalf.
 *
 * /people/v2 is the People API root, which IS the Organization resource for
 * whichever org the token belongs to.
 */
export async function assertOrgMatches(accessToken: string, claimedOrgId: string) {
  const doc = await pcoFetchWithToken(accessToken, "/people/v2");
  const data = doc?.data;
  const apiOrgId = Array.isArray(data) ? data[0]?.id : data?.id;

  if (apiOrgId && String(apiOrgId) !== String(claimedOrgId)) {
    throw new HttpError(
      409,
      `PCO organization mismatch: userinfo said ${claimedOrgId}, ` +
        `/people/v2 said ${apiOrgId}`,
    );
  }
  return apiOrgId ? String(apiOrgId) : null;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface Membership {
  id: string;
  role: string;
  status: string;
  organization_id: string;
  pco_person_id: string | null;
}

export async function findMembership(
  admin: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<Membership | null> {
  const { data, error } = await admin
    .from("memberships")
    .select("id, role, status, organization_id, pco_person_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  return (data as Membership) ?? null;
}

/**
 * Throw 403 unless the caller is an active member of this church.
 *
 * This is defence in depth, not the boundary. The boundary is the membership
 * join inside pco_connection_get - remove this check and the token still does
 * not come out. What this buys is a 403 that says `not_a_member` instead of a
 * 404 that says "no connection", which makes the cross-tenant test
 * unambiguous.
 */
export async function requireMembership(
  admin: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<Membership> {
  const m = await findMembership(admin, userId, orgId);
  if (!m || m.status !== "active") {
    throw new HttpError(403, "not_a_member");
  }
  return m;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface TenancyEvent {
  user_id?: string | null;
  email?: string | null;
  pco_organization_id?: string | null;
  pco_organization_name?: string | null;
  decision: string;
  reason?: string | null;
  detail?: unknown;
}

/**
 * Record why a tenancy decision went the way it did.
 *
 * Must be written BEFORE reapOrphanUser: tenancy_events.user_id is ON DELETE
 * SET NULL, so the row survives the deletion with its email and church name
 * intact. That row is the audit trail, the refusal test's assertion target,
 * and the "tell me when my church signs up" list, all at once.
 *
 * Never throws. A failed audit write must not turn a clean refusal into a 500.
 */
export async function logTenancyEvent(admin: SupabaseClient, e: TenancyEvent) {
  const { error } = await admin.from("tenancy_events").insert({
    user_id: e.user_id ?? null,
    email: e.email ?? null,
    pco_organization_id: e.pco_organization_id ?? null,
    pco_organization_name: e.pco_organization_name ?? null,
    decision: e.decision,
    reason: e.reason ?? null,
    detail: e.detail ?? null,
  });
  if (error) console.error("tenancy_events insert failed:", error.message);
}

// ---------------------------------------------------------------------------
// Orphan reaping
// ---------------------------------------------------------------------------

/**
 * Delete an auth user that has no tenancy at all.
 *
 * Supabase creates the auth.users row during sign-in, before our gate can run.
 * A row with no membership is a phantom account: it holds a valid JWT and can
 * call every Edge Function, so every one of them would need to remember to
 * check tenancy. Deleting it removes a class of bugs rather than documenting
 * one.
 *
 * Two guards, both load-bearing:
 *
 *   1. A user who already belongs to church A and is here trying to add church
 *      B must NEVER be deleted. Multi-church membership makes this the
 *      difference between a refusal and destroying someone's account. This is
 *      the worst bug this design can produce; it is tested deliberately.
 *   2. Someone who can register the church right now is one click from being
 *      its owner. Killing their session mid-flight would take the in-memory
 *      provider tokens with it.
 */
export async function reapOrphanUser(
  admin: SupabaseClient,
  userId: string,
  canRegister: boolean,
): Promise<boolean> {
  if (canRegister) return false;

  const { count: memberships, error: mErr } = await admin
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (mErr) throw new HttpError(500, mErr.message);

  const { count: connections, error: cErr } = await admin
    .from("pco_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (cErr) throw new HttpError(500, cErr.message);

  if ((memberships ?? 0) > 0 || (connections ?? 0) > 0) return false;

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error("reapOrphanUser failed:", error.message);
    return false;
  }
  return true;
}

/** The church a user should act as when the request did not name one. */
export async function defaultOrgFor(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: settings } = await admin
    .from("user_settings")
    .select("active_organization_id")
    .eq("user_id", userId)
    .maybeSingle();

  const active = settings?.active_organization_id as string | undefined;
  if (active) {
    // A stale pointer is never an access grant - confirm the membership still
    // stands before handing it back.
    const m = await findMembership(admin, userId, active);
    if (m && m.status === "active") return active;
  }

  const { data } = await admin
    .from("memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return (data?.organization_id as string) ?? null;
}
