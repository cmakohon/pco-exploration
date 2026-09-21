// Revoke at PCO and forget one church's connection.
//
// Revoking the refresh token also invalidates its access token. PCO answers
// 200 even when the token is already invalid, so this is safe to retry.
//
// If the connection being dropped was the church's service identity, the RPC
// hands that role to another owner/admin - or, if there is nobody eligible,
// marks the church needs_service_connection rather than leaving background
// work quietly broken.

import { handler, json } from "../_shared/http.ts";
import {
  adminClient,
  getConnection,
  HttpError,
  requireUser,
  revokeToken,
} from "../_shared/pco.ts";
import { defaultOrgFor, requireMembership } from "../_shared/tenancy.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const body = await req.json().catch(() => ({}));
  const orgId = (body?.organization_id as string) ?? await defaultOrgFor(admin, user.id);
  if (!orgId) throw new HttpError(409, "No church selected and none to default to");

  await requireMembership(admin, user.id, orgId);

  const conn = await getConnection(admin, user.id, orgId);
  await revokeToken(conn.refresh_token, "refresh_token");

  // Removes the row and both Vault secrets together; deleting only the row
  // would orphan two secrets per disconnect.
  const { data: result, error } = await admin.rpc("pco_connection_delete", {
    p_connection_id: conn.id,
  });
  if (error) throw new HttpError(500, error.message);

  return json({
    disconnected: true,
    organization_id: orgId,
    connection_id: conn.id,
    was_service: result?.was_service ?? false,
    promoted_connection_id: result?.promoted_connection_id ?? null,
    // Nobody left who can act for this church in the background.
    organization_degraded: Boolean(result?.was_service) &&
      !result?.promoted_connection_id,
  });
}));
