// What Planning Center will tell us about campuses, and to whom.
//
// Read-only, and deliberately non-fatal: every sub-probe records its own
// outcome rather than throwing, because a refusal from PCO IS the finding here.
// Section 8.1 established that org-level structure (/people/v2, the
// Organization vertex) is forbidden to an ordinary member. Campuses are
// org-level structure too, so whether a member can read them decides whether
// campus-aware UI can run on the user's own connection or has to go through the
// church's service connection.
//
// Nothing here writes - not even tenancy_events, which section 8.9 counts and
// reads as an assertion target. A diagnostic must not pollute the evidence.
// The only state this can change is one token rotation, through the shared path.

import { handler, json } from "../_shared/http.ts";
import {
  adminClient,
  getConnection,
  HttpError,
  type PcoProbe,
  pcoProbeWithToken,
  requireUser,
  validAccessToken,
} from "../_shared/pco.ts";
import { defaultOrgFor, requireMembership } from "../_shared/tenancy.ts";

// A filter key PCO cannot possibly recognise. The control probe (P8) sends it
// so we learn whether PCO VALIDATES unknown where[] keys or silently ignores
// them. Without that, a filtered read returning rows proves nothing: an ignored
// filter and an effective one are the same 200.
const BOGUS_FILTER_KEY = "zz_not_a_real_field";

// Campus-shaped collections across PCO's products, plus each product's root.
//
// Run with { sweep: true }. The token here carries only `openid people`, which
// is the point: an endpoint that EXISTS but is out of scope should answer
// differently from one that does not exist at all. Probing the product root
// alongside its campus collection is what makes that readable - if the root and
// the campus path return the identical scope error, the sweep is inconclusive
// for that product and only granting the scope will settle it.
const SWEEP_PATHS = [
  "/people/v2/campuses",
  "/services/v2/campuses",
  "/check-ins/v2/campuses",
  "/registrations/v2/campuses",
  "/giving/v2/campuses",
  "/groups/v2/campuses",
  "/calendar/v2/campuses",
  "/publishing/v2/campuses",
  "/resources/v2/campuses",
  "/services/v2",
  "/check-ins/v2",
  "/registrations/v2",
  "/giving/v2",
  "/groups/v2",
  "/calendar/v2",
  // Needs no scope at all (section 3). Worth knowing whether the scope-free
  // identity endpoint carries anything org- or campus-shaped.
  "/current/v2/me",
];

/** Why PCO said no, from its own words rather than from the status alone. */
function classify(p: PcoProbe): string {
  if (p.ok) return "ok";
  if (p.status === 404) return "not_found";
  const e = (p.error ?? "").toLowerCase();
  if (e.includes("scope")) return "scope";
  if (e.includes("cannot read") || e.includes("vertex")) return "permission";
  if (p.status === 401) return "unauthorized";
  return `other_${p.status}`;
}

/** Sorted keys of a JSON:API attributes/relationships object, or []. */
function keysOf(o: unknown): string[] {
  return o && typeof o === "object" ? Object.keys(o as Record<string, unknown>).sort() : [];
}

