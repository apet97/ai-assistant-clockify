# Plan 009 — Stop the agentic loop when the client disconnects (cooperative cancellation)

> **Audience:** an executor model that follows steps literally. Do EXACTLY what
> each step says. After every step run the stated command and confirm the stated
> result before moving on. Do not improvise, do not refactor anything else, do
> not "improve" nearby code. If a step's result does not match, STOP and re-read
> the step.

---

## 0. Background (read once, then act)

The chat runs an **agentic loop**: the model is called, it may call tools, the
results are fed back, and it is called again — up to `DEFAULT_MAX_STEPS` (6)
model round-trips per turn (`src/assistant/agent-loop.ts`). Reads and *safe*
writes auto-chain inside the loop.

**The problem.** When the admin closes the embedded iframe (or a proxy times out)
**mid-turn**, the server keeps running the loop to completion against a dead
socket: more paid model calls, and more safe writes, for a turn nobody is
watching. There is no disconnect handling anywhere in `src/routes`.

**The fix.** Thread an `AbortSignal` from the two streaming HTTP routes into the
agent loop and check it at the loop's boundaries (before each model call and
before each tool execution). When the signal is aborted, the loop stops and
returns a new `aborted` outcome; the caller does nothing further. This stops all
*further* model calls and *further* writes once the client is gone.

**Explicitly OUT OF SCOPE (do NOT do these):**
- Do NOT abort the in-flight model `fetch` itself (the model client already has
  its own per-request timeout). We only stop *starting new* work.
- Do NOT touch the single-turn / JSON planner path (`planConversation`). Only the
  agentic path (`runAgentConversation` / `runAgentTurn`) and the resume path.
- Do NOT change `src/assistant/model-client.ts` or `src/assistant/usage.ts`.
- Do NOT change risk/policy/confirmation logic.

**Non-negotiables (will be checked):**
- `npm run verify` must be green at the end (type-check + 0 cycles + tests + build).
- New params are OPTIONAL (`signal?: AbortSignal`) so no existing caller breaks.
- One focused commit at the end.

## 1. Preconditions

Run:
```
cd /Users/15x/Downloads/WORKING/addons-me/ai-assistant-addon
git status --short          # MUST be empty (clean tree)
npm run verify              # MUST exit 0 (note the test count, call it N)
```
If the tree is not clean or verify is not green, STOP — do not start.

---

## 2. Step 1 — Add the `aborted` outcome + a failing unit test (RED)

**File:** `tests/integration/agentic-chat.test.ts` is NOT used here; create a new
unit test file.

**Create** `tests/unit/agent-loop-abort.test.ts` with EXACTLY this content:

