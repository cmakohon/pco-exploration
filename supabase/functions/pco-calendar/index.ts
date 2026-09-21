// What Planning Center Calendar exposes, and to whom.
//
// Third probe of this shape (pco-campuses, pco-groups, this). Same rules:
// read-only, non-fatal, every outcome recorded because at this surface a
// refusal is the finding.
//
// Why Calendar, and why now. Three open questions land here at once:
//
//   1. Section 10.5 left campus-local routing with no mechanism. A Group
//      carries no campus edge and campus is not a queryable key on it. If a
//      Calendar event carries one, the "at the North campus" feature has a
//      home. Section 9.8 says from DOCUMENTATION that Calendar has no campus
//      API - and 9.7 established that a claim about another product can only
//      be settled by granting its scope. This settles it by observation.
//
//   2. Section 10.7 drew the line between what every church is guaranteed
//      (People) and what it merely might have (Groups). Calendar splits down
//      the middle of that line rather than sitting on one side: events are
//      free and unlimited, rooms and resources are metered from one. The probe
//      measures BOTH halves so each endpoint can be filed on the right side.
//
//   3. Whether an ordinary member can read the church's calendar at all. Their
//      People directory access is no_access (8.1) and their Groups reach stops
//      at their own memberships (10.2). If Calendar answers church-wide to a
//      member, it is the first surface in this spike that does.
//
// The sweep runs by DEFAULT here, unlike pco-campuses. 9.7's rule cuts both
// ways: outside a scope every path returns an identical 401 and a sweep is
// worthless, but INSIDE the scope 404 and 403 finally mean different things.
// Calendar is unmapped, this is the one cheap chance to map it, and a 404 on a
// path we guessed is a real answer. Pass {sweep: false} to skip it.
//
// Nothing here writes. The only state this can change is one token rotation,
// through the shared path.

import { handler, json } from "../_shared/http.ts";
import {
  adminClient,
  getConnection,
  HttpError,
  introspect,
  negativeFilterVerdict,
  type PcoProbe,
  pcoProbeWithToken,
  requireUser,
  validAccessToken,
} from "../_shared/pco.ts";
import { defaultOrgFor, requireMembership } from "../_shared/tenancy.ts";

// Third product, third control. 9.4 found People ignores unknown where[] keys;
// 10.5 found Groups does too. Never carried across on faith - a filtered count
// is uninterpretable until this says what an ignored filter looks like here.
const BOGUS_FILTER_KEY = "zz_not_a_real_field";

// The surface map. Guessed from PCO's product vocabulary, not from docs, which
// is the point: inside the scope a 404 says "this noun does not exist" and a
// 403 says "not for you", and those are different products downstream.
const SWEEP_PATHS = [
  "/calendar/v2/me",
  "/calendar/v2/event_instances",
  "/calendar/v2/event_times",
  "/calendar/v2/event_connections",
  "/calendar/v2/conflicts",
  "/calendar/v2/feeds",
  "/calendar/v2/attachments",
  "/calendar/v2/people",
  "/calendar/v2/tag_groups",
  "/calendar/v2/room_setups",
  "/calendar/v2/resource_bookings",
  "/calendar/v2/event_resource_requests",
  "/calendar/v2/required_approvals",
  "/calendar/v2/resource_approval_groups",
  "/calendar/v2/resource_questions",
  "/calendar/v2/resource_suggestions",
  "/calendar/v2/job_statuses",
  "/calendar/v2/reports",
];

/** Why PCO said no, from its own words rather than from the status alone. */
/**
 * Why PCO said no, from its own words rather than from the status alone.
 *
 * Three distinct refusals now, and the status code separates none of them:
 *
 *   403 + "cannot read XVertex"          the vertex permission wall (9.2)
 *   401 + code "bad_scope"               the app never asked for this product (9.7)
 *   401 + code "unauthorized"/TRASH_PANDA  asked, granted, and still refused (11.1)
 *
 * The last two share a status. Branch on errors[0].code, never on 401.
 */
