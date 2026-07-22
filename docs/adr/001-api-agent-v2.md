# ADR 001: Atomic API Agent v2 Architecture

- Status: Accepted architecture; implementation not started by this ADR
- Date: 2026-07-22
- Scope: Assistant-layer replacement only

## Context and decision

The assistant will be replaced by a provider-independent runner that discovers a
bounded set of atomic, API-shaped Clockify tools, executes reads immediately, and
turns every model-originated write into an exact durable preview that only a
button-confirmation path can execute. The existing deterministic Clockify safety
and control plane remains authoritative.

This ADR records the target contract. It does **not** claim that v2 runtime code,
v2 release evidence, a deployment, a live probe, or a cutover exists.

## Coexistence, cutover, rollback, and retirement

- Keep the TypeScript modular monolith, Node.js 22, Express, vanilla
  TypeScript/Vite UI, SQLite through the existing store, Zod, Vitest, Playwright,
  the existing REST adapter, request governor, installation and role barriers,
  policy and confirmation gates, mutation journal, target snapshots,
  idempotency, ambiguity handling, reconciliation, backup/restore, and
  single-instance deployment.
- Build v2 beside v1 under `src/assistant-v2/`. The sole rewrite switch is
  `ASSISTANT_ENGINE=v1|v2`, selected once at the top-level composition seam, and
  it defaults to `v1` until an explicitly authorized Task 18 cutover.
- Preserve byte-for-byte v1 behavior through Task 18 unless a canonical task
  explicitly changes a shared contract. During coexistence, v1 accepts only
  critical safety, production, and verified Clockify-contract fixes.
- Cut over private production only to a fresh, previously unused database path,
  after full parity and the required local, CI, live, backup/restore, and owner
  authorization gates. Do not migrate the v1 production database into v2.
- Retain v1 and its rollback artifacts for one finite, predeclared rollback
  window. The window is not open-ended and does not authorize mixed v1/v2 state.
- Delete v1 only after that rollback window and explicit owner signoff. Then
  mechanically move the surviving v2 modules from `src/assistant-v2/` into the
  final `src/assistant/` layout; do not combine that move with semantic changes.

## Model-tool boundary

- Do not expose the complete API catalog to any v2 model call. The discovery
  meta-tool is always available; at most 12 API tools may be loaded.
- Every model-visible Clockify tool maps to one logical Clockify API operation.
  Every model-visible write has at most one primary mutation request.
  Pagination, name-to-ID resolution, permission checks, target verification, and
  post-dispatch reconciliation are support work, not extra primary mutations.
- Composite, generic, local, internal-support, and unavailable actions are not
  model API tools. Local permissions, recent activity, and deterministic undo
  remain explicit UI/route/service operations. The sole always-available
  non-Clockify model tool is discovery.
- Every model-originated write is preview-only until a human presses a button.
  Typed chat text, including `yes`, never confirms.

## Normative end-state contracts

The contracts below are the exact target contracts. Their presence here does not
assert that their files or implementations exist yet.

### API operation metadata

Create `src/harness/api-operation.ts` and use this cross-boundary contract:

```ts
export type ApiHost = "api" | "reports" | "audit";
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiAccess = "read" | "write";
export type ApiExposure = "api" | "composite" | "generic" | "local";

export interface ApiOperationMetadata {
  operationId: string;
  host: ApiHost;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  exposure: ApiExposure;
}

export type AuthClass = "addon" | "api_key";
export type AvailabilityReason =
  | "unsupported_auth_class"
  | "unavailable_endpoint"
  | "official_operation_id_missing";

export interface AdapterEndpointBinding {
  primary: readonly string[];
  support: readonly string[];
}

export interface BoundedDictionaryMetadata {
  path: string; // reviewed RFC 6901 pointer
  keyPattern: string; // anchored, reviewed regex source
  maxKeyUtf8Bytes: number;
  maxEntries: number;
  valueSchemaFingerprint: string;
}

export type MaterialFieldMetadata =
  | {
      kind: "value";
      path: string; // reviewed RFC 6901 pointer into normalized operation data
      label: string;
      formatterId: string;
      formatterVersion: number;
      requiredInPreview: boolean;
    }
  | {
      kind: "array_item";
      containerPath: string; // reviewed RFC 6901 pointer to the bounded array
      itemPath: string; // "" for the item, otherwise RFC 6901 pointer relative to it
      labelTemplate: string; // contains exactly one literal {index}
      maxItems: number; // equals the strict schema's finite array maximum
      formatterId: string;
      formatterVersion: number;
      requiredInPreview: boolean;
    }
  | {
      kind: "dictionary_entry";
      containerPath: string; // pointer also named by BoundedDictionaryMetadata.path
      valuePath: string; // "" for the value, otherwise RFC 6901 pointer relative to it
      labelTemplate: string; // contains exactly one literal {key}
      maxEntries: number; // equals BoundedDictionaryMetadata.maxEntries
      formatterId: string;
      formatterVersion: number;
      requiredInPreview: boolean;
    };

export interface ActionPresentationMetadata {
  presenterId: string; // stable reviewed registry key
  version: number; // positive integer; bump on semantic presentation changes
}
```

