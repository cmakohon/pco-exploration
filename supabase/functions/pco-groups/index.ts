// What Planning Center will tell us about groups, and to whom.
//
// Same shape and the same discipline as pco-campuses: read-only, non-fatal,
// every sub-probe records its own outcome because a refusal from PCO IS the
// finding. Run it from a member's row and an administrator's row and compare.
//
// Why this one matters more than campuses. Section 9 settled WHERE a person
// is; groups settle WHO a person is with. If a member can read their own
// group's roster on their own token, then care can be routed to the eight
// people most likely to act on it without the church's service identity being
// involved at all. If they cannot, every group-scoped feature has to run as
// the church - which is a different product, a different privacy posture, and
// a different failure mode when a church's service connection lapses.
//
// The four questions, in the order the answers gate each other:
//   Q1  Was the `groups` scope actually granted?      (nothing else matters)
//   Q2  Which groups am I in?                         (the routing primitive)
//   Q3  Who else is in them?                          (member token or service)
//   Q4  Does a group carry a campus?                  (local routing)
//
// Nothing here writes. The only state this can change is one token rotation,
// through the shared path.

import { handler, json } from "../_shared/http.ts";
import {
  adminClient,
  getConnection,
  HttpError,
  negativeFilterVerdict,
  type PcoProbe,
  pcoProbeWithToken,
  requireUser,
  validAccessToken,
} from "../_shared/pco.ts";
import { defaultOrgFor, requireMembership } from "../_shared/tenancy.ts";

// Same control key as the campuses probe. Section 9 established that PCO
// IGNORES unknown where[] keys on /people/v2 rather than rejecting them, which
// makes any filtered count meaningless without a control. Groups is a separate
// product with its own parameter handling, so the control is re-run here
// rather than assumed to behave the same way.
const BOGUS_FILTER_KEY = "zz_not_a_real_field";

