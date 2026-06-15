/**
 * Deterministic tool subsetting (Phase 1 — the centerpiece for weak-model
 * consistency). A weak model handed all 139 tools (~66 KB of schema) every turn
 * scatters across plausible-but-wrong choices. This module shrinks that menu to
 * the handful of RELEVANT tools for the message — by lexical relevance over the
 * 13 feature groups, plus a small always-on CORE — so the model decides among
 * ~15–30 tools, not 139.
 *
 * Properties that matter:
 *   - DETERMINISTIC: same message → same tool set (no model call, no embeddings,
 *     no vector DB — honors the repo's "no vector DB" rule). Determinism is the
 *     point: a stable, smaller menu is a more consistent decision.
 *   - RECALL-SAFE: it selects whole GROUPS (never a partial area), unions in the
 *     always-on CORE (curated intents, setup composites, assistant-meta, status),
 *     and the caller keeps an escape hatch (retry with the full catalog) so a miss
 *     can never strand a turn.
 *   - The harness still validates + gates every proposed action: subsetting only
 *     changes what the model SEES, never what is allowed.
 *
 * Pure (the catalog + core are injectable for tests). Flag-gated by the caller.
 */
import { ACTION_CATALOG } from "./catalog.js";
import { CURATED_ACTIONS } from "./workflows/curated.js";
import { SETUP_PROJECT_ACTIONS } from "./workflows/setup-project.js";
import { SETUP_TASK_ACTIONS } from "./workflows/setup-task.js";

/** The minimal action metadata the selector reads (a slice of ActionDefinition). */
export interface SelectableAction {
  name: string;
  description: string;
  featureGroup: string;
}

export interface SelectOptions {
  /** Catalog to select from (default: the real ACTION_CATALOG). Injectable for tests. */
  catalog?: SelectableAction[];
  /** Names always included regardless of relevance (default: {@link CORE_ACTION_NAMES}). */
  alwaysInclude?: Set<string>;
  /** Max feature groups to surface beyond the core (default 3). */
  maxGroups?: number;
}

/** Default number of relevant feature groups to surface (tune against the matrix). */
export const DEFAULT_MAX_GROUPS = 3;

/**
 * The always-on core: the proven single-action intents (curated + the setup
 * composites), every assistant-meta action (recaps + the admin's own permission
 * management), and the timer status quick-read. Derived from the arrays so it
 * never drifts when the curated/meta sets change.
 */
export const CORE_ACTION_NAMES: Set<string> = new Set<string>([
  ...CURATED_ACTIONS.map((a) => a.name),
  ...SETUP_PROJECT_ACTIONS.map((a) => a.name),
  ...SETUP_TASK_ACTIONS.map((a) => a.name),
  ...ACTION_CATALOG.filter((a) => a.name.startsWith("assistant_") || a.name === "clockify_status").map(
    (a) => a.name,
  ),
]);

/**
 * Generic words that carry NO area signal — articles, pronouns, prepositions,
 * fillers, and the CRUD verbs that appear across every group (so "create"/"delete"
 * don't make every group match). The discriminative NOUNS are what route a turn.
 */
const STOPWORDS = new Set<string>(
  (
    "a an the this that these those my your our their his her its me you we us them i it" +
    " to for of on at by with from into onto about as and or but if then so do does did" +
    " can could would should will shall is are was were be been being have has had please" +
    " just now want wants need needs like let lets ok okay hey hi hello thanks thank" +
    " all any some what which who whom when where why how there here not no yes" +
    " create creates created make makes made add adds new list lists show shows see view" +
    " views display get gets fetch set sets update updates edit edits modify change changes" +
    " delete deletes remove removes give gives put clockify assistant"
  ).split(/\s+/),
);

/**
 * Per-group trigger words (recall booster). Lexical name/description matching alone
 * misses synonyms ("bill" → invoices, "track" → time tracking); this closes the gap
 * without embeddings. Keyed by the 13 feature groups.
 */
