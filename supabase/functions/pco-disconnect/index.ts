// Revoke at PCO and forget the connection.
//
// Revoking the refresh token also invalidates its access token. PCO answers
// 200 even when the token is already invalid, so this is safe to retry.

import { handler, json } from "../_shared/http.ts";
import { adminClient, getConnection, requireUser, revokeToken } from "../_shared/pco.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const conn = await getConnection(admin, user.id);
  await revokeToken(conn.refresh_token, "refresh_token");

  const { error } = await admin
    .from("pco_connections")
    .delete()
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);

  return json({ disconnected: true });
}));
