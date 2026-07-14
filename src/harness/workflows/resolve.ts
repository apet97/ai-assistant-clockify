import type { ActionContext, ClarifyOption, RiskyClarifyResult } from "../action.js";
import type { ListResult } from "../../clockify/types.js";

/**
 * Deterministic name → entity resolution shared by workflows. Writes must stop
 * when identity is ambiguous (SAFETY_AND_PERMISSIONS "Ambiguous Identity"): the
 * harness never picks one of several matches — it asks the admin to choose.
 */
export type NameMatch<T> =
  | { kind: "none" }
  | { kind: "one"; entity: T }
  | { kind: "many"; matches: T[] };

/** Most "did you mean?" options to offer when a named entity isn't found. */
const MAX_SUGGESTIONS = 12;

/** A clarify option label that flags archived candidates so duplicates are tellable apart. */
function optionLabel(item: { name: string; archived?: boolean }): string {
  return item.archived ? `${item.name} (archived)` : item.name;
}

/**
 * Build grounded "did you mean one of these?" clarify options from the candidates
 * already fetched (Phase 4 — a clarify offers options, never "go list them
 * yourself"). Prefers names containing the query; falls back to all candidates;
 * excludes archived unless `includeArchived` (destructive/archive verbs may
 * legitimately target archived entities — live item 305); capped. Empty when
 * there are none to offer.
 */
export function suggestOptions<T extends { id: string; name: string; archived?: boolean }>(
  items: T[],
  query: string,
  opts?: { includeArchived?: boolean },
): ClarifyOption[] {
  const candidates = opts?.includeArchived ? items : items.filter((item) => !item.archived);
  const q = query.trim().toLowerCase();
  const contains = q ? candidates.filter((item) => item.name.toLowerCase().includes(q)) : [];
  const pool = contains.length > 0 ? contains : candidates;
  return pool.slice(0, MAX_SUGGESTIONS).map((item) => ({ id: item.id, label: optionLabel(item) }));
}

export function matchByName<T extends { name: string; archived?: boolean }>(
  items: T[],
  name: string,
  opts?: { includeArchived?: boolean },
): NameMatch<T> {
  const target = name.trim().toLowerCase();
  const matches = items.filter(
    (item) =>
      (opts?.includeArchived || !item.archived) &&
      item.name.trim().toLowerCase() === target,
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", entity: matches[0] };
  return { kind: "many", matches };
}

/**
 * Clockify entity ids are 24-hex Mongo ObjectIds. The planner habitually puts a
 * NAME (or an invoice number) in the id slot — the live loop showed
 * `GET /projects/AIASSIST_LOOP_P4` 400ing after the admin had already confirmed.
 * Anything that doesn't look like a real id must be resolved, never sent.
 */
export function looksLikeClockifyId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value.trim());
}

export type ResolveEntityResult<T> =
  | { ok: true; id: string; name?: string; entity?: T }
  | { ok: false; clarify: RiskyClarifyResult };

/** The archived filter the WorkspaceClient list methods accept. */
export type ArchivedFilter = { archived?: boolean };

/**
 * Fetch active + archived entities explicitly — the real list adapters default
 * to ACTIVE-ONLY on the wire, so an includeArchived resolution must ask for
 * both states. Deduped by id in case a backend ignores the filter.
 */
async function listBothArchivedStates<T extends { id: string }>(
  list: (filter?: ArchivedFilter) => Promise<ListResult<T>>,
): Promise<ListResult<T>> {
  const [active, archived] = await Promise.all([
    list({ archived: false }),
    list({ archived: true }),
  ]);
  const seen = new Set(active.rows.map((item) => item.id));
  return {
    rows: [...active.rows, ...archived.rows.filter((item) => !seen.has(item.id))],
    truncated: active.truncated || archived.truncated,
  };
}

function incompleteListClarify(
  query: string,
  opts: { noun: string; verb: string },
): RiskyClarifyResult {
  return {
    clarify: `Clockify returned an incomplete ${opts.noun} list, so I can't prove "${query}" is unique or absent. Provide the exact id or use a narrower filter before I ${opts.verb}.`,
  };
}