function classify(p: PcoProbe): string {
  if (p.ok) return "ok";
  if (p.status === 404) return "not_found";
  const e = (p.error ?? "").toLowerCase();
  // Checked BEFORE the generic scope test: "bad_scope" contains "scope", and
  // ordering these the other way round collapses the two 401s into one.
  if (e.includes("bad_scope")) return "scope_not_granted";
  if (e.includes("trash_panda") || (p.status === 401 && e.includes('"unauthorized"'))) {
    return "granted_but_unauthorized";
  }
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

const rowsOf = (d: Doc): Doc[] => (Array.isArray(d?.data) ? d.data : []);
const totalOf = (d: Doc): number | null => d?.meta?.total_count ?? null;
const metaList = (d: Doc, k: string): string[] | null =>
  Array.isArray(d?.meta?.[k]) ? d.meta[k] : null;

/** Union of attribute keys across rows - a null field still carries its key. */
const unionKeys = (rows: Doc[], which: "attributes" | "relationships"): string[] =>
  [...new Set(rows.flatMap((r) => keysOf(r?.[which])))].sort();

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const body = await req.json().catch(() => ({}));
  const orgId = (body?.organization_id as string) ?? await defaultOrgFor(admin, user.id);
  if (!orgId) throw new HttpError(409, "No church selected and none to default to");

  await requireMembership(admin, user.id, orgId);

  const before = await getConnection(admin, user.id, orgId);
  const expiredOnEntry = new Date(before.expires_at).getTime() <= Date.now();
  const token = await validAccessToken(admin, before);

  // The gate, first and on its own. 10.9: widening the scope does not touch
  // tokens already issued, and PCO answers an unrequested scope with a 401
  // that reads exactly like a permissions failure. Knowing which we are
  // looking at costs one column read and saves an afternoon.
  const grantedScopes = (before.scope ?? "").split(/\s+/).filter(Boolean);
  const hasCalendarScope = grantedScopes.includes("calendar");

  // The stored scope is a REMEMBERED value - written at store time from an
  // introspection of a token that has since been rotated. When every request
  // to a product comes back 401 while the column says the scope was granted,
  // the column is one of the suspects. Ask PCO about the token in hand.
  //
  // Non-fatal: a failed introspection removes a hypothesis from the evidence,
  // it does not invalidate the probes.
  let live: { active: boolean; scope?: string; exp?: number } | null = null;
  let liveError: string | null = null;
  try {
    live = await introspect(token);
  } catch (err) {
    liveError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
  const liveScopes = (live?.scope ?? "").split(/\s+/).filter(Boolean);

  const probes: PcoProbe[] = [];

  async function probe(path: string): Promise<PcoProbe> {
    const p = await pcoProbeWithToken(token, path);
    probes.push(p);
    return p;
  }

  function skip(path: string, why: string) {
    probes.push({ path, ok: false, status: -1, error: `not attempted: ${why}` });
  }

  // --- Is the door open? ----------------------------------------------------

  const rootProbe = await probe("/calendar/v2");

  // --- Three refusals, one request, one token -------------------------------
  //
  // 9.7 recorded the bad_scope shape from a DIFFERENT run against a DIFFERENT
  // token. Comparing today's 401 against a remembered one is how you conclude
  // "same error" about two different errors. So all three shapes are collected
  // here, side by side, in the request that is trying to tell them apart:
  //
  //   in scope, refused      /calendar/v2         ← the shape under test
  //   NOT in scope           /giving/v2           ← the known bad_scope control
  //   in scope, no permission /people/v2/campuses ← the known 403 control (9.2)
  //
  // `giving` is deliberately absent from PCO_SCOPES and must stay absent. It
  // is the control, and granting it would destroy the only unambiguous
  // bad_scope sample we can take.
  const scopeControl = await probe("/giving/v2");
  const permControl = await probe("/people/v2/campuses");

  const meProbe = await probe("/people/v2/me");
  const meAttrs = ((meProbe.body as Doc)?.data?.attributes ?? {}) as Record<string, unknown>;
  const personId = (meProbe.body as Doc)?.data?.id ? String((meProbe.body as Doc).data.id) : null;
  const directoryStatus = meAttrs.directory_status ?? null;

  // --- Does the Person carry a per-product permission for Calendar? ---------
  //
  // 8.6 established that PCO models per-product permission ON THE PERSON:
  // `people_permissions` is People-app scoped and says Manager/Editor/Viewer/
  // No access. 9.5 found `directory_status` as a third attribute of that
  // family. If a calendar-shaped one exists, hypothesis 1 is confirmed from a
  // member's own token and no administrator's row is needed.
  //
  // 8.1's rule applies: PCO gates at least one Person attribute behind
  // ?fields, so absence from the default payload is not proof of absence. Ask
  // by name before concluding anything - a guessed field name that does not
  // exist comes back absent, which is the same answer as a real one that is
  // null, so the sparse read is reported separately rather than merged.
  const permShapedDefault: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meAttrs)) {
    if (/permission|calendar|access|admin|status/i.test(k)) permShapedDefault[k] = v;
  }

  const GUESSED_PERMISSION_FIELDS = [
    "calendar_permissions",
    "calendar_permission",
    "services_permissions",
    "check_ins_permissions",
    "giving_permissions",
    "groups_permissions",
    "registrations_permissions",
    "publishing_permissions",
    "people_permissions",
    "site_administrator",
  ];
  const sparseProbe = await probe(
    `/people/v2/me?fields[Person]=${GUESSED_PERMISSION_FIELDS.join(",")}`,
  );
  const sparseAttrs = ((sparseProbe.body as Doc)?.data?.attributes ?? {}) as Record<
    string,
    unknown
  >;
  // Which of the guesses PCO actually answered. `people_permissions` and
  // `site_administrator` are known-real (8.6) and act as the positive control:
  // if THEY come back absent, the sparse read is not working and the silence
  // of the others means nothing.
  const sparseAnswered = Object.keys(sparseAttrs).sort();
  const sparseControlWorked = sparseAnswered.includes("people_permissions") ||
    sparseAnswered.includes("site_administrator");
  const calendarPermissionAttr = sparseAnswered.find((k) => /calendar/i.test(k)) ??
    Object.keys(permShapedDefault).find((k) => /calendar/i.test(k)) ?? null;

  // --- Events: the free, unlimited half -------------------------------------

  // The question 10.7 makes urgent. People says no_access, Groups stops at my
  // own memberships - does Calendar answer church-wide to an ordinary member?
  const eventsProbe = await probe("/calendar/v2/events?per_page=25");
  const eventsDoc = eventsProbe.body as Doc;
  const eventRows = rowsOf(eventsDoc);
  const eventsTotal = totalOf(eventsDoc);
  const eventAttrKeys = unionKeys(eventRows, "attributes");
  const eventRelKeys = unionKeys(eventRows, "relationships");
  const eventsCanQueryBy = metaList(eventsDoc, "can_query_by");

  // THE member-facing filter. Calendar is the staff's room-booking tool as much
  // as it is a public what's-on; a church's calendar is full of setup blocks,
  // staff meetings and facility holds. Whatever flags an event as member-facing
  // decides whether this product is showing the congregation their church or
  // the janitorial schedule.
  const visibilityShaped: Record<string, unknown> = {};
  for (const r of eventRows.slice(0, 1)) {
    for (const [k, v] of Object.entries((r?.attributes ?? {}) as Record<string, unknown>)) {
      if (/visible|public|church_center|approval|registration/i.test(k)) visibilityShaped[k] = v;
    }
  }

  // One event in full. Names are church structure and are kept; anything
  // person-shaped is not (see pii_note).
  const firstEventId = eventRows[0]?.id ? String(eventRows[0].id) : null;
  let eventDetail: unknown = null;
  let eventDetailRels: string[] = [];
  if (firstEventId) {
    const d = await probe(`/calendar/v2/events/${firstEventId}`);
    eventDetail = (d.body as Doc)?.data?.attributes ?? null;
    eventDetailRels = keysOf((d.body as Doc)?.data?.relationships);
  } else {
    skip("/calendar/v2/events/{id}", "no event id available");
  }

  // --- Recurrence: the thing that makes a calendar a calendar ---------------

  // An Event is the series; an instance is a date. 10.6 found Groups' schedule
  // is free text and unparseable - if Calendar's instances are structured, this
  // is where any time-aware feature has to read from, and the difference is
  // whether "is anything happening Sunday" is answerable at all.
  const instProbe = await probe("/calendar/v2/event_instances?per_page=25");
  const instDoc = instProbe.body as Doc;
  const instRows = rowsOf(instDoc);
  const instCanQueryBy = metaList(instDoc, "can_query_by");
  // Read before the negative probes below, which gate on there being rows to
  // exclude. Same values as instTotal/eventsTotal further down; named apart so
  // the ordering dependency is visible rather than implied.
  const instTotalEarly = totalOf(instDoc);
  const eventsTotalEarly = eventsTotal;

  // Date filtering, without which none of this is usable at scale. PCO's
  // bracket syntax is a guess; both spellings are tried and BOTH are compared
  // against the control, because 9.4 and 10.5 both found unknown where[] keys
  // silently ignored rather than rejected.
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const to = new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();

  let dateProbeA: PcoProbe | null = null;
  let dateProbeB: PcoProbe | null = null;
  if (instProbe.ok) {
    dateProbeA = await probe(
      `/calendar/v2/event_instances?where[starts_at][gte]=${encodeURIComponent(from)}` +
        `&where[starts_at][lte]=${encodeURIComponent(to)}&per_page=5`,
    );
    dateProbeB = await probe(
      `/calendar/v2/event_instances?filter=future&per_page=5`,
    );
  } else {
    skip("/calendar/v2/event_instances?where[starts_at][gte]=...", "instances not readable");
    skip("/calendar/v2/event_instances?filter=future", "instances not readable");
  }

  // --- The filters that must EXCLUDE ----------------------------------------
  //
  // 9.4's lesson, which pco-campuses carried as `negative_filter` and this
  // probe was written without. A window the data falls INSIDE returns the same
  // count whether the filter bites or is thrown away - and at a church with
  // one event that is every positive window. Only a filter that should return
  // NOTHING separates them, and it is decisive at n=1, which is exactly the
  // size of church available.
  const FAR_FUTURE = "2099-01-01T00:00:00Z";
  let negDateProbe: PcoProbe | null = null;
  let negVisibleProbe: PcoProbe | null = null;
  if (instProbe.ok && (instTotalEarly ?? 0) > 0) {
    negDateProbe = await probe(
      `/calendar/v2/event_instances?where[starts_at][gte]=${
        encodeURIComponent(FAR_FUTURE)
      }&per_page=5`,
    );
  } else {
    skip(`/calendar/v2/event_instances?where[starts_at][gte]=${FAR_FUTURE}`, "no instances");
  }
  // The same trick on the attribute that decides the whole member-facing
  // feature. The one event here is visible_in_church_center: true, so asking
  // for false must return zero if the key is honoured.
  if (eventsProbe.ok && (eventsTotalEarly ?? 0) > 0) {
    negVisibleProbe = await probe(
      "/calendar/v2/events?where[visible_in_church_center]=false&per_page=5",
    );
  } else {
    skip("/calendar/v2/events?where[visible_in_church_center]=false", "no events");
  }

  // The control, on the collection the date filters were aimed at.
  let controlStatus: number | null = null;
  let controlTotal: number | null = null;
  if (instProbe.ok) {
    const c = await probe(
      `/calendar/v2/event_instances?where[${BOGUS_FILTER_KEY}]=1&per_page=1`,
    );
    controlStatus = c.status;
    controlTotal = totalOf(c.body as Doc);
  } else {
    skip(`/calendar/v2/event_instances?where[${BOGUS_FILTER_KEY}]=1`, "instances not readable");
  }
  const instTotal = totalOf(instDoc);
  // Same degeneracy, one layer up: 0 === 0 is not proof that PCO ignored the
  // key, so the control reports null rather than true on an empty collection.
  const unknownKeysIgnored =
    controlStatus === 200 && controlTotal !== null && instTotal !== null && instTotal > 0
      ? controlTotal === instTotal
      : null;

  // `can_query_by` is PCO's own statement about which keys are real, and it
  // outranks any arithmetic done on counts. 10.5 established that for Groups;
  // the admin row proved why it matters, by producing a church with zero
  // instances where every count comparison is 0 < 0 and the first version of
  // this function confidently reported "ignored" for a key PCO lists as real.
  function dateVerdict(p: PcoProbe | null, key: string | null): string {
    if (!p) return "not_attempted";
    if (p.status === 400) return "param_rejected";
    if (!p.ok) return `refused_${p.status}`;
    // Authoritative and cheap. Consulted before the counts, never after.
    if (key && instCanQueryBy && !instCanQueryBy.includes(key)) return "not_a_query_key";
    const t = totalOf(p.body as Doc);
    if (t === null || instTotal === null) return "inconclusive";
    // The degenerate case. An empty collection filters to empty whether the
    // filter bites or is thrown away, so nothing here is evidence of either.
    if (instTotal === 0) return "inconclusive_empty_collection";
    if (t < instTotal) return "effective";
    // A positive window that MATCHES the data is not evidence. Say so rather
    // than letting the unknown-key control answer a question it was not asked.
    if (t === instTotal) return "inconclusive_filter_matches_all";
    return "inconclusive";
  }

  // negativeFilterVerdict now lives in _shared/pco.ts - see 13.7.

  // --- Campus: the question 10.5 left open ----------------------------------

  // 9.8 says, from documentation, that Calendar has no campus API. 9.7 says a
  // claim about another product can only be settled by granting its scope.
  // Three ways to ask, so a single absence is not mistaken for the answer.
  const calCampusProbe = await probe("/calendar/v2/campuses?per_page=100");
  const calCampusRows = rowsOf(calCampusProbe.body as Doc);
  const campusRelOnEvent = eventRelKeys.includes("campus") ||
    eventDetailRels.includes("campus");
  const eventsCanInclude = metaList(eventsDoc, "can_include");
  const campusIncludable = Boolean(eventsCanInclude?.some((k) => /campus/i.test(k)));
  const campusShapedEventAttrs = eventAttrKeys.filter((k) => /campus/i.test(k));

  // --- Resources: the metered half ------------------------------------------

  // 10.7's tiering applied to one product rather than across two. Rooms are
  // where Calendar starts charging, so the count here says whether THIS church
  // pays - and a feature built on it is a feature that works at some churches.
  const resProbe = await probe("/calendar/v2/resources?per_page=100");
  const resRows = rowsOf(resProbe.body as Doc);
  const resTotal = totalOf(resProbe.body as Doc);
  const resAttrKeys = unionKeys(resRows, "attributes");
  // PCO splits resources into rooms and equipment; both are metered, only
  // rooms are named in the pricing. Count them apart or the meter is unreadable.
  const resKinds: Record<string, number> = {};
  for (const r of resRows) {
    const k = String((r?.attributes ?? {}).kind ?? "unknown");
    resKinds[k] = (resKinds[k] ?? 0) + 1;
  }

  // --- Tags: how a church sorts its own calendar ----------------------------

  const tagsProbe = await probe("/calendar/v2/tags?per_page=100");
  const tagRows = rowsOf(tagsProbe.body as Doc);

  // --- Does a Calendar event know about a Group? ----------------------------

  // If group meetings surface on the church calendar, 10.6's unparseable
  // free-text `schedule` has a structured twin and the group tier gets a rhythm
  // for free. Relationship keys are the cheapest place to see it.
  const groupShapedEventRels = [...new Set([...eventRelKeys, ...eventDetailRels])]
    .filter((k) => /group|owner|registration/i.test(k));

  // --- Surface map ----------------------------------------------------------

  const sweep: Array<Record<string, unknown>> = [];
  if (body?.sweep !== false) {
    for (const path of SWEEP_PATHS) {
      const r = await pcoProbeWithToken(token, path);
      sweep.push({
        path,
        status: r.status,
        why: classify(r),
        total_count: r.ok ? totalOf(r.body as Doc) : null,
        returned_type: r.ok ? (rowsOf(r.body as Doc)[0]?.type ?? "empty_or_singular") : null,
        detail: r.ok ? null : (r.error ?? "").slice(0, 160),
      });
    }
  }

  // --- One word for the FINDINGS table cell ---------------------------------

  const scopeLiveConfirmed = liveScopes.includes("calendar");

  let verdict: string;
  if (!hasCalendarScope && !rootProbe.ok) verdict = "scope_not_granted_reconsent_required";
  else if (!rootProbe.ok && classify(rootProbe) === "scope_not_granted") {
    // The stored column lied, or the reconnect did not take.
    verdict = "scope_missing_despite_stored_grant";
  } else if (!rootProbe.ok && classify(rootProbe) === "granted_but_unauthorized") {
    // The finding this run exists to name: consented, introspected, refused.
    // Which of the three hypotheses in 11.1 holds is NOT decidable from a
    // member's token alone - it needs the administrator's row.
    verdict = scopeLiveConfirmed
      ? "scope_granted_product_refuses_needs_admin_row"
      : "scope_granted_stored_but_absent_live";
  } else if (!rootProbe.ok) verdict = "root_forbidden";
  else if (!eventsProbe.ok) verdict = "events_forbidden";
  else if (eventRows.length === 0) verdict = "readable_but_empty";
  else if (instProbe.ok) verdict = "events_and_instances_readable";
  else verdict = "events_readable_instances_forbidden";

  const after = await getConnection(admin, user.id, orgId);

  return json({
    organization_id: orgId,
    pco_organization_name: after.pco_organization_name,
    pco_organization_id: after.pco_organization_id,
    role: before.role,
    is_service: before.is_service,

    scope: {
      stored: before.scope,
      granted: grantedScopes,
      calendar_scope_present: hasCalendarScope,
      // Observed now, not remembered. The stored column was written at store
      // time against a token that has since rotated.
      live: live
        ? {
          active: live.active,
          scope: live.scope ?? null,
          scopes: liveScopes,
          calendar_present: liveScopes.includes("calendar"),
          // A disagreement here is the whole answer: it would mean the stored
          // column echoes what we ASKED for rather than what PCO granted.
          agrees_with_stored: liveScopes.slice().sort().join(" ") ===
            grantedScopes.slice().sort().join(" "),
        }
        : { error: liveError },
      note: hasCalendarScope ? null : "Add `calendar` to PCO_SCOPES in web/index.html " +
        "and reconnect - the dashboard field does not override the client (10.9).",
    },

    // The evidence for 11.1. Three noes, one token, one request.
    refusal_shapes: {
      in_scope_under_test: {
        path: "/calendar/v2",
        status: rootProbe.status,
        shape: classify(rootProbe),
        body: (rootProbe.error ?? "").slice(0, 300),
      },
      out_of_scope_control: {
        path: "/giving/v2",
        status: scopeControl.status,
        shape: classify(scopeControl),
        body: (scopeControl.error ?? "").slice(0, 300),
      },
      no_permission_control: {
        path: "/people/v2/campuses",
        status: permControl.status,
        shape: classify(permControl),
        body: (permControl.error ?? "").slice(0, 300),
      },
      // If this is false the two 401s are the same error and there is no new
      // finding - only a scope that never reached PCO.
      calendar_differs_from_out_of_scope: classify(rootProbe) !== classify(scopeControl),
    },

    token: {
      expired_on_entry: expiredOnEntry,
      refreshed_during_request: after.refresh_token !== before.refresh_token,
      expires_at: after.expires_at,
    },

    person: {
      id: personId,
      directory_status: directoryStatus,
      // Every attribute key PCO returned by default. A wrong field name should
      // cost thirty seconds, not an hour (9.1).
      attribute_keys: Object.keys(meAttrs).sort(),
      permission_shaped_attributes: permShapedDefault,
      sparse_fields: {
        asked: GUESSED_PERMISSION_FIELDS,
        answered: sparseAnswered,
        // Without this the silence of the calendar guesses proves nothing:
        // an unsupported sparse read and an absent attribute look identical.
        control_worked: sparseControlWorked,
      },
      // Non-null confirms hypothesis 1 outright - PCO gates Calendar per
      // person, and this member has no Calendar role. Null is NOT the
      // converse; PCO may simply not surface it on Person.
      calendar_permission_attribute: calendarPermissionAttr,
      calendar_permission_value: calendarPermissionAttr
        ? (sparseAttrs[calendarPermissionAttr] ?? permShapedDefault[calendarPermissionAttr] ??
          null)
        : null,
    },

    calendar_root: {
      readable: rootProbe.ok,
      status: rootProbe.status,
      why: classify(rootProbe),
      error: rootProbe.error ?? null,
    },

    // The free, unlimited half.
    events: {
      readable: eventsProbe.ok,
      status: eventsProbe.status,
      error: eventsProbe.error ?? null,
      total_count: eventsTotal,
      returned: eventRows.length,
      has_next: Boolean(eventsDoc?.links?.next),
      // A member reading a church-wide total here would be the first
      // church-wide read in this spike. 8.1 and 10.2 both said no.
      church_wide_read_by_member: eventsProbe.ok && before.role === "member" &&
        (eventsTotal ?? 0) > 0,
      can_query_by: eventsCanQueryBy,
      can_order_by: metaList(eventsDoc, "can_order_by"),
      can_include: eventsCanInclude,
      empty_is_ambiguous: eventsProbe.ok && eventRows.length === 0,
      attribute_keys: eventAttrKeys,
      relationship_keys: eventRelKeys,
      // Which attributes decide whether an event is for the congregation.
      visibility_shaped_attributes: visibilityShaped,
      names: eventRows.slice(0, 15).map((e) => (e?.attributes ?? {}).name ?? null),
      detail: eventDetail,
      detail_relationship_keys: eventDetailRels,
      group_shaped_relationships: groupShapedEventRels,
    },

    instances: {
      readable: instProbe.ok,
      // Values, not just keys, for ONE instance. Two time pairs exist on this
      // resource and nothing observed says which is which: starts_at/ends_at
      // is presumed the reserved block including setup and teardown, and
      // published_* what the congregation is shown. A member-facing feature
      // that reads the wrong pair shows a 7am call time for a 9am service, so
      // this is settled by comparison rather than by assumption.
      //
      // Safe to return: a church calendar names rooms and meetings, and the
      // pii_note already covers the free-text risk.
      first_instance: instRows[0]?.attributes ?? null,
      published_differs_from_actual: instRows[0]
        ? (instRows[0].attributes?.published_starts_at !==
          instRows[0].attributes?.starts_at)
        : null,
      status: instProbe.status,
      error: instProbe.error ?? null,
      total_count: instTotal,
      returned: instRows.length,
      attribute_keys: unionKeys(instRows, "attributes"),
      relationship_keys: unionKeys(instRows, "relationships"),
      can_query_by: instCanQueryBy,
      can_include: metaList(instDoc, "can_include"),
      date_filter: {
        control: { bogus_key: BOGUS_FILTER_KEY, status: controlStatus, total_count: controlTotal },
        // null means the control could not run, NOT that keys are validated.
        unknown_where_keys_ignored: unknownKeysIgnored,
        baseline_total: instTotal,
        bracket_syntax: {
          attempted: Boolean(dateProbeA),
          window: { from, to },
          status: dateProbeA?.status ?? null,
          total_count: dateProbeA ? totalOf(dateProbeA.body as Doc) : null,
          verdict: dateVerdict(dateProbeA, "starts_at"),
        },
        filter_param: {
          attempted: Boolean(dateProbeB),
          status: dateProbeB?.status ?? null,
          total_count: dateProbeB ? totalOf(dateProbeB.body as Doc) : null,
          verdict: dateVerdict(dateProbeB, null),
        },
        // The decisive one. Everything above can only fail to disprove.
        negative_window: {
          attempted: Boolean(negDateProbe),
          from: FAR_FUTURE,
          status: negDateProbe?.status ?? null,
          total_count: negDateProbe ? totalOf(negDateProbe.body as Doc) : null,
          verdict: negativeFilterVerdict(negDateProbe, instTotal),
        },
      },
    },

    // Whether the attribute the whole member-facing feature depends on is a
    // real filter or a decorative one in `can_query_by`.
    church_center_filter: {
      attempted: Boolean(negVisibleProbe),
      asked: "where[visible_in_church_center]=false",
      baseline_total: eventsTotal,
      status: negVisibleProbe?.status ?? null,
      total_count: negVisibleProbe ? totalOf(negVisibleProbe.body as Doc) : null,
      verdict: negativeFilterVerdict(negVisibleProbe, eventsTotal),
    },

    // 10.5's open question, asked of a third product.
    campus: {
      collection_readable: calCampusProbe.ok,
      collection_status: calCampusProbe.status,
      collection_error: calCampusProbe.error ?? null,
      list: calCampusRows.map((c) => ({
        id: String(c?.id),
        name: (c?.attributes ?? {}).name ?? null,
      })),
      campus_relationship_on_event: campusRelOnEvent,
      campus_includable_on_event: campusIncludable,
      campus_shaped_event_attributes: campusShapedEventAttrs,
      // The one-line answer to whether campus-local routing has a home here.
      usable_for_locality: campusRelOnEvent || campusIncludable ||
        campusShapedEventAttrs.length > 0,
      // 9.8 said no, from documentation. This is the observation.
      documentation_claim: "9.8: Services and Calendar expose no campus API at all",
    },

    // The metered half.
    resources: {
      readable: resProbe.ok,
      status: resProbe.status,
      error: resProbe.error ?? null,
      total_count: resTotal,
      returned: resRows.length,
      kinds: resKinds,
      attribute_keys: resAttrKeys,
      names: resRows.slice(0, 15).map((r) => (r?.attributes ?? {}).name ?? null),
      // Free tier is one room. More than one means this church pays for
      // Calendar, which makes every resource observation here a paying
      // church's - the same caveat 10.7 records for Groups.
      church_appears_to_pay: resTotal !== null ? resTotal > 1 : null,
    },

    tags: {
      readable: tagsProbe.ok,
      status: tagsProbe.status,
      count: tagRows.length,
      names: tagRows.slice(0, 25).map((t) => (t?.attributes ?? {}).name ?? null),
      attribute_keys: unionKeys(tagRows, "attributes"),
    },

    probes: probes.map((p) => ({
      path: p.path,
      ok: p.ok,
      status: p.status,
      ...(p.error ? { error: p.error } : {}),
    })),

    // Default-on, because inside the scope a 404 is finally a real answer (9.7).
    ...(body?.sweep !== false ? { sweep } : {}),

    // Nothing person-shaped is REQUESTED - no /calendar/v2/people, no owner
    // includes, no attendee reads. But an event name is free text a human
    // typed, and "Premarital counseling - the Ruizes" is a name in a field
    // this probe returns. Unlike the campus and group probes, this output
    // cannot be pasted into git unread.
    pii_note: "event, resource and tag NAMES are returned verbatim. No person " +
      "resource is read - but event names are free text and may carry names. " +
      "Read before pasting anywhere.",

    verdict,
  });
}));
