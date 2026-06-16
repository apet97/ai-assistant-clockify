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

// Relevance weights. A match on an action NAME or a group SYNONYM is a strong signal;
// a match in a DESCRIPTION is weak (descriptions cross-reference other areas — e.g.
// invoice/expense actions MENTION "project"). Weighting + COUNTING per-action (below)
// is what stops a single shared description word from hijacking the routing.
const WEIGHT_NAME = 3;
const WEIGHT_SYNONYM = 3;
const WEIGHT_DESCRIPTION = 1;

/**
 * The GENERIC entity CRUD ops — they act by `entityType` + name/id across EVERY
 * area, so they're the safety net for a bare command with no lexical area signal
 * ("delete Beacon", "rename X to Y") that would otherwise route to nothing. Without
 * them in the core, the matrix showed "delete Beacon" stranded with no delete tool.
 */
const GENERIC_ENTITY_OPS = [
  "clockify_list_entities",
  "clockify_get_entity",
  "clockify_delete_entity",
  "clockify_update_entity",
  "clockify_create_work_package",
];

/**
 * The always-on core: the proven single-action intents (curated + the setup
 * composites), the generic entity CRUD ops (the no-lexical-signal safety net),
 * every assistant-meta action (recaps + the admin's own permission management), and
 * the timer status quick-read. Derived from the arrays + filtered against the real
 * catalog so it never drifts.
 */
export const CORE_ACTION_NAMES: Set<string> = new Set<string>(
  [
    ...CURATED_ACTIONS.map((a) => a.name),
    ...SETUP_PROJECT_ACTIONS.map((a) => a.name),
    ...SETUP_TASK_ACTIONS.map((a) => a.name),
    ...GENERIC_ENTITY_OPS,
    ...ACTION_CATALOG.filter((a) => a.name.startsWith("assistant_") || a.name === "clockify_status").map(
      (a) => a.name,
    ),
  ].filter((name) => ACTION_CATALOG.some((a) => a.name === name)),
);

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

interface CatalogIndex {
  /** group → tokens from the group name + its synonyms (a strong, group-level signal). */
  groupSyn: Map<string, Set<string>>;
  /** per-action token sets, kept SEPARATE so NAME matches can outweigh DESCRIPTION noise. */
  actions: { group: string; nameTokens: Set<string>; descTokens: Set<string> }[];
}

/** Build the relevance index: per-group synonyms + per-action name/description tokens. */
function buildIndex(catalog: SelectableAction[]): CatalogIndex {
  const groupSyn = new Map<string, Set<string>>();
  const actions: CatalogIndex["actions"] = [];
  for (const action of catalog) {
    if (!groupSyn.has(action.featureGroup)) {
      const set = new Set<string>();
      for (const t of tokenize(action.featureGroup.replace(/_/g, " "))) set.add(t);
      for (const syn of SYNONYMS[action.featureGroup] ?? []) for (const t of tokenize(syn)) set.add(t);
      groupSyn.set(action.featureGroup, set);
    }
    actions.push({
      group: action.featureGroup,
      nameTokens: tokenize(action.name.replace(/_/g, " ")),
      descTokens: tokenize(action.description),
    });
  }
  return { groupSyn, actions };
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
  // COUNT-based, weighted group scoring: a group wins by how many of ITS OWN actions
  // match by NAME (+ its synonyms), not by a single shared token — so "list my
  // projects" routes to work_structure (many projects_* actions) over invoices/
  // expenses (which only MENTION projects in descriptions). Without this, every group
  // tied at 1 and the alphabetical tiebreak sent the turn to the wrong area (matrix
  // finding: DeepSeek pro 100%→94% under subsetting, projects_list never shown).
  const score = new Map<string, number>();
  const bump = (group: string, points: number): void => {
    if (points) score.set(group, (score.get(group) ?? 0) + points);
  };
  for (const [group, synTokens] of index.groupSyn) {
    let hits = 0;
    for (const t of messageTokens) if (synTokens.has(t)) hits += 1;
    bump(group, hits * WEIGHT_SYNONYM);
  }
  for (const action of index.actions) {
    let nameHits = 0;
    let descHits = 0;
    for (const t of messageTokens) {
      if (action.nameTokens.has(t)) nameHits += 1;
      else if (action.descTokens.has(t)) descHits += 1;
    }
    bump(action.group, nameHits * WEIGHT_NAME + descHits * WEIGHT_DESCRIPTION);
  }
  // Highest score first; ties broken by group name so the result is deterministic.
  const selectedGroups = new Set(
    [...score.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxGroups)
      .map(([group]) => group),
  );

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