Add these required classification fields plus
`apiOperation?: ApiOperationMetadata` to `ActionDefinitionBase` in
`src/harness/action.ts`:

```ts
apiExposure: ApiExposure;
apiExposureReason?: string;
apiOperation?: ApiOperationMetadata;
adapterEndpoints?: AdapterEndpointBinding;
boundedArgumentDictionaries?: readonly BoundedDictionaryMetadata[];
materialFields?: readonly MaterialFieldMetadata[];
presentation?: ActionPresentationMetadata;
```

For `apiExposure === "api"`, `apiOperation`, `adapterEndpoints`, and
`presentation` are required, `adapterEndpoints.primary` has exactly one canonical
operation endpoint, `apiOperation.exposure` must be `api`, and
`apiExposureReason` must be absent. Task 4 registers only the stable presenter
identity/version; Tasks 11 and 15 bind the reviewed implementation to that exact
identity and fail startup if it is absent or duplicated. For
`composite|generic`, `apiOperation` is absent, the nonempty reason is required,
and reviewed `adapterEndpoints` is allowed/required whenever the action calls
Clockify so inventory can identify every primary/support consumer; multiple
primary keys prove why it is not atomic. For `local`, both API operation and
endpoint bindings are absent unless the local action performs a reviewed internal
Clockify support read, in which case bindings are inventory-only. Never invent an
operation ID for a non-API action. The reviewed endpoint keys come from the raw
extractor, distinguish primary from support calls, and are fingerprinted. Include
classification/reason, endpoint bindings, availability maps, presentation
metadata, and every operation field in action fingerprints and registry/catalog
hashes. Method + normalized path is the stable endpoint identity; `operationId`
must be copied from the official spec. If the official operation lacks a stable
operation ID, keep it internal/unavailable with reason
`official_operation_id_missing` and open an upstream spec-truth task; do not
invent a fallback.

Every model-visible write schema is recursively closed
(`additionalProperties:false`) and has no legacy `argumentOpenPaths`. The only
exception is an official API dictionary documented by
`boundedArgumentDictionaries`: exact pointer, anchored key pattern, finite entry
cap, strict value schema/fingerprint, recursive preview/provenance, and
write-authority coverage are all required and hashed. Every model-visible write
also has a nonempty reviewed `materialFields` declaration. Expansion is
mechanical: `value` yields its literal pointer; `array_item` yields
`containerPath + "/" + zero-based-index + itemPath` in numeric index order;
`dictionary_entry` yields
`containerPath + "/" + escapeRfc6901(key) + valuePath` after
`Object.keys(dictionary).sort()` (the repository's canonical-JSON UTF-16
code-unit order). `escapeRfc6901` replaces `~` with `~0` and then `/` with `~1`.
`itemPath`/`valuePath` is empty or begins with `/`. Labels substitute the one
required placeholder and are then UTF-8 bounded. Each expanded pointer is a JSON
scalar and uses its exact registered `formatterId/version`; object/array material
values are rejected until their leaves are declared. A container-only declaration
cannot hide nested values. The static worst-case expansion sum (`1`, `maxItems`,
or `maxEntries` for each metadata row) must be at most 22; the remaining two of
the 24 public fact slots are reserved for the endpoint and reversibility facts. A
larger operation is not model-visible until its strict API schema is safely
narrowed/split. Every resolved target/default must map to one of those material
pointers and be formatted in that fact; it does not consume a hidden extra fact.
Include ordered material-field/formatter metadata in action fingerprints, the
inventory report, and registry/catalog hashes. The model catalog gate rejects an
unannotated `z.record`, `z.unknown`, catch-all object, open JSON Schema node, open
authority path, a metadata/schema maximum mismatch, missing/mismatched formatter
registration, a worst-case fact count over 22, or a write without complete
material-field metadata. Prefer explicit operation fields; existing generic
`fields` spreads remain v1-internal.

