# Plan 001: Make `npm run verify` run the circular-dependency check so the local gate equals CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7826299..HEAD -- package.json .github/workflows/ci.yml`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `7826299`, 2026-06-14

## Why this matters

The repo's one-command local gate is `npm run verify`. CI runs `npm run verify`
**and then** `npm run cycles` (the zero-circular-dependency check) as a separate
step. So a developer who introduces a circular dependency can pass `npm run
verify` locally and only discover the failure in CI — the "local gate = CI gate"
property the team relies on is silently broken for this one check. The project
explicitly values zero cycles (`madge` is a pinned devDep; CLAUDE.md says "keep
both green"). `npm run cycles` takes ~0.7s, so folding it into `verify` costs
nothing and closes the gap.

## Current state

- `package.json` — defines the scripts. The `verify` script omits `cycles`:

  ```json
  "scripts": {
    "dev": "tsx src/server.ts",
    "build": "tsc -p tsconfig.build.json && vite build",
    "start": "node dist/server/server.js",
    "type-check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "cycles": "madge --circular --extensions ts --ts-config tsconfig.json src",
    "verify": "npm run type-check && npm test && npm run build"
  },
  ```

- `.github/workflows/ci.yml` — runs them as two steps (lines ~26-27):

  ```yaml
      - run: npm run verify
      - run: npm run cycles
  ```

- Convention: this repo uses Conventional Commits (recent log: `feat(chat): …`,
  `refactor(clockify): …`, `build(ci): …`, `docs: …`).

## Commands you will need

| Purpose        | Command            | Expected on success            |
|----------------|--------------------|--------------------------------|
| Cycles check   | `npm run cycles`   | "✔ No circular dependency found!" |
| Full gate      | `npm run verify`   | exit 0 (now includes cycles)   |

## Scope

**In scope** (the only files you may modify):
- `package.json` (the `verify` script line only)
- `.github/workflows/ci.yml` (optional simplification — see Step 2)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- Any other `package.json` script.
- Any source file under `src/` or `tests/`.

## Git workflow

- Branch `advisor/001-verify-cycles`, or direct-commit if that matches your
  workflow. Do NOT push or open a PR unless the operator instructed it.
- One commit; message e.g. `build: fold cycles check into npm run verify`.

## Steps

### Step 1: Add `cycles` to the `verify` script

In `package.json`, change the `verify` script so the cheap static checks
(`type-check`, `cycles`) run before the expensive dynamic ones (`test`,
`build`) — fail-fast on a cycle:

```json
    "verify": "npm run type-check && npm run cycles && npm test && npm run build"
```

(Appending `&& npm run cycles` at the end is also acceptable; the
fail-fast ordering above is preferred.)

**Verify**: `npm run verify` → exit 0, and the output includes the madge line
"✔ No circular dependency found!" before the vitest run.

### Step 2 (optional): Drop the now-redundant separate CI step

Because `npm run verify` now includes cycles, the standalone `- run: npm run
cycles` step in `.github/workflows/ci.yml` is redundant. You MAY remove that one
line. Leaving it is harmless (it just runs cycles twice). If you remove it,
keep the `npm run verify` step.

**Verify**: `cat .github/workflows/ci.yml` shows the `verify` step still
present; no other steps changed.

## Test plan

- No new tests. This is a build-script change; the existing suite is the
  regression guard.
- Verification: `npm run verify` → exit 0 with the cycles check visibly running
  inside it.

## Done criteria

ALL must hold:

- [ ] `package.json` `verify` script contains `npm run cycles`.
- [ ] `npm run verify` exits 0 and its output shows "✔ No circular dependency found!".
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `npm run cycles` reports a circular dependency on the current tree (that's a
  pre-existing problem this plan must not mask — report it).
- The `package.json` `verify` line doesn't match the "Current state" excerpt
  (the scripts changed since this plan was written).

## Maintenance notes

- After this lands, `npm run verify` is the single source of truth for "is the
  tree green," matching CI exactly. Any future gate (e.g. a lint step) should be
  added to `verify`, not bolted on only in CI.
- Reviewer: confirm the cycles check actually runs inside `verify` (look for the
  madge line in the output), not just that the string is present.