```ts
import { describe, expect, it } from "vitest";
import { runAgentTurn } from "../../src/assistant/agent-loop.js";
import type { ModelClient, ToolCompletion } from "../../src/assistant/model-client.js";
import type { ActionResult } from "../../src/harness/action.js";

// A model that would keep calling a read tool forever (so the loop only stops
// when something else stops it — here, the abort signal).
function loopingModel(): { client: ModelClient; calls: () => number } {
  let calls = 0;
  const client: ModelClient = {
    async complete() {
      return "";
    },
    async completeWithTools(): Promise<ToolCompletion> {
      calls += 1;
      return { text: "", toolCalls: [{ id: `c${calls}`, name: "clockify_tags_list", arguments: {} }] };
    },
  };
  return { client, calls: () => calls };
}

const okRead: ActionResult = {
  kind: "receipt",
  receipt: { ok: true, action: "clockify_tags_list", entity: "tag", data: { tags: [] } },
};

describe("agent loop cooperative cancellation (client disconnect)", () => {
  it("returns kind:'aborted' and makes NO model call when the signal is already aborted", async () => {
    const { client, calls } = loopingModel();
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentTurn({
      modelClient: client,
      messages: [{ role: "user", content: "list tags forever" }],
      tools: [],
      runAction: async () => okRead,
      signal: controller.signal,
    });
    expect(result.kind).toBe("aborted");
    expect(calls()).toBe(0); // the loop never called the model
  });

  it("stops after the in-flight step when the signal aborts mid-turn (no runaway)", async () => {
    const { client, calls } = loopingModel();
    const controller = new AbortController();
    let actions = 0;
    const result = await runAgentTurn({
      modelClient: client,
      messages: [{ role: "user", content: "list tags forever" }],
      tools: [],
      runAction: async () => {
        actions += 1;
        controller.abort(); // the client disconnects during the first tool execution
        return okRead;
      },
      signal: controller.signal,
    });
    expect(result.kind).toBe("aborted");
    // Without the guard this model loops to DEFAULT_MAX_STEPS (6). With it, the
    // loop stops at the next boundary: at most one extra model call, far below 6.
    expect(calls()).toBeLessThan(3);
    expect(actions).toBe(1);
  });

  it("an unset signal is a no-op (the loop completes normally)", async () => {
    // A model that calls a tool once, then answers.
    let step = 0;
    const client: ModelClient = {
      async complete() {
        return "";
      },
      async completeWithTools(): Promise<ToolCompletion> {
        step += 1;
        return step === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "clockify_tags_list", arguments: {} }] }
          : { text: "Here are your tags.", toolCalls: [] };
      },
    };
    const result = await runAgentTurn({
      modelClient: client,
      messages: [{ role: "user", content: "list tags" }],
      tools: [],
      runAction: async () => okRead,
    });
    expect(result.kind).toBe("final");
  });
});
```

Run:
```
npx vitest run tests/unit/agent-loop-abort.test.ts
```
**Expected:** it FAILS to compile / run, because `runAgentTurn` does not yet
accept `signal` and never returns `kind:"aborted"`. That is correct (RED).

---

## 3. Step 2 — Implement the abort in `runAgentTurn` (GREEN)

**File:** `src/assistant/agent-loop.ts`

### 2a. Add the `aborted` variant to the result union.

FIND this block (around line 89):
```ts
export type AgentTurnResult =
  | { kind: "final"; text: string; transcript: ModelMessage[] }
  | { kind: "clarify"; message: string; options?: ClarifyOption[]; transcript: ModelMessage[] }
  | {
      kind: "interrupt";
      call: ToolCall;
      preview: PreviewCard;
      operation: ConfirmableOperation;
      transcript: ModelMessage[];
    }
  | { kind: "exhausted"; text: string; transcript: ModelMessage[] };
```
REPLACE it with (adds one line — the `aborted` variant):
```ts
export type AgentTurnResult =
  | { kind: "final"; text: string; transcript: ModelMessage[] }
  | { kind: "clarify"; message: string; options?: ClarifyOption[]; transcript: ModelMessage[] }
  | {
      kind: "interrupt";
      call: ToolCall;
      preview: PreviewCard;
      operation: ConfirmableOperation;
      transcript: ModelMessage[];
    }
  | { kind: "exhausted"; text: string; transcript: ModelMessage[] }
  // The client disconnected mid-turn (the route aborted the signal). The loop
  // stops at its next boundary so it issues no further model calls or writes for
  // a turn nobody is watching. The caller discards this (no reply is sent).
  | { kind: "aborted"; transcript: ModelMessage[] };
```

### 2b. Add the optional `signal` to the input.

FIND (around line 110):
```ts
  /** Streaming hook: fired once per executed read/safe-write step (not for the terminal preview). */
  onStep?: (step: AgentStep) => void;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
}
```
REPLACE with:
```ts
  /** Streaming hook: fired once per executed read/safe-write step (not for the terminal preview). */
  onStep?: (step: AgentStep) => void;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  /**
   * Cooperative cancellation. When this aborts (the route fires it on client
   * disconnect), the loop stops at its next boundary and returns `aborted` —
   * no further model calls, no further tool executions.
   */
  signal?: AbortSignal;
}
```

### 2c. Check the signal at the top of each step.