For every dictionary material field, catalog validation must prove the worst-case
substituted label is at most 128 UTF-8 bytes from the literal template plus
`maxKeyUtf8Bytes`; array labels use the strict maximum decimal index. Missing
key-byte bounds or larger labels fail catalog creation. Hash `maxKeyUtf8Bytes`
with the other dictionary constraints.

### Catalog surfaces

`src/harness/api-catalog.ts` must export catalog-scoped registries so v1 and v2
definitions with the same action name cannot collide:

```ts
export interface ActionRegistry {
  id: "v1-internal" | "v2-api" | "v2-local";
  actions: readonly ActionDefinition[];
  get(name: string): ActionDefinition | undefined;
  fingerprint(name: string): string | undefined;
  availability(name: string, authClass: AuthClass): { available: boolean; reason?: AvailabilityReason };
  hash(): string;
}

export const INTERNAL_ACTION_CATALOG: ActionRegistry;
export const MODEL_API_ACTION_CATALOG: ActionRegistry;
export const LOCAL_ASSISTANT_ACTIONS: ActionRegistry;
```

- `INTERNAL_ACTION_CATALOG` keeps all v1 actions during coexistence.
- `MODEL_API_ACTION_CATALOG.actions` contains only `apiExposure === "api"`
  definitions with exact `apiOperation` metadata that pass the generated
  atomicity and availability gates.
- `LOCAL_ASSISTANT_ACTIONS` is the v2 local-only view for permissions, recent
  activity, and the deterministic `assistant_undo` route contract. During
  coexistence equivalent definitions/behavior intentionally also exist in
  `INTERNAL_ACTION_CATALOG` because v1 still needs them; only the v2 model-API and
  v2 local surfaces are disjoint. V2 handles local actions through explicit
  UI/routes/services and never sends them as model tools. The only
  always-available non-Clockify model tool is discovery.
- `ActionRegistry.hash()` includes ordered action fingerprints **and** each
  action's complete generated `availabilityByAuthClass` map/reason codes. A
  changed availability decision invalidates cache, pending preview, confirmation
  compatibility, and replay even when the Zod/action function is unchanged.
- No model tool helper may default to or resolve through global registry state.
  The signatures are `catalogForModel(registry, names?)` and
  `toolsForModel(registry, names?)`; an action-name set without its exact
  `ActionRegistry` is never sufficient.

### Discovery meta-tool

```ts
export interface FindApiOperationsInput {
  query: string;
  access?: "read" | "write" | "any";
  groups?: FeatureGroup[];
  limit?: number;
}

export interface ApiOperationDescriptor {
  toolName: string;
  operationId: string;
  host: ApiHost;
  method: ApiMethod;
  path: string;
  description: string;
  requiredArguments: string[];
  access: ApiAccess;
  risks: readonly RiskLabel[];
}

export type ApiSearchResult =
  | {
      kind: "matches";
      query: string;
      access: "read" | "write" | "any";
      operations: ApiOperationDescriptor[]; // ranked, unique, at most requested limit
    }
  | {
      kind: "notice";
      code: "no_available_operation_for_auth_class";
      authClass: AuthClass;
    };
```

The sole meta-tool name is `assistant_find_api_operations`. Its schema uses
strict Zod objects, trims `query`, caps it at the explicit
`API_SEARCH_QUERY_MAX_CHARS = 256`, constrains `limit` to `1..12`, and defaults
access to `any` and limit to `12`. Generated metadata stores
`availabilityByAuthClass: Record<AuthClass, {available:boolean; reason?:AvailabilityReason}>`.
Discovery filters unavailable operations before scoring and never returns their
tool name/schema/descriptor to the model. When filtering removes every match,
return a non-callable notice
`{code:"no_available_operation_for_auth_class", authClass}`; detailed unavailable
rows remain only in the inventory and development/operator diagnostics.

