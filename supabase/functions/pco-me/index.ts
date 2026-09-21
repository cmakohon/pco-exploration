// Prove the stored credentials work end to end, for one church, including the
// refresh path.

import { handler, json } from "../_shared/http.ts";
import {
  adminClient,
  getConnection,
  HttpError,
  pcoFetch,
  requireUser,
} from "../_shared/pco.ts";
import { defaultOrgFor, requireMembership } from "../_shared/tenancy.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const body = await req.json().catch(() => ({}));
  const orgId = (body?.organization_id as string) ?? await defaultOrgFor(admin, user.id);
  if (!orgId) throw new HttpError(409, "No church selected and none to default to");

  // Defence in depth, and a clearer failure. The real boundary is the
  // membership join inside pco_connection_get - delete this line and the token
  // still does not come out, it just 404s instead of saying not_a_member.
  await requireMembership(admin, user.id, orgId);

  const before = await getConnection(admin, user.id, orgId);
  const expiredOnEntry = new Date(before.expires_at).getTime() <= Date.now();

  // Requires the `people` scope and enforces this user's PCO permissions.
  // (/current/v2/me is the scope-free alternative if you ever need it.)
  const me = await pcoFetch(admin, before, "/people/v2/me");

  const after = await getConnection(admin, user.id, orgId);

  return json({
    organization_id: orgId,
    connection_id: before.id,
    role: before.role,
    is_service: before.is_service,
    // Surfaced so you can watch rotation happen during verification.
    token: {
      expired_on_entry: expiredOnEntry,
      refreshed_during_request: after.refresh_token !== before.refresh_token,
      expires_at: after.expires_at,
    },
    organization_name: after.pco_organization_name,
    me: me.data,
  });
}));