FIND (around line 143):
```ts
  for (let step = 0; step < maxSteps; step += 1) {
    const completion = await input.modelClient.completeWithTools(transcript, input.tools);
```
REPLACE with:
```ts
  for (let step = 0; step < maxSteps; step += 1) {
    // Client gone → stop BEFORE the next (paid) model call.
    if (input.signal?.aborted) return { kind: "aborted", transcript };
    const completion = await input.modelClient.completeWithTools(transcript, input.tools);
```

### 2d. Check the signal before each tool execution.

FIND (around line 158):
```ts
    for (const call of calls) {
      const result = await input.runAction(call);
      honored.push(call);
```
REPLACE with:
```ts
    for (const call of calls) {
      // Client gone → stop BEFORE running another action (e.g. a safe write).
      if (input.signal?.aborted) return { kind: "aborted", transcript };
      const result = await input.runAction(call);
      honored.push(call);
```

Run:
```
npx vitest run tests/unit/agent-loop-abort.test.ts
```
**Expected:** all 3 tests PASS (GREEN).

Run:
```
npm run type-check
```
**Expected:** it may now report errors in `src/routes/api.ts` about
`AgentTurnResult` / `turn.kind` not handling `"aborted"`. That is expected — Step
4 fixes them. If it reports errors ANYWHERE ELSE, STOP and re-read Step 2.

---

## 4. Step 3 — Thread `signal` through `runAgentConversation`

**File:** `src/assistant/planner.ts`

### 3a. Add `signal` to the Pick that builds `AgentConversationInput`.

FIND (around line 82):
```ts
export interface AgentConversationInput
  extends Pick<RunAgentTurnInput, "modelClient" | "messages" | "runAction" | "onStep" | "maxSteps"> {
```
REPLACE with (adds `"signal"` to the Pick):
```ts
export interface AgentConversationInput
  extends Pick<RunAgentTurnInput, "modelClient" | "messages" | "runAction" | "onStep" | "maxSteps" | "signal"> {
```

### 3b. Pass `signal` to `runAgentTurn`.

FIND (around line 106):
```ts
  return runAgentTurn({
    modelClient: input.modelClient,
    messages: [{ role: "system", content: system }, ...input.messages],
    tools: input.tools ?? toolsForModel(),
    runAction: input.runAction,
    onStep: input.onStep,
    maxSteps: input.maxSteps,
  });
```
REPLACE with:
```ts
  return runAgentTurn({
    modelClient: input.modelClient,
    messages: [{ role: "system", content: system }, ...input.messages],
    tools: input.tools ?? toolsForModel(),
    runAction: input.runAction,
    onStep: input.onStep,
    maxSteps: input.maxSteps,
    signal: input.signal,
  });
```

Run `npm run type-check`. Same expectation as before (only `api.ts` may error).

---

## 5. Step 4 — Wire the route → `executeChatTurn` / `runResume` → loop

**File:** `src/routes/api.ts`

### 4a. Handle the new `aborted` kind in `settleAgentTurn`.

FIND (around line 307):
```ts
    if (turn.kind === "clarify") return { replyKind: "clarify", baseText: "" };
    // "final" and "exhausted" both carry truthful text from the loop.
    return { replyKind: "answer", baseText: turn.text };
  }
```
REPLACE with:
```ts
    if (turn.kind === "clarify") return { replyKind: "clarify", baseText: "" };
    // The client disconnected mid-turn: no reply is sent (the socket is gone).
    if (turn.kind === "aborted") return { replyKind: "aborted", baseText: "" };
    // "final" and "exhausted" both carry truthful text from the loop.
    return { replyKind: "answer", baseText: turn.text };
  }
```

### 4b. Make `executeChatTurn` accept and pass a `signal`.

FIND (around line 775):
```ts
  async function executeChatTurn(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installation: Installation,
    message: string,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
  ): Promise<ChatTurnOutcome> {
```
REPLACE with (adds a trailing optional param):
```ts
  async function executeChatTurn(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installation: Installation,
    message: string,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
  ): Promise<ChatTurnOutcome> {
```

