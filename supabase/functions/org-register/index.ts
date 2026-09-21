// Claim a church as a tenant.
//
// This is the only way an organization row comes into existence, and the gate
// is PCO's own answer to "is this person an Organization Administrator?" -
// asserted against the API, not self-reported.
//
// It receives the same one-shot provider tokens pco-store-tokens just refused
// to store, still held in the browser's memory. That is the resolution to the
// ordering problem: the tokens travel to whichever function makes the tenancy
// decision, and are persisted only once one of them says yes.

import { handler, json } from "../_shared/http.ts";
import {
  adminClient,
  expiresAtFrom,
  fetchUserInfo,
  HttpError,
  introspect,
  normalizeOrgId,
  requireUser,
} from "../_shared/pco.ts";
import {
  assertOrgMatches,
  fetchAdminSignal,
  judgeOrgAdmin,
  logTenancyEvent,
} from "../_shared/tenancy.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const { provider_token, provider_refresh_token } = await req.json();
  if (!provider_token || !provider_refresh_token) {
    throw new HttpError(
      400,
      "Both provider tokens are required to register a church. If the page was " +
        "reloaded since signing in, they are gone - connect again.",
    );
  }

  const info = await introspect(provider_token);
  if (!info.active) {
    throw new HttpError(400, "PCO reports the provided access token is not active");
  }

  // /people/v2/me enforces the caller's own permissions and needs the `people`
  // scope. Without it the admin check cannot be made at all, and the honest
  // answer is to say so rather than fall back to a weaker signal.
  const scopes = (info.scope ?? "").split(/\s+/);
  if (!scopes.includes("people")) {
    throw new HttpError(
      403,
      "The 'people' scope is required to verify Organization Administrator status.",
    );
  }

  const identity = await fetchUserInfo(provider_token);
  const pcoOrgId = normalizeOrgId(identity.organization_id);
  const pcoOrgName = identity.organization_name ?? "Unnamed organization";
  if (!pcoOrgId) {
    throw new HttpError(409, "PCO did not return an organization_id for this token");
  }

  // The admin check runs FIRST, and deliberately so. The org cross-check reads
  // GET /people/v2, which an ordinary member is forbidden to do - running it
  // first meant a non-admin got a raw PCO 403 instead of a clean
  // not_organization_administrator, and no tenancy_events row at all, because
  // the throw beat the logging.
  const signal = await fetchAdminSignal(provider_token);
  const verdict = judgeOrgAdmin(signal);

  if (!verdict.ok) {
    await logTenancyEvent(admin, {
      user_id: user.id,
      email: user.email,
      pco_organization_id: pcoOrgId,
      pco_organization_name: pcoOrgName,
      decision: "register_refused",
      reason: verdict.reason,
      detail: { signal },
    });
    throw new HttpError(
      403,
      verdict.reason === "not_organization_administrator"
        ? "Only an Organization Administrator of this Planning Center " +
          "organization can register it."
        : "Planning Center did not report an administrator status we can " +
          "verify, so registration was refused. Contact support to complete " +
          "registration manually.",
    );
  }

  const { data: result, error } = await admin.rpc("pco_org_register", {
    p_user_id: user.id,
    p_pco_org_id: pcoOrgId,
    p_pco_org_name: pcoOrgName,
    p_person_id: identity.sub,
    p_method: verdict.method,
  });
  if (error) throw new HttpError(500, error.message);

  if (result.status === "claimed_by_other") {
    await logTenancyEvent(admin, {
      user_id: user.id,
      email: user.email,
      pco_organization_id: pcoOrgId,
      pco_organization_name: pcoOrgName,
      decision: "register_conflict",
      reason: "already_registered",
      detail: { organization_id: result.organization_id },
    });
    throw new HttpError(
      409,
      "This Planning Center organization has already been registered. Ask an " +
        "existing administrator to add you, then sign in again.",
    );
  }

  // Only now, having established this caller is an administrator and therefore
  // entitled to read the Organization vertex. A mismatch still fails; a refusal
  // to answer is recorded and moves on.
  const crossCheck = await assertOrgMatches(provider_token, pcoOrgId);

  const orgId = result.organization_id as string;
  const expiresAt = expiresAtFrom(info);

  const { data: connectionId, error: upsertErr } = await admin.rpc(
    "pco_connection_upsert",
    {
      p_user_id: user.id,
      p_org_id: orgId,
      p_person_id: identity.sub,
      p_pco_org_id: pcoOrgId,
      p_pco_org_name: pcoOrgName,
      p_access: provider_token,
      p_refresh: provider_refresh_token,
      p_scope: info.scope ?? "",
      p_expires_at: expiresAt,
    },
  );
  if (upsertErr) throw new HttpError(500, upsertErr.message);

  // The registering owner's connection becomes the church's background
  // identity. A plain update is enough because the partial unique index
  // (organization_id) where is_service is the actual guarantee; if
  // re-designation is ever allowed, move this into an RPC that clears the old
  // flag in the same statement.
  await admin.from("pco_connections")
    .update({ is_service: true })
    .eq("id", connectionId);

  await admin.from("user_settings").upsert({
    user_id: user.id,
    active_organization_id: orgId,
  });

  await logTenancyEvent(admin, {
    user_id: user.id,
    email: user.email,
    pco_organization_id: pcoOrgId,
    pco_organization_name: pcoOrgName,
    decision: "registered",
    reason: verdict.method,
    detail: { organization_id: orgId, connection_id: connectionId, signal, crossCheck },
  });

  return json({
    // already_owner is a 200, not a 409: re-registering your own church is
    // idempotent, not an error.
    registered: result.status === "created",
    already_owner: result.status === "already_owner",
    organization: {
      id: orgId,
      pco_organization_id: pcoOrgId,
      name: pcoOrgName,
    },
    role: "owner",
    connection_id: connectionId,
    is_service: true,
    admin_verification_method: verdict.method,
    // Safe to echo: it carries no tokens, and seeing exactly what PCO said is
    // the entire point of the diagnostic panel.
    admin_signal: signal,
    org_cross_check: crossCheck,
    expires_at: expiresAt,
  });
}));