### Runner limits

Create `src/assistant-v2/budgets.ts`; hard-code and test the initial safety
ceilings rather than adding environment flags:

```ts
export const V2_LIMITS = Object.freeze({
  maxModelCalls: 6,
  maxDiscoveryCalls: 2,
  maxLoadedApiTools: 12,
  maxApiCalls: 12,
  maxConcurrentReads: 4,
  maxActiveWriteBatches: 1,
  maxHostCalls: 60,
  maxWallClockMs: 300_000,
  maxTotalTokens: 64_000,
  maxOutputTokensPerCall: 8_192,
});
```

Extract and continue using the repository's exact
`TOOL_RESULT_MAX_BYTES = 24_000` ceiling and `capToolResultForModel` behavior; do
not create a second byte-limit constant. Sum provider-reported prompt/completion
tokens. If a provider omits usage, charge **one estimated token per UTF-8 byte**
for the complete serialized request (messages plus tool schemas) and response.
This deliberately overcounts instead of assuming ordinary tokenization; never
treat missing usage as zero.

```ts
export type RunPhase =
  | "model"
  | "discovering"
  | "executing_reads"
  | "preparing_writes"
  | "awaiting_confirmation"
  | "awaiting_clarification"
  | "completed"
  | "failed";
```

`RunPhase.awaiting_clarification` is required. Durable exact-choice suspension
must never be encoded as `model` or `failed`.

Persist original admin request, current phase, exact loaded and used tool names,
catalog hash, action-result links, pending operation/batch IDs, server-derived
unfinished-operation records, and consumed budgets. Never persist provider
reasoning, hidden messages, an unresolved tool-call transcript, or model-authored
claims about which natural-language clauses are complete.

### Action origin and preview rule

```ts
export type ActionOrigin =
  | "assistant"
  | "direct_ui"
  | "system"
  | "live_test";
```

For `origin === "assistant"`, every non-read definition must prepare a durable
exact operation and return `pending_confirmation`. Immediate safe-write execution
remains temporarily available only to explicitly trusted non-model callers. Do
not infer origin; pass it explicitly from each entry point and reject an absent
origin.

### Durable run events

Use these exact event names:

```text
run.started
model.started
model.completed
api.search_started
api.operations_loaded
tool.requested
tool.denied
tool.started
tool.completed
operation.prepared
operation.confirmed
operation.started
operation.completed
clarification.required
run.suspended
run.completed
run.failed
```

Every server event has `runId`, a positive monotonic `sequence`, `eventType`, a
bounded/sanitized payload, and timestamp. Durable events reference
`actionResultId`/operation IDs; they never duplicate full results, secrets,
tokens, headers, confirmation nonces, nonce hashes, or executable operation
payloads.

### Generic references and clarifications

```ts
export interface EntityReference {
  id: string;
  conversationId: string; // exactly the current chat sessionId; not a second scope
  entityType: string;
  externalId: string;
  displayName: string;
  sourceRunId: string;
  bindings: Readonly<Record<string, string>>;
  status: "active" | "stale" | "deleted";
  verifiedAt: string;
}
```

Relevant atomic actions may accept one optional `referenceId`. The server
resolves it under the same workspace/admin/session
(`conversationId === sessionId`), rejects a simultaneous conflicting explicit
target, injects only the reviewed bindings, removes `referenceId`, then invokes
the action's strict Zod/harness path. A write revalidates every injected
target/scope immediately before preparation. A task reference can therefore bind
both the task ID and its authoritative project scope without inventing
entity-specific route logic.

Clarification chips call:

```text
POST /api/clarifications/:id/resolve
Content-Type: application/json

{"optionId":"019f0000-0000-7000-8000-000000000001"}
```

The label is display-only and never reinterpreted as authority. A free-text
continuation remains an ordinary chat body but must carry the exact
`continuationRunId`; the UI gets that ID from durable history/run state. The
server must never guess the latest clarification across runs.

### Authoritative presentation

