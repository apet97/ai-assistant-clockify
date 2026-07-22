from __future__ import annotations

import importlib.util
import hashlib
import inspect
import json
import os
from pathlib import Path
from dataclasses import replace
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any
import unittest
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[2]
SUPERVISOR_PATH = REPOSITORY / "scripts" / "codex-v2-supervisor.py"
README_PATH = REPOSITORY / "scripts" / "codex-v2-supervisor.README.md"
EXAMPLE_CONFIG_PATH = REPOSITORY / "scripts" / "codex-v2-supervisor.example.json"


def load_supervisor_module():
    spec = importlib.util.spec_from_file_location(
        "codex_v2_supervisor", SUPERVISOR_PATH
    )
    if spec is None or spec.loader is None:
        raise AssertionError("unable to load supervisor module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


supervisor = load_supervisor_module()


PACK_TEXT = """\
# Test Prompt Pack

- repository: `/tmp/repository`
- canonical implementation plan: `/tmp/plan.md`
- plan SHA-256: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- baseline repository commit: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`

## Base Execution Contract

BASE CONTRACT BODY

## Prompt T00-A: Authorize branch

**Prerequisites:** None.

```bash
git switch -c codex/rewrite-api-agent-v2
```

**Commit:** None.

---

## Prompt T01-C: Existing seam

**Prerequisite:** COMPLETE T01-B handoff.

**Commit:** `refactor: add the top-level assistant engine seam`.

---

## Prompt T01-D: Quarantine evidence

**Prerequisite:** COMPLETE T01-C handoff.

**Frozen files:** `scripts/evidence/release-evidence.ts`, `tests/unit/release-evidence.test.ts`, `CLAUDE.md`, `AGENTS.md`.

```bash
npx vitest run tests/unit/release-evidence.test.ts
npm run verify
```

**Documentation delta:** Record next prompt `T04-K`.

**Commit:** `docs: quarantine evidence`.

---

## Task 4 Annotation-Slice Contract

Every T04 annotation prompt must also read this section.

---

## Prompt T04-K: Generate inventory

**Prerequisite:** COMPLETE T01-D handoff.

**Frozen files:** `scripts/generate-inventory.ts`, `CLAUDE.md`, `AGENTS.md`.

**Documentation delta:** Next prompts `T04-R1` and `T04-R2`.

**Commit:** `feat: generate inventory`.

---

## Prompt T04-R1: Reviewer A

**Mode:** Read-only reviewer.

**Next:** `T04-R3` after reviewer B completes.

---

## Prompt T04-R2: Reviewer B

**Mode:** Read-only reviewer.

**Next:** `T04-R3`.

---

## Prompt T04-R3: Review remediation

**Prerequisite:** Both T04-R1 and T04-R2 reports.

**Commit:** `fix: remediate inventory`.

---

## Task 10 Read-Parity Slice Contract

Every T10 prompt reads this contract.

---

## Task 12 Write-Parity Slice Contract

Every T12 prompt reads the Task 10 parity contract too.

---

## Prompt T12-A: Write parity

**Prerequisite:** COMPLETE T11-F.

**Frozen files:** `src/write.ts`, `CLAUDE.md`, `AGENTS.md`.

**Commit:** `feat: write parity`.

---

## Prompt T17-G: Close local work

**Prerequisite:** COMPLETE T17-F.

**Commit:** `test: close local work`.

---

## Prompt T18-A: Operator gate

**Prerequisite:** COMPLETE T17-G and explicit authority to implement local deployment-script changes.

**Commit:** `ops: operator work`.

---

## Prompt-order index

```text
T00-A
T01-C T01-D
T04-K
T04-R1 + T04-R2 -> T04-R3
T12-A
T17-G
T18-A
```
"""


def valid_handoff(
    *,
    prompt: str = "T01-C",
    title: str = "Existing seam",
    commit: str = "c" * 40,
    subject: str = "refactor: add the top-level assistant engine seam",
    next_prompt: str = "T01-D",
) -> str:
    return f"""\
SLICE HANDOFF
Prompt: {prompt}: {title}
Status: COMPLETE
Commit: {commit} {subject}
Invariant delivered: one seam
Files changed: CLAUDE.md, AGENTS.md
Red evidence: npx vitest run tests/integration/routes.test.ts failed as intended
Green evidence: npx vitest run tests/integration/routes.test.ts passed
Docs synchronized: CLAUDE.md=updated; AGENTS.md=updated
Generated artifacts: none
Live/external actions: NONE
Worktree: clean
Next prompt: {next_prompt}
Blockers/not evaluated: none
"""


class SupervisorModuleTests(unittest.TestCase):
    def test_supervisor_module_exists_and_imports_without_side_effects(self) -> None:
        self.assertTrue(SUPERVISOR_PATH.is_file())
        self.assertTrue(callable(supervisor.main))


class OperatorArtifactTests(unittest.TestCase):
    def test_example_configuration_is_complete_and_loadable(self) -> None:
        self.assertTrue(EXAMPLE_CONFIG_PATH.is_file())
        config = supervisor.SupervisorConfig.load(EXAMPLE_CONFIG_PATH)
        self.assertEqual(config.model, "gpt-5.6-sol")
        self.assertEqual(config.reasoning_effort, "max")
        self.assertEqual(config.stop_before, "T18-A")
        self.assertTrue(config.protect_findings)
        self.assertGreater(config.child_timeout_seconds, 0)
        self.assertEqual(config.execution_profile, "strict")
        self.assertEqual(
            tuple(
                f"{group.start_prompt}..{group.end_prompt}"
                for group in config.efficient_prompt_groups
            ),
            supervisor.INITIAL_EFFICIENT_GROUP_RANGES,
        )

    def test_readme_contains_every_operator_command_and_review_transition(self) -> None:
        text = README_PATH.read_text(encoding="utf-8")
        for fragment in (
            "pbpaste > /Users/15x/Downloads/T01-C-SLICE-HANDOFF.txt",
            "adopt --completed T01-C",
            "codex-v2-supervisor.py validate",
            "codex-v2-supervisor.py status",
            "codex-v2-supervisor.py step",
            "codex-v2-supervisor.py run --stop-before T18-A",
            "--execution-profile efficient",
            "/Users/15x/Downloads/codex-v2-supervisor-recovery.json",
            "T04-R3",
            "--dangerously-bypass-approvals-and-sandbox",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, text)


def planning_pack(
    prompt_ids: tuple[str, ...],
    *,
    reviewer_pair: tuple[str, ...] | None = None,
    gated_prompts: frozenset[str] = frozenset(),
) -> Any:
    prompts = {
        prompt_id: supervisor.Prompt(
            prompt_id,
            prompt_id,
            f"## Prompt {prompt_id}: {prompt_id}\n",
            "",
            f"commit {prompt_id}",
            (
                ("explicit operator authorization required",)
                if prompt_id in gated_prompts
                else ()
            ),
        )
        for prompt_id in prompt_ids
    }
    order_items: list[str | tuple[str, ...]] = []
    index = 0
    while index < len(prompt_ids):
        if (
            reviewer_pair
            and prompt_ids[index : index + len(reviewer_pair)] == reviewer_pair
        ):
            order_items.append(reviewer_pair)
            index += len(reviewer_pair)
        else:
            order_items.append(prompt_ids[index])
            index += 1
    return supervisor.PromptPack(
        text="",
        base_contract="BASE\n",
        prompts=prompts,
        contracts=(),
        order_items=tuple(order_items),
        repository_path="/tmp/repo",
        implementation_plan_path="/tmp/plan",
        declared_plan_sha256="a" * 64,
        baseline_commit="b" * 40,
    )


class EfficientExecutionProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pack = planning_pack(
            (
                "T04-D",
                "T04-E",
                "T04-F",
                "T04-G",
                "T04-H",
                "T04-I",
                "T04-J",
                "T04-K",
                "T04-R1",
                "T04-R2",
                "T04-R3",
                "T05-A",
                "T05-B",
                "T05-C",
                "T06-PROJECTS",
                "T06-TASKS",
                "T06-USER-RATES",
                "T06-FINAL",
                "T08-A",
                "T18-A",
            ),
            reviewer_pair=("T04-R1", "T04-R2"),
            gated_prompts=frozenset({"T18-A"}),
        )

    def test_cli_accepts_explicit_efficient_profile(self) -> None:
        args = supervisor._argument_parser().parse_args(
            ["--execution-profile", "efficient", "run", "--stop-before", "T18-A"]
        )

        self.assertEqual(args.execution_profile, "efficient")

    def test_group_resolution_and_partial_restart_keep_ordered_suffix(self) -> None:
        groups = supervisor.resolve_prompt_groups(
            self.pack,
            (supervisor.PromptGroupSpec("T04-E", "T04-J"),),
            max_prompt_patterns=("T04-K",),
        )

        self.assertEqual(
            groups[0].prompt_ids,
            ("T04-E", "T04-F", "T04-G", "T04-H", "T04-I", "T04-J"),
        )
        selected = supervisor.select_prompt_group(groups, "T04-G")
        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected.prompt_ids, ("T04-G", "T04-H", "T04-I", "T04-J"))

    def test_partial_group_recovery_advances_only_the_validated_commit_prefix(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init")
            git(repo, "config", "user.name", "Supervisor Test")
            git(repo, "config", "user.email", "supervisor@example.invalid")
            (repo / "base.txt").write_text("base\n", encoding="utf-8")
            git(repo, "add", "--", "base.txt")
            git(repo, "commit", "-m", "base")
            pre_head = git(repo, "rev-parse", "HEAD")
            (repo / "e.txt").write_text("e\n", encoding="utf-8")
            git(repo, "add", "--", "e.txt")
            git(repo, "commit", "-m", "commit T04-E")
            commit = git(repo, "rev-parse", "HEAD")
            handoff = supervisor.parse_handoff(
                valid_handoff(
                    prompt="T04-E",
                    title="T04-E",
                    commit=commit,
                    subject="commit T04-E",
                    next_prompt="T04-F",
                )
            )
            config = replace(
                supervisor.SupervisorConfig.defaults(),
                repository_path=repo,
                state_dir=root / "state",
                execution_profile="efficient",
                efficient_prompt_groups=(supervisor.PromptGroupSpec("T04-E", "T04-F"),),
            )
            instance = supervisor.Supervisor(config)
            instance._create_state_directories()
            state = {
                "last_completed_prompt": "T04-D",
                "last_commit": pre_head,
                "next_prompt": "T04-E",
                "current_status": "running",
                "last_blocker": None,
                "last_failed_run": None,
                "active_run": {"run_id": "group"},
                "last_run_completed_at": None,
            }
            group = supervisor.ResolvedPromptGroup(
                prompt_ids=("T04-E", "T04-F"),
                configured_prompt_ids=("T04-E", "T04-F"),
            )
            with patch.object(
                instance, "_validate_completed_group", return_value=(handoff,)
            ):
                with self.assertRaisesRegex(
                    supervisor.SupervisorError,
                    "validated committed prefix through T04-E",
                ):
                    instance._reconcile_or_block_group(
                        pack=self.pack,
                        state=state,
                        group=group,
                        pre_head=pre_head,
                        messages=(handoff.raw,),
                        blocker="interrupted",
                    )

            saved = json.loads(instance.state_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["last_completed_prompt"], "T04-E")
            self.assertEqual(saved["last_commit"], commit)
            self.assertEqual(saved["next_prompt"], "T04-F")
            self.assertEqual(
                saved["efficient_group_progress"]["completed_prompt_ids"],
                ["T04-E"],
            )

    def test_effort_selection_defaults_to_high_and_uses_explicit_max_patterns(
        self,
    ) -> None:
        strict = supervisor.SupervisorConfig.defaults()
        efficient = replace(
            strict,
            execution_profile="efficient",
            efficient_max_prompt_patterns=("T04-K", "T08-*"),
            efficient_audit_prompt_patterns=("T05-B",),
            efficient_critical_gate_patterns=("T05-C",),
        )

        self.assertEqual(supervisor.reasoning_effort_for_prompt(strict, "T04-E"), "max")
        self.assertEqual(
            supervisor.reasoning_effort_for_prompt(efficient, "T04-E"), "high"
        )
        for prompt_id in ("T04-K", "T08-A", "T05-B", "T05-C"):
            with self.subTest(prompt_id=prompt_id):
                self.assertEqual(
                    supervisor.reasoning_effort_for_prompt(efficient, prompt_id),
                    "max",
                )

    def test_full_verify_is_limited_to_task_closures_and_critical_gates(self) -> None:
        config = replace(
            supervisor.SupervisorConfig.defaults(),
            execution_profile="efficient",
            efficient_critical_gate_patterns=("T04-K",),
        )

        for prompt_id in ("T04-K", "T05-C", "T06-FINAL"):
            with self.subTest(prompt_id=prompt_id):
                self.assertTrue(
                    supervisor.efficient_full_verify_required(
                        config, self.pack, prompt_id
                    )
                )
        for prompt_id in ("T04-E", "T05-A", "T06-PROJECTS"):
            with self.subTest(prompt_id=prompt_id):
                self.assertFalse(
                    supervisor.efficient_full_verify_required(
                        config, self.pack, prompt_id
                    )
                )

    def test_no_subagent_policy_has_only_named_exceptions(self) -> None:
        config = replace(
            supervisor.SupervisorConfig.defaults(),
            execution_profile="efficient",
            efficient_audit_prompt_patterns=("T13-B",),
        )

        self.assertFalse(supervisor.subagents_allowed(config, ("T04-E",)))
        for prompt_id in ("T04-R1", "T04-R2", "T19-J", "T13-B"):
            with self.subTest(prompt_id=prompt_id):
                self.assertTrue(supervisor.subagents_allowed(config, (prompt_id,)))
        event = {
            "item": {
                "type": "collaboration_tool_call",
                "tool_name": "spawn_agent",
            }
        }
        self.assertEqual(
            supervisor.audit_subagent_event(event, allowed=False),
            "efficient profile forbids subagents for this prompt",
        )
        self.assertIsNone(supervisor.audit_subagent_event(event, allowed=True))
        verify_event = {
            "item": {
                "type": "command_execution",
                "command": "PATH=/opt/homebrew/bin:$PATH npm run verify",
            }
        }
        self.assertEqual(
            supervisor.audit_full_verify_event(verify_event, allowed=False),
            "efficient profile reserves npm run verify for critical gates",
        )
        self.assertIsNone(
            supervisor.audit_full_verify_event(verify_event, allowed=True)
        )

    def test_groups_cannot_cross_task_max_reviewer_or_authorization_boundaries(
        self,
    ) -> None:
        cases = (
            (supervisor.PromptGroupSpec("T05-C", "T06-PROJECTS"), "numbered task"),
            (supervisor.PromptGroupSpec("T04-E", "T04-K"), "Max boundary"),
            (supervisor.PromptGroupSpec("T04-R1", "T04-R3"), "reviewer boundary"),
            (supervisor.PromptGroupSpec("T08-A", "T18-A"), "authorization gate"),
        )
        for group, message in cases:
            with self.subTest(group=group):
                with self.assertRaisesRegex(supervisor.SupervisorError, message):
                    supervisor.resolve_prompt_groups(
                        self.pack,
                        (group,),
                        max_prompt_patterns=("T04-K",),
                    )

    def test_group_handoff_requires_every_prompt_in_exact_order(self) -> None:
        text = "\n".join(
            (
                valid_handoff(
                    prompt="T04-E",
                    title="E",
                    commit="1" * 40,
                    subject="commit T04-E",
                    next_prompt="T04-F",
                ).rstrip(),
                valid_handoff(
                    prompt="T04-F",
                    title="F",
                    commit="2" * 40,
                    subject="commit T04-F",
                    next_prompt="T04-G",
                ).rstrip(),
            )
        )

        handoffs = supervisor.parse_group_handoffs(
            text, expected_prompt_ids=("T04-E", "T04-F")
        )

        self.assertEqual(tuple(item.prompt_id for item in handoffs), ("T04-E", "T04-F"))
        self.assertEqual(
            tuple(item.commit_sha for item in handoffs), ("1" * 40, "2" * 40)
        )
        with self.assertRaisesRegex(supervisor.SupervisorError, "exact prompt order"):
            supervisor.parse_group_handoffs(
                text, expected_prompt_ids=("T04-F", "T04-E")
            )

    def test_group_handoff_requires_a_clean_worktree_at_each_prompt(self) -> None:
        config = replace(
            supervisor.SupervisorConfig.defaults(), execution_profile="efficient"
        )
        instance = supervisor.Supervisor(config)
        handoff = supervisor.parse_handoff(
            valid_handoff(
                prompt="T04-E",
                title="E",
                commit="1" * 40,
                subject="commit T04-E",
                next_prompt="T04-F",
            )
            .replace(
                "Green evidence: ",
                "Green evidence: `git diff --check` passed; "
                "`git status --short --branch` reported clean; ",
            )
            .replace("Worktree: clean", "Worktree: dirty")
        )

        with self.assertRaisesRegex(supervisor.SupervisorError, "clean worktree"):
            instance._validate_group_handoff_evidence(
                self.pack, self.pack.prompt("T04-E"), handoff
            )

    def test_group_prompt_contains_each_scope_and_efficient_gate_contract(self) -> None:
        group = supervisor.ResolvedPromptGroup(
            prompt_ids=("T04-E", "T04-F"),
            configured_prompt_ids=("T04-E", "T04-F"),
        )

        prompt = supervisor.build_efficient_group_prompt(
            self.pack,
            group,
            "SLICE HANDOFF\nPrompt: T04-D: prior\n",
            full_verify_prompt_ids=(),
        )

        self.assertIn("## Prompt T04-E:", prompt)
        self.assertIn("## Prompt T04-F:", prompt)
        self.assertIn("Do not spawn or delegate to subagents", prompt)
        self.assertIn("synchronize `CLAUDE.md` and `AGENTS.md` exactly once", prompt)
        self.assertIn("one SLICE HANDOFF block for every prompt", prompt)
        self.assertIn("Do not run `npm run verify` for this group", prompt)

    def test_implementation_command_uses_selected_effort_without_changing_strict(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            capabilities = supervisor.detect_codex_capabilities(str(fixture.codex))
            strict_command = supervisor.Supervisor(
                fixture.config
            )._implementation_command(capabilities, reasoning_effort="max")
            efficient_command = supervisor.Supervisor(
                replace(fixture.config, execution_profile="efficient")
            )._implementation_command(capabilities, reasoning_effort="high")

        self.assertIn('model_reasoning_effort="max"', strict_command)
        self.assertIn('model_reasoning_effort="high"', efficient_command)


class PromptPackParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pack = supervisor.PromptPack.parse(PACK_TEXT)

    def test_parses_prompt_order_and_reviewer_pair_from_index(self) -> None:
        self.assertEqual(
            self.pack.ordered_prompt_ids,
            (
                "T00-A",
                "T01-C",
                "T01-D",
                "T04-K",
                "T04-R1",
                "T04-R2",
                "T04-R3",
                "T12-A",
                "T17-G",
                "T18-A",
            ),
        )
        self.assertEqual(self.pack.expected_next("T04-K"), ("T04-R1", "T04-R2"))
        self.assertEqual(self.pack.expected_next("T04-R3"), ("T12-A",))

    def test_extracts_only_the_selected_prompt_section_and_metadata(self) -> None:
        prompt = self.pack.prompt("T01-D")
        self.assertEqual(prompt.title, "Quarantine evidence")
        self.assertIn("COMPLETE T01-C", prompt.prerequisite)
        self.assertEqual(prompt.commit_subject, "docs: quarantine evidence")
        self.assertIn("npx vitest run", prompt.text)
        self.assertNotIn("Task 4 Annotation-Slice Contract", prompt.text)

    def test_extracts_required_task_contracts_including_contract_dependency(
        self,
    ) -> None:
        task4 = self.pack.required_contracts_for("T04-K")
        self.assertEqual(tuple(contract.task_number for contract in task4), (4,))

        task12 = self.pack.required_contracts_for("T12-A")
        self.assertEqual(tuple(contract.task_number for contract in task12), (10, 12))

    def test_prompt_suffix_starting_with_r_is_not_mistaken_for_reviewer(self) -> None:
        task6_contract = supervisor.TaskContract(6, "Task 6 Contract", "contract")
        prompt = supervisor.Prompt(
            "T06-REPORTS", "Reports", "## Prompt T06-REPORTS: Reports\n", "", None, ()
        )
        pack = supervisor.PromptPack(
            text="",
            base_contract="",
            prompts={prompt.prompt_id: prompt},
            contracts=(task6_contract,),
            order_items=(prompt.prompt_id,),
            repository_path="/tmp/repo",
            implementation_plan_path="/tmp/plan",
            declared_plan_sha256="a" * 64,
            baseline_commit="b" * 40,
        )

        self.assertEqual(
            pack.required_contracts_for(prompt.prompt_id), (task6_contract,)
        )

    def test_extracts_explicit_authorization_gate(self) -> None:
        gates = self.pack.prompt("T18-A").authorization_gates
        self.assertTrue(any("explicit authority" in gate for gate in gates))


class HandoffParsingTests(unittest.TestCase):
    def test_parses_complete_handoff(self) -> None:
        handoff = supervisor.parse_handoff(valid_handoff())
        self.assertEqual(handoff.prompt_id, "T01-C")
        self.assertEqual(handoff.status, "COMPLETE")
        self.assertEqual(handoff.commit_sha, "c" * 40)
        self.assertEqual(handoff.next_prompt_ids, ("T01-D",))

    def test_rejects_malformed_or_ambiguous_handoff(self) -> None:
        cases = {
            "missing field": valid_handoff().replace(
                "Green evidence:", "Green result:"
            ),
            "duplicate marker": valid_handoff() + "\nSLICE HANDOFF\n",
            "invalid status": valid_handoff().replace(
                "Status: COMPLETE", "Status: SUCCESS"
            ),
            "short commit": valid_handoff().replace("c" * 40, "ccccccc"),
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(supervisor.SupervisorError):
                    supervisor.parse_handoff(text)


def write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return completed.stdout.strip()


class RepositoryFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.repo = root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-b", "codex/rewrite-api-agent-v2")
        git(self.repo, "config", "user.name", "Supervisor Test")
        git(self.repo, "config", "user.email", "supervisor@example.invalid")
        checkpoint = """\
# Guide

## Current v2 implementation checkpoint

- T01-C is complete. Next: T01-D.

## Other
"""
        (self.repo / "CLAUDE.md").write_text(checkpoint, encoding="utf-8")
        (self.repo / "AGENTS.md").write_text(checkpoint, encoding="utf-8")
        git(self.repo, "add", "--", "CLAUDE.md", "AGENTS.md")
        git(
            self.repo,
            "commit",
            "-m",
            "refactor: add the top-level assistant engine seam",
        )
        self.head = git(self.repo, "rev-parse", "HEAD")

        self.plan = root / "plan.md"
        self.plan.write_text("# Plan\n\n`src/allowed.ts`\n", encoding="utf-8")
        plan_hash = hashlib.sha256(self.plan.read_bytes()).hexdigest()
        self.pack_path = root / "pack.md"
        pack_text = PACK_TEXT.replace("/tmp/repository", str(self.repo)).replace(
            "/tmp/plan.md", str(self.plan)
        )
        pack_text = pack_text.replace("a" * 64, plan_hash).replace("b" * 40, self.head)
        self.pack_path.write_text(pack_text, encoding="utf-8")

        self.codex = root / "codex"
        write_executable(
            self.codex,
            """#!/bin/sh
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  printf '%s\n' '  --dangerously-bypass-approvals-and-sandbox' '  -s, --sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]'
  exit 0
fi
if [ "$1" = "--help" ]; then
  printf '%s\n' '  -a, --ask-for-approval <POLICY>' '  -s, --sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]' '  - never'
  exit 0
fi
exit 97
""",
        )
        self.node = root / "node"
        write_executable(
            self.node,
            """#!/bin/sh
if [ "$1" = "-p" ]; then printf '127\n'; else printf 'v22.23.1\n'; fi
""",
        )
        self.state_dir = root / "state"
        self.config = supervisor.SupervisorConfig(
            repository_path=self.repo,
            prompt_pack_path=self.pack_path,
            state_dir=self.state_dir,
            codex_executable=str(self.codex),
            node_executable=str(self.node),
            child_timeout_seconds=2.0,
            reviewer_timeout_seconds=2.0,
            model="gpt-5.6-sol",
            reasoning_effort="max",
            stop_before="T18-A",
            protect_findings=True,
        )
        self.handoff_path = root / "T01-C-handoff.txt"
        self.handoff_text = valid_handoff(commit=self.head)
        self.handoff_path.write_text(self.handoff_text, encoding="utf-8")


class CodexCapabilityTests(unittest.TestCase):
    def test_detects_explicit_full_autonomy_and_read_only_reviewer_modes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "codex"
            write_executable(
                executable,
                """#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s\n' '--dangerously-bypass-approvals-and-sandbox' '--sandbox <MODE> read-only danger-full-access'
else
  printf '%s\n' '--ask-for-approval <POLICY>' 'never' '--sandbox <MODE> read-only danger-full-access'
fi
""",
            )
            capabilities = supervisor.detect_codex_capabilities(str(executable))
        self.assertEqual(
            capabilities.full_autonomy_flags,
            ("--dangerously-bypass-approvals-and-sandbox",),
        )
        self.assertEqual(
            capabilities.reviewer_prefix_flags,
            ("--ask-for-approval", "never"),
        )
        self.assertEqual(capabilities.reviewer_exec_flags, ("--sandbox", "read-only"))

    def test_refuses_interactive_or_workspace_only_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "codex"
            write_executable(
                executable,
                """#!/bin/sh
printf '%s\n' '--full-auto' '--sandbox <MODE> read-only workspace-write'
""",
            )
            with self.assertRaisesRegex(supervisor.SupervisorError, "full-autonomy"):
                supervisor.detect_codex_capabilities(str(executable))

    def test_child_environment_removes_arbitrary_credential_variables(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            with patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin",
                    "CODEX_CI": "1",
                    "UNRELATED_API_KEY": "must-not-reach-child",
                    "VENDOR_ACCESS_TOKEN": "must-not-reach-child",
                },
                clear=True,
            ):
                environment = supervisor.Supervisor(fixture.config)._child_environment()
                node_parent = str(fixture.node.resolve().parent)

        self.assertEqual(environment["CODEX_CI"], "1")
        self.assertNotIn("UNRELATED_API_KEY", environment)
        self.assertNotIn("VENDOR_ACCESS_TOKEN", environment)
        self.assertTrue(environment["PATH"].startswith(node_parent))

    def test_efficient_reviewer_profile_denies_repo_writes_and_findings_reads(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repo"
            repository.mkdir()
            protected = repository / "FINDINGS.md"
            protected.write_text("private\n", encoding="utf-8")
            profile = root / "reviewer.sb"
            supervisor._write_read_only_reviewer_profile(profile, repository)
            profile_text = profile.read_text(encoding="utf-8")

            self.assertIn("file-write*", profile_text)
            self.assertIn("FINDINGS.md", profile_text)
            if Path("/usr/bin/sandbox-exec").is_file():
                write_attempt = subprocess.run(
                    (
                        "/usr/bin/sandbox-exec",
                        "-f",
                        str(profile),
                        "/bin/sh",
                        "-c",
                        f"touch {repository / 'new.txt'}",
                    ),
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                read_attempt = subprocess.run(
                    (
                        "/usr/bin/sandbox-exec",
                        "-f",
                        str(profile),
                        "/bin/cat",
                        str(protected),
                    ),
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                self.assertNotEqual(write_attempt.returncode, 0)
                self.assertNotEqual(read_attempt.returncode, 0)

    def test_external_reviewer_sandbox_changes_only_efficient_command_mode(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            capabilities = supervisor.detect_codex_capabilities(str(fixture.codex))
            review = supervisor.Supervisor(fixture.config)
            strict_command = review._reviewer_command(capabilities)
            efficient_command = review._reviewer_command(
                capabilities, externally_sandboxed=True
            )

        self.assertIn("--ask-for-approval", strict_command)
        self.assertIn("read-only", strict_command)
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", efficient_command)
        self.assertNotIn("--sandbox", efficient_command)


class SupervisorLockTests(unittest.TestCase):
    def test_second_supervisor_process_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            with supervisor.supervisor_lock(fixture.config):
                with self.assertRaisesRegex(
                    supervisor.SupervisorError, "already running"
                ):
                    with supervisor.supervisor_lock(fixture.config):
                        self.fail("second lock unexpectedly acquired")


class GitBoundaryTests(unittest.TestCase):
    def test_validates_commit_and_subject_against_git(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            supervisor.validate_commit_boundary(
                fixture.repo,
                fixture.head,
                "refactor: add the top-level assistant engine seam",
            )
            with self.assertRaisesRegex(supervisor.SupervisorError, "subject"):
                supervisor.validate_commit_boundary(
                    fixture.repo, fixture.head, "wrong subject"
                )

    def test_dirty_worktree_allows_only_untracked_findings(self) -> None:
        supervisor.validate_dirty_entries(())
        supervisor.validate_dirty_entries((("??", "FINDINGS.md"),))
        for entries in (
            ((" M", "src/changed.ts"),),
            (("??", "other.txt"),),
            ((" M", "FINDINGS.md"),),
        ):
            with self.subTest(entries=entries):
                with self.assertRaises(supervisor.SupervisorError):
                    supervisor.validate_dirty_entries(entries)

    def test_frozen_path_validation_is_fail_closed(self) -> None:
        pack = supervisor.PromptPack.parse(PACK_TEXT)
        allowed = supervisor.derive_allowed_path_specs(
            pack.prompt("T01-D"), pack.required_contracts_for("T01-D"), ""
        )
        supervisor.validate_frozen_paths(
            (
                "scripts/evidence/release-evidence.ts",
                "tests/unit/release-evidence.test.ts",
                "CLAUDE.md",
                "AGENTS.md",
            ),
            allowed,
        )
        with self.assertRaisesRegex(supervisor.SupervisorError, "frozen scope"):
            supervisor.validate_frozen_paths(("src/unrelated.ts",), allowed)

    def test_git_staging_audit_parses_shell_wrapped_explicit_paths(self) -> None:
        pack = supervisor.PromptPack.parse(PACK_TEXT)
        allowed = supervisor.derive_allowed_path_specs(
            pack.prompt("T01-D"), pack.required_contracts_for("T01-D"), ""
        )

        self.assertIsNone(
            supervisor.audit_git_staging(
                "/bin/zsh -lc 'git add -- AGENTS.md CLAUDE.md "
                "scripts/evidence/release-evidence.ts "
                "tests/unit/release-evidence.test.ts'",
                allowed,
            )
        )
        self.assertEqual(
            supervisor.audit_git_staging(
                "/bin/zsh -lc 'git add -- AGENTS.md src/unrelated.ts'",
                allowed,
            ),
            "Git staging command exceeds frozen scope",
        )
        self.assertEqual(
            supervisor.audit_git_staging(
                "/bin/zsh --no-rcs -lc 'git add -- src/unrelated.ts'",
                allowed,
            ),
            "Git staging command exceeds frozen scope",
        )
        self.assertEqual(
            supervisor.audit_git_staging(
                "git add -- src/unrelated.ts; /bin/zsh -lc 'echo reviewed'",
                allowed,
            ),
            "Git staging command exceeds frozen scope",
        )

    def test_focused_task_tests_resolve_from_the_canonical_task_plan(self) -> None:
        prompt = supervisor.Prompt(
            "T04-E",
            "Annotate invoice actions",
            """## Prompt T04-E: Annotate invoice actions

**Frozen files:** `src/harness/workflows/invoices.ts`, focused Task 4/invoice tests, `CLAUDE.md`, `AGENTS.md`.

**Focused gate:** Task 4 metadata/fingerprint/mutation tests plus invoice workflow/hardening tests.
""",
            "COMPLETE T04-D",
            "docs: annotate invoice API action metadata",
            (),
        )
        plan_context = """## Task 4: API action metadata

- `src/harness/workflows/invoices.ts`
- `tests/unit/api-action-inventory.test.ts`
"""
        allowed = supervisor.derive_allowed_path_specs(prompt, (), plan_context)

        supervisor.validate_frozen_paths(
            (
                "src/harness/workflows/invoices.ts",
                "tests/unit/api-action-inventory.test.ts",
            ),
            allowed,
        )
        with self.assertRaisesRegex(supervisor.SupervisorError, "frozen scope"):
            supervisor.validate_frozen_paths(("tests/unit/unrelated.test.ts",), allowed)

    def test_task_4_closure_includes_required_metadata_carrier_fixtures(self) -> None:
        prompt = supervisor.Prompt(
            "T04-K",
            "Close metadata migration",
            """## Prompt T04-K: Close metadata migration

**Frozen files:** Modify metadata carrier types/builders, all Task 4 tests, and only annotation files needed to fix a generator-detected omission.
""",
            "COMPLETE T04-J",
            "feat: generate the complete API action inventory",
            (),
        )
        plan_context = """## Task 4: API action metadata

- `tests/unit/api-action-inventory.test.ts`
"""
        allowed = supervisor.derive_allowed_path_specs(prompt, (), plan_context)

        supervisor.validate_frozen_paths(
            (
                "tests/unit/define-builders.test.ts",
                "tests/unit/executor-fail-closed.test.ts",
                "tests/unit/safe-write-clarification.test.ts",
            ),
            allowed,
        )
        self.assertIsNone(
            supervisor.audit_git_staging(
                "git add -- tests/unit/define-builders.test.ts "
                "tests/unit/executor-fail-closed.test.ts "
                "tests/unit/safe-write-clarification.test.ts",
                allowed,
            )
        )
        with self.assertRaisesRegex(supervisor.SupervisorError, "frozen scope"):
            supervisor.validate_frozen_paths(("tests/unit/unrelated.test.ts",), allowed)

    def test_named_unit_tests_resolve_from_the_focused_gate_only(self) -> None:
        prompt = supervisor.Prompt(
            "T01-D",
            "Quarantine evidence",
            """## Prompt T01-D: Quarantine evidence

**Frozen files:**

- `scripts/evidence/release-evidence.ts`;
- their four named unit tests from Task 1;
- `CLAUDE.md`, `AGENTS.md` only for synchronized truth.

**Focused gate:**

```bash
npx vitest run tests/unit/deepseek-release-evidence.test.ts tests/unit/live-browser-acceptance-evidence.test.ts tests/unit/private-production-release-evidence.test.ts tests/unit/release-evidence.test.ts
```

**Task gate:**

```bash
npx vitest run tests/unit/config.test.ts tests/integration/routes.test.ts
```
""",
            "COMPLETE T01-C",
            "docs: quarantine evidence",
            (),
        )
        allowed = supervisor.derive_allowed_path_specs(prompt, (), "")

        supervisor.validate_frozen_paths(
            (
                "tests/unit/deepseek-release-evidence.test.ts",
                "tests/unit/live-browser-acceptance-evidence.test.ts",
                "tests/unit/private-production-release-evidence.test.ts",
                "tests/unit/release-evidence.test.ts",
            ),
            allowed,
        )
        with self.assertRaisesRegex(supervisor.SupervisorError, "frozen scope"):
            supervisor.validate_frozen_paths(("tests/unit/config.test.ts",), allowed)

    def test_path_extraction_rejects_parent_paths_and_keeps_guidance_at_root(
        self,
    ) -> None:
        paths = supervisor._extract_path_specs(
            "`src/harness/action.ts`, `CLAUDE.md`, `AGENTS.md`, `../sibling/secret.ts`"
        )

        self.assertIn("src/harness/action.ts", paths.exact)
        self.assertIn("CLAUDE.md", paths.exact)
        self.assertIn("AGENTS.md", paths.exact)
        self.assertNotIn("src/harness/CLAUDE.md", paths.exact)
        self.assertFalse(any(path.startswith("..") for path in paths.exact))

    def test_semantic_scope_uses_matching_paths_from_the_task_plan_only(self) -> None:
        prompt = supervisor.Prompt(
            "T16-C",
            "Extract run and confirmation services",
            """## Prompt T16-C: Extract run and confirmation services

**Frozen files:** The run and confirmation services, runner, focused tests, dependency wiring, guidance files.
""",
            "COMPLETE T16-B",
            "refactor: extract services",
            (),
        )
        plan = """## Task 16: Services

- `src/services/run-service.ts`
- `src/services/confirmation-service.ts`
- `src/services/metrics-service.ts`
- `src/assistant-v2/runner.ts`
- `tests/unit/v2-service-contracts.test.ts`

## Task 17: Evaluation

- `scripts/eval-v2/run.ts`
"""
        context = supervisor.extract_task_plan_context(plan, prompt.prompt_id)
        allowed = supervisor.derive_allowed_path_specs(prompt, (), context)

        supervisor.validate_frozen_paths(
            (
                "src/services/run-service.ts",
                "src/services/confirmation-service.ts",
                "src/assistant-v2/runner.ts",
            ),
            allowed,
        )
        with self.assertRaisesRegex(supervisor.SupervisorError, "frozen scope"):
            supervisor.validate_frozen_paths(
                ("src/services/metrics-service.ts",), allowed
            )
        self.assertNotIn("scripts/eval-v2/run.ts", allowed.exact)


class AdoptionAndStopTests(unittest.TestCase):
    def test_adopt_validates_boundary_and_preserves_handoff_verbatim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            state = supervisor.Supervisor(fixture.config).adopt(
                completed="T01-C", handoff_path=fixture.handoff_path
            )
            self.assertEqual(state["last_completed_prompt"], "T01-C")
            self.assertEqual(state["last_commit"], fixture.head)
            self.assertEqual(state["next_prompt"], "T01-D")
            saved = fixture.state_dir / "handoffs" / "T01-C.txt"
            self.assertEqual(saved.read_bytes(), fixture.handoff_path.read_bytes())
            self.assertEqual(git(fixture.repo, "status", "--porcelain"), "")

    def test_adopt_rejects_wrong_next_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            fixture.handoff_path.write_text(
                valid_handoff(commit=fixture.head, next_prompt="T04-K"),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(supervisor.SupervisorError, "next prompt"):
                supervisor.Supervisor(fixture.config).adopt(
                    completed="T01-C", handoff_path=fixture.handoff_path
                )

    def test_reviewer_pair_and_t18_are_hard_stop_boundaries(self) -> None:
        pack = supervisor.PromptPack.parse(PACK_TEXT)
        self.assertEqual(supervisor.next_action_kind(pack, "T04-R1"), "reviewer_pair")
        with self.assertRaises(supervisor.StopBoundary):
            supervisor.enforce_stop_boundary(pack, "T18-A", "T18-A")


class PromptAssemblyTests(unittest.TestCase):
    def test_child_prompt_contains_only_required_pack_sections_and_prior_handoff(
        self,
    ) -> None:
        pack = supervisor.PromptPack.parse(PACK_TEXT)
        assembled = supervisor.build_child_prompt(
            pack,
            "T01-D",
            valid_handoff(),
        )
        self.assertIn("## Base Execution Contract", assembled)
        self.assertIn("## Prompt T01-D: Quarantine evidence", assembled)
        self.assertIn("SLICE HANDOFF", assembled)
        self.assertIn("You have full local implementation authority", assembled)
        self.assertNotIn("## Prompt T04-K", assembled)

    def test_contract_dependencies_and_reviewer_reports_are_explicit(self) -> None:
        pack = supervisor.PromptPack.parse(PACK_TEXT)
        task12 = supervisor.build_child_prompt(pack, "T12-A", valid_handoff())
        self.assertIn("## Task 10 Read-Parity Slice Contract", task12)
        self.assertIn("## Task 12 Write-Parity Slice Contract", task12)

        remediation = supervisor.build_child_prompt(
            pack,
            "T04-R3",
            valid_handoff(
                prompt="T04-K",
                title="Generate inventory",
                next_prompt="T04-R1 and T04-R2",
            ),
            reviewer_reports={"T04-R1": "review A", "T04-R2": "review B"},
        )
        self.assertIn("review A", remediation)
        self.assertIn("review B", remediation)


class ManagedProcessTests(unittest.TestCase):
    def test_efficient_group_stops_on_blocked_or_invalid_checkpoint(self) -> None:
        self.assertIn(
            "group_prompt_ids",
            inspect.signature(supervisor.run_managed_process).parameters,
        )
        valid = valid_handoff(
            prompt="T04-E",
            title="E",
            commit="1" * 40,
            subject="commit T04-E",
            next_prompt="T04-F",
        )
        self.assertIsNone(
            supervisor.audit_group_checkpoint_message(
                valid, expected_prompt_ids=("T04-E", "T04-F")
            )
        )
        cases = (
            (
                "blocked",
                valid.replace("Status: COMPLETE", "Status: BLOCKED").replace(
                    f"Commit: {'1' * 40} commit T04-E", "Commit: NONE"
                ),
                "Status BLOCKED",
            ),
            ("invalid", "SLICE HANDOFF\nPrompt: T04-E: E\n", "invalid"),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, message, expected_reason in cases:
                with self.subTest(name=name):
                    case_root = root / name
                    case_root.mkdir()
                    marker = case_root / "continued"
                    executable = case_root / "child"
                    write_executable(
                        executable,
                        f"""#!/usr/bin/env python3
import json
from pathlib import Path
import time

print(json.dumps({{
    "type": "item.completed",
    "item": {{"type": "agent_message", "text": {message!r}}},
}}), flush=True)
time.sleep(0.7)
Path({str(marker)!r}).write_text("continued\\n", encoding="utf-8")
""",
                    )
                    result = supervisor.run_managed_process(
                        command=(str(executable),),
                        prompt="group prompt",
                        cwd=case_root,
                        timeout_seconds=2.0,
                        events_path=case_root / "events.jsonl",
                        stderr_path=case_root / "stderr.log",
                        final_path=case_root / "final.txt",
                        group_prompt_ids=("T04-E", "T04-F"),
                    )
                    time.sleep(0.8)

                    self.assertIn(expected_reason, result.violation or "")
                    self.assertFalse(marker.exists())

    def test_secret_detection_allows_typed_api_key_identifiers(self) -> None:
        source = "\n".join(
            (
                'api_key: assertAvailabilityDecision(actionName, "api_key", value.api_key),',
                (
                    "availabilityByAuthClass?: { addon: AvailabilityDecision; "
                    "api_key: AvailabilityDecision };"
                ),
            )
        )

        self.assertIsNone(supervisor.secret_violation(source))

    def test_secret_detection_keeps_literal_assignments_fail_closed(self) -> None:
        for assignment in (
            "API_KEY=abcdefghijklmnop",
            'api_key: "abcdefghijklmnop"',
            "password: abcdefghijklmnop123",
        ):
            with self.subTest(assignment=assignment):
                self.assertEqual(
                    supervisor.secret_violation(assignment),
                    "secret-like value detected: credential-like assignment",
                )

    def test_timeout_terminates_the_complete_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "slow-child"
            marker = root / "grandchild-finished"
            body = (
                "#!/bin/sh\n"
                f"(sleep 1.2; printf done > '{marker}') &\n"
                'printf \'%s\\n\' \'{"type":"status","message":"started"}\'\n'
                "sleep 5\n"
            )
            write_executable(executable, body)
            result = supervisor.run_managed_process(
                command=(str(executable),),
                prompt="test prompt",
                cwd=root,
                timeout_seconds=0.4,
                events_path=root / "events.jsonl",
                stderr_path=root / "stderr.log",
                final_path=root / "final.txt",
            )
            time.sleep(1.3)
            self.assertTrue(result.timed_out)
            self.assertFalse(marker.exists())
            self.assertIn("started", (root / "events.jsonl").read_text())

    def test_structured_event_audit_rejects_forbidden_actions(self) -> None:
        cases = {
            "findings": "sed -n '1,20p' FINDINGS.md",
            "push": "git push origin main",
            "merge": "git merge feature-branch",
            "broad staging": "git add -A",
            "deployment": "npm run deploy:private-production",
            "live write": "LIVE_CLOCKIFY=1 npm run live:v2-full",
        }
        for name, command in cases.items():
            with self.subTest(name=name):
                event = {"item": {"type": "command_execution", "command": command}}
                self.assertIsNotNone(supervisor.audit_structured_event(event))

    def test_structured_event_audit_allows_read_only_merge_base(self) -> None:
        event = {
            "item": {
                "type": "command_execution",
                "command": (
                    "git merge-base --is-ancestor "
                    "d0f29bc90c28e42d052db441a414abcb37865681 HEAD"
                ),
            }
        }

        self.assertIsNone(supervisor.audit_structured_event(event))

    def test_structured_event_audit_allows_findings_exclusion_glob(self) -> None:
        event = {
            "item": {
                "type": "command_execution",
                "command": "rg -n -g '!FINDINGS.md' 'release evidence' .",
            }
        }

        self.assertIsNone(supervisor.audit_structured_event(event))

    def test_structured_event_audit_allows_path_only_staging_check(self) -> None:
        event = {
            "item": {
                "type": "command_execution",
                "command": (
                    "if git diff --cached --name-only | rg -qx 'FINDINGS.md'; "
                    "then echo staged; else echo not-staged; fi"
                ),
            }
        }

        self.assertIsNone(supervisor.audit_structured_event(event))

    def test_path_only_staging_check_does_not_mask_a_content_read(self) -> None:
        event = {
            "item": {
                "type": "command_execution",
                "command": (
                    "if git diff --cached --name-only | rg -qx 'FINDINGS.md'; "
                    "then echo staged; else echo not-staged; fi\n"
                    "sed -n '1,20p' FINDINGS.md"
                ),
            }
        }

        self.assertEqual(
            supervisor.audit_structured_event(event),
            "attempted FINDINGS.md access",
        )

    def test_structured_event_audit_allows_exact_git_diff_exclusion(self) -> None:
        event = {
            "item": {
                "type": "command_execution",
                "command": (
                    '/bin/zsh -lc "if git diff --no-ext-diff -- . '
                    "':(exclude)FINDINGS.md' | LC_ALL=C rg -q 'secret'; "
                    'then exit 1; else echo clean; fi"'
                ),
            }
        }

        self.assertIsNone(supervisor.audit_structured_event(event))

    def test_git_diff_exclusion_does_not_mask_a_second_content_path(self) -> None:
        event = {
            "item": {
                "type": "command_execution",
                "command": (
                    "git diff --no-ext-diff -- . ':(exclude)FINDINGS.md' FINDINGS.md"
                ),
            }
        }

        self.assertEqual(
            supervisor.audit_structured_event(event),
            "attempted FINDINGS.md access",
        )

    def test_structured_event_audit_allows_gh_token_pattern_as_rg_argument(
        self,
    ) -> None:
        event = {
            "item": {
                "type": "command_execution",
                "command": "git diff | rg -n 'gh[pousr]_[A-Za-z0-9]+'",
            }
        }

        self.assertIsNone(supervisor.audit_structured_event(event))

    def test_structured_event_audit_rejects_external_admin_executables(self) -> None:
        for command in ("gh pr create", "railway status", "git diff | gh pr create"):
            with self.subTest(command=command):
                event = {"item": {"type": "command_execution", "command": command}}
                self.assertEqual(
                    supervisor.audit_structured_event(event),
                    "forbidden external administration command",
                )

    def test_findings_guard_denies_file_content_reads(self) -> None:
        supervisor.validate_findings_guard_support()


def install_committing_fake_codex(fixture: RepositoryFixture) -> None:
    script = r'''#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import sys

args = sys.argv[1:]
if args == ["exec", "--help"]:
    print("--dangerously-bypass-approvals-and-sandbox")
    print("--sandbox <MODE> read-only danger-full-access")
    raise SystemExit(0)
if args == ["--help"]:
    print("--ask-for-approval <POLICY> never")
    print("--sandbox <MODE> read-only danger-full-access")
    raise SystemExit(0)

sys.stdin.read()
repo = Path.cwd()
(repo / "scripts" / "evidence").mkdir(parents=True, exist_ok=True)
(repo / "scripts" / "evidence" / "release-evidence.ts").write_text(
    "export const historical = true;\n", encoding="utf-8"
)
checkpoint = (
    "# Guide\n\n## Current v2 implementation checkpoint\n\n"
    "- T01-D is complete. Next: T04-K.\n\n## Other\n"
)
(repo / "CLAUDE.md").write_text(checkpoint, encoding="utf-8")
(repo / "AGENTS.md").write_text(checkpoint, encoding="utf-8")
subprocess.run(
    [
        "git",
        "add",
        "--",
        "scripts/evidence/release-evidence.ts",
        "CLAUDE.md",
        "AGENTS.md",
    ],
    check=True,
)
subprocess.run(
    ["git", "commit", "-m", "docs: quarantine evidence"],
    check=True,
    stdout=subprocess.DEVNULL,
)
sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
handoff = f"""SLICE HANDOFF
Prompt: T01-D: Quarantine evidence
Status: COMPLETE
Commit: {sha} docs: quarantine evidence
Invariant delivered: old evidence is quarantined
Files changed: scripts/evidence/release-evidence.ts, CLAUDE.md, AGENTS.md
Red evidence: npx vitest run tests/unit/release-evidence.test.ts failed as intended
Green evidence: npx vitest run tests/unit/release-evidence.test.ts passed; npm run verify passed
Docs synchronized: CLAUDE.md=updated; AGENTS.md=updated
Generated artifacts: none
Live/external actions: NONE
Worktree: clean
Next prompt: T04-K
Blockers/not evaluated: none
"""
print(
    json.dumps(
        {"type": "item.completed", "item": {"type": "agent_message", "text": handoff}}
    ),
    flush=True,
)
'''
    write_executable(fixture.codex, script)


def prepare_reviewer_boundary(fixture: RepositoryFixture) -> str:
    (fixture.repo / "scripts").mkdir(exist_ok=True)
    (fixture.repo / "scripts" / "generate-inventory.ts").write_text(
        "export const inventory = true;\n", encoding="utf-8"
    )
    checkpoint = (
        "# Guide\n\n## Current v2 implementation checkpoint\n\n"
        "- T04-K is complete. Next: T04-R1 and T04-R2.\n\n## Other\n"
    )
    (fixture.repo / "CLAUDE.md").write_text(checkpoint, encoding="utf-8")
    (fixture.repo / "AGENTS.md").write_text(checkpoint, encoding="utf-8")
    git(
        fixture.repo,
        "add",
        "--",
        "scripts/generate-inventory.ts",
        "CLAUDE.md",
        "AGENTS.md",
    )
    git(fixture.repo, "commit", "-m", "feat: generate inventory")
    immutable_sha = git(fixture.repo, "rev-parse", "HEAD")
    handoff = valid_handoff(
        prompt="T04-K",
        title="Generate inventory",
        commit=immutable_sha,
        subject="feat: generate inventory",
        next_prompt="T04-R1 and T04-R2",
    )
    handoff_path = fixture.state_dir / "handoffs" / "T04-K.txt"
    handoff_path.write_text(handoff, encoding="utf-8")
    instance = supervisor.Supervisor(fixture.config)
    state = instance.load_state()
    state["last_completed_prompt"] = "T04-K"
    state["last_commit"] = immutable_sha
    state["next_prompt"] = "T04-R1"
    state["current_status"] = "ready"
    state["reviewer_boundary_state"] = {
        "status": "pending",
        "reviewers": ["T04-R1", "T04-R2"],
        "immutable_sha": immutable_sha,
        "reports": {},
    }
    instance._write_state(state)
    return immutable_sha


def install_read_only_reviewer_fake(fixture: RepositoryFixture) -> None:
    script = r"""#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
if args == ["exec", "--help"]:
    print("--dangerously-bypass-approvals-and-sandbox")
    print("--sandbox <MODE> read-only danger-full-access")
    raise SystemExit(0)
if args == ["--help"]:
    print("--ask-for-approval <POLICY> never")
    print("--sandbox <MODE> read-only danger-full-access")
    raise SystemExit(0)
prompt = sys.stdin.read()
reviewer = "T04-R1" if "## Prompt T04-R1:" in prompt else "T04-R2"
report = f"{reviewer} immutable review: zero findings"
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": report}}), flush=True)
"""
    write_executable(fixture.codex, script)


class SupervisorExecutionTests(unittest.TestCase):
    def test_step_advances_only_after_independent_commit_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            instance = supervisor.Supervisor(fixture.config)
            instance.adopt(completed="T01-C", handoff_path=fixture.handoff_path)
            install_committing_fake_codex(fixture)

            state = instance.step()

            self.assertEqual(state["last_completed_prompt"], "T01-D")
            self.assertEqual(state["next_prompt"], "T04-K")
            self.assertEqual(state["current_status"], "ready")
            self.assertNotEqual(state["last_commit"], fixture.head)
            self.assertEqual(
                git(fixture.repo, "rev-list", "--count", f"{fixture.head}..HEAD"),
                "1",
            )
            self.assertTrue((fixture.state_dir / "handoffs" / "T01-D.txt").is_file())

    def test_restart_after_interruption_retries_same_prompt_only_when_git_is_unchanged(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            instance = supervisor.Supervisor(fixture.config)
            state = instance.adopt(completed="T01-C", handoff_path=fixture.handoff_path)
            state["current_status"] = "running"
            state["active_run"] = {
                "prompt_id": "T01-D",
                "pre_head": fixture.head,
                "run_id": "interrupted",
                "final_response_path": str(
                    fixture.state_dir / "final-responses" / "missing.txt"
                ),
            }
            instance._write_state(state)

            recovered = supervisor.Supervisor(fixture.config).load_state(reconcile=True)

            self.assertEqual(recovered["current_status"], "blocked")
            self.assertEqual(recovered["next_prompt"], "T01-D")
            self.assertIn("interrupted", recovered["last_blocker"])

    def test_restart_recovers_verified_commit_without_rerunning_completed_prompt(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            instance = supervisor.Supervisor(fixture.config)
            state = instance.adopt(completed="T01-C", handoff_path=fixture.handoff_path)
            install_committing_fake_codex(fixture)
            completed = subprocess.run(
                [str(fixture.codex), "exec"],
                cwd=fixture.repo,
                input="ignored",
                text=True,
                check=True,
                stdout=subprocess.PIPE,
            )
            event = json.loads(completed.stdout)
            final_response = event["item"]["text"]
            final_path = fixture.state_dir / "final-responses" / "interrupted.txt"
            final_path.write_text(final_response, encoding="utf-8")
            state["current_status"] = "running"
            state["active_run"] = {
                "prompt_id": "T01-D",
                "pre_head": fixture.head,
                "run_id": "interrupted-after-commit",
                "final_response_path": str(final_path),
            }
            instance._write_state(state)

            recovered = supervisor.Supervisor(fixture.config).load_state(reconcile=True)

            self.assertEqual(recovered["last_completed_prompt"], "T01-D")
            self.assertEqual(recovered["next_prompt"], "T04-K")
            self.assertEqual(recovered["current_status"], "ready")
            self.assertTrue((fixture.state_dir / "handoffs" / "T01-D.txt").is_file())

    def test_stale_state_versus_git_requires_manual_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            instance = supervisor.Supervisor(fixture.config)
            instance.adopt(completed="T01-C", handoff_path=fixture.handoff_path)
            (fixture.repo / "extra.txt").write_text("unexpected\n", encoding="utf-8")
            git(fixture.repo, "add", "--", "extra.txt")
            git(fixture.repo, "commit", "-m", "unexpected commit")

            with self.assertRaisesRegex(
                supervisor.SupervisorError, "manual reconciliation"
            ):
                supervisor.Supervisor(fixture.config).validate()

    def test_t04_reviewer_pair_is_independent_read_only_and_stops_before_r3(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            instance = supervisor.Supervisor(fixture.config)
            instance.adopt(completed="T01-C", handoff_path=fixture.handoff_path)
            immutable_sha = prepare_reviewer_boundary(fixture)
            install_read_only_reviewer_fake(fixture)

            state = instance.step()

            self.assertEqual(git(fixture.repo, "rev-parse", "HEAD"), immutable_sha)
            self.assertEqual(state["current_status"], "review_complete")
            self.assertEqual(state["next_prompt"], "T04-R3")
            review_state = state["reviewer_boundary_state"]
            self.assertEqual(review_state["status"], "reports_complete")
            self.assertEqual(set(review_state["reports"]), {"T04-R1", "T04-R2"})
            for reviewer_id, report_path in review_state["reports"].items():
                report = Path(report_path).read_text(encoding="utf-8")
                self.assertIn(reviewer_id, report)
                self.assertIn("zero findings", report)

    def test_run_stops_before_t18_without_launching_a_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = RepositoryFixture(Path(directory))
            instance = supervisor.Supervisor(fixture.config)
            state = instance.adopt(completed="T01-C", handoff_path=fixture.handoff_path)
            checkpoint = (
                "# Guide\n\n## Current v2 implementation checkpoint\n\n"
                "- T17-G is complete. Next: T18-A.\n\n## Other\n"
            )
            (fixture.repo / "CLAUDE.md").write_text(checkpoint, encoding="utf-8")
            (fixture.repo / "AGENTS.md").write_text(checkpoint, encoding="utf-8")
            git(fixture.repo, "add", "--", "CLAUDE.md", "AGENTS.md")
            git(fixture.repo, "commit", "-m", "test: close local work")
            head = git(fixture.repo, "rev-parse", "HEAD")
            handoff = valid_handoff(
                prompt="T17-G",
                title="Close local work",
                commit=head,
                subject="test: close local work",
                next_prompt="T18-A",
            )
            (fixture.state_dir / "handoffs" / "T17-G.txt").write_text(
                handoff, encoding="utf-8"
            )
            state["last_completed_prompt"] = "T17-G"
            state["last_commit"] = head
            state["next_prompt"] = "T18-A"
            instance._write_state(state)

            stopped = instance.run_until(stop_before="T18-A")

            self.assertEqual(stopped["current_status"], "boundary_reached")
            self.assertEqual(stopped["next_prompt"], "T18-A")
            self.assertIn("stopped before T18-A", stopped["last_blocker"])

            efficient = supervisor.Supervisor(
                replace(
                    fixture.config,
                    execution_profile="efficient",
                    efficient_prompt_groups=(),
                )
            )
            efficiently_stopped = efficient.run_until(stop_before="T18-A")
            self.assertEqual(efficiently_stopped["current_status"], "boundary_reached")
            self.assertEqual(efficiently_stopped["next_prompt"], "T18-A")


if __name__ == "__main__":
    unittest.main()
