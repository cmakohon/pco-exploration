// The tenancy gate, and the one-shot token capture it guards.
//
// Supabase does not persist or refresh provider tokens: provider_token and
// provider_refresh_token exist in the session object immediately after sign-in
// and are gone on the next session refresh. The browser posts them here.
//
// What is new is that arriving with valid PCO tokens is no longer sufficient.
// The church must already be registered by one of its Organization
// Administrators. If it is not, this function stores NOTHING - it records why,
// tells the browser whether this person could register it themselves, and
// reaps the auth user Supabase created before we got a say.

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
  fetchAdminSignal,
  judgeOrgAdmin,
  logTenancyEvent,
  reapOrphanUser,
} from "../_shared/tenancy.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const { provider_token, provider_refresh_token } = await req.json();

  if (!provider_token) {
    throw new HttpError(400, "provider_token missing from request body");
  }
  if (!provider_refresh_token) {
    // The go/no-go from the original spike. Without a refresh token we can act
    // for 2 hours and then we are stuck, so fail loudly rather than storing a
    // connection that will silently die.
    throw new HttpError(
      400,
      "provider_refresh_token missing. Supabase did not pass through a PCO " +
        "refresh token - if you are re-authorizing an already-approved app, " +
        "revoke it in your PCO account and retry. If it is still missing, " +
        "fall back to the self-hosted /pco-connect + /pco-callback flow.",
    );
  }

  // Exact expiry and granted scope, straight from PCO - we did not perform the
  // code exchange ourselves, so we should not guess at issuance time.
  const info = await introspect(provider_token);
  if (!info.active) {
    throw new HttpError(400, "PCO reports the provided access token is not active");
  }

  const identity = await fetchUserInfo(provider_token);
  const pcoOrgId = normalizeOrgId(identity.organization_id);
  const pcoOrgName = identity.organization_name ?? null;

  if (!pcoOrgId) {
    throw new HttpError(409, "PCO did not return an organization_id for this token");
  }

  const { data: join, error } = await admin.rpc("pco_org_join", {
    p_user_id: user.id,
    p_pco_org_id: pcoOrgId,
    p_person_id: identity.sub,
  });
  if (error) throw new HttpError(500, error.message);

  // -------------------------------------------------------------------------
  // Refused. Nothing reaches pco_connections on this path.
  // -------------------------------------------------------------------------
  if (join.status !== "joined") {
    // Only worth asking PCO about admin rights when registering is the actual
    // remedy. A suspended member is not helped by knowing they are an admin.
    let canRegister = false;
    let adminSignal = null;
    if (join.status === "org_not_registered" && (info.scope ?? "").split(/\s+/).includes("people")) {
      // Never let a failed courtesy lookup turn a clean refusal into a 500 -
      // the refusal is the answer; can_register is only an offer on top of it.
      try {
        adminSignal = await fetchAdminSignal(provider_token);
        canRegister = judgeOrgAdmin(adminSignal).ok;
      } catch (err) {
        console.error("admin signal lookup failed:", err);
      }
    }

    // Written BEFORE the reap: tenancy_events.user_id is ON DELETE SET NULL, so
    // this row survives with the email intact.
    await logTenancyEvent(admin, {
      user_id: user.id,
      email: user.email,
      pco_organization_id: pcoOrgId,
      pco_organization_name: pcoOrgName,
      decision: "store_refused",
      reason: join.status,
      detail: { join, can_register: canRegister, signal: adminSignal },
    });

    const accountDeleted = await reapOrphanUser(admin, user.id, canRegister);

    // Returned rather than thrown: handler() flattens HttpError to {error} and
    // would destroy the structure the UI needs to offer registration.
    return json({
      stored: false,
      reason: join.status,
      organization_name: pcoOrgName,
      pco_organization_id: pcoOrgId,
      can_register: canRegister,
      admin_signal: adminSignal,
      account_deleted: accountDeleted,
      action: accountDeleted ? "sign_out" : null,
      message: join.status === "org_not_registered"
        ? (canRegister
          ? `${pcoOrgName} has not signed up yet - but you are an ` +
            `Organization Administrator, so you can register it now.`
          : `${pcoOrgName} has not signed up for this app yet. Ask an ` +
            `Organization Administrator at your church to register it.`)
        : `Your membership at ${pcoOrgName} is ${join.status}.`,
    }, 403);
  }

  // -------------------------------------------------------------------------
  // Accepted. Only now do tokens reach the database.
  // -------------------------------------------------------------------------
  const expiresAt = expiresAtFrom(info);

  const { data: connectionId, error: upsertErr } = await admin.rpc(
    "pco_connection_upsert",
    {
      p_user_id: user.id,
      p_org_id: join.organization_id,
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

  await admin.from("user_settings").upsert({
    user_id: user.id,
    active_organization_id: join.organization_id,
  });

  await logTenancyEvent(admin, {
    user_id: user.id,
    email: user.email,
    pco_organization_id: pcoOrgId,
    pco_organization_name: pcoOrgName,
    decision: "stored",
    reason: join.role,
    detail: { connection_id: connectionId },
  });

  // Deliberately does not echo the tokens back.
  return json({
    stored: true,
    organization: {
      id: join.organization_id,
      pco_organization_id: pcoOrgId,
      name: pcoOrgName,
    },
    role: join.role,
    membership_status: join.membership_status,
    connection_id: connectionId,
    pco_person_id: identity.sub,
    name: identity.name ?? null,
    scope: info.scope ?? "",
    expires_at: expiresAt,
  });
}));