// Candidate doors to "the groups I am in". Probed in order; the first that
// yields group ids wins and is recorded as the cheapest source.
//
// This list is a hypothesis, not documentation. PCO's Groups API is not People
// with different nouns - /me may not exist, sub-resources may not route, and
// the top-level collections may or may not accept a person filter. A 404 here
// is a real finding and is kept in the output: "this door does not exist" and
// "this door is shut to you" are different answers with different products
// behind them.
const MY_GROUPS_DOORS = (pid: string | null) => [
  "/groups/v2/me",
  "/groups/v2/me/groups",
  ...(pid
    ? [
      `/groups/v2/people/${pid}`,
      `/groups/v2/people/${pid}/groups`,
      `/groups/v2/people/${pid}/memberships`,
      `/groups/v2/memberships?where[person_id]=${pid}`,
    ]
    : []),
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

/**
 * Pull group ids out of a response whose shape is not known in advance.
 *
 * A "my groups" door may answer with Group resources or with GroupMembership
 * resources that merely point at one. Both are useful and neither is worth a
 * separate code path, so read the type and follow the relationship when there
 * is one.
 */
function groupIdsFrom(doc: Doc): string[] {
  const rows: Doc[] = Array.isArray(doc?.data) ? doc.data : doc?.data ? [doc.data] : [];
  const ids = rows.map((r) => {
    const type = String(r?.type ?? "");
    if (/^group$/i.test(type)) return r?.id ? String(r.id) : null;
    const relId = r?.relationships?.group?.data?.id;
    if (relId) return String(relId);
    // A door that answers with a Person tells us the door exists, not which
    // groups we are in. Not an id, and must not be mistaken for one.
    return null;
  });
  return [...new Set(ids.filter((x): x is string => Boolean(x)))];
}

/** Membership row ids in a response that belong to the given person. */
function selfMembershipIdsFrom(doc: Doc, personId: string | null): string[] {
  if (!personId) return [];
  const rows: Doc[] = Array.isArray(doc?.data) ? doc.data : [];
  return rows
    .filter((r) => /membership/i.test(String(r?.type ?? "")))
    .filter((r) => String(r?.relationships?.person?.data?.id ?? "") === personId)
    .map((r) => String(r?.id));
}

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);

  const body = await req.json().catch(() => ({}));
  const orgId = (body?.organization_id as string) ?? await defaultOrgFor(admin, user.id);
  if (!orgId) throw new HttpError(409, "No church selected and none to default to");

  await requireMembership(admin, user.id, orgId);

  const before = await getConnection(admin, user.id, orgId);
  const expiredOnEntry = new Date(before.expires_at).getTime() <= Date.now();

  // Refresh ONCE and hand the same token to every probe, so a single rotation
  // stays attributable (5.2) instead of happening an unknown number of times.
  const token = await validAccessToken(admin, before);

  // Q1, and it is a hard gate. Changing the scope list in the Supabase
  // dashboard does not touch tokens that were already issued: this connection
  // carries whatever it was granted at authorization time, and a re-consent is
  // the only thing that widens it. Reading the stored scope BEFORE probing is
  // what separates "PCO refused us" from "we never asked for this".
  const grantedScopes = (before.scope ?? "").split(/\s+/).filter(Boolean);
  const hasGroupsScope = grantedScopes.includes("groups");

  const probes: PcoProbe[] = [];

  async function probe(path: string): Promise<PcoProbe> {
    const p = await pcoProbeWithToken(token, path);
    probes.push(p);
    return p;
  }

  // status -1 means the request was never sent. "We did not ask" and "PCO
  // would not answer" are different findings; a missing line reads as neither.
  function skip(path: string, why: string) {
    probes.push({ path, ok: false, status: -1, error: `not attempted: ${why}` });
  }

  // --- Q1. Is the door open at all? -----------------------------------------

  // The product root. If the scope is missing this is where it shows, and the
  // error text is the evidence - section 9.7 found PCO answers a scope refusal
  // differently from a permission refusal, and that the scope check wins.
  const rootProbe = await probe("/groups/v2");

  // Resolve the person id from the People side, which we know works. Several
  // candidate doors below are addressed by person id, and /groups/v2/me may
  // not exist to supply one.
  const meProbe = await probe("/people/v2/me");
  const personId = (meProbe.body as Doc)?.data?.id
    ? String((meProbe.body as Doc).data.id)
    : null;
  const directoryStatus = ((meProbe.body as Doc)?.data?.attributes ?? {}).directory_status ??
    null;

  // --- Q2. Which groups am I in? --------------------------------------------

  const doors: Array<Record<string, unknown>> = [];
  const doorIds = new Map<string, string[]>();
  let myGroupIds: string[] = [];
  let myGroupsSource: string | null = null;

  for (const path of MY_GROUPS_DOORS(personId)) {
    const p = await probe(path);
    const ids = p.ok ? groupIdsFrom(p.body as Doc) : [];
    doors.push({
      path,
      status: p.status,
      why: classify(p),
      // A collection that is implicitly scoped to the caller and one that
      // honours a person filter return the same two rows. Only the count over
      // the whole collection separates them, so it is recorded even though
      // every door here happens to answer 200.
      total_count: (p.body as Doc)?.meta?.total_count ?? null,
      // The type PCO answered with is the interesting part of a 200 that
      // yields no group ids: /groups/v2/me returning a Person means the door
      // exists but is not the one we want.
      returned_type: p.ok
        ? (Array.isArray((p.body as Doc)?.data)
          ? ((p.body as Doc).data[0]?.type ?? "empty_collection")
          : ((p.body as Doc)?.data?.type ?? null))
        : null,
      group_ids: ids.length,
      // Which groups, not just how many. After a join at Hope City the Group
      // doors said 3 and the Membership doors said 2; a count cannot say
      // which group went missing, or that it is the same one on both.
      group_id_list: ids,
      // The caller's own Membership rows, by id. Compared against the row
      // found in the group's own roster below: same person, same group, two
      // different collections.
      self_membership_ids: p.ok ? selfMembershipIdsFrom(p.body as Doc, personId) : [],
      detail: p.ok ? null : (p.error ?? "").slice(0, 200),
    });
    doorIds.set(path, ids);
    if (!myGroupsSource && ids.length > 0) {
      myGroupIds = ids;
      myGroupsSource = path;
    }
  }

  // --- Q3a. The church's groups ---------------------------------------------

  // The enumeration question, and the one most likely to differ between a
  // member and an administrator. A member who can list every group in the
  // church is a directory; a member who can list only their own is a product
  // constraint we have to design around.
  const listProbe = await probe("/groups/v2/groups?per_page=100");
  const listDoc = listProbe.body as Doc;
  const groupRows: Doc[] = Array.isArray(listDoc?.data) ? listDoc.data : [];
  const baseTotalEarly: number | null = listDoc?.meta?.total_count ?? null;

  // Union across all rows: a group with a null field still carries the key.
  const groupAttrKeys = [...new Set(groupRows.flatMap((g) => keysOf(g?.attributes)))].sort();
  const groupRelKeys = [...new Set(groupRows.flatMap((g) => keysOf(g?.relationships)))].sort();

  // The taxonomy. "Your group" only means something if the church separates
  // small groups from serving teams from classes - if every group is one
  // undifferentiated type, concentric routing has nothing to route on.
  const typesProbe = await probe("/groups/v2/group_types?per_page=100");
  const typeRows: Doc[] = Array.isArray((typesProbe.body as Doc)?.data)
    ? (typesProbe.body as Doc).data
    : [];

  // --- Q3b. One group in full, preferring one I am actually in --------------

  // Prefer a group the caller belongs to over the first in the list. If a
  // detail read succeeds on my own group while the enumeration above is
  // forbidden, that is the shippable rule: you may read what you are part of.
  const mineListed = groupRows.map((g) => String(g?.id)).find((id) => myGroupIds.includes(id));
  const focusId = mineListed ?? myGroupIds[0] ?? (groupRows[0]?.id ? String(groupRows[0].id) : null);
  const focusIsMine = Boolean(focusId && myGroupIds.includes(focusId));

  let focusAttrs: unknown = null;
  let focusRels: string[] = [];
  if (focusId) {
    const d = await probe(`/groups/v2/groups/${focusId}`);
    focusAttrs = (d.body as Doc)?.data?.attributes ?? null;
    focusRels = keysOf((d.body as Doc)?.data?.relationships);
  } else {
    skip("/groups/v2/groups/{id}", "no group id available");
  }

  // --- Q3c. The roster ------------------------------------------------------

  // THE question for the product. Include the person so the response carries
  // its own proof: a membership row without a resolvable person is a count,
  // not a roster, and you cannot route care to a count.
  let memProbe: PcoProbe | null = null;
  let memIncluded: PcoProbe | null = null;
  if (focusId) {
    memProbe = await probe(`/groups/v2/groups/${focusId}/memberships?per_page=25`);
    if (memProbe.ok) {
      memIncluded = await probe(
        `/groups/v2/groups/${focusId}/memberships?per_page=25&include=person`,
      );
    } else {
      skip(`/groups/v2/groups/${focusId}/memberships?include=person`, "memberships forbidden");
    }
  } else {
    skip("/groups/v2/groups/{id}/memberships", "no group id available");
  }

  const memRows: Doc[] = Array.isArray((memProbe?.body as Doc)?.data)
    ? (memProbe!.body as Doc).data
    : [];
  const memAttrKeys = [...new Set(memRows.flatMap((m) => keysOf(m?.attributes)))].sort();

  // ids and roles only, never names or emails - this output is destined for a
  // markdown file in git. Whether the edge resolves is the evidence; who the
  // person is is not.
  const memSample = memRows.slice(0, 5).map((m) => ({
    membership_id: String(m?.id),
    role: (m?.attributes ?? {}).role ?? null,
    person_id: m?.relationships?.person?.data?.id
      ? String(m.relationships.person.data.id)
      : null,
  }));

  const includedTypes = Array.isArray((memIncluded?.body as Doc)?.included)
    ? [...new Set((memIncluded!.body as Doc).included.map((r: Doc) => String(r?.type)))]
    : null;
  // What a sideloaded Person actually carries here. If it carries no contact
  // route, the roster is a list of strangers and the product needs the service
  // connection after all.
  const includedPersons: Doc[] = Array.isArray((memIncluded?.body as Doc)?.included)
    ? (memIncluded!.body as Doc).included.filter((r: Doc) => /person/i.test(String(r?.type)))
    : [];
  const includedPersonKeys = keysOf(includedPersons[0]?.attributes);

  /**
   * Are the contact arrays POPULATED, or merely present?
   *
   * 10.4 recorded the attribute names and deliberately not the values, which
   * left 10.10's second item open: a roster you can see but cannot reach is a
   * list of strangers, and the group tier is a different product if these come
   * back empty.
   *
   * Counts and presence only - never a value, never a partial value, never a
   * domain. "How many people have at least one email" answers the product
   * question completely and discloses nothing about any of them.
   */
  function populationOf(field: string) {
    let withAny = 0;
    let total = 0;
    for (const p of includedPersons) {
      const v = (p?.attributes ?? {})[field];
      const n = Array.isArray(v) ? v.length : (v ? 1 : 0);
      total += n;
      if (n > 0) withAny++;
    }
    return {
      people_with_at_least_one: withAny,
      of_people: includedPersons.length,
      total_entries: total,
    };
  }
  /**
   * Is reachability a function of ROLE?
   *
   * At Hope City exactly 2 of 25 people carried an email, and the first five
   * membership rows contained exactly 2 leaders. If those are the same two
   * people, PCO is not withholding contact details at random - it is exposing
   * the people a member is meant to be able to contact, and withholding the
   * rest of the congregation. That is a different product from "the roster is
   * unreachable", and a better-behaved one.
   *
   * Joins the membership rows to the sideloaded Person by id. Counts only, and
   * the same discipline as populationOf: how many, never who, never a value.
   */
  const personById = new Map<string, Doc>(
    includedPersons.map((p: Doc) => [String(p?.id), p]),
  );
  const includedMemberships: Doc[] = Array.isArray((memIncluded?.body as Doc)?.data)
    ? (memIncluded!.body as Doc).data
    : [];
  const byRole: Record<string, { n: number; with_email: number; with_phone: number }> = {};
  for (const m of includedMemberships) {
    const role = String((m?.attributes ?? {}).role ?? "unknown");
    const pid = m?.relationships?.person?.data?.id
      ? String(m.relationships.person.data.id)
      : null;
    const attrs = (pid ? personById.get(pid)?.attributes : null) ?? {};
    const has = (f: string) => {
      const v = (attrs as Record<string, unknown>)[f];
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    };
    byRole[role] ??= { n: 0, with_email: 0, with_phone: 0 };
    byRole[role].n++;
    if (has("email_addresses")) byRole[role].with_email++;
    if (has("phone_numbers")) byRole[role].with_phone++;
  }

  /**
   * The `permissions` attribute on the sideloaded Person.
   *
   * It has been in `person_attribute_keys` since 10.4 and its VALUE has never
   * been read. Role is refuted (16.1) and the caller's own directory_status
   * cannot explain 2-of-25 either - a per-caller rule would produce 0 or 25,
   * not 2. Whatever varies, varies per subject, and this is the only
   * subject-level field in the payload that could carry it.
   *
   * Distribution and cross-tab only. The values are an enum PCO defines, not
   * anything personal, but the cross-tab is still reported as counts so that
   * no individual is ever identifiable as "the reachable one".
   */
  const byPermission: Record<string, { n: number; with_email: number }> = {};
  for (const p of includedPersons) {
    const attrs = (p?.attributes ?? {}) as Record<string, unknown>;
    const key = attrs.permissions === null || attrs.permissions === undefined
      // null and the string "no_access" would be different findings; 11.3
      // found people_permissions null where 8.6 expected a string.
      ? `__${String(attrs.permissions)}__`
      : String(attrs.permissions);
    const emails = attrs.email_addresses;
    const hasEmail = Array.isArray(emails) ? emails.length > 0 : Boolean(emails);
    byPermission[key] ??= { n: 0, with_email: 0 };
    byPermission[key].n++;
    if (hasEmail) byPermission[key].with_email++;
  }

  const contactPopulation = includedPersons.length > 0
    ? {
      // Refuted at Hope City: 0 of 3 leaders reachable, 2 of 22 members.
      // Kept because a second church could still disagree.
      by_role: byRole,
      // The remaining candidate for what varies per subject.
      by_permission: byPermission,
      email_addresses: populationOf("email_addresses"),
      phone_numbers: populationOf("phone_numbers"),
      addresses: populationOf("addresses"),
      // The one non-contact field worth counting: an avatar is the difference
      // between a roster that looks like people and one that looks like rows.
      avatar_url: populationOf("avatar_url"),
    }
    : null;

  // Does the roster include ME?
  //
  // Computed over every returned row, never over memSample - that sample is
  // truncated to five on purpose, and a question about the whole set cannot be
  // answered from a deliberate truncation. The first version of this probe did
  // exactly that and reported false for a caller who was in the group.
  //
  // Even over all returned rows a `false` is only conclusive when the page is
  // the whole collection, so it is reported as a tri-state and `returned` /
  // `total_count` sit beside it in the output.
  const rosterPersonIds = memRows.map((m) =>
    m?.relationships?.person?.data?.id ? String(m.relationships.person.data.id) : null
  );
  const rosterIncludesMe = !personId || memRows.length === 0
    ? null
    : rosterPersonIds.includes(personId);
  const rosterPageIsWhole = memRows.length > 0 &&
    (memProbe?.body as Doc)?.meta?.total_count === memRows.length;

  // --- Q4. Campus linkage ---------------------------------------------------

  // Groups has its own campuses collection. Section 9 found /people/v2/campuses
  // forbidden to an ordinary member; whether the Groups copy is too decides
  // whether campus-local routing can run on a member token.
  const gCampusProbe = await probe("/groups/v2/campuses?per_page=100");
  const gCampusRows: Doc[] = Array.isArray((gCampusProbe.body as Doc)?.data)
    ? (gCampusProbe.body as Doc).data
    : [];

  const campusRelPresent = groupRelKeys.includes("campus");
  const campusIdsOnGroups = [
    ...new Set(
      groupRows
        .map((g) => g?.relationships?.campus?.data?.id)
        .filter(Boolean)
        .map((x: Doc) => String(x)),
    ),
  ];

  // The filter question, with the same three-probe structure section 9.4
  // proved is necessary: baseline, control, then the filtered read. The
  // baseline is the group list above.
  const baseTotal = baseTotalEarly;
  const canQueryBy: string[] | null = Array.isArray(listDoc?.meta?.can_query_by)
    ? listDoc.meta.can_query_by
    : null;

  let controlStatus: number | null = null;
  let controlTotal: number | null = null;
  if (listProbe.ok) {
    const control = await probe(
      `/groups/v2/groups?where[${BOGUS_FILTER_KEY}]=1&per_page=1`,
    );
    controlStatus = control.status;
    controlTotal = (control.body as Doc)?.meta?.total_count ?? null;
  } else {
    skip(`/groups/v2/groups?where[${BOGUS_FILTER_KEY}]=1`, "group list not readable");
  }
  const unknownKeysIgnored = controlStatus === 200 && controlTotal !== null && baseTotal !== null
    ? controlTotal === baseTotal
    : null;

  // Everything so far proves what PCO IGNORES. Nothing has yet proved that a
  // key PCO advertises in can_query_by is honoured - and a `where` clause that
  // silently does nothing is the same failure either way. `name` is declared,
  // so a name that cannot match must return zero.
  const NO_SUCH_NAME = "zzz_no_such_group_zzz";
  let declaredKeyProbe: PcoProbe | null = null;
  if (listProbe.ok && (baseTotalEarly ?? 0) > 0) {
    declaredKeyProbe = await probe(
      `/groups/v2/groups?where[name]=${NO_SUCH_NAME}&per_page=1`,
    );
  } else {
    skip(`/groups/v2/groups?where[name]=${NO_SUCH_NAME}`, "no groups to exclude");
  }

  const filterCampusId = (gCampusRows[0]?.id ? String(gCampusRows[0].id) : null) ??
    campusIdsOnGroups[0] ?? null;
  let campusFilterProbe: PcoProbe | null = null;
  if (!listProbe.ok) {
    skip("/groups/v2/groups?where[campus_id]=...", "group list not readable");
  } else if (!filterCampusId) {
    skip("/groups/v2/groups?where[campus_id]=...", "no campus id to filter on");
  } else {
    campusFilterProbe = await probe(
      `/groups/v2/groups?where[campus_id]=${filterCampusId}&per_page=5`,
    );
  }
  const campusFilterTotal = (campusFilterProbe?.body as Doc)?.meta?.total_count ?? null;

  let campusFilterVerdict: string;
  if (!listProbe.ok) campusFilterVerdict = "group_list_forbidden";
  else if (!campusFilterProbe) campusFilterVerdict = "not_attempted";
  else if (campusFilterProbe.status === 403) campusFilterVerdict = "forbidden";
  else if (campusFilterProbe.status === 400) campusFilterVerdict = "param_rejected";
  else if (canQueryBy && !canQueryBy.includes("campus_id")) campusFilterVerdict = "ignored";
  else if (
    unknownKeysIgnored && campusFilterTotal !== null && baseTotal !== null &&
    campusFilterTotal === baseTotal && (baseTotal ?? 0) > 1
  ) campusFilterVerdict = "ignored";
  else if (
    campusFilterTotal !== null && baseTotal !== null && campusFilterTotal < baseTotal
  ) campusFilterVerdict = "effective";
  else campusFilterVerdict = "inconclusive";

  // --- Meetings -------------------------------------------------------------

  // Not load-bearing for care routing, but it is the difference between a
  // group that is a list of names and a group that has a rhythm. A meal train
  // that knows the group meets Tuesday can ask on Tuesday.
  let eventsProbe: PcoProbe | null = null;
  if (focusId) {
    eventsProbe = await probe(`/groups/v2/groups/${focusId}/events?per_page=5`);
  } else {
    skip("/groups/v2/groups/{id}/events", "no group id available");
  }
  const eventRows: Doc[] = Array.isArray((eventsProbe?.body as Doc)?.data)
    ? (eventsProbe!.body as Doc).data
    : [];

  // --- Group doors vs Membership doors --------------------------------------

  // After joining a request-to-join group at Hope City, /me/groups and
  // /people/{id}/groups said 3 while /people/{id}/memberships - the door 15.2
  // recommended - still said 2, on two runs. Either the Membership index lags
  // the Group one, or something about the new group hides the caller's row.
  // For each group, read its settings, its own roster, and its enrollment
  // rules.
  const membershipDoorIds = new Set(
    [...doorIds.entries()]
      .filter(([path]) => /memberships/.test(path))
      .flatMap(([, ids]) => ids),
  );
  const unmatchedGroupIds = myGroupIds.filter((id) => !membershipDoorIds.has(id));

  // The first run of this block showed the gap runs both ways: the Membership
  // doors also name a group (2453651) that no Group door returns, and agree
  // with the Group doors on one group only by id. So check the union - every
  // group either family names - and for each, whether the caller's row in
  // the group's own roster is the same row the Membership doors returned.
  const selfIdsOnMembershipDoors = new Set(
    doors
      .filter((d) => /memberships/.test(String(d.path)))
      .flatMap((d) => d.self_membership_ids as string[]),
  );
  const crosscheckIds = [...new Set([...myGroupIds, ...membershipDoorIds])];

  const membershipCrosscheck: Array<Record<string, unknown>> = [];
  for (const gid of crosscheckIds) {
    const detail = await probe(`/groups/v2/groups/${gid}`);
    const a = (detail.body as Doc)?.data?.attributes ?? {};

    // per_page=100 so a small group's roster is one whole page and "my row is
    // absent" is conclusive rather than "not on page one" (15.4).
    const roster = await probe(`/groups/v2/groups/${gid}/memberships?per_page=100`);
    const rows: Doc[] = Array.isArray((roster.body as Doc)?.data) ? (roster.body as Doc).data : [];
    const rosterTotal: number | null = (roster.body as Doc)?.meta?.total_count ?? null;
    const mine = rows.find((m) =>
      personId && String(m?.relationships?.person?.data?.id ?? "") === personId
    );

    const enrollment = await probe(`/groups/v2/groups/${gid}/enrollment`);

    membershipCrosscheck.push({
      group_id: gid,
      in_group_doors: myGroupIds.includes(gid),
      in_membership_doors: membershipDoorIds.has(gid),
      detail_status: detail.status,
      detail_why: classify(detail),
      detail_error: detail.ok ? null : (detail.error ?? "").slice(0, 200),
      // Group names are church structure and already kept elsewhere; this is
      // the only way to recognise a group no Group door will list.
      name: a.name ?? null,
      members_are_confidential: a.members_are_confidential ?? null,
      memberships_count: a.memberships_count ?? null,
      listed: a.listed ?? null,
      archived_at: a.archived_at ?? null,
      roster: {
        status: roster.status,
        why: classify(roster),
        total_count: rosterTotal,
        returned: rows.length,
        page_is_whole_collection: rosterTotal !== null && rows.length >= rosterTotal,
        // The caller's own row only. Role and join time are the caller's own
        // data; nobody else's attributes leave this block.
        caller_row: mine
          ? {
            membership_id: String(mine.id),
            role: (mine.attributes ?? {}).role ?? null,
            joined_at: (mine.attributes ?? {}).joined_at ?? null,
            // Same row, or the same group reached by a different row?
            also_on_membership_doors: selfIdsOnMembershipDoors.has(String(mine.id)),
          }
          : null,
        error: roster.ok ? null : (roster.error ?? "").slice(0, 200),
      },
      // Group configuration, not personal data - kept verbatim so the value
      // set (strategy, status) is on record the first time it is seen.
      enrollment: {
        status: enrollment.status,
        why: classify(enrollment),
        type: (enrollment.body as Doc)?.data?.type ?? null,
        attributes: (enrollment.body as Doc)?.data?.attributes ?? null,
        error: enrollment.ok ? null : (enrollment.error ?? "").slice(0, 200),
      },
    });
  }

  // --- One word for the FINDINGS table cell ---------------------------------

  let verdict: string;
  if (!hasGroupsScope && !rootProbe.ok) verdict = "scope_not_granted_reconsent_required";
  else if (!rootProbe.ok) verdict = classify(rootProbe) === "scope"
    ? "scope_refused_despite_grant"
    : "groups_root_forbidden";
  else if (memProbe?.ok && (rosterIncludesMe || memRows.length > 0)) {
    verdict = myGroupsSource
      ? "own_groups_and_roster_readable"
      : "roster_readable_but_own_groups_undiscoverable";
  } else if (listProbe.ok && groupRows.length === 0) {
    // Nothing was refused - there was nothing to ask about. The admin row at
    // an empty church reported "roster forbidden" for a roster never
    // requested, because `!memProbe?.ok` is true when memProbe is null.
    verdict = myGroupIds.length === 0
      ? "no_groups_visible_nothing_to_probe"
      : "own_groups_known_but_list_empty";
  } else if (listProbe.ok && memProbe && !memProbe.ok) {
    verdict = "groups_visible_roster_forbidden";
  } else if (listProbe.ok) verdict = "groups_visible_no_memberships";
  else verdict = "group_list_forbidden";

  const after = await getConnection(admin, user.id, orgId);

  return json({
    organization_id: orgId,
    pco_organization_name: after.pco_organization_name,
    pco_organization_id: after.pco_organization_id,
    role: before.role,
    is_service: before.is_service,

    // Q1 first and on its own, because every refusal below is uninterpretable
    // without it. A dashboard scope change does not reissue tokens.
    scope: {
      stored: before.scope,
      granted: grantedScopes,
      groups_scope_present: hasGroupsScope,
      note: hasGroupsScope
        ? null
        : "This connection predates the scope change. Disconnect and reconnect " +
          "to re-consent; PCO may also need the app revoked at " +
          "planningcenteronline.com before it will re-prompt for a widened scope.",
    },

    token: {
      expired_on_entry: expiredOnEntry,
      refreshed_during_request: after.refresh_token !== before.refresh_token,
      expires_at: after.expires_at,
    },

    person: {
      id: personId,
      // Context for every 403 below, exactly as in the campuses probe.
      directory_status: directoryStatus,
    },

    groups_root: {
      readable: rootProbe.ok,
      status: rootProbe.status,
      why: classify(rootProbe),
      error: rootProbe.error ?? null,
    },

    // Q2
    my_groups: {
      source: myGroupsSource,
      ids: myGroupIds,
      count: myGroupIds.length,
      // Absent vs empty are different findings: no door opened at all is a
      // platform limit, an open door with zero groups is a person who is in
      // none. Do not collapse them.
      no_door_opened: myGroupsSource === null,
      doors,
      // Groups the Group doors return and the Membership doors do not, and
      // the reverse. The crosscheck below covers the union of both families.
      membership_door_gap: unmatchedGroupIds,
      group_door_gap: [...membershipDoorIds].filter((id) => !myGroupIds.includes(id)),
      membership_crosscheck: membershipCrosscheck,
    },

    // Q3a
    groups: {
      readable: listProbe.ok,
      status: listProbe.status,
      error: listProbe.error ?? null,
      total_count: baseTotal,
      returned: groupRows.length,
      has_next: Boolean(listDoc?.links?.next),
      can_query_by: canQueryBy,
      can_order_by: listDoc?.meta?.can_order_by ?? null,
      can_include: listDoc?.meta?.can_include ?? null,
      // A 200 with an empty list cannot distinguish "this church runs no
      // groups" from "this person may not see them". Say so rather than
      // leaving the reader the generous reading.
      empty_is_ambiguous: listProbe.ok && groupRows.length === 0,
      attribute_keys: groupAttrKeys,
      relationship_keys: groupRelKeys,
      list: groupRows.map((g) => ({
        id: String(g?.id),
        name: (g?.attributes ?? {}).name ?? null,
        memberships_count: (g?.attributes ?? {}).memberships_count ?? null,
        campus_id: g?.relationships?.campus?.data?.id
          ? String(g.relationships.campus.data.id)
          : null,
        mine: myGroupIds.includes(String(g?.id)),
      })),
    },

    group_types: {
      readable: typesProbe.ok,
      status: typesProbe.status,
      count: typeRows.length,
      list: typeRows.map((t) => ({
        id: String(t?.id),
        name: (t?.attributes ?? {}).name ?? null,
        church_center_visible: (t?.attributes ?? {}).church_center_visible ?? null,
      })),
      attribute_keys: [...new Set(typeRows.flatMap((t) => keysOf(t?.attributes)))].sort(),
    },

    // Q3b
    focus_group: {
      id: focusId,
      // Whether the detail read below is a privilege test or a self read.
      is_mine: focusIsMine,
      attributes: focusAttrs,
      relationship_keys: focusRels,
    },

    // Q3c - a permission probe, not a roster dump.
    roster: {
      attempted: Boolean(memProbe),
      readable: memProbe?.ok ?? null,
      status: memProbe?.status ?? null,
      error: memProbe?.error ?? null,
      total_count: (memProbe?.body as Doc)?.meta?.total_count ?? null,
      returned: memRows.length,
      attribute_keys: memAttrKeys,
      can_include: (memProbe?.body as Doc)?.meta?.can_include ?? null,
      sample: memSample,
      includes_caller: rosterIncludesMe,
      // false + page_is_whole false means "not on this page", which is not an
      // answer. Without this the two are indistinguishable.
      includes_caller_conclusive: rosterIncludesMe === true || rosterPageIsWhole,
      page_is_whole_collection: rosterPageIsWhole,
      include_person: {
        attempted: Boolean(memIncluded),
        status: memIncluded?.status ?? null,
        included_types: includedTypes,
        // The decisive detail: a Person here with no email or phone means a
        // member token can see WHO is in their group but cannot reach them,
        // and the product needs the church's identity to close the loop.
        person_attribute_keys: includedPersonKeys,
        people_returned: includedPersons.length,
        // Counts only. Answers "can we reach these people" without saying
        // anything about any one of them.
        contact_population: contactPopulation,
      },
    },

    // Q4
    campus: {
      groups_campuses_readable: gCampusProbe.ok,
      groups_campuses_status: gCampusProbe.status,
      groups_campuses_error: gCampusProbe.error ?? null,
      list: gCampusRows.map((c) => ({
        id: String(c?.id),
        name: (c?.attributes ?? {}).name ?? null,
      })),
      campus_relationship_on_group: campusRelPresent,
      distinct_campus_ids_on_groups: campusIdsOnGroups,
      filter: {
        // Proves a DECLARED key is honoured. Without it, "campus_id is
        // ignored" is indistinguishable from "no where clause does anything".
        declared_key_control: {
          attempted: Boolean(declaredKeyProbe),
          asked: `where[name]=${NO_SUCH_NAME}`,
          status: declaredKeyProbe?.status ?? null,
          total_count: declaredKeyProbe
            ? ((declaredKeyProbe.body as Doc)?.meta?.total_count ?? null)
            : null,
          verdict: negativeFilterVerdict(declaredKeyProbe, baseTotal),
        },
        control: {
          bogus_key: BOGUS_FILTER_KEY,
          status: controlStatus,
          total_count: controlTotal,
        },
        // null means the control could not run, NOT that keys are validated.
        unknown_where_keys_ignored: unknownKeysIgnored,
        attempted_campus_id: filterCampusId,
        status: campusFilterProbe?.status ?? null,
        baseline_total: baseTotal,
        filtered_total: campusFilterTotal,
        verdict: campusFilterVerdict,
      },
    },

    meetings: {
      attempted: Boolean(eventsProbe),
      readable: eventsProbe?.ok ?? null,
      status: eventsProbe?.status ?? null,
      count: eventRows.length,
      attribute_keys: [...new Set(eventRows.flatMap((e) => keysOf(e?.attributes)))].sort(),
    },

    // Every request in order, bodies omitted. The sequence is the evidence.
    probes: probes.map((p) => ({
      path: p.path,
      ok: p.ok,
      status: p.status,
      ...(p.error ? { error: p.error } : {}),
    })),

    // Group names are church structure and are kept, the same way campus names
    // were. Person names and emails are not, and never enter this payload -
    // but note that "which groups I am in" is itself sensitive at a church
    // that runs recovery or care groups. Redact before pasting into git.
    pii_note: "ids and group names only; no person names or contact details",

    verdict,
  });
}));