/**
 * Resolve a possibly-symbolic entity reference to a real id at PREVIEW time, so
 * an identity mistake becomes a clarify — never a confirmed-then-failed commit.
 *
 * - A 24-hex `id` is trusted as-is (no extra list call on the happy path).
 * - A non-hex `id` is checked against the listed ids first (fakes/tests use
 *   short ids), then treated as a name.
 * - A `name` resolves via {@link matchByName}; none/many stop and ask, with
 *   grounded "did you mean?" options.
 * - `includeArchived` lets destructive/archive/unarchive verbs target an
 *   ARCHIVED entity by name (live item 305: "delete <archived project>" could
 *   neither match nor suggest it). Create/normal-update resolution stays
 *   archived-excluding.
 * - `notFoundHint` appends a caller-specific sentence to the none-match
 *   clarifies ("Or should I create it first?") — copy stays byte-identical
 *   when absent.
 */
export async function resolveEntityRef<T extends { id: string; name: string; archived?: boolean }>(
  ref: { id?: string; name?: string },
  opts: {
    noun: string;
    verb: string;
    list: (filter?: ArchivedFilter) => Promise<ListResult<T>>;
    includeArchived?: boolean;
    notFoundHint?: string;
    /**
     * Force a list lookup even for a 24-hex `id` (the happy path trusts it
     * blind). Use where the PREVIEW must show the entity's REAL name, not the
     * model-supplied one (e.g. billing rate cards), or where a wrong id must
     * clarify rather than 404 at commit — mirrors resolveUserRef's verifyIds.
     */
    verifyId?: boolean;
  },
): Promise<ResolveEntityResult<T>> {
  const rawId = ref.id?.trim();
  const isHexId = !!rawId && looksLikeClockifyId(rawId);
  if (isHexId && !opts.verifyId) return { ok: true, id: rawId as string, name: ref.name };
  const query = (ref.name ?? rawId ?? "").trim();
  const includeArchived = opts.includeArchived === true;
  // "a"/"an" by the noun's leading sound, and the "active " qualifier the
  // non-includeArchived clarifies carry — hoisted so the 4 clarify sites can't
  // drift apart (resolve-entity.test.ts pins the exact strings).
  const article = (noun: string): string => (/^[aeiou]/i.test(noun) ? "an" : "a");
  const qualifier = includeArchived ? "" : "active ";
  const listed = includeArchived ? await listBothArchivedStates(opts.list) : await opts.list();
  const items = listed.rows;
  if (rawId) {
    const exact = items.find((item) => item.id === rawId);
    if (exact) return { ok: true, id: exact.id, name: exact.name, entity: exact };
    // A VERIFIED hex id that isn't in the list must clarify — never fall through
    // to matching a DIFFERENT entity by the (unverified) model-supplied name.
    if (isHexId && opts.verifyId) {
      if (listed.truncated) {
        return { ok: false, clarify: incompleteListClarify(rawId, opts) };
      }
      return {
        ok: false,
        clarify: { clarify: `I couldn't find ${article(opts.noun)} ${opts.noun} with id ${rawId} to ${opts.verb}.` },
      };
    }
  }
  const match = matchByName(items, query, { includeArchived });
  if (match.kind === "one") {
    if (listed.truncated) {
      return { ok: false, clarify: incompleteListClarify(query, opts) };
    }
    return { ok: true, id: match.entity.id, name: match.entity.name, entity: match.entity };
  }
  if (match.kind === "many") {
    return {
      ok: false,
      clarify: {
        clarify: `More than one ${qualifier}${opts.noun} is named "${query}". Which one should I ${opts.verb}?`,
        options: match.matches.map((m) => ({ id: m.id, label: optionLabel(m) })),
      },
    };
  }
  if (listed.truncated) {
    return { ok: false, clarify: incompleteListClarify(query, opts) };
  }
  const options = suggestOptions(items, query, { includeArchived });
  // KEEP the none-match combined "an active" form (not "a active") when active-only.
  const noneArticle = includeArchived ? article(opts.noun) : "an active";
  const base = options.length
    ? `I couldn't find ${noneArticle} ${opts.noun} named "${query}". Did you mean one of these?`
    : `There is no ${qualifier}${opts.noun} named "${query}" to ${opts.verb}.`;
  return {
    ok: false,
    clarify: {
      clarify: opts.notFoundHint ? `${base} ${opts.notFoundHint}` : base,
      options: options.length ? options : undefined,
    },
  };
}

