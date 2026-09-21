// Prove the stored credentials work end to end, including the refresh path.

import { handler, json } from "../_shared/http.ts";
import { adminClient, getConnection, pcoFetch, requireUser } from "../_shared/pco.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const before = await getConnection(admin, user.id);
  const expiredOnEntry = new Date(before.expires_at).getTime() <= Date.now();

  // Requires the `people` scope and enforces this user's PCO permissions.
  // (/current/v2/me is the scope-free alternative if you ever need it.)
  const me = await pcoFetch(admin, user.id, "/people/v2/me");

  const after = await getConnection(admin, user.id);

  return json({
    // Surfaced so you can watch rotation happen during verification.
    token: {
      expired_on_entry: expiredOnEntry,
      refreshed_during_request: after.refresh_token !== before.refresh_token,
      expires_at: after.expires_at,
    },
    organization_name: after.organization_name,
    me: me.data,
  });
}));