FIND (around line 881, inside the `if (deps.config.llmAgentic && ...)` branch):
```ts
        turn = await runAgentConversation({
          modelClient: tracked.client,
          messages,
          policy,
          authClass: m.ctx.clockify.authClass,
          // The server clock's date so the model narrates the real date instead
          // of its stale knowledge cutoff (finding new-3: "we're still in 2025").
          currentDate: now().toISOString().slice(0, 10),
          runAction: m.runAction,
          onStep: m.onStep,
        });
```
REPLACE with (adds `signal`):
```ts
        turn = await runAgentConversation({
          modelClient: tracked.client,
          messages,
          policy,
          authClass: m.ctx.clockify.authClass,
          // The server clock's date so the model narrates the real date instead
          // of its stale knowledge cutoff (finding new-3: "we're still in 2025").
          currentDate: now().toISOString().slice(0, 10),
          runAction: m.runAction,
          onStep: m.onStep,
          signal,
        });
```

### 4c. Make `runResume` accept and pass a `signal`.

FIND the `runResume` signature (around line 484):
```ts
  async function runResume(
```
Read the next ~8 lines to find its parameter list. It ends with two optional
callbacks `onResult?` and `onStatus?` (mirroring `executeChatTurn`). ADD a
trailing parameter `signal?: AbortSignal,` after the last existing parameter,
exactly as in 4b.

THEN find the `runAgentTurn({ ... })` call inside `runResume` (around line 517).
It passes `modelClient`, `messages`, `tools`, `runAction`, `onStep`, etc. ADD a
trailing property `signal,` to that object (same pattern as 3b).

Run `npm run type-check`. **Expected:** 0 errors now (all `aborted` paths handled).

### 4d. Wire the AbortController in the streaming chat route.

FIND (around line 1118):
```ts
  router.post("/chat/stream", asyncHandler(async (req, res) => {
    const pre = chatPreconditions(req, res);
    if (!pre) return;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
    const write = (event: unknown): void => {
      res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const turn = await executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        (result) => write({ type: "result", result }),
        (status) => write({ type: "status", ...status }),
      );
```
REPLACE with (adds the controller + close handler + passes the signal):
```ts
  router.post("/chat/stream", asyncHandler(async (req, res) => {
    const pre = chatPreconditions(req, res);
    if (!pre) return;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
    // Stop the agentic loop if the client (iframe/proxy) drops the connection
    // mid-turn — no further model calls or writes for a turn nobody is watching.
    // res.on("close") fires on a normal end too, but aborting after we've ended
    // is a harmless no-op (the turn already finished).
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    const write = (event: unknown): void => {
      res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const turn = await executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        (result) => write({ type: "result", result }),
        (status) => write({ type: "status", ...status }),
        ac.signal,
      );
```

### 4e. Wire the AbortController in the streaming confirm-resume route.

FIND (around line 1171, the `if (req.query.stream === "1") {` block inside
`/confirmations/:id/confirm`):
```ts
    if (req.query.stream === "1") {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      const write = (event: unknown): void => {
        res.write(`${JSON.stringify(event)}\n`);
      };
      write({ type: "receipt", receipt, ...(undoId ? { undo: { id: undoId } } : {}) });
      try {
        const resumed = await runResume(
          claims,
          installation,
          agentState,
          receipt,
          (result) => write({ type: "result", result }),
          (status) => write({ type: "status", ...status }),
        );
```
REPLACE with (adds the controller + passes the signal as the new trailing arg):
```ts
    if (req.query.stream === "1") {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      // Stop the resumed loop if the client drops mid-resume (see /chat/stream).
      const ac = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) ac.abort();
      });
      const write = (event: unknown): void => {
        res.write(`${JSON.stringify(event)}\n`);
      };
      write({ type: "receipt", receipt, ...(undoId ? { undo: { id: undoId } } : {}) });
      try {
        const resumed = await runResume(
          claims,
          installation,
          agentState,
          receipt,
          (result) => write({ type: "result", result }),
          (status) => write({ type: "status", ...status }),
          ac.signal,
        );
```

