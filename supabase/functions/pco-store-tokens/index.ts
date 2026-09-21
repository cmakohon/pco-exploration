// Capture the PCO tokens that Supabase Auth hands back exactly once.
//
// Supabase does not persist or refresh provider tokens: provider_token and
// provider_refresh_token exist in the session object immediately after sign-in
// and are gone on the next session refresh. The browser posts them here, and
// from this point on the tokens live server-side only.

import { handler, json } from "../_shared/http.ts";
import {
  adminClient,
  fetchUserInfo,
  HttpError,
  introspect,
  requireUser,
} from "../_shared/pco.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const { provider_token, provider_refresh_token } = await req.json();

  if (!provider_token) {
    throw new HttpError(400, "provider_token missing from request body");
  }
  if (!provider_refresh_token) {
    // The go/no-go from the plan. Without a refresh token we can act for 2
    // hours and then we are stuck, so fail loudly rather than storing a
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

  const expiresAt = info.exp
    ? new Date(info.exp * 1000).toISOString()
    : new Date(Date.now() + 7200 * 1000).toISOString();

  const { error } = await admin.rpc("pco_connection_upsert", {
    p_user_id: user.id,
    p_person_id: identity.sub,
    p_org_id: identity.organization_id?.toString() ?? null,
    p_org_name: identity.organization_name ?? null,
    p_access: provider_token,
    p_refresh: provider_refresh_token,
    p_scope: info.scope ?? "",
    p_expires_at: expiresAt,
  });
  if (error) throw new HttpError(500, error.message);

  // Deliberately does not echo the tokens back.
  return json({
    stored: true,
    pco_person_id: identity.sub,
    name: identity.name ?? null,
    organization_name: identity.organization_name ?? null,
    scope: info.scope ?? "",
    expires_at: expiresAt,
  });
}));