Put the wire contract in `src/shared/contracts.ts`:

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface PresentedResult {
  status:
    | "succeeded"
    | "failed"
    | "partial"
    | "pending_confirmation"
    | "cancelled"
    | "outcome_unknown";
  title: string;
  summary: string;
  facts: Array<{ label: string; value: string }>;
  warnings: Array<{ code: string; message: string }>;
  references: EntityReference[];
  recovery?:
    | { kind: "view_operation"; label: string; operationId: string }
    | { kind: "retry_read"; label: string; readAttemptId: string }
    | { kind: "start_new_chat"; label: string };
}

export interface DiagnosticView {
  kind: "sanitized_receipt";
  byteLength: number;
  value: JsonValue;
}

export interface PresentedResultEnvelope {
  presentation: PresentedResult;
  actionResultId?: string;
  confirmation?: {
    id: string;
    nonce: string;
    expiresAt: string;
  };
  undo?: { id: string };
  diagnostic?: DiagnosticView;
}
```

Task 9 creates this closed shared wire type because event attachments need it;
Task 15 fills the complete presenter registry and strict UI codec without
changing the shape. Write cards, previews, partial results, and unknown outcomes
are generated deterministically from stored operation/result state. Model prose
may summarize reads only. Raw receipt JSON remains available only in the existing
sanitized diagnostic disclosure.

## Final ownership map after Task 19

```text
src/
  assistant/
    runner.ts                 one native-tool orchestration loop
    state.ts                  provider-independent durable state contracts
    budgets.ts                fixed run ceilings/accounting
    events.ts                 event types and sanitized views
    protocol.ts               run scope/dependencies/outcome contracts
    prompt.ts                 smalltalk/discovery/atomic-operation rules
    tool-results.ts           one 24,000-byte model-result cap
    discovery/
      api-index.ts            immutable trusted operation index
      api-search.ts           generic token/trigram scoring
      api-search-tool.ts      assistant_find_api_operations schema/handler
    model/
      client.ts               provider-independent interface
      openai-compatible.ts    native-tool HTTP implementation
      protocol.ts             messages, tools, usage, protocol errors
    context/
      entity-references.ts    typed scoped reference resolution
      clarifications.ts       durable exact-option continuation
    presentation/
      presented-result.ts     structured result contracts/helpers
      presenter-registry.ts   complete deterministic presenter registry
  services/
    run-service.ts
    api-discovery-service.ts
    action-execution-service.ts
    operation-preparation-service.ts
    confirmation-service.ts
    conversation-context-service.ts
    result-presentation-service.ts
    run-event-service.ts
    run-event-view-service.ts
    session-context-service.ts
    history-service.ts
    permissions-service.ts
    artifact-service.ts
    undo-service.ts
    metrics-service.ts
  harness/
    action.ts
    actions.ts
    api-operation.ts
    api-catalog.ts
    api-catalog.generated.ts
    confirmations.ts
    receipts.ts
    permissions.ts
    mutation-workflow.ts
    workflows/               atomic API actions and internal support only
  routes/
    api.ts                    router composition only
    me.ts
    chat.ts
    runs.ts
    confirmations.ts
    clarifications.ts
    history.ts
    permissions.ts
    artifacts.ts
    undo.ts
    metrics.ts
  metrics/
    run-metrics.ts            the single event-derived metric definitions
  db/
    schema.ts
    store.ts
    store/
      runs.ts
      run-events.ts
      references.ts
      clarifications.ts
      confirmation-batches.ts
      confirmations.ts
      operation-runs.ts
      action-results.ts
  ui/
    main.ts
    api-client.ts
    protocol.ts
    composer-flow.ts
    render.ts
    shared.ts
```

There is no final `src/assistant-v2/`, `src/harness/api-actions/`, legacy planner,
intent-declaration runtime, generic model dispatcher, workflow model tool, or
lexical selector.

## Consequences

- V1 remains the only implemented/default runtime until later prompts add and
  authorize the single top-level seam.
- The v2 model surface stays small, atomic, provider-independent, and unable to
  dispatch writes.
- Existing control-plane invariants are reused rather than reimplemented inside
  the runner or REST adapter.
- Cutover and retirement are explicit owner-controlled transitions, not side
  effects of landing v2 code.