/**
 * Resolve the OPTIONAL project/task slot pair every entry-shaped action carries
 * (expenses create/update, fix_entry, start_timer, log_work, entries_list) —
 * ONE copy of "a name in either slot resolves; a task needs its project". A
 * 24-hex id is trusted with zero list calls (the happy path stays free); a
 * symbolic ref resolves via {@link resolveEntityRef} with grounded clarifies.
 * Returns resolved names so previews can speak names, not ids. No refs ⇒
 * all-undefined passthrough.
 */
export async function resolveProjectTaskRefs(
  refs: { projectId?: string; projectName?: string; taskId?: string; taskName?: string },
  opts: {
    verb: string;
    listProjects: (filter?: ArchivedFilter) => Promise<ListResult<{ id: string; name: string; archived?: boolean }>>;
    listTasks: (projectId: string) => Promise<ListResult<{ id: string; name: string }>>;
    /** Appended to an unknown-project clarify ("Or should I create it first?"). */
    projectNotFoundHint?: string;
  },
): Promise<
  | { ok: true; projectId?: string; projectName?: string; taskId?: string; taskName?: string }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  let projectId: string | undefined;
  let projectName: string | undefined;
  if (refs.projectId?.trim() || refs.projectName?.trim()) {
    const project = await resolveEntityRef(
      { id: refs.projectId, name: refs.projectName },
      { noun: "project", verb: opts.verb, list: opts.listProjects, notFoundHint: opts.projectNotFoundHint },
    );
    if (!project.ok) return project;
    projectId = project.id;
    projectName = project.name;
  }

  let taskId: string | undefined;
  let taskName: string | undefined;
  const rawTaskId = refs.taskId?.trim();
  const taskIdIsResolved = !!rawTaskId && looksLikeClockifyId(rawTaskId);
  if (taskIdIsResolved) {
    // An already-resolved task id is trusted as-is — no project needed.
    taskId = rawTaskId;
    taskName = refs.taskName;
  } else if (rawTaskId || refs.taskName?.trim()) {
    const query = (refs.taskName ?? rawTaskId ?? "").trim();
    if (!projectId) {
      // The project-required clarify only applies to a SYMBOLIC task (a hex id
      // short-circuited above); a name/short id needs its project to resolve.
      return {
        ok: false,
        clarify: { clarify: `To ${opts.verb} task "${query}" I need the project. Which project is it in?` },
      };
    }
    const scopedProjectId = projectId;
    const task = await resolveEntityRef(
      { id: rawTaskId, name: refs.taskName },
      { noun: "task", verb: opts.verb, list: () => opts.listTasks(scopedProjectId) },
    );
    if (!task.ok) return task;
    taskId = task.id;
    taskName = task.name;
  }

  return { ok: true, projectId, projectName, taskId, taskName };
}

/**
 * The shared "Several <kind> match …, which one?" ambiguity clarify, used by
 * BOTH the LIST resolver and the single-{@link resolveUserRef} — extracted so the
 * exact copy + option shape can't drift between the two. `query` is the raw ref,
 * `verb` the caller's action phrase, `pluralNoun` the entity kind.
 */
function manyMatchClarify(
  matches: Array<{ id: string; name: string }>,
  opts: { query: string; verb: string; pluralNoun: string },
): RiskyClarifyResult {
  return {
    clarify: `Several ${opts.pluralNoun} match "${opts.query}". Which one should I ${opts.verb}?`,
    options: matches.map((m) => ({ id: m.id, label: m.name })),
  };
}

/**
 * The shared "<query> isn't <singularPhrase>, so I can't <verb> <pronoun>."
 * not-found clarify, with grounded "did you mean?" options — used by BOTH the
 * LIST resolver and the single-{@link resolveUserRef} so the copy stays in step.
 */
function notFoundClarify(
  options: ClarifyOption[],
  opts: { query: string; verb: string; singularPhrase: string; pronoun: string },
): RiskyClarifyResult {
  return {
    clarify: `"${opts.query}" isn't ${opts.singularPhrase}, so I can't ${opts.verb} ${opts.pronoun}.`,
    options,
  };
}

/**
 * Generic LIST resolver — id/exact-name (and an optional `special` token like
 * "me") → ids + display labels, with a grounded clarify on any ambiguous/unknown
 * entry (identity-mistake-is-a-clarify). Order is kept, duplicates collapse,
 * `labels[i]` pairs with `ids[i]`, and `list` is called at most once. The single
 * place this logic lives — `resolveUserRefs` and `resolveGroupRefs` are thin
 * wrappers, so users and groups can never drift apart.
 *
 * `trustIds`: when true a 24-hex value is taken as an id WITHOUT a list call (the
 * assignee happy path). When false even a 24-hex value is verified against the
 * real list — a wrong-typed id (a project id in a member slot) then clarifies
 * instead of hitting the wire (permission-affecting writes set this).
 */
