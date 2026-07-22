# Codex v2 local supervisor

`codex-v2-supervisor.py` adopts the completed T01-C boundary and runs one fresh
Codex process per prompt from T01-D through T17-G. It parses prompt order and
prompt content from the prompt pack; it does not carry a handwritten task list.
It stops before T18-A and never deploys, pushes, tags, publishes, or performs a
live Clockify/Railway/Marketplace action.

## Before adoption

Review and commit the supervisor files first. Adoption intentionally refuses a
worktree containing any path other than an optional untracked `FINDINGS.md`.
The supervisor never reads that file; every child is wrapped in a verified macOS
profile that denies its contents and all writes to it.

The supplied handoff must name the resulting clean `HEAD`. If an older T01-C
handoff names the pre-supervisor commit, adoption correctly rejects it; reconcile
the local boundary and produce a truthful refreshed T01-C handoff rather than
editing only its SHA.

Copy the existing, complete T01-C `SLICE HANDOFF` to the clipboard, then save it
verbatim with private default permissions:

```bash
umask 077
pbpaste > /Users/15x/Downloads/T01-C-SLICE-HANDOFF.txt
```

Adopt it. This validates the full SHA and subject against `HEAD`, the branch,
Node 22/ABI 127, plan hash, prompt pack, both guidance checkpoints, and the
worktree. It does not run T01-D.

```bash
python3 scripts/codex-v2-supervisor.py adopt --completed T01-C --handoff /Users/15x/Downloads/T01-C-SLICE-HANDOFF.txt
```

## Normal commands

```bash
# Inspect everything required for the next prompt without launching Codex.
python3 scripts/codex-v2-supervisor.py validate

# Reconcile interrupted state and show the current boundary.
python3 scripts/codex-v2-supervisor.py status

# Run exactly one implementation prompt, or the T04 read-only reviewer pair.
python3 scripts/codex-v2-supervisor.py step

# Run unattended from the current boundary through T17-G, then stop before T18-A.
python3 scripts/codex-v2-supervisor.py run --stop-before T18-A
```

To use the example configuration, put the global option before the command:

```bash
python3 scripts/codex-v2-supervisor.py --config scripts/codex-v2-supervisor.example.json validate
```

The defaults already match the paths in this checkout. The example mainly makes
the four-hour implementation/reviewer hard timeouts visible and editable.

## T04 independent-review boundary

After T04-K, `step` launches T04-R1 and T04-R2 concurrently as fresh,
non-resumed, read-only Codex roots on the same immutable SHA. Neither receives
the other's output. Both reports are stored outside the repository, Git is
rechecked, state becomes `review_complete`, and automatic execution stops.

Inspect `status`, then launch T04-R3 with both reports by running one explicit
step. After that succeeds, `run` may continue:

```bash
python3 scripts/codex-v2-supervisor.py status
python3 scripts/codex-v2-supervisor.py step  # T04-R3 only
python3 scripts/codex-v2-supervisor.py run --stop-before T18-A
```

T19-J is also an independent-review boundary, but this supervisor refuses every
T18/T19 launch. Separate authority and a later supervisor change would be
required.

## Safe resume after a blocker

The failed prompt is never skipped. First fix the reported local condition
without broad Git cleanup. Then run:

```bash
python3 scripts/codex-v2-supervisor.py validate
python3 scripts/codex-v2-supervisor.py status
python3 scripts/codex-v2-supervisor.py step
```

If Git still equals the stored commit and only optional `?? FINDINGS.md` is
present, `step` retries the same prompt. If an interrupted child already produced
one valid commit and final handoff, reconciliation verifies the complete boundary
and advances without rerunning it. Any other Git/state disagreement requires
manual reconciliation; the supervisor never resets or cleans the checkout.

## Enforcement and artifacts

At every writable boundary the supervisor independently checks one new direct
commit, exact subject, COMPLETE handoff, expected next prompt, synchronized
guidance, exact reported/actual paths, frozen scope, required evidence commands,
empty staging, clean worktree, and secret-like additions. Structured command
events are stopped on prohibited Git, external-admin, deployment, publication,
live Clockify, nested-agent, or `FINDINGS.md` actions.

The installed CLI is discovered from `codex exec --help`. This machine currently
uses the only accepted writable mode:

```text
--dangerously-bypass-approvals-and-sandbox
```

Reviewers instead use `--ask-for-approval never` plus `--sandbox read-only`.
Every invocation is `--ephemeral`, uses `gpt-5.6-sol` with max reasoning, and is
given only the Base Execution Contract, required task contract(s), selected
prompt, immediately preceding handoff, and autonomy rules. T04-R3 additionally
receives the two bound reviewer reports.

Runtime state is private and atomically replaced under:

```text
~/.local/state/ai-assistant-v2-supervisor/
```

It contains handoffs, exact child prompts, sanitized JSONL events, sanitized
stderr/progress, final responses, reviewer reports, process receipts, and state
checkpoints. External-service and generally credential-shaped environment
variables are removed from child environments; any remaining inherited
credential values are redacted from captured output.

## Local tests

The tests use temporary Git repositories and fake Codex/Node executables. They
never launch a model:

```bash
python3 -B -m unittest discover -s tests/scripts -p 'test_*.py' -v
ruff check scripts/codex-v2-supervisor.py tests/scripts/test_codex_v2_supervisor.py
ruff format --check scripts/codex-v2-supervisor.py tests/scripts/test_codex_v2_supervisor.py
pyright scripts/codex-v2-supervisor.py tests/scripts/test_codex_v2_supervisor.py
```

Frozen paths are derived conservatively from exact path references in the
selected prompt and required contracts, plus only role/domain-matching paths
from the named canonical-plan and task context. A semantically described path
that cannot be proved is a blocker, not an implicit scope expansion.

## Current checkout caveat

At supervisor creation time, `npm run verify` reaches `type-check:scripts` and
fails because the tracked `scripts/repro-chat.ts` T01-C-era `AppConfig` fixture
does not set the required `assistantEngine`. The supervisor files do not touch
that implementation. Resolve this pre-existing checkpoint mismatch and refresh
the adopted T01-C boundary before expecting unattended T01-D execution.
