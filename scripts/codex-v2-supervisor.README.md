# Codex v2 local supervisor

`codex-v2-supervisor.py` adopts the completed T01-C boundary and runs Codex from
T01-D through T17-G. Strict mode, which remains the default, launches one fresh
process per prompt. The optional efficient profile may run a configured sequence
of related prompts in one fresh process while retaining each prompt's scope,
evidence, commit, and clean-worktree boundary. The supervisor parses prompt order
and content from the prompt pack, stops before T18-A, and never deploys, pushes,
tags, publishes, or performs a live Clockify/Railway/Marketplace action.

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

## Efficient execution profile

Strict behavior is unchanged unless `--execution-profile efficient` is supplied
or `execution_profile` is set to `efficient` in configuration. Efficient mode
uses Sol High by default. Configured architecture, safety, task-closure, and
independent-review prompt patterns use Sol Max. Subagents are rejected from
structured events except for T04-R1, T04-R2, T19-J, and configured audit prompts.

The initial `efficient_prompt_groups` are recorded in the example configuration.
Each range must be contiguous within one numbered task and may not contain an
explicit Max prompt, reviewer, or authorization gate. A group creates one exact
commit per prompt unless its configuration object supplies
`consolidated_commit_subject`. Per-prompt checkpoints make a validated committed
prefix restartable without rerunning it. Group completion requires ordered
handoffs for every prompt, exact ordered commits, domain regression tests,
type-check, relevant lint, and one final synchronization of `CLAUDE.md` and
`AGENTS.md`. `npm run verify` is reserved for numbered-task closures and the
configured critical-gate patterns.

Resume the already completed T04-D boundary in efficient mode, using the current
recovery configuration, with exactly:

```bash
python3 scripts/codex-v2-supervisor.py --config /Users/15x/Downloads/codex-v2-supervisor-recovery.json --execution-profile efficient run --stop-before T18-A
```

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
Every invocation is `--ephemeral` and uses `gpt-5.6-sol`. Strict mode uses Max
reasoning. Efficient mode selects High or configured Max and gives a grouped
process only the Base Execution Contract, required task contract(s), selected
prompt sections, immediately preceding handoff, and efficient gate rules. T04-R3
additionally receives the two bound reviewer reports.

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