async function resolveRefList(
  refs: string[],
  opts: {
    verb: string;
    /** Plural noun for the ambiguity clarify ("workspace users" / "user groups"). */
    pluralNoun: string;
    /** "a workspace member" / "a user group" — for the not-found clarify. */
    singularPhrase: string;
    /** "them" / "it" — pronoun closing the not-found clarify. */
    pronoun: string;
    list: () => Promise<ListResult<{ id: string; name: string }>>;
    special?: (ref: string) => { id: string; label: string } | undefined;
    trustIds?: boolean;
  },
): Promise<{ ok: true; ids: string[]; labels: string[] } | { ok: false; clarify: RiskyClarifyResult }> {
  const ids: string[] = [];
  const labels: string[] = [];
  const push = (id: string, label: string): void => {
    if (!ids.includes(id)) {
      ids.push(id);
      labels.push(label);
    }
  };
  let listed: ListResult<{ id: string; name: string }> | undefined;
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const special = opts.special?.(ref);
    if (special) {
      push(special.id, special.label);
      continue;
    }
    if (opts.trustIds && looksLikeClockifyId(ref)) {
      push(ref, ref);
      continue;
    }
    if (!listed) listed = await opts.list();
    const items = listed.rows;
    // A ref may still be a real id (short test id, or a verified 24-hex) before it is a name.
    const byId = items.find((x) => x.id === ref);
    if (byId) {
      push(byId.id, byId.name);
      continue;
    }
    const match = matchByName(items, ref);
    if (match.kind === "one") {
      if (listed.truncated) {
        return {
          ok: false,
          clarify: incompleteListClarify(ref, { noun: opts.pluralNoun, verb: opts.verb }),
        };
      }
      push(match.entity.id, match.entity.name);
      continue;
    }
    if (match.kind === "many") {
      return {
        ok: false,
        clarify: manyMatchClarify(match.matches, { query: ref, verb: opts.verb, pluralNoun: opts.pluralNoun }),
      };
    }
    if (listed.truncated) {
      return {
        ok: false,
        clarify: incompleteListClarify(ref, { noun: opts.pluralNoun, verb: opts.verb }),
      };
    }
    return {
      ok: false,
      clarify: notFoundClarify(suggestOptions(items, ref), {
        query: ref,
        verb: opts.verb,
        singularPhrase: opts.singularPhrase,
        pronoun: opts.pronoun,
      }),
    };
  }
  return { ok: true, ids, labels };
}

/**
 * Resolve a LIST of user references — ids, exact names, or "me" — to user ids with
 * display labels (task assignees, group adds). "me" is the admin (label "you").
 * See {@link resolveRefList}; `verifyIds` sets `trustIds: false` so a 24-hex value
 * is verified rather than blindly trusted (permission-affecting writes).
 */
export async function resolveUserRefs(
  refs: string[],
  opts: { verb: string; adminUserId: string; listUsers: () => Promise<ListResult<{ id: string; name: string }>>; verifyIds?: boolean },
): Promise<{ ok: true; userIds: string[]; labels: string[] } | { ok: false; clarify: RiskyClarifyResult }> {
  const r = await resolveRefList(refs, {
    verb: opts.verb,
    pluralNoun: "workspace users",
    singularPhrase: "a workspace member",
    pronoun: "them",
    list: opts.listUsers,
    special: (ref) => (ref.toLowerCase() === "me" ? { id: opts.adminUserId, label: "you" } : undefined),
    trustIds: !opts.verifyIds,
  });
  return r.ok ? { ok: true, userIds: r.ids, labels: r.labels } : r;
}

/**
 * Resolve a LIST of user-GROUP references — ids or exact names — to group ids with
 * display labels (holiday/policy scoping). No "me"; a 24-hex value is always
 * verified against the real groups (so a project/user id in a group slot
 * clarifies, never hits the wire). See {@link resolveRefList}.
 */