> NOTE on 4e: confirm the exact argument order of `runResume` matches what you
> set in 4c (the signal must be the LAST argument, after `onStatus`). If
> `runResume`'s parameters differ from the snippet, pass `ac.signal` as the final
> argument regardless.

Run `npm run type-check`. **Expected:** 0 errors.

---

## 6. Step 5 — Integration test: a disconnect stops the turn (RED→GREEN)

The agent-loop unit test already proves the core. Add ONE integration test that
proves the route wires the signal. Open `tests/integration/agentic-chat.test.ts`
and look at the top for how `makeApp` and a multi-step scripted model are set up
(reuse that exact harness — do not invent a new one). Add this test inside the
existing top-level `describe(...)` that uses `makeApp` (append it as a new `it`):

```ts
  it("aborts the agentic loop when the client disconnects mid-stream (no runaway model calls)", async () => {
    // A model that would keep calling a read tool every step (never finishes on
    // its own), so the ONLY thing that can stop it is the disconnect.
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    const script = Array.from({ length: 6 }, (_unused, i) => ({
      text: "",
      toolCalls: [{ id: `c${i}`, name: "clockify_tags_list", arguments: {} }],
    }));
    const { app, model, cookie } = await makeApp(script, fake);

    const req = request(app)
      .post("/api/chat/stream")
      .set("Cookie", cookie)
      .send({ message: "list tags repeatedly" });
    // Abort the HTTP request shortly after it starts (simulates the iframe close).
    setTimeout(() => req.abort(), 30);
    await req.catch(() => undefined); // the aborted request rejects; ignore it

    // Give any in-flight step a moment to settle, then assert the loop did NOT
    // run all 6 steps — it stopped at a boundary after the disconnect.
    await new Promise((r) => setTimeout(r, 50));
    expect(model.completeWithTools.mock.calls.length).toBeLessThan(6);
  });
```

> If the harness's model spy is exposed under a different name than
> `model.completeWithTools.mock.calls.length`, find how other tests in this file
> assert call counts (search for `completeWithTools` and `toHaveBeenCalled`) and
> mirror that. The assertion's intent: FEWER than the 6 scripted steps ran.

Run:
```
npx vitest run tests/integration/agentic-chat.test.ts
```
**Expected:** all tests pass, including the new one. If the new test is flaky
(call count occasionally equals 6), increase the post-abort wait to 100ms; if it
still flakes, the wiring is wrong — re-check Step 4d.

---

## 7. Step 6 — Full verify + commit

Run:
```
npm run verify
```
**Expected:** exit 0; test count is `N + 4` (3 unit + 1 integration) from Step 1.

Then commit (one focused commit):
```
git add src/assistant/agent-loop.ts src/assistant/planner.ts src/routes/api.ts \
        tests/unit/agent-loop-abort.test.ts tests/integration/agentic-chat.test.ts
git commit -m "fix(chat): stop the agentic loop on client disconnect (cooperative cancellation)

The agentic loop ran to completion against a dead socket when the admin closed
the iframe mid-turn — further paid model calls + safe writes for a turn nobody
was watching. Thread an optional AbortSignal from the two streaming routes
(/chat/stream, /confirmations/:id/confirm?stream=1) through executeChatTurn/
runResume -> runAgentConversation -> runAgentTurn; the loop checks it before each
model call and each tool execution and returns a new 'aborted' outcome. The
in-flight model fetch is left to its own timeout (out of scope). The single-turn
JSON path is unchanged."
```

## 8. Rollback

If anything is wrong, `git checkout -- <file>` the touched files (they are all
listed in the commit command). The change is additive and behind an optional
param, so reverting the commit fully restores prior behavior.

## 9. Done criteria

- `npm run verify` is green at `N + 4` tests, 0 cycles.
- `tests/unit/agent-loop-abort.test.ts` exists and passes.
- The new integration test passes.
- One commit on `main` matching Step 6.