const SYNONYMS: Record<string, string[]> = {
  time_tracking: "timer time track tracking log hours hour clock stopwatch start stop running entry entries duration billable".split(
    " ",
  ),
  work_structure: "project projects task tasks subtask client clients tag tags label milestone".split(" "),
  reports: "report reports summary total totals breakdown weekly monthly analytics dashboard export".split(" "),
  invoices: "invoice invoices bill billing charge payment paid due receivable".split(" "),
  expenses: "expense expenses cost costs spend spending receipt reimburse reimbursement".split(" "),
  users_groups: "user users member members team teams group groups people staff invite onboard role roles deactivate seat".split(
    " ",
  ),
  time_off_approvals: "vacation pto leave absence holiday holidays balance policy policies timeoff".split(" "),
  scheduling: "schedule scheduling assignment assignments shift shifts roster capacity plan planning".split(" "),
  webhooks: "webhook webhooks hook hooks callback subscription".split(" "),
  workspace_settings: "workspace setting settings currency preference config".split(" "),
  custom_fields: "custom field fields attribute metadata".split(" "),
  approvals: "approval approvals approve approved timesheet timesheets submit resubmit reject".split(" "),
  audit_log: "audit log logs history activity changes trail".split(" "),
};

/** Crude singular fold so "invoices"/"hours"/"tags" match "invoice"/"hour"/"tag". */
function singular(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Lowercase → discriminative, singular-folded token set (stopwords + 1-char dropped). */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.add(singular(raw));
  }
  return out;
}

/** Build a `featureGroup → token set` index (names + descriptions + group + synonyms). */
function buildIndex(catalog: SelectableAction[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const action of catalog) {
    let set = index.get(action.featureGroup);
    if (!set) {
      set = new Set<string>();
      // The group's own name + its synonyms apply to every action in it.
      for (const t of tokenize(action.featureGroup.replace(/_/g, " "))) set.add(t);
      for (const syn of SYNONYMS[action.featureGroup] ?? []) for (const t of tokenize(syn)) set.add(t);
      index.set(action.featureGroup, set);
    }
    for (const t of tokenize(action.name.replace(/_/g, " "))) set.add(t);
    for (const t of tokenize(action.description)) set.add(t);
  }
  return index;
}

const DEFAULT_CATALOG: SelectableAction[] = ACTION_CATALOG.map((a) => ({
  name: a.name,
  description: a.description,
  featureGroup: a.featureGroup,
}));
const DEFAULT_INDEX = buildIndex(DEFAULT_CATALOG);

/**
 * Select the relevant action NAMES for a message: the always-on core plus the
 * actions of the top {@link SelectOptions.maxGroups} feature groups by lexical
 * relevance. Returns names in CATALOG ORDER (deterministic). When nothing matches
 * (smalltalk / gibberish), returns just the core — the model needs no domain tool.
 */
export function selectActionsForMessage(message: string, opts: SelectOptions = {}): string[] {
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const core = opts.alwaysInclude ?? CORE_ACTION_NAMES;
  const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;
  const index = catalog === DEFAULT_CATALOG ? DEFAULT_INDEX : buildIndex(catalog);

  const messageTokens = tokenize(message);
  const scored: { group: string; score: number }[] = [];
  for (const [group, groupTokens] of index) {
    let score = 0;
    for (const t of messageTokens) if (groupTokens.has(t)) score += 1;
    if (score > 0) scored.push({ group, score });
  }
  // Highest score first; ties broken by group name so the result is deterministic.
  scored.sort((a, b) => b.score - a.score || a.group.localeCompare(b.group));
  const selectedGroups = new Set(scored.slice(0, maxGroups).map((s) => s.group));

  const chosen = new Set<string>(core);
  for (const action of catalog) {
    if (selectedGroups.has(action.featureGroup)) chosen.add(action.name);
  }

  // Emit in catalog order, then any core names not in the catalog (none, in prod).
  const ordered: string[] = [];
  const emitted = new Set<string>();
  for (const action of catalog) {
    if (chosen.has(action.name) && !emitted.has(action.name)) {
      ordered.push(action.name);
      emitted.add(action.name);
    }
  }
  for (const name of chosen) {
    if (!emitted.has(name)) {
      ordered.push(name);
      emitted.add(name);
    }
  }
  return ordered;
}
