// What the browser needs to render tenancy: which churches this person belongs
// to, as what, and whether each one has a live connection.
//
// Deliberately selects pco_connections directly rather than going through
// pco_connection_get. Status needs metadata, not plaintext - decrypting Vault
// secrets to render a page is a habit worth never forming.

import { handler, json } from "../_shared/http.ts";
import { adminClient, HttpError, requireUser } from "../_shared/pco.ts";
import { findMembership } from "../_shared/tenancy.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  // Optional: POST { organization_id } to make a church active.
  const body = await req.json().catch(() => ({}));
  const requestedActive = body?.organization_id as string | undefined;

  const { data: memberships, error: mErr } = await admin
    .from("memberships")
    .select(
      "id, role, status, pco_person_id, organization_id, created_at, " +
        "organizations!inner(id, pco_organization_id, name, status, join_policy, " +
        "admin_verification_method, admin_verified_at)",
    )
    .eq("user_id", user.id)
    .neq("status", "removed")
    .order("created_at", { ascending: true });
  if (mErr) throw new HttpError(500, mErr.message);

  const { data: connections, error: cErr } = await admin
    .from("pco_connections")
    .select(
      "id, organization_id, pco_person_id, scope, expires_at, refreshed_at, is_service",
    )
    .eq("user_id", user.id);
  if (cErr) throw new HttpError(500, cErr.message);

  if (requestedActive) {
    const m = await findMembership(admin, user.id, requestedActive);
    if (!m || m.status !== "active") throw new HttpError(403, "not_a_member");
    await admin.from("user_settings").upsert({
      user_id: user.id,
      active_organization_id: requestedActive,
    });
  }

  const { data: settings } = await admin
    .from("user_settings")
    .select("active_organization_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const byOrg = new Map(
    (connections ?? []).map((c) => [c.organization_id as string, c]),
  );

  const now = Date.now();
  const churches = (memberships ?? []).map((m) => {
    const c = byOrg.get(m.organization_id as string);
    return {
      organization: m.organizations,
      role: m.role,
      membership_status: m.status,
      pco_person_id: m.pco_person_id,
      connection: c
        ? { ...c, expired: new Date(c.expires_at as string).getTime() <= now }
        : null,
    };
  });

  // A stale active pointer is never an access grant - fall back rather than
  // carry it forward.
  let active = settings?.active_organization_id as string | null ?? null;
  if (
    active &&
    !churches.some((c) =>
      (c.organization as { id: string }).id === active &&
      c.membership_status === "active"
    )
  ) {
    active = null;
  }

  return json({
    user: { id: user.id, email: user.email },
    active_organization_id: active ??
      churches.find((c) => c.membership_status === "active")
        ?.organization?.id ?? null,
    churches,
    // No tenancy at all. The browser uses this to decide whether to offer
    // registration or a sign-out.
    orphan: churches.length === 0,
  });
}));