export async function resolveGroupRefs(
  refs: string[],
  opts: { verb: string; listGroups: () => Promise<ListResult<{ id: string; name: string }>> },
): Promise<{ ok: true; groupIds: string[]; labels: string[] } | { ok: false; clarify: RiskyClarifyResult }> {
  const r = await resolveRefList(refs, {
    verb: opts.verb,
    pluralNoun: "user groups",
    singularPhrase: "a user group",
    pronoun: "it",
    list: opts.listGroups,
    trustIds: false,
  });
  return r.ok ? { ok: true, groupIds: r.ids, labels: r.labels } : r;
}

/**
 * Resolve a LIST of TAG references — ids or exact names — to tag ids ("log 2h
 * with tag billable"). A 24-hex value is trusted without a list call (tags on
 * an entry aren't permission-affecting; a wrong id is a wire 400, caught
 * there); names/short ids resolve against the real tags with grounded
 * clarifies. See {@link resolveRefList}.
 */
export async function resolveTagRefs(
  refs: string[],
  opts: { verb: string; listTags: () => Promise<ListResult<{ id: string; name: string }>> },
): Promise<{ ok: true; tagIds: string[]; labels: string[] } | { ok: false; clarify: RiskyClarifyResult }> {
  const r = await resolveRefList(refs, {
    verb: opts.verb,
    pluralNoun: "workspace tags",
    singularPhrase: "a workspace tag",
    pronoun: "it",
    list: opts.listTags,
    trustIds: true,
  });
  return r.ok ? { ok: true, tagIds: r.ids, labels: r.labels } : r;
}

/**
 * Resolve ONE user reference — an id, an exact name, or "me" — to a `{ userId,
 * label }`, verifying it against the workspace user list so an identity mistake
 * (a name in the id slot, a 24-hex non-user) becomes a clarify at preview, never
 * a confirmed-then-failed commit. Shared by every action that targets a single
 * member (role grant, the per-project / workspace member rate, group add/remove)
 * so the resolution + grounded clarify live in ONE place. A name passed in the
 * `id` slot is matched by name after the exact-id lookup misses (the planner
 * routinely puts a NAME where an id belongs). `label` is "you" for the admin,
 * else the member's name — for a legible preview.
 *
 * `trustIds`: when true a 24-hex value is taken as the user id WITHOUT a list
 * call (read FILTERS — a wrong id there yields an empty list, not a damaging
 * write). Default false: even a 24-hex value is verified against the real
 * users, so a wrong-typed id clarifies instead of hitting the wire
 * (permission/assignment-affecting writes).
 */
export async function resolveUserRef(
  ref: { id?: string; name?: string },
  opts: {
    verb: string;
    adminUserId: string;
    listUsers: () => Promise<ListResult<{ id: string; name: string }>>;
    trustIds?: boolean;
  },
): Promise<{ ok: true; userId: string; label: string } | { ok: false; clarify: RiskyClarifyResult }> {
  if ((ref.id ?? ref.name ?? "").trim().toLowerCase() === "me") {
    return { ok: true, userId: opts.adminUserId, label: "you" };
  }
  const rawId = ref.id?.trim();
  if (opts.trustIds && rawId && looksLikeClockifyId(rawId)) {
    return { ok: true, userId: rawId, label: ref.name ?? rawId };
  }
  const listed = await opts.listUsers();
  const users = listed.rows;
  let user = ref.id ? users.find((u) => u.id === ref.id) : undefined;
  if (!user) {
    // A name may have been passed in EITHER slot — match it after the id lookup.
    const query = (ref.name ?? ref.id ?? "").trim();
    if (query) {
      const match = matchByName(users, query);
      if (match.kind === "many") {
        return {
          ok: false,
          clarify: manyMatchClarify(match.matches, { query, verb: opts.verb, pluralNoun: "workspace users" }),
        };
      }
      if (match.kind === "one") user = match.entity;
      if (match.kind === "one" && listed.truncated) {
        return {
          ok: false,
          clarify: incompleteListClarify(query, { noun: "workspace users", verb: opts.verb }),
        };
      }
    }
  }
  if (!user) {
    const target = (ref.name ?? ref.id ?? "").trim();
    if (listed.truncated) {
      return {
        ok: false,
        clarify: incompleteListClarify(target, { noun: "workspace users", verb: opts.verb }),
      };
    }
    return {
      ok: false,
      clarify: notFoundClarify(suggestOptions(users, target), {
        query: target,
        verb: opts.verb,
        singularPhrase: "a workspace member",
        pronoun: "them",
      }),
    };
  }
  return { ok: true, userId: user.id, label: user.name };
}