// deno-lint-ignore no-explicit-any
type Doc = any;

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const body = await req.json().catch(() => ({}));
  const orgId = (body?.organization_id as string) ?? await defaultOrgFor(admin, user.id);
  if (!orgId) throw new HttpError(409, "No church selected and none to default to");

  // Defence in depth and a clearer error; the real boundary is the membership
  // join inside pco_connection_get. Asking about a church you do not belong to
  // must say not_a_member, not return a campus list.
  await requireMembership(admin, user.id, orgId);

  const before = await getConnection(admin, user.id, orgId);
  const expiredOnEntry = new Date(before.expires_at).getTime() <= Date.now();

  // Refresh ONCE, here, and hand the same token to every probe. Nine
  // refresh-aware calls would each re-read a stale connection row and could
  // rotate more than once per request - which would make the rotation
  // assertion (5.2) unreadable rather than merely wasteful.
  const token = await validAccessToken(admin, before);

  const probes: PcoProbe[] = [];

  async function probe(path: string): Promise<PcoProbe> {
    const p = await pcoProbeWithToken(token, path);
    probes.push(p);
    return p;
  }

  // status -1 means the request was never sent. Recorded rather than omitted:
  // "we did not ask" and "PCO would not answer" are different findings, and a
  // missing line in the probe list reads as neither.
  function skip(path: string, why: string) {
    probes.push({ path, ok: false, status: -1, error: `not attempted: ${why}` });
  }

  // --- The person -----------------------------------------------------------

  // P1. The Person vertex exactly as PCO returns it. The key lists are the
  // point: a wrong field name should cost thirty seconds, not an hour.
  const meProbe = await probe("/people/v2/me");
  const meData = (meProbe.body as Doc)?.data;
  const meAttrs = (meData?.attributes ?? {}) as Record<string, unknown>;
  const meRels = (meData?.relationships ?? {}) as Record<string, Doc>;
  const personId = meData?.id ? String(meData.id) : null;

  // Any attribute whose NAME mentions a campus, with its value. If PCO ever
  // carries the campus on the Person itself, this is where it surfaces.
  const campusShaped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meAttrs)) {
    if (/campus/i.test(k)) campusShaped[k] = v;
  }

  // Presence of the KEY, not truthiness of the value. `primary_campus` absent
  // means the edge is not exposed; present with data: null means exposed but
  // unassigned. Different findings; only a key check separates them.
  const relKeyPresent = "primary_campus" in meRels;
  const rel = meRels?.primary_campus?.data ?? null;

  // P2. Section 8.1 found PCO gates some Person attributes behind ?fields, so
  // absence from the default payload is not proof of absence. If
  // primary_campus_id is a sparse-field attribute it is the cheapest campus
  // read in the whole API, and a product should use it.
  const sparseProbe = await probe("/people/v2/me?fields[Person]=primary_campus_id");
  const sparseAttrs = ((sparseProbe.body as Doc)?.data?.attributes ?? {}) as Record<
    string,
    unknown
  >;
  const sparseCampusId = sparseAttrs.primary_campus_id ?? null;

  // P3. Person and campus in one round trip - what a product would ship. The
  // relationship TYPE string is worth recording verbatim: PCO's type names do
  // not always match the resource type you fetch.
  const includeProbe = await probe("/people/v2/me?include=primary_campus");
  const includeDoc = includeProbe.body as Doc;
  const includedKeyPresent = includeDoc !== null && typeof includeDoc === "object" &&
    "included" in includeDoc;

  // P4. Edge traversal, addressed by the resolved person id rather than through
  // /me - /me is an alias and its sub-resources may not route.
  let edgeCampusId: string | null = null;
  if (personId) {
    const edge = await probe(`/people/v2/people/${personId}/primary_campus`);
    edgeCampusId = (edge.body as Doc)?.data?.id ? String((edge.body as Doc).data.id) : null;
  } else {
    skip("/people/v2/people/{id}/primary_campus", "no person id from /people/v2/me");
  }

  const includedCampusId = Array.isArray(includeDoc?.included) && includeDoc.included[0]?.id
    ? String(includeDoc.included[0].id)
    : null;

  // Which probe actually answered "what is my campus". Recorded because the
  // cheapest source is the one the product should use.
  const campusIdSources: Array<[string, string | null]> = [
    ["relationships", rel?.id ? String(rel.id) : null],
    ["sparse_fields", sparseCampusId ? String(sparseCampusId) : null],
    ["include", includedCampusId],
    ["edge", edgeCampusId],
  ];
  const resolved = campusIdSources.find(([, v]) => v);
  const myCampusId = resolved?.[1] ?? null;

  // --- The church's campuses ------------------------------------------------

  // P5. The central question: may THIS person list the church's campuses?
  const listProbe = await probe("/people/v2/campuses?per_page=100");
  const listDoc = listProbe.body as Doc;
  const rows: Doc[] = Array.isArray(listDoc?.data) ? listDoc.data : [];

  // Union across all rows, not just the first: a campus with a null field
  // still carries the key, and unioning removes a class of error for free.
  const campusAttrKeys = [
    ...new Set(rows.flatMap((c) => keysOf(c?.attributes))),
  ].sort();

  // P6. One campus in full. Prefer the caller's OWN campus over the first in
  // the list: if this succeeds while P5 is forbidden, a member can read their
  // own campus but not enumerate the others - a real, shippable product rule.
  const detailId = myCampusId ?? (rows[0]?.id ? String(rows[0].id) : null);
  let firstCampus: unknown = null;
  if (detailId) {
    firstCampus = ((await probe(`/people/v2/campuses/${detailId}`)).body as Doc)
      ?.data?.attributes ?? null;
  } else {
    skip("/people/v2/campuses/{id}", "no campus id available");
  }

  // --- Can a campus scope a people read? ------------------------------------

  // P7. The unfiltered baseline, FIRST. Without it a filtered count is
  // uninterpretable. Also the answer to "may this person read the directory at
  // all" - at a church where directory_status is "no_access", a refusal here
  // makes the rest moot.
  const baseProbe = await probe("/people/v2/people?per_page=1");
  const baseDoc = baseProbe.body as Doc;
  const baseTotal = baseDoc?.meta?.total_count ?? null;
  const canQueryBy: string[] | null = Array.isArray(baseDoc?.meta?.can_query_by)
    ? baseDoc.meta.can_query_by
    : null;

  // P8. The control. If a filter key PCO cannot know still returns the full
  // count, then PCO ignores unknown where[] keys and P9's numbers prove
  // nothing on their own. This one request is what makes P9 mean anything.
  let controlTotal: number | null = null;
  let controlStatus: number | null = null;
  if (baseProbe.ok) {
    const control = await probe(
      `/people/v2/people?where[${BOGUS_FILTER_KEY}]=1&per_page=1`,
    );
    controlStatus = control.status;
    controlTotal = (control.body as Doc)?.meta?.total_count ?? null;
  } else {
    skip(`/people/v2/people?where[${BOGUS_FILTER_KEY}]=1`, "directory not readable");
  }
  const unknownKeysIgnored = controlStatus === 200 && controlTotal !== null &&
      baseTotal !== null
    ? controlTotal === baseTotal
    : null;

  // P9. The filtered read, with include so the response carries its own proof:
  // counts can lie, but a returned person's own primary_campus cannot.
  let dirProbe: PcoProbe | null = null;
  if (!baseProbe.ok) {
    skip("/people/v2/people?where[primary_campus_id]=...", "directory not readable");
  } else if (!detailId) {
    skip("/people/v2/people?where[primary_campus_id]=...", "no campus id to filter on");
  } else {
    dirProbe = await probe(
      `/people/v2/people?where[primary_campus_id]=${detailId}` +
        `&per_page=5&include=primary_campus`,
    );
  }
  // The decisive test when the directory is small: filter by a campus the
  // caller is NOT in. Filtering by your own campus in a one-person church
  // returns you either way - an effective filter and an ignored one are the
  // same row. Filtering by the OTHER campus separates them at any directory
  // size: effective returns fewer, ignored returns the baseline unchanged.
  const otherCampusId = rows.map((c) => String(c?.id)).find((id) => id !== detailId) ?? null;
  let negProbe: PcoProbe | null = null;
  if (baseProbe.ok && otherCampusId) {
    negProbe = await probe(
      `/people/v2/people?where[primary_campus_id]=${otherCampusId}&per_page=5`,
    );
  } else if (baseProbe.ok) {
    skip(
      "/people/v2/people?where[primary_campus_id]=<other>",
      "no second campus to filter against",
    );
  }
  const negTotal = (negProbe?.body as Doc)?.meta?.total_count ?? null;

  const dirDoc = dirProbe?.body as Doc;
  const dirRows: Doc[] = Array.isArray(dirDoc?.data) ? dirDoc.data : [];
  const dirTotal = dirDoc?.meta?.total_count ?? null;

  // ids only, never names or emails - this output is destined for a markdown
  // file in git. The campus id per row is the evidence; who they are is not.
  const sample = dirRows.map((p) => ({
    id: String(p?.id),
    primary_campus_id: p?.relationships?.primary_campus?.data?.id
      ? String(p.relationships.primary_campus.data.id)
      : null,
  }));
  const allMatch = sample.length > 0 && sample.every((p) => p.primary_campus_id === detailId);

  let dirVerdict: string;
  if (!baseProbe.ok) dirVerdict = "directory_forbidden";
  else if (!dirProbe) dirVerdict = "not_attempted";
  else if (dirProbe.status === 403) dirVerdict = "forbidden";
  else if (dirProbe.status === 400) dirVerdict = "param_rejected";
  else if (canQueryBy && !canQueryBy.includes("primary_campus_id")) dirVerdict = "ignored";
  // The negative filter is the strongest evidence available, so it is consulted
  // before the counts from the caller's own campus.
  else if (negTotal !== null && baseTotal !== null && negTotal < baseTotal) {
    dirVerdict = "effective";
  } else if (negTotal !== null && baseTotal !== null && negTotal === baseTotal) {
    dirVerdict = "ignored";
  } else if (unknownKeysIgnored && dirTotal !== null && dirTotal === baseTotal && (baseTotal ?? 0) > 1) {
    dirVerdict = "ignored";
  } else if (allMatch && dirTotal !== null && baseTotal !== null && dirTotal < baseTotal) {
    dirVerdict = "effective";
  } else dirVerdict = "inconclusive";

  // --- One word for the FINDINGS table cell ---------------------------------

  let verdict: string;
  if (listProbe.status === 403) verdict = "campus_list_forbidden";
  else if (!listProbe.ok) verdict = "inconclusive";
  else if (rows.length === 0) verdict = "no_campuses_configured";
  else if (dirVerdict === "effective") verdict = "campus_readable_and_queryable";
  else if (["ignored", "forbidden", "param_rejected", "directory_forbidden"].includes(dirVerdict)) {
    verdict = "campus_visible_but_not_queryable";
  } else verdict = "inconclusive";

  // Optional, because it is another sixteen PCO calls. Driven from the console
  // escape hatch: __pco.call("pco-campuses", {organization_id, sweep: true}).
  const sweep: Array<Record<string, unknown>> = [];
  if (body?.sweep === true) {
    for (const path of SWEEP_PATHS) {
      const r = await pcoProbeWithToken(token, path);
      sweep.push({
        path,
        status: r.status,
        why: classify(r),
        detail: r.ok ? null : (r.error ?? "").slice(0, 200),
      });
    }
  }

  const after = await getConnection(admin, user.id, orgId);

  return json({
    organization_id: orgId,
    pco_organization_name: after.pco_organization_name,
    pco_organization_id: after.pco_organization_id,
    role: before.role,
    is_service: before.is_service,
    scope: before.scope,

    // Surfaced so rotation stays visible, and so it is obvious this probe went
    // through the shared refresh path rather than around it.
    token: {
      expired_on_entry: expiredOnEntry,
      refreshed_during_request: after.refresh_token !== before.refresh_token,
      expires_at: after.expires_at,
    },

    person: {
      id: personId,
      attribute_keys: keysOf(meAttrs),
      relationship_keys: keysOf(meRels),
      // Context for every 403 below - 8.1 recorded this as "no_access" at the
      // church where the tester is an ordinary member.
      directory_status: meAttrs.directory_status ?? null,
      campus_shaped_attributes: campusShaped,
      primary_campus_relationship_present: relKeyPresent,
      primary_campus_relationship: rel
        ? { type: rel.type ?? null, id: rel.id ? String(rel.id) : null }
        : null,
      // Absent vs empty are different findings; do not collapse them.
      included_key_present: includedKeyPresent,
      included: Array.isArray(includeDoc?.included)
        ? includeDoc.included.map((r: Doc) => ({
          type: r?.type ?? null,
          id: r?.id ? String(r.id) : null,
          name: (r?.attributes ?? {}).name ?? null,
        }))
        : null,
      sparse_fields_primary_campus_id: sparseCampusId,
      my_campus_id: myCampusId,
      my_campus_id_source: resolved?.[0] ?? null,
    },

    campuses: {
      readable: listProbe.ok,
      status: listProbe.status,
      error: listProbe.error ?? null,
      total_count: listDoc?.meta?.total_count ?? null,
      returned: rows.length,
      has_next: Boolean(listDoc?.links?.next),
      can_query_by: listDoc?.meta?.can_query_by ?? null,
      can_order_by: listDoc?.meta?.can_order_by ?? null,
      can_include: listDoc?.meta?.can_include ?? null,
      // A 200 with an empty list cannot distinguish "this church has no
      // campuses" from "this person may not see them". Only the PCO web UI
      // settles it. Say so rather than leaving the reader the generous reading.
      empty_is_ambiguous: listProbe.ok && rows.length === 0,
      list: rows.map((c) => ({ id: String(c?.id), name: (c?.attributes ?? {}).name ?? null })),
      attribute_keys: campusAttrKeys,
      campus_detail: firstCampus,
      campus_detail_id: detailId,
    },

    // A permission probe, not a roster dump.
    directory_scoped_by_campus: {
      unfiltered: {
        readable: baseProbe.ok,
        status: baseProbe.status,
        total_count: baseTotal,
      },
      can_query_by: canQueryBy,
      control: {
        bogus_key: BOGUS_FILTER_KEY,
        status: controlStatus,
        total_count: controlTotal,
      },
      // null means the control could not run, NOT that keys are validated.
      unknown_where_keys_ignored: unknownKeysIgnored,
      filtered: dirProbe
        ? {
          attempted: true,
          campus_id: detailId,
          status: dirProbe.status,
          error: dirProbe.error ?? null,
          total_count: dirTotal,
          returned: dirRows.length,
          sample,
          all_returned_match_campus: allMatch,
        }
        : { attempted: false },
      // Filtering by a campus the caller is NOT in. total_count below the
      // unfiltered baseline proves the filter bites; equal to it proves it does
      // not. Decisive even in a one-person church.
      negative_filter: negProbe
        ? {
          campus_id: otherCampusId,
          status: negProbe.status,
          total_count: negTotal,
          returned: Array.isArray((negProbe.body as Doc)?.data)
            ? (negProbe.body as Doc).data.length
            : null,
        }
        : { attempted: false },
      verdict: dirVerdict,
    },

    // Every request in order, bodies omitted. The sequence is the evidence.
    probes: probes.map((p) => ({
      path: p.path,
      ok: p.ok,
      status: p.status,
      ...(p.error ? { error: p.error } : {}),
    })),

    verdict,
    ...(body?.sweep === true ? { sweep } : {}),
  });
}));