/** Common options for {@link resolveUserFilter}; `defaultTo` is split out by the overloads. */
interface UserFilterOptsBase {
  verb: string;
  adminUserId: string;
  listUsers: () => Promise<ListResult<{ id: string; name: string }>>;
}

/**
 * Resolve an OPTIONAL `userId` READ-FILTER slot — id, exact name, or 'me'. When
 * the slot is empty the caller's stated default applies (`defaultTo`, usually
 * the admin; `undefined` = unfiltered). Built on {@link resolveUserRef} with
 * `trustIds` — a wrong id on a read yields an empty list, not a damaging
 * write, so the 24-hex happy path stays list-free. ONE copy for every read
 * that filters by user (entries list, review day/week, scheduling, time off).
 *
 * Overloaded so a caller that passes a `defaultTo: string` gets a NARROWED
 * `userId: string` (the empty slot can't yield `undefined`), letting consumers
 * drop the `as string` cast; without `defaultTo` the slot may stay unfiltered,
 * so `userId` is `string | undefined`. The runtime body is unchanged — it
 * already returns `opts.defaultTo` for the empty slot.
 */
export async function resolveUserFilter(
  userId: string | undefined,
  opts: UserFilterOptsBase & { defaultTo: string },
): Promise<{ ok: true; userId: string } | { ok: false; clarify: RiskyClarifyResult }>;
export async function resolveUserFilter(
  userId: string | undefined,
  opts: UserFilterOptsBase & { defaultTo?: undefined },
): Promise<{ ok: true; userId: string | undefined } | { ok: false; clarify: RiskyClarifyResult }>;
export async function resolveUserFilter(
  userId: string | undefined,
  opts: UserFilterOptsBase & { defaultTo?: string },
): Promise<{ ok: true; userId: string | undefined } | { ok: false; clarify: RiskyClarifyResult }> {
  if (!userId?.trim()) return { ok: true, userId: opts.defaultTo };
  const user = await resolveUserRef(
    { id: userId },
    { verb: opts.verb, adminUserId: opts.adminUserId, listUsers: opts.listUsers, trustIds: true },
  );
  return user.ok ? { ok: true, userId: user.userId } : user;
}

/**
 * Resolve a scope's `userIds` (ids/names/'me') and `userGroupIds` (ids/names) to
 * real ids at PREVIEW for holidays AND time-off policies — the ONE copy of the
 * "verify both lists or clarify" scope resolution so the two callers can't drift
 * apart. Each list is verified against the real users/groups (`verifyIds: true`)
 * so a name never reaches the wire (it would 400 / silently mis-scope). Returns
 * the resolved ids (each `undefined` when its slot was empty) + display labels,
 * or a `clarify` to surface directly. `verb` parameterizes the copy ("scope the
 * policy to" / "assign the holiday to").
 */
export async function resolveScopeRefs(
  ctx: ActionContext,
  args: { userIds?: string[]; userGroupIds?: string[] },
  opts: { verb: string },
): Promise<
  | { ok: true; userIds?: string[]; userGroupIds?: string[]; labels: string[] }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  const labels: string[] = [];
  let userIds: string[] | undefined;
  let userGroupIds: string[] | undefined;
  if (args.userIds?.length) {
    const r = await resolveUserRefs(args.userIds, {
      verb: opts.verb,
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      verifyIds: true,
    });
    if (!r.ok) return r;
    userIds = r.userIds;
    labels.push(...r.labels);
  }
  if (args.userGroupIds?.length) {
    const r = await resolveGroupRefs(args.userGroupIds, { verb: opts.verb, listGroups: () => ctx.clockify.listGroups() });
    if (!r.ok) return r;
    userGroupIds = r.groupIds;
    labels.push(...r.labels);
  }
  return { ok: true, userIds, userGroupIds, labels };
}

// The DATE family (resolveRelativeDay / resolvePeriod / resolveInstant /
// resolveDateRange + REPORT_PERIODS / ReportPeriod) now lives in resolve-dates.js
// and the risky-update PREVIEW renderer (describePatch) in preview-patch.js — both
// re-exported here so every `import { … } from "./resolve.js"` keeps working.
export {
  resolveRelativeDay,
  resolvePeriod,
  resolveInstant,
  resolveDateRange,
  zonedDayTimeInstant,
  REPORT_PERIODS,
} from "./resolve-dates.js";
export type { ReportPeriod } from "./resolve-dates.js";
export { describePatch } from "./preview-patch.js";
