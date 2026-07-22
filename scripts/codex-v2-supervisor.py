#!/usr/bin/env python3
"""Fail-closed local supervisor for the atomic API assistant v2 prompt pack."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import fnmatch
import hashlib
import json
import os
import platform
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterable, Iterator, Mapping


PROMPT_ID_RE = re.compile(r"\bT\d{2}(?:-[A-Z0-9]+)+\b")


class SupervisorError(RuntimeError):
    """A fail-closed validation or execution error."""


class StopBoundary(SupervisorError):
    """A deliberate operator/reviewer/late-task stop boundary."""


@dataclass(frozen=True)
class TaskContract:
    task_number: int
    title: str
    text: str


@dataclass(frozen=True)
class Prompt:
    prompt_id: str
    title: str
    text: str
    prerequisite: str
    commit_subject: str | None
    authorization_gates: tuple[str, ...]


@dataclass(frozen=True)
class PromptPack:
    text: str
    base_contract: str
    prompts: dict[str, Prompt]
    contracts: tuple[TaskContract, ...]
    order_items: tuple[str | tuple[str, ...], ...]
    repository_path: str
    implementation_plan_path: str
    declared_plan_sha256: str
    baseline_commit: str

    @classmethod
    def parse(cls, text: str) -> "PromptPack":
        base_match = re.search(
            r"(?ms)^## Base Execution Contract\s*$.*?(?=^## (?:Prompt |Task \d+ .*Contract\s*$|Prompt-order index\s*$))",
            text,
        )
        if base_match is None:
            raise SupervisorError("prompt pack is missing Base Execution Contract")

        prompts: dict[str, Prompt] = {}
        prompt_matches = list(
            re.finditer(r"(?m)^## Prompt (T\d{2}(?:-[A-Z0-9]+)+):\s*(.+?)\s*$", text)
        )
        for index, match in enumerate(prompt_matches):
            end_candidates = [len(text)]
            if index + 1 < len(prompt_matches):
                end_candidates.append(prompt_matches[index + 1].start())
            for boundary in re.finditer(
                r"(?m)^## (?:Task \d+ .*Contract|Prompt-order index)\s*$", text
            ):
                if boundary.start() > match.start():
                    end_candidates.append(boundary.start())
            section = text[match.start() : min(end_candidates)].rstrip() + "\n"
            prompt_id = match.group(1)
            if prompt_id in prompts:
                raise SupervisorError(f"duplicate prompt section: {prompt_id}")
            prerequisite = _bold_field(section, "Prerequisite")
            if not prerequisite:
                prerequisite = _bold_field(section, "Prerequisites")
            commit_value = _bold_field(section, "Commit")
            commit_subject = _first_code_span(commit_value) if commit_value else None
            if commit_value and re.search(r"\bNone\b", commit_value, re.IGNORECASE):
                commit_subject = None
            gate_candidates = [
                _bold_field(section, field)
                for field in (
                    "Prerequisite",
                    "Prerequisites",
                    "Stop",
                    "Stop boundary",
                )
            ]
            gate_candidates.extend(
                line.strip()
                for line in section.splitlines()
                if re.match(
                    r"^\s*(?:\d+\.\s+)?(?:Only after|Before .* requires)",
                    line,
                    re.IGNORECASE,
                )
            )
            gates = tuple(
                candidate
                for candidate in gate_candidates
                if candidate
                and re.search(
                    r"\b(?:explicit|separate|operator|external|signed)\b.*"
                    r"\b(?:authority|authorization|gate|branch)\b",
                    candidate,
                    re.IGNORECASE | re.DOTALL,
                )
            )
            prompts[prompt_id] = Prompt(
                prompt_id=prompt_id,
                title=match.group(2).strip(),
                text=section,
                prerequisite=prerequisite,
                commit_subject=commit_subject,
                authorization_gates=gates,
            )

        if not prompts:
            raise SupervisorError("prompt pack contains no prompt sections")

        contracts: list[TaskContract] = []
        contract_matches = list(
            re.finditer(r"(?m)^## Task (\d+) (.+Contract)\s*$", text)
        )
        for match in contract_matches:
            following = [
                candidate.start()
                for candidate in prompt_matches
                if candidate.start() > match.start()
            ]
            following.extend(
                candidate.start()
                for candidate in contract_matches
                if candidate.start() > match.start()
            )
            order_heading = re.search(
                r"(?m)^## Prompt-order index\s*$", text[match.end() :]
            )
            if order_heading is not None:
                following.append(match.end() + order_heading.start())
            end = min(following, default=len(text))
            contracts.append(
                TaskContract(
                    task_number=int(match.group(1)),
                    title=f"Task {match.group(1)} {match.group(2).strip()}",
                    text=text[match.start() : end].rstrip() + "\n",
                )
            )

        order_match = re.search(
            r"(?ms)^## Prompt-order index\s*$.*?```(?:text)?\s*\n(.*?)^```\s*$",
            text,
        )
        if order_match is None:
            raise SupervisorError("prompt pack is missing its prompt-order index")
        order_items: list[str | tuple[str, ...]] = []
        for raw_line in order_match.group(1).splitlines():
            line = raw_line.strip()
            if not line or line.lower().startswith("on signed failure"):
                continue
            ids = PROMPT_ID_RE.findall(line)
            if not ids:
                continue
            if "+" in line and "->" in line:
                before, after = line.split("->", 1)
                pair: tuple[str, ...] = tuple(PROMPT_ID_RE.findall(before))
                if len(pair) < 2:
                    raise SupervisorError(f"malformed reviewer pair: {line}")
                order_items.append(pair)
                order_items.extend(PROMPT_ID_RE.findall(after))
            else:
                order_items.extend(ids)

        flattened = [
            prompt_id
            for item in order_items
            for prompt_id in ((item,) if isinstance(item, str) else item)
        ]
        missing = [prompt_id for prompt_id in flattened if prompt_id not in prompts]
        if missing:
            raise SupervisorError(
                "prompt-order index references missing sections: " + ", ".join(missing)
            )
        if len(flattened) != len(set(flattened)):
            raise SupervisorError("prompt-order index contains duplicate prompt IDs")

        return cls(
            text=text,
            base_contract=base_match.group(0).rstrip() + "\n",
            prompts=prompts,
            contracts=tuple(contracts),
            order_items=tuple(order_items),
            repository_path=_metadata_path(text, "repository"),
            implementation_plan_path=_metadata_path(
                text, "canonical implementation plan"
            ),
            declared_plan_sha256=_metadata_hash(text, "plan SHA-256", 64),
            baseline_commit=_metadata_hash(text, "baseline repository commit", 40),
        )

    @property
    def ordered_prompt_ids(self) -> tuple[str, ...]:
        return tuple(
            prompt_id
            for item in self.order_items
            for prompt_id in ((item,) if isinstance(item, str) else item)
        )

    def prompt(self, prompt_id: str) -> Prompt:
        try:
            return self.prompts[prompt_id]
        except KeyError as error:
            raise SupervisorError(f"unknown prompt ID: {prompt_id}") from error

    def expected_next(self, prompt_id: str) -> tuple[str, ...]:
        for index, item in enumerate(self.order_items):
            ids = (item,) if isinstance(item, str) else item
            if prompt_id not in ids:
                continue
            if not isinstance(item, str):
                if index + 1 >= len(self.order_items):
                    return ()
                following = self.order_items[index + 1]
                return (following,) if isinstance(following, str) else following
            if index + 1 >= len(self.order_items):
                return ()
            following = self.order_items[index + 1]
            return (following,) if isinstance(following, str) else following
        raise SupervisorError(f"prompt ID is not in the order index: {prompt_id}")

    def required_contracts_for(self, prompt_id: str) -> tuple[TaskContract, ...]:
        prompt = self.prompt(prompt_id)
        task_match = re.match(r"T(\d{2})-", prompt_id)
        own_task = int(task_match.group(1)) if task_match else -1
        required: set[int] = set()
        if not re.fullmatch(r"T\d{2}-R\d+", prompt_id) and any(
            contract.task_number == own_task for contract in self.contracts
        ):
            required.add(own_task)

        searchable = (
            prompt.text
            + "\n"
            + "\n".join(
                contract.text
                for contract in self.contracts
                if contract.task_number in required
            )
        )
        for contract in self.contracts:
            title_pattern = re.escape(contract.title)
            shorthand_pattern = rf"Task\s+{contract.task_number}\b[^\n.]*?contract"
            if re.search(title_pattern, searchable, re.IGNORECASE) or re.search(
                shorthand_pattern, searchable, re.IGNORECASE
            ):
                required.add(contract.task_number)
        return tuple(
            contract
            for contract in sorted(self.contracts, key=lambda item: item.task_number)
            if contract.task_number in required
        )


HANDOFF_FIELDS: tuple[str, ...] = (
    "Prompt",
    "Status",
    "Commit",
    "Invariant delivered",
    "Files changed",
    "Red evidence",
    "Green evidence",
    "Docs synchronized",
    "Generated artifacts",
    "Live/external actions",
    "Worktree",
    "Next prompt",
    "Blockers/not evaluated",
)


@dataclass(frozen=True)
class Handoff:
    raw: str
    prompt_id: str
    prompt_title: str
    status: str
    commit_sha: str | None
    commit_subject: str | None
    fields: dict[str, str]
    next_prompt_ids: tuple[str, ...]


def parse_handoff(text: str) -> Handoff:
    if len(re.findall(r"(?m)^SLICE HANDOFF\s*$", text)) != 1:
        raise SupervisorError("final response must contain exactly one SLICE HANDOFF")
    lines = text.splitlines()
    marker_index = next(
        index for index, line in enumerate(lines) if line.strip() == "SLICE HANDOFF"
    )
    if any(line.strip() for line in lines[:marker_index]):
        raise SupervisorError("SLICE HANDOFF must be the complete final response")

    field_pattern = re.compile(
        r"^(" + "|".join(re.escape(field) for field in HANDOFF_FIELDS) + r"):\s*(.*)$"
    )
    parsed: dict[str, str] = {}
    current: str | None = None
    for line in lines[marker_index + 1 :]:
        match = field_pattern.match(line)
        if match:
            field_name = match.group(1)
            current = field_name
            if field_name in parsed:
                raise SupervisorError(f"duplicate handoff field: {field_name}")
            parsed[field_name] = match.group(2).strip()
        elif current is not None and line.strip():
            parsed[current] += " " + line.strip()
        elif line.strip():
            raise SupervisorError(f"unexpected handoff content: {line.strip()}")

    missing = [field for field in HANDOFF_FIELDS if not parsed.get(field)]
    if missing:
        raise SupervisorError("handoff is missing fields: " + ", ".join(missing))
    if parsed["Status"] not in {"COMPLETE", "BLOCKED"}:
        raise SupervisorError("handoff Status must be COMPLETE or BLOCKED")

    prompt_match = re.match(
        r"^(T\d{2}(?:-[A-Z0-9]+)+)(?:\s*[:\-—]\s*|\s+)(.+)$",
        parsed["Prompt"],
    )
    if prompt_match is None:
        raise SupervisorError("handoff Prompt must contain an ID and title")

    commit_sha: str | None
    commit_subject: str | None
    if parsed["Commit"] == "NONE":
        commit_sha = None
        commit_subject = None
    else:
        commit_match = re.match(r"^([0-9a-f]{40})\s+(.+)$", parsed["Commit"])
        if commit_match is None:
            raise SupervisorError("handoff Commit must contain a full SHA and subject")
        commit_sha, commit_subject = commit_match.groups()

    next_ids = tuple(PROMPT_ID_RE.findall(parsed["Next prompt"]))
    if not next_ids and parsed["Next prompt"].strip().upper() != "STOP":
        raise SupervisorError("handoff Next prompt must contain prompt IDs or STOP")

    return Handoff(
        raw=text,
        prompt_id=prompt_match.group(1),
        prompt_title=prompt_match.group(2).strip(),
        status=parsed["Status"],
        commit_sha=commit_sha,
        commit_subject=commit_subject,
        fields=parsed,
        next_prompt_ids=next_ids,
    )


def _bold_field(section: str, name: str) -> str:
    match = re.search(rf"(?m)^\*\*{re.escape(name)}:\*\*[ \t]*(.*)$", section)
    if match is None:
        return ""
    lines = [match.group(1)]
    for line in section[match.end() :].splitlines():
        if re.match(r"^\*\*[^*\n]+:\*\*", line) or re.match(r"^(?:##|---)\s*", line):
            break
        lines.append(line)
    return "\n".join(lines).strip()


def _first_code_span(value: str) -> str | None:
    match = re.search(r"`([^`]+)`", value)
    return match.group(1) if match else None


def _metadata_path(text: str, label: str) -> str:
    match = re.search(rf"(?mi)^- {re.escape(label)}:\s*`([^`]+)`\s*$", text)
    if match is None:
        raise SupervisorError(f"prompt pack is missing metadata: {label}")
    return match.group(1)


def _metadata_hash(text: str, label: str, length: int) -> str:
    match = re.search(
        rf"(?mi)^- {re.escape(label)}:\s*`([0-9a-f]{{{length}}})`\s*$", text
    )
    if match is None:
        raise SupervisorError(f"prompt pack is missing metadata: {label}")
    return match.group(1)


@dataclass(frozen=True)
class CodexCapabilities:
    full_autonomy_prefix_flags: tuple[str, ...]
    full_autonomy_exec_flags: tuple[str, ...]
    reviewer_prefix_flags: tuple[str, ...]
    reviewer_exec_flags: tuple[str, ...]
    help_text: str

    @property
    def full_autonomy_flags(self) -> tuple[str, ...]:
        return self.full_autonomy_prefix_flags + self.full_autonomy_exec_flags


def detect_codex_capabilities(executable: str) -> CodexCapabilities:
    exec_help = _command_output((executable, "exec", "--help"), timeout=10.0)
    root_help = _command_output((executable, "--help"), timeout=10.0)
    combined = re.search(
        r"(?m)^\s*(--[a-z0-9-]*bypass[a-z0-9-]*(?:approvals?|confirmation)[a-z0-9-]*sandbox[a-z0-9-]*)\b",
        exec_help,
        re.IGNORECASE,
    )
    if combined is None:
        combined = re.search(
            r"(?m)^\s*(--dangerously-bypass-approvals-and-sandbox)\b", exec_help
        )

    has_danger_full = "danger-full-access" in exec_help
    approval_match = re.search(
        r"(?m)^\s*(?:-[a-z],\s*)?(--(?:ask-for-approval|approval-policy))\b",
        exec_help + "\n" + root_help,
    )
    has_never = bool(re.search(r"\bnever\b", root_help + exec_help))
    sandbox_match = re.search(
        r"(?m)^\s*(?:-[a-z],\s*)?(--sandbox)\b", exec_help + "\n" + root_help
    )
    has_read_only = "read-only" in exec_help + root_help

    if combined is not None:
        autonomy_prefix: tuple[str, ...] = ()
        autonomy_exec = (combined.group(1),)
    elif has_danger_full and approval_match is not None and has_never:
        autonomy_prefix = (approval_match.group(1), "never")
        autonomy_exec = ("--sandbox", "danger-full-access")
    else:
        raise SupervisorError(
            "Codex CLI does not expose a non-interactive full-autonomy mode; "
            "refusing to fall back to interactive or workspace-only execution"
        )

    if (
        approval_match is None
        or not has_never
        or sandbox_match is None
        or not has_read_only
    ):
        raise SupervisorError(
            "Codex CLI does not expose the required no-approval read-only reviewer mode"
        )
    return CodexCapabilities(
        full_autonomy_prefix_flags=autonomy_prefix,
        full_autonomy_exec_flags=autonomy_exec,
        reviewer_prefix_flags=(approval_match.group(1), "never"),
        reviewer_exec_flags=(sandbox_match.group(1), "read-only"),
        help_text=exec_help,
    )


@dataclass(frozen=True)
class SupervisorConfig:
    repository_path: Path
    prompt_pack_path: Path
    state_dir: Path
    codex_executable: str
    node_executable: str
    child_timeout_seconds: float
    reviewer_timeout_seconds: float
    model: str
    reasoning_effort: str
    stop_before: str
    protect_findings: bool

    ALLOWED_KEYS = frozenset(
        {
            "repository_path",
            "prompt_pack_path",
            "state_dir",
            "codex_executable",
            "node_executable",
            "child_timeout_seconds",
            "reviewer_timeout_seconds",
            "model",
            "reasoning_effort",
            "stop_before",
            "protect_findings",
        }
    )

    @classmethod
    def defaults(cls, script_path: Path | None = None) -> "SupervisorConfig":
        script = (script_path or Path(__file__)).resolve()
        repository = script.parents[1]
        return cls(
            repository_path=repository,
            prompt_pack_path=Path(
                "/Users/15x/Downloads/ai-assistant-addon-v2-task-prompts.md"
            ),
            state_dir=Path.home() / ".local" / "state" / "ai-assistant-v2-supervisor",
            codex_executable="codex",
            node_executable="/opt/homebrew/opt/node@22/bin/node",
            child_timeout_seconds=14_400.0,
            reviewer_timeout_seconds=14_400.0,
            model="gpt-5.6-sol",
            reasoning_effort="max",
            stop_before="T18-A",
            protect_findings=True,
        )

    @classmethod
    def load(
        cls, config_path: Path | None, script_path: Path | None = None
    ) -> "SupervisorConfig":
        defaults = cls.defaults(script_path)
        if config_path is None:
            return defaults
        try:
            raw = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise SupervisorError(
                f"cannot read config {config_path}: {error}"
            ) from error
        if not isinstance(raw, dict):
            raise SupervisorError("supervisor config must be a JSON object")
        unknown = sorted(set(raw) - cls.ALLOWED_KEYS)
        if unknown:
            raise SupervisorError("unknown config keys: " + ", ".join(unknown))
        values = {field: getattr(defaults, field) for field in cls.ALLOWED_KEYS}
        values.update(raw)
        for key in ("repository_path", "prompt_pack_path", "state_dir"):
            values[key] = Path(values[key]).expanduser()
        for key in ("child_timeout_seconds", "reviewer_timeout_seconds"):
            value = float(values[key])
            if value <= 0:
                raise SupervisorError(f"{key} must be positive")
            values[key] = value
        if values["model"] != "gpt-5.6-sol" or values["reasoning_effort"] != "max":
            raise SupervisorError("model must be gpt-5.6-sol with max reasoning")
        return cls(**values)


@contextmanager
def supervisor_lock(config: SupervisorConfig) -> Iterator[None]:
    repository = config.repository_path.resolve()
    state_dir = config.state_dir.resolve()
    if state_dir == repository or repository in state_dir.parents:
        raise SupervisorError("supervisor state directory must be outside repository")
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir.chmod(0o700)
    lock_path = state_dir / "supervisor.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SupervisorError(
                "another ai-assistant v2 supervisor is already running"
            ) from error
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


@dataclass(frozen=True)
class AllowedPathSpecs:
    exact: frozenset[str]
    basenames: frozenset[str]
    globs: frozenset[str]
    prefixes: frozenset[str]


def derive_allowed_path_specs(
    prompt: Prompt,
    contracts: Iterable[TaskContract],
    plan_context: str,
    extra_scope_text: str = "",
) -> AllowedPathSpecs:
    prompt_scope = _bold_field(prompt.text, "Frozen files") or _bold_field(
        prompt.text, "Files"
    )
    scope_declarations = [prompt_scope]
    for contract in contracts:
        scope_declarations.extend(
            filter(
                None,
                (
                    _bold_field(contract.text, "Common frozen files"),
                    _bold_field(contract.text, "Frozen files"),
                    _bold_field(contract.text, "Files"),
                ),
            )
        )
    if extra_scope_text:
        scope_declarations.append(extra_scope_text)
    primary_source = "\n".join(filter(None, scope_declarations))
    primary = _extract_path_specs(primary_source)
    plan = _extract_path_specs(plan_context)
    term_source = "\n".join(
        filter(
            None,
            (
                prompt.title,
                primary_source,
                _bold_field(prompt.text, "Canonical plan context"),
                _bold_field(prompt.text, "Red phase"),
                _bold_field(prompt.text, "Required decisions"),
                _bold_field(prompt.text, "Cases"),
                _bold_field(prompt.text, "Implement"),
                _without_fenced_code(_bold_field(prompt.text, "Focused gate")),
            ),
        )
    )

    def matches_scope(path: str) -> bool:
        path_term_source = term_source
        narrowed_scope = _path_specific_scope(prompt_scope, path)
        if narrowed_scope != prompt_scope:
            pieces = [prompt.title, narrowed_scope]
            if path.startswith("tests/"):
                narrowed_specific = (
                    _scope_terms(narrowed_scope)
                    .difference(WEAK_SCOPE_TERMS)
                    .difference({"focused"})
                )
                pieces = [narrowed_scope]
                if not narrowed_specific:
                    pieces.extend((prompt.title, _bold_field(prompt.text, "Red phase")))
                pieces.extend(
                    _without_fenced_code(_bold_field(prompt.text, field))
                    for field in ("Focused gate", "Gate")
                )
            path_term_source = "\n".join(filter(None, pieces))
        return _path_matches_scope(path, _scope_terms(path_term_source), narrowed_scope)

    def category_permitted(path: str) -> bool:
        category_scope = primary_source
        if path.startswith("tests/"):
            category_scope += "\n" + "\n".join(
                _without_fenced_code(_bold_field(prompt.text, field))
                for field in ("Focused gate", "Gate")
            )
        return _path_category_permitted(path, category_scope)

    plan_exact = {
        path for path in plan.exact if category_permitted(path) and matches_scope(path)
    }
    plan_globs = {
        path for path in plan.globs if category_permitted(path) and matches_scope(path)
    }
    plan_prefixes = {
        path
        for path in plan.prefixes
        if category_permitted(path) and matches_scope(path)
    }
    if re.search(
        r"\b(?:named|focused)\s+(?:unit\s+)?tests?\b",
        primary_source,
        re.IGNORECASE,
    ):
        focused_gate = _extract_path_specs(_bold_field(prompt.text, "Focused gate"))
        plan_exact.update(
            path for path in focused_gate.exact if path.startswith("tests/")
        )
    if "annotation files" in primary_source.lower():
        plan_prefixes.add("src/harness/workflows/")
    if "metadata carrier types/builders" in primary_source.lower():
        plan_exact.update(
            path
            for path in plan.exact
            if path.startswith("src/harness/")
            and not path.startswith("src/harness/workflows/")
        )
    if "all task 4 tests" in primary_source.lower():
        plan_exact.update(path for path in plan.exact if path.startswith("tests/"))
    if "eval/release/live workflows" in primary_source.lower():
        plan_exact.update(
            path
            for path in plan.exact
            if path.startswith(".github/workflows/")
            and {"eval", "release", "live"}.intersection(_path_scope_tokens(path))
        )
    if "package scripts/tests" in primary_source.lower():
        plan_exact.update(
            path
            for path in plan.exact
            if path == "package.json"
            or path.startswith("tests/")
            or (
                path.startswith("scripts/")
                and {"eval", "release", "live", "report"}.intersection(
                    _path_scope_tokens(path)
                )
            )
        )
    if "shared authority/compatibility files" in primary_source.lower():
        shared_match = re.search(
            r"(?ms)Every domain write change may also modify these shared "
            r"authority/compatibility files:.*?(?=\n\n)",
            plan_context,
        )
        if shared_match is None:
            raise SupervisorError(
                "selected prompt requires the Task 6 shared authority files, "
                "but the canonical plan does not define them"
            )
        shared = _extract_path_specs(shared_match.group(0))
        plan_exact.update(shared.exact)
        plan_globs.update(shared.globs)
        plan_prefixes.update(shared.prefixes)
    primary_globs = set(primary.globs)
    primary_globs.discard("src/harness/api-actions/*.ts")
    return AllowedPathSpecs(
        exact=frozenset({"CLAUDE.md", "AGENTS.md", *primary.exact, *plan_exact}),
        basenames=primary.basenames,
        globs=frozenset({*primary_globs, *plan_globs}),
        prefixes=frozenset({*primary.prefixes, *plan_prefixes}),
    )


def _extract_path_specs(source: str) -> AllowedPathSpecs:
    exact: set[str] = set()
    basenames: set[str] = set()
    globs: set[str] = set()
    prefixes: set[str] = set()
    root_files = {
        ".env.example",
        "AGENTS.md",
        "CLAUDE.md",
        "DEPLOYMENT.md",
        "MARKETPLACE_READINESS.md",
        "PRIVACY.md",
        "README.md",
        "SECURITY.md",
        "package-lock.json",
        "package.json",
        "tsconfig.json",
        "tsconfig.server.json",
        "tsconfig.ui.json",
    }
    for line in source.splitlines():
        current_directory: str | None = None
        for code in re.findall(r"`([^`\n]+)`", line):
            candidate = code.strip().rstrip(".,;:")
            if any(character.isspace() for character in candidate):
                continue
            if not re.fullmatch(r"[.A-Za-z0-9_@+*?\-/]+", candidate):
                continue
            if candidate in root_files:
                exact.add(candidate)
                continue
            if "/" in candidate:
                normalized = candidate.removeprefix("./")
                if _path_escapes_repository(normalized):
                    continue
                if normalized.endswith("/"):
                    prefixes.add(normalized)
                    current_directory = normalized.rstrip("/")
                elif any(character in normalized for character in "*?["):
                    globs.add(normalized)
                    current_directory = str(PurePosixPath(normalized).parent)
                elif _looks_like_repository_file(normalized):
                    exact.add(normalized)
                    current_directory = str(PurePosixPath(normalized).parent)
            elif _looks_like_repository_file(candidate) and not candidate.startswith(
                "T"
            ):
                if current_directory and current_directory != ".":
                    exact.add(f"{current_directory}/{candidate}")
                else:
                    basenames.add(candidate)
        unquoted_line = re.sub(r"`[^`\n]+`", "", line)
        for candidate in re.findall(
            r"(?<![A-Za-z0-9_.-])([A-Za-z0-9_.@+-]+(?:/[A-Za-z0-9_.@+*?-]+)+)",
            unquoted_line,
        ):
            normalized = candidate.rstrip(".,;:").removeprefix("./")
            if _path_escapes_repository(normalized):
                continue
            if any(character in normalized for character in "*?["):
                globs.add(normalized)
            elif _looks_like_repository_file(normalized):
                exact.add(normalized)
    return AllowedPathSpecs(
        exact=frozenset(exact),
        basenames=frozenset(basenames),
        globs=frozenset(globs),
        prefixes=frozenset(prefixes),
    )


def _path_escapes_repository(path: str) -> bool:
    pure = PurePosixPath(path)
    return pure.is_absolute() or ".." in pure.parts


REPOSITORY_FILE_SUFFIXES = frozenset(
    {
        ".css",
        ".html",
        ".js",
        ".json",
        ".jsonl",
        ".md",
        ".mjs",
        ".sh",
        ".sql",
        ".ts",
        ".tsx",
        ".txt",
        ".yaml",
        ".yml",
    }
)


def _looks_like_repository_file(path: str) -> bool:
    name = PurePosixPath(path).name
    return name == ".env.example" or PurePosixPath(name).suffix.lower() in (
        REPOSITORY_FILE_SUFFIXES
    )


SCOPE_STOP_WORDS = frozenset(
    {
        "add",
        "all",
        "and",
        "common",
        "create",
        "current",
        "exact",
        "existing",
        "files",
        "frozen",
        "guidance",
        "implement",
        "modify",
        "named",
        "new",
        "only",
        "path",
        "paths",
        "prompt",
        "relevant",
        "required",
        "same",
        "selected",
        "task",
        "tests",
        "their",
        "where",
        "with",
    }
)


WEAK_SCOPE_TERMS = frozenset(
    {
        "action",
        "app",
        "api",
        "assistant",
        "async",
        "client",
        "contract",
        "db",
        "doc",
        "deletion",
        "domain",
        "durable",
        "fake",
        "agent",
        "harness",
        "handler",
        "helper",
        "js",
        "json",
        "md",
        "integration",
        "package",
        "port",
        "rest",
        "recovery",
        "resume",
        "route",
        "schema",
        "script",
        "service",
        "store",
        "startup",
        "test",
        "ui",
        "v2",
        "verification",
        "verify",
        "workflow",
        "yaml",
        "yml",
    }
)


def _scope_terms(text: str) -> set[str]:
    terms = {
        _singularize(word.lower())
        for word in _word_tokens(text)
        if word.lower() not in SCOPE_STOP_WORDS
    }
    return terms


def _path_scope_tokens(path: str) -> set[str]:
    return {
        _singularize(token.lower())
        for token in _word_tokens(path)
        if token.lower() not in {"src", "test", "tests", "unit", "integration", "ts"}
    }


def _path_matches_scope(path: str, terms: set[str], scope_text: str) -> bool:
    tokens = _path_scope_tokens(path)
    specific = tokens.difference(WEAK_SCOPE_TERMS).difference({"clockify", "model"})
    if specific:
        return specific.issubset(terms)
    stem = PurePosixPath(path.rstrip("/")).name.split(".", 1)[0].lower()
    stem_tokens = {_singularize(token) for token in re.findall(r"[a-z][a-z0-9]*", stem)}
    return (
        bool(stem_tokens)
        and stem_tokens.issubset(terms)
        and bool(
            re.search(
                rf"(?<![A-Za-z0-9]){re.escape(stem)}(?![A-Za-z0-9])",
                scope_text,
                re.I,
            )
        )
    )


def _path_category_permitted(path: str, scope_text: str) -> bool:
    scope = scope_text.lower()
    if path.startswith("src/services/") and "service" not in scope:
        return False
    if path.startswith("src/routes/"):
        if PurePosixPath(path).name == "deps.ts" and "dependency wiring" in scope:
            return True
        if not any(term in scope for term in ("route", "api branch", "request schema")):
            return False
    if path.startswith("src/assistant-v2/context/") and not any(
        term in scope for term in ("assistant-v2", "v2 runner", "entity-reference")
    ):
        return False
    if path.startswith("src/harness/") and not any(
        term in scope
        for term in (
            "harness",
            "action",
            "authority",
            "catalog",
            "confirmation",
            "durable",
            "presentation",
            "workflow",
        )
    ):
        return False
    if path.startswith("src/ui/") and "ui" not in scope:
        return False
    if path.startswith("src/db/") and not any(
        term in scope for term in ("db", "schema", "store", "persistence")
    ):
        return False
    if path.startswith("tests/e2e/") and not any(
        _scope_has_word(scope, term) for term in ("e2e", "ui", "browser")
    ):
        return False
    if path.startswith("tests/"):
        name = PurePosixPath(path).name.lower()
        if "route" in name and not _scope_has_word(scope, "route"):
            return False
        if re.search(r"(?:^|[-_.])ui(?:[-_.]|$)", name) and not _scope_has_word(
            scope, "ui"
        ):
            return False
    if path == "src/clockify/rest/workspace.ts" and not re.search(
        r"(?<!-)\bworkspace\b", scope
    ):
        return False
    return True


def _scope_has_word(scope: str, word: str) -> bool:
    return bool(re.search(rf"(?<![A-Za-z0-9]){re.escape(word)}(?![A-Za-z0-9])", scope))


def _path_specific_scope(scope_text: str, path: str) -> str:
    if ";" not in scope_text and "," not in scope_text:
        return scope_text
    keywords: set[str] = set()
    if path.startswith("src/harness/workflows/"):
        keywords.add("workflow")
    if path.startswith("src/harness/api-actions/"):
        keywords.update(("split", "action"))
    if path.startswith("src/clockify/rest/"):
        keywords.add("rest")
    if path.startswith("src/clockify/ports/"):
        keywords.add("port")
    if path in {"src/clockify/client.ts", "src/clockify/rest-workspace.ts"}:
        keywords.update(("client", "rest-workspace"))
    if path.startswith("tests/helpers/fake"):
        keywords.add("fake")
    elif path.startswith("tests/"):
        keywords.add("test")
    if any(term in path for term in ("durable", "reconciliation")):
        keywords.update(("durable", "reconciliation"))
    if not keywords:
        return scope_text
    clauses = [
        clause.strip() for clause in re.split(r"[;,]", scope_text) if clause.strip()
    ]
    relevant = [
        clause
        for clause in clauses
        if any(
            re.search(rf"\b{re.escape(keyword)}", clause, re.IGNORECASE)
            for keyword in keywords
        )
    ]
    return "; ".join(relevant) if relevant else scope_text


def _word_tokens(text: str) -> tuple[str, ...]:
    separated = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    return tuple(re.findall(r"[A-Za-z][A-Za-z0-9]*", separated))


def _without_fenced_code(text: str) -> str:
    return re.sub(r"(?ms)```.*?^```\s*$", "", text)


def _singularize(value: str) -> str:
    normalized = {
        "dependencies": "dependency",
        "deps": "dependency",
        "restoration": "restore",
        "restored": "restore",
    }.get(value)
    if normalized is not None:
        return normalized
    if value.endswith("ies") and len(value) > 4:
        return value[:-3] + "y"
    if value.endswith("s") and not value.endswith("ss") and len(value) > 3:
        return value[:-1]
    return value


def validate_frozen_paths(
    changed_paths: Iterable[str], allowed: AllowedPathSpecs
) -> None:
    rejected: list[str] = []
    for raw_path in changed_paths:
        path = PurePosixPath(raw_path).as_posix().removeprefix("./")
        if path in allowed.exact:
            continue
        if PurePosixPath(path).name in allowed.basenames:
            continue
        if any(fnmatch.fnmatchcase(path, pattern) for pattern in allowed.globs):
            continue
        if any(path.startswith(prefix) for prefix in allowed.prefixes):
            continue
        rejected.append(path)
    if rejected:
        raise SupervisorError(
            "changed paths exceed the selected prompt's frozen scope: "
            + ", ".join(sorted(rejected))
        )


def validate_dirty_entries(entries: Iterable[tuple[str, str]]) -> None:
    unexpected = [
        f"{status} {path}"
        for status, path in entries
        if not (status == "??" and path == "FINDINGS.md")
    ]
    if unexpected:
        raise SupervisorError(
            "unexpected dirty worktree entries: " + ", ".join(unexpected)
        )


def git_status_entries(repository: Path) -> tuple[tuple[str, str], ...]:
    completed = _run(
        ("git", "status", "--porcelain=v1", "-z", "--untracked-files=all"),
        cwd=repository,
        text=False,
    )
    records = completed.stdout.split(b"\0")
    entries: list[tuple[str, str]] = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if len(record) < 4 or record[2:3] != b" ":
            raise SupervisorError("cannot parse git status porcelain output")
        status = record[:2].decode("ascii", "strict")
        path = record[3:].decode("utf-8", "surrogateescape")
        entries.append((status, path))
        if "R" in status or "C" in status:
            if index >= len(records) or not records[index]:
                raise SupervisorError("cannot parse renamed git status entry")
            second = records[index].decode("utf-8", "surrogateescape")
            entries.append((status, second))
            index += 1
    return tuple(entries)


def validate_commit_boundary(repository: Path, sha: str, subject: str) -> None:
    actual_sha = _git(repository, "rev-parse", "HEAD")
    if sha != actual_sha:
        raise SupervisorError(
            f"reported commit {sha} does not equal repository HEAD {actual_sha}"
        )
    actual_subject = _git(repository, "log", "-1", "--format=%s")
    if subject != actual_subject:
        raise SupervisorError(
            f"reported commit subject does not match HEAD subject: {actual_subject!r}"
        )


def next_action_kind(pack: PromptPack, next_prompt: str) -> str:
    for item in pack.order_items:
        if isinstance(item, tuple) and next_prompt in item:
            return "reviewer_pair"
    return "prompt"


def enforce_stop_boundary(
    pack: PromptPack, next_prompt: str, stop_before: str | None
) -> None:
    prompt = pack.prompt(next_prompt)
    if stop_before and next_prompt == stop_before:
        raise StopBoundary(f"stopped before {stop_before} as configured")
    if next_prompt.startswith("T18-") or next_prompt.startswith("T19-"):
        raise StopBoundary(f"{next_prompt} requires separate operator authorization")
    if prompt.authorization_gates:
        raise StopBoundary(
            f"{next_prompt} contains an explicit operator/external authorization gate"
        )


STATE_SUBDIRECTORIES = (
    "handoffs",
    "child-run-prompts",
    "structured-events",
    "stderr-progress",
    "final-responses",
    "reviewer-reports",
    "supervisor-checkpoints",
)


AUTONOMY_INSTRUCTIONS = """You have full local implementation authority for this selected prompt. Do not ask the owner to choose among ordinary in-scope implementation options. Inspect the permitted evidence, make the narrowest correct decision, implement it, test it, synchronize documentation, commit it, and emit the required SLICE HANDOFF.

The root Codex agent is the sole writer. Subagents are read-only investigators and may not edit, generate, format, stage, commit, switch branches/worktrees, or perform external actions.

Stop only when a Base Execution Contract stop condition applies, external or destructive authority is required, the prompt explicitly requires human authorization, evidence cannot establish correctness, or the slice cannot be completed without violating scope or safety."""


READ_ONLY_REVIEWER_INSTRUCTIONS = """This is an independent read-only root review. Do not edit, create, delete, generate, format, stage, commit, switch branches/worktrees, or perform external actions. Any subagent is also a read-only investigator. Bind every finding or explicit zero-finding conclusion to the immutable SHA supplied by the selected prompt."""


def build_child_prompt(
    pack: PromptPack,
    prompt_id: str,
    previous_handoff: str,
    *,
    reviewer_reports: Mapping[str, str] | None = None,
    read_only_reviewer: bool = False,
    immutable_sha: str | None = None,
) -> str:
    selected = pack.prompt(prompt_id)
    sections = [pack.base_contract.rstrip()]
    sections.extend(
        contract.text.rstrip() for contract in pack.required_contracts_for(prompt_id)
    )
    sections.append(selected.text.rstrip())
    sections.append(
        "Immediately preceding SLICE HANDOFF\n\n" + previous_handoff.rstrip()
    )
    if reviewer_reports is not None:
        if prompt_id != "T04-R3" or set(reviewer_reports) != {"T04-R1", "T04-R2"}:
            raise SupervisorError(
                "reviewer reports may be supplied only as the complete T04-R3 pair"
            )
        sections.append(
            "Independent reviewer reports bound to the T04-K SHA\n\n"
            + "\n\n".join(
                f"### {reviewer_id}\n\n{reviewer_reports[reviewer_id].rstrip()}"
                for reviewer_id in ("T04-R1", "T04-R2")
            )
        )
    if immutable_sha is not None:
        sections.append(f"Immutable review SHA: {immutable_sha}")
    sections.append(
        "Autonomy and delegation rules\n\n"
        + (
            READ_ONLY_REVIEWER_INSTRUCTIONS
            if read_only_reviewer
            else AUTONOMY_INSTRUCTIONS
        )
    )
    return "\n\n---\n\n".join(sections).rstrip() + "\n"


@dataclass(frozen=True)
class ChildProcessResult:
    exit_code: int
    timed_out: bool
    interrupted: bool
    violation: str | None
    final_response: str
    duration_seconds: float


_ACTIVE_PROCESS_LOCK = threading.Lock()
_ACTIVE_PROCESSES: set[subprocess.Popen[str]] = set()


def run_managed_process(
    *,
    command: tuple[str, ...],
    prompt: str,
    cwd: Path,
    timeout_seconds: float,
    events_path: Path,
    stderr_path: Path,
    final_path: Path,
    env: Mapping[str, str] | None = None,
    pid_path: Path | None = None,
    allowed_paths: AllowedPathSpecs | None = None,
    read_only: bool = False,
) -> ChildProcessResult:
    for path in (events_path, stderr_path, final_path):
        path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=dict(env) if env is not None else None,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=True,
        )
    except OSError as error:
        raise SupervisorError(f"cannot launch child process: {error}") from error
    with _ACTIVE_PROCESS_LOCK:
        _ACTIVE_PROCESSES.add(process)
    if pid_path is not None:
        try:
            _atomic_write_bytes(
                pid_path,
                (
                    json.dumps(
                        {"pid": process.pid, "active": True, "started_at": _utc_now()},
                        sort_keys=True,
                    )
                    + "\n"
                ).encode("utf-8"),
                mode=0o600,
            )
        except SupervisorError:
            _terminate_process_group(process)
            with _ACTIVE_PROCESS_LOCK:
                _ACTIVE_PROCESSES.discard(process)
            raise

    final_messages: list[str] = []
    violation_box: list[str] = []
    stream_error: list[str] = []
    sensitive_values = _sensitive_environment_values(env or {})

    def read_events() -> None:
        assert process.stdout is not None
        try:
            with events_path.open("w", encoding="utf-8") as output:
                for line in process.stdout:
                    safe_line = redact_secrets(line, sensitive_values)
                    output.write(safe_line)
                    output.flush()
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    violation = audit_structured_event(event)
                    for command_text in _event_command_strings(event):
                        if read_only and re.search(
                            r"\bgit\s+(?:add|commit|mv|rm|reset|checkout|switch|rebase|cherry-pick|revert)\b",
                            command_text,
                        ):
                            violation = (
                                violation or "read-only reviewer attempted a Git write"
                            )
                        if allowed_paths is not None:
                            staging_violation = audit_git_staging(
                                command_text, allowed_paths
                            )
                            violation = violation or staging_violation
                    if violation and not violation_box:
                        violation_box.append(violation)
                    message = _agent_message_from_event(event)
                    if message is not None:
                        final_messages.append(message)
        except OSError as error:
            stream_error.append(f"structured-event capture failed: {error}")

    def read_stderr() -> None:
        assert process.stderr is not None
        try:
            with stderr_path.open("w", encoding="utf-8") as output:
                for line in process.stderr:
                    output.write(redact_secrets(line, sensitive_values))
                    output.flush()
        except OSError as error:
            stream_error.append(f"stderr capture failed: {error}")

    event_thread = threading.Thread(
        target=read_events, name="codex-events", daemon=True
    )
    stderr_thread = threading.Thread(
        target=read_stderr, name="codex-stderr", daemon=True
    )
    event_thread.start()
    stderr_thread.start()
    try:
        assert process.stdin is not None
        process.stdin.write(prompt)
        process.stdin.close()
    except (BrokenPipeError, OSError):
        pass

    timed_out = False
    interrupted = False
    try:
        while process.poll() is None:
            if violation_box:
                _terminate_process_group(process)
                break
            if time.monotonic() - started >= timeout_seconds:
                timed_out = True
                _terminate_process_group(process)
                break
            time.sleep(0.05)
        exit_code = process.wait(timeout=5.0)
    except KeyboardInterrupt:
        interrupted = True
        _terminate_process_group(process)
        exit_code = process.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        _kill_process_group(process)
        exit_code = process.wait(timeout=5.0)

    event_thread.join(timeout=5.0)
    stderr_thread.join(timeout=5.0)
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()
    if process.stdin is not None and not process.stdin.closed:
        process.stdin.close()
    if event_thread.is_alive() or stderr_thread.is_alive():
        stream_error.append("child output capture thread did not terminate")

    final_response = final_messages[-1] if final_messages else ""
    final_secret = secret_violation(final_response, sensitive_values)
    if final_secret and not violation_box:
        violation_box.append(final_secret)
    if stream_error and not violation_box:
        violation_box.append(stream_error[0])
    try:
        _atomic_write_bytes(
            final_path,
            (
                final_response
                if not final_secret
                else redact_secrets(final_response, sensitive_values)
            ).encode("utf-8"),
            mode=0o600,
        )
        if pid_path is not None:
            _atomic_write_bytes(
                pid_path,
                (
                    json.dumps(
                        {
                            "pid": process.pid,
                            "active": False,
                            "started_at": None,
                            "completed_at": _utc_now(),
                            "exit_code": exit_code,
                        },
                        sort_keys=True,
                    )
                    + "\n"
                ).encode("utf-8"),
                mode=0o600,
            )
    finally:
        with _ACTIVE_PROCESS_LOCK:
            _ACTIVE_PROCESSES.discard(process)
    return ChildProcessResult(
        exit_code=exit_code,
        timed_out=timed_out,
        interrupted=interrupted,
        violation=violation_box[0] if violation_box else None,
        final_response=final_response,
        duration_seconds=time.monotonic() - started,
    )


def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        _kill_process_group(process)


def _kill_process_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _terminate_all_active_processes() -> None:
    with _ACTIVE_PROCESS_LOCK:
        processes = tuple(_ACTIVE_PROCESSES)
    for process in processes:
        _terminate_process_group(process)


def _reconcile_process_receipt(path_value: Any) -> dict[str, Any] | None:
    if not isinstance(path_value, str):
        return None
    path = Path(path_value)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SupervisorError(f"cannot read child process receipt: {error}") from error
    if not isinstance(raw, dict) or not isinstance(raw.get("pid"), int):
        raise SupervisorError("child process receipt is malformed")
    if raw.get("active") is True:
        _terminate_recorded_process_group(raw["pid"])
    return raw


def _terminate_recorded_process_group(pid: int) -> None:
    try:
        process_group = os.getpgid(pid)
    except ProcessLookupError:
        return
    if process_group != pid:
        raise SupervisorError(
            "recorded child PID no longer owns its process group; refusing to signal it"
        )
    completed = subprocess.run(
        ("/bin/ps", "-p", str(pid), "-o", "command="),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=5.0,
    )
    command = completed.stdout.strip().lower()
    if completed.returncode != 0 or (
        "codex" not in command and "sandbox-exec" not in command
    ):
        raise SupervisorError(
            "recorded child PID identity is not Codex; refusing to signal it"
        )
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _validate_saved_events(path_value: Any) -> None:
    if path_value is None:
        return
    if not isinstance(path_value, str):
        raise SupervisorError("structured-event path is malformed")
    try:
        with Path(path_value).open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                violation = audit_structured_event(event)
                if violation:
                    raise SupervisorError(
                        f"saved child event contains a boundary violation: {violation}"
                    )
    except FileNotFoundError:
        return
    except (OSError, UnicodeError) as error:
        raise SupervisorError(f"cannot read structured-event log: {error}") from error


def _agent_message_from_event(event: Any) -> str | None:
    if not isinstance(event, dict):
        return None
    item = event.get("item")
    if (
        event.get("type") == "item.completed"
        and isinstance(item, dict)
        and item.get("type") in {"agent_message", "assistant_message"}
        and isinstance(item.get("text"), str)
    ):
        return item["text"]
    for key in ("last_agent_message", "final_response", "output_text"):
        if isinstance(event.get(key), str):
            return event[key]
    return None


FORBIDDEN_COMMAND_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?<!!)\bFINDINGS\.md\b"), "attempted FINDINGS.md access"),
    (
        re.compile(r"\bgit\s+(?:(?:push|pull|fetch|tag)\b|merge(?!-base(?=\s|$))\b)"),
        "forbidden remote or integration Git action",
    ),
    (
        re.compile(
            r"\bgit\s+(?:reset\b|checkout\b|switch\b|clean\b|rebase\b|cherry-pick\b|revert\b|replace\b|update-ref\b|worktree\b)"
        ),
        "forbidden Git history, branch, or worktree action",
    ),
    (
        re.compile(r"\bgit\s+add\s+(?:-[^\s]*A\b|--all\b|\.\s*(?:$|[;&|]))"),
        "forbidden broad Git staging",
    ),
    (
        re.compile(r"\bgit\s+commit\b[^\n;&|]*\s-a(?:\s|$)"),
        "forbidden broad Git commit",
    ),
    (
        re.compile(r"\bgit\s+commit\b[^\n;&|]*--amend\b"),
        "forbidden commit amendment",
    ),
    (
        re.compile(
            r"(?:^|[\n;&|()]\s*|(?:-lc|-c)\s+['\"])\s*"
            r"(?:(?:env|command|exec|sudo)(?:\s+-\S+)*\s+|"
            r"[A-Za-z_][A-Za-z0-9_]*=\S+\s+|(?:if|then|do|while|until)\s+)*"
            r"(?:\S*/)?(?:railway|gh)(?=\s|[;&|()]|$)"
        ),
        "forbidden external administration command",
    ),
    (re.compile(r"\bnpm\s+(?:publish|unpublish)\b"), "forbidden package publication"),
    (
        re.compile(r"\bdeploy:private-production\b|\brailway\s+up\b"),
        "forbidden deployment command",
    ),
    (
        re.compile(r"\bLIVE_CLOCKIFY\s*=\s*1\b|\bscripts/live-[^\s]+"),
        "forbidden live Clockify action",
    ),
    (
        re.compile(r"\b(?:openclaw|claude|codex)\s+(?:agent|-p|exec)\b"),
        "forbidden nested external agent process",
    ),
)


def audit_structured_event(event: Any) -> str | None:
    for command in _event_command_strings(event):
        for pattern, reason in FORBIDDEN_COMMAND_PATTERNS:
            if pattern.search(command):
                return reason
    return None


def audit_git_staging(command: str, allowed: AllowedPathSpecs) -> str | None:
    for match in re.finditer(r"\bgit\s+add\s+([^;&|\n]+)", command):
        try:
            arguments = shlex.split(match.group(1))
        except ValueError:
            return "cannot parse Git staging command"
        paths = [argument for argument in arguments if argument != "--"]
        if not paths or any(argument.startswith("-") for argument in paths):
            return "Git staging command is not an explicit path list"
        try:
            validate_frozen_paths(paths, allowed)
        except SupervisorError:
            return "Git staging command exceeds frozen scope"
    return None


def _event_command_strings(value: Any, key: str = "") -> Iterable[str]:
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            if child_key.lower() in {
                "command",
                "cmd",
                "script",
                "shell_command",
            } and isinstance(child_value, str):
                yield child_value
            else:
                yield from _event_command_strings(child_value, child_key)
    elif isinstance(value, list):
        for child in value:
            yield from _event_command_strings(child, key)


SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
        "private-key material",
    ),
    (
        re.compile(r"\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b"),
        "credential-like token",
    ),
    (
        re.compile(
            r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}"
        ),
        "credential-like assignment",
    ),
    (re.compile(r"(?i)\bAuthorization:\s*Bearer\s+\S+"), "authorization header"),
)


def secret_violation(text: str, sensitive_values: Iterable[str] = ()) -> str | None:
    if any(value and value in text for value in sensitive_values):
        return "secret-like value detected: inherited credential"
    for pattern, reason in SECRET_PATTERNS:
        if pattern.search(text):
            return f"secret-like value detected: {reason}"
    return None


def redact_secrets(text: str, sensitive_values: Iterable[str] = ()) -> str:
    redacted = text
    for value in sorted(set(sensitive_values), key=len, reverse=True):
        if value:
            redacted = redacted.replace(value, "[REDACTED]")
    for pattern, _reason in SECRET_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def _sensitive_environment_values(environment: Mapping[str, str]) -> tuple[str, ...]:
    return tuple(
        value
        for name, value in environment.items()
        if len(value) >= 8
        and re.search(
            r"(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)", name, re.I
        )
    )


class Supervisor:
    def __init__(self, config: SupervisorConfig) -> None:
        self.config = config

    @property
    def state_path(self) -> Path:
        return self.config.state_dir / "state.json"

    def load_pack(self) -> PromptPack:
        try:
            text = self.config.prompt_pack_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise SupervisorError(
                f"cannot read prompt pack {self.config.prompt_pack_path}: {error}"
            ) from error
        return PromptPack.parse(text)

    def adopt(self, *, completed: str, handoff_path: Path) -> dict[str, Any]:
        if completed != "T01-C":
            raise SupervisorError("adopt requires --completed T01-C")
        pack, capabilities = self._validate_static_setup()
        raw = handoff_path.read_bytes()
        try:
            handoff = parse_handoff(raw.decode("utf-8"))
        except UnicodeError as error:
            raise SupervisorError("handoff must be UTF-8") from error
        if handoff.prompt_id != "T01-C":
            raise SupervisorError("adopt handoff must report Prompt T01-C")
        if handoff.status != "COMPLETE":
            raise SupervisorError("adopt handoff must report Status COMPLETE")
        if handoff.commit_sha is None or handoff.commit_subject is None:
            raise SupervisorError("adopt handoff must report its commit")
        validate_commit_boundary(
            self.config.repository_path,
            handoff.commit_sha,
            handoff.commit_subject,
        )
        expected = pack.expected_next("T01-C")
        if expected != ("T01-D",) or handoff.next_prompt_ids != expected:
            raise SupervisorError("T01-C handoff next prompt must be T01-D")
        validate_guidance_checkpoint(self.config.repository_path, "T01-C", expected)
        validate_dirty_entries(git_status_entries(self.config.repository_path))
        if self.state_path.exists():
            raise SupervisorError(
                f"supervisor state already exists at {self.state_path}; refusing overwrite"
            )
        self._create_state_directories()
        _atomic_write_bytes(
            self.config.state_dir / "handoffs" / "T01-C.txt", raw, mode=0o600
        )
        now = _utc_now()
        state: dict[str, Any] = {
            "schema_version": 1,
            "prompt_pack_sha256": _sha256_file(self.config.prompt_pack_path),
            "implementation_plan_sha256": _sha256_file(
                Path(pack.implementation_plan_path)
            ),
            "repository_path": str(self.config.repository_path.resolve()),
            "branch": _git(self.config.repository_path, "branch", "--show-current"),
            "last_completed_prompt": "T01-C",
            "last_commit": handoff.commit_sha,
            "next_prompt": "T01-D",
            "current_status": "ready",
            "selected_codex_model": self.config.model,
            "reasoning_effort": self.config.reasoning_effort,
            "child_cli_invocation_mode": list(capabilities.full_autonomy_flags),
            "reviewer_boundary_state": {"status": "not_reached"},
            "last_blocker": None,
            "start_timestamp": now,
            "completion_timestamp": None,
            "active_run": None,
            "last_failed_run": None,
            "last_run_started_at": None,
            "last_run_completed_at": None,
        }
        self._write_state(state)
        return state

    def load_state(self, *, reconcile: bool = False) -> dict[str, Any]:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise SupervisorError(
                f"supervisor is not adopted; state is missing at {self.state_path}"
            ) from error
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise SupervisorError(f"cannot read supervisor state: {error}") from error
        if not isinstance(raw, dict) or raw.get("schema_version") != 1:
            raise SupervisorError("unsupported or malformed supervisor state")
        required = {
            "prompt_pack_sha256",
            "implementation_plan_sha256",
            "repository_path",
            "branch",
            "last_completed_prompt",
            "last_commit",
            "next_prompt",
            "current_status",
            "selected_codex_model",
            "reasoning_effort",
            "child_cli_invocation_mode",
            "reviewer_boundary_state",
            "last_blocker",
            "start_timestamp",
            "completion_timestamp",
            "active_run",
            "last_failed_run",
        }
        missing = sorted(required - raw.keys())
        if missing:
            raise SupervisorError("state is missing keys: " + ", ".join(missing))
        state = dict(raw)
        if reconcile and state["current_status"] == "reviewing":
            return self._reconcile_interrupted_reviewer_pair(state)
        if reconcile and state["current_status"] == "running":
            active = state.get("active_run")
            if not isinstance(active, dict):
                raise SupervisorError("running state has no valid active_run")
            receipt = _reconcile_process_receipt(active.get("pid_path"))
            actual_head = _git(self.config.repository_path, "rev-parse", "HEAD")
            if actual_head == active.get("pre_head"):
                state["current_status"] = "blocked"
                state["last_blocker"] = (
                    f"child run {active.get('run_id', 'unknown')} was interrupted "
                    "before a commit; retry the same prompt after validate succeeds"
                )
                state["active_run"] = None
                state["last_run_completed_at"] = _utc_now()
                self._write_state(state)
            else:
                final_path_value = active.get("final_response_path")
                try:
                    if receipt is not None and (
                        receipt.get("active") is not False
                        or receipt.get("exit_code") != 0
                    ):
                        raise SupervisorError(
                            "child process success was not durably recorded"
                        )
                    _validate_saved_events(active.get("events_path"))
                    if not isinstance(final_path_value, str):
                        raise SupervisorError("active run has no final-response path")
                    final_response = Path(final_path_value).read_text(encoding="utf-8")
                    pack = self.load_pack()
                    prompt_id = str(active.get("prompt_id", ""))
                    prompt = pack.prompt(prompt_id)
                    recovery_scope = ""
                    if prompt_id == "T04-R3":
                        recovery_scope = "\n".join(
                            self._load_reviewer_reports(state).values()
                        )
                    self._validate_completed_child(
                        pack=pack,
                        prompt=prompt,
                        pre_head=str(active.get("pre_head", "")),
                        final_response=final_response,
                        extra_scope_text=recovery_scope,
                    )
                except (OSError, UnicodeError, SupervisorError) as error:
                    raise SupervisorError(
                        "interrupted child changed Git without a recoverable verified boundary; "
                        f"manual reconciliation required: {error}"
                    ) from error
                expected_next = pack.expected_next(prompt_id)
                _atomic_write_bytes(
                    self.config.state_dir / "handoffs" / f"{prompt_id}.txt",
                    final_response.encode("utf-8"),
                    mode=0o600,
                )
                state["last_completed_prompt"] = prompt_id
                state["last_commit"] = actual_head
                state["next_prompt"] = expected_next[0] if expected_next else "STOP"
                state["current_status"] = "ready"
                state["last_blocker"] = None
                state["active_run"] = None
                state["last_run_completed_at"] = _utc_now()
                if expected_next and expected_next[0].startswith("T18-"):
                    state["completion_timestamp"] = _utc_now()
                if len(expected_next) > 1:
                    state["reviewer_boundary_state"] = {
                        "status": "pending",
                        "reviewers": list(expected_next),
                        "immutable_sha": actual_head,
                        "reports": {},
                    }
                self._write_state(state)
        return state

    def _reconcile_interrupted_reviewer_pair(
        self, state: dict[str, Any]
    ) -> dict[str, Any]:
        reviewer_state = state.get("reviewer_boundary_state")
        if not isinstance(reviewer_state, dict):
            raise SupervisorError("reviewing state has no reviewer boundary")
        immutable_sha = str(reviewer_state.get("immutable_sha", ""))
        runs = reviewer_state.get("runs")
        if not isinstance(runs, dict) or set(runs) != {"T04-R1", "T04-R2"}:
            raise SupervisorError("reviewing state has no complete reviewer run map")
        reports: dict[str, str] = {}
        recoverable = True
        for reviewer_id in ("T04-R1", "T04-R2"):
            run = runs[reviewer_id]
            if not isinstance(run, dict):
                recoverable = False
                continue
            receipt = _reconcile_process_receipt(run.get("pid_path"))
            try:
                if receipt is not None and (
                    receipt.get("active") is not False or receipt.get("exit_code") != 0
                ):
                    raise SupervisorError("reviewer process did not exit successfully")
                _validate_saved_events(run.get("events_path"))
                final_value = run.get("final_response_path")
                if not isinstance(final_value, str):
                    raise SupervisorError("reviewer final-response path is missing")
                report = Path(final_value).read_text(encoding="utf-8")
                if not report.strip() or secret_violation(report):
                    raise SupervisorError(
                        "reviewer report is empty or contains a secret"
                    )
                reports[reviewer_id] = report
            except (OSError, UnicodeError, SupervisorError):
                recoverable = False

        if _git(self.config.repository_path, "rev-parse", "HEAD") != immutable_sha:
            raise SupervisorError(
                "interrupted reviewer pair changed Git; manual reconciliation required"
            )
        validate_dirty_entries(git_status_entries(self.config.repository_path))
        if recoverable and set(reports) == {"T04-R1", "T04-R2"}:
            report_paths: dict[str, str] = {}
            for reviewer_id, report in reports.items():
                path = (
                    self.config.state_dir
                    / "reviewer-reports"
                    / f"{reviewer_id}-{immutable_sha}.txt"
                )
                _atomic_write_bytes(path, report.encode("utf-8"), mode=0o600)
                report_paths[reviewer_id] = str(path)
            state["next_prompt"] = "T04-R3"
            state["current_status"] = "review_complete"
            state["last_blocker"] = None
            state["reviewer_boundary_state"] = {
                "status": "reports_complete",
                "reviewers": ["T04-R1", "T04-R2"],
                "immutable_sha": immutable_sha,
                "reports": report_paths,
                "started_at": reviewer_state.get("started_at"),
                "completed_at": _utc_now(),
            }
        else:
            state["next_prompt"] = "T04-R1"
            state["current_status"] = "blocked"
            state["last_blocker"] = (
                "reviewer pair was interrupted; rerun both independent reviewers"
            )
            state["reviewer_boundary_state"] = {
                "status": "pending",
                "reviewers": ["T04-R1", "T04-R2"],
                "immutable_sha": immutable_sha,
                "reports": {},
            }
        state["active_run"] = None
        state["last_run_completed_at"] = _utc_now()
        self._write_state(state)
        return state

    def validate(self) -> dict[str, Any]:
        pack, capabilities = self._validate_static_setup()
        state = self.load_state(reconcile=True)
        self._validate_stored_state(pack, capabilities, state)
        return state

    def status(self) -> dict[str, Any]:
        return self.validate()

    def run_until(self, *, stop_before: str) -> dict[str, Any]:
        pack = self.load_pack()
        pack.prompt(stop_before)
        while True:
            state = self.validate()
            next_prompt = str(state["next_prompt"])
            if (
                next_prompt == stop_before
                or next_prompt.startswith("T18-")
                or next_prompt.startswith("T19-")
            ):
                state["current_status"] = "boundary_reached"
                state["last_blocker"] = (
                    f"stopped before {next_prompt}; separate operator authority required"
                )
                state["completion_timestamp"] = (
                    state.get("completion_timestamp") or _utc_now()
                )
                self._write_state(state)
                return state
            if state["current_status"] == "review_complete":
                return state
            state = self.step()
            if state["current_status"] == "review_complete":
                return state

    def step(self) -> dict[str, Any]:
        pack, capabilities = self._validate_static_setup()
        state = self.load_state(reconcile=True)
        self._validate_stored_state(pack, capabilities, state)
        next_prompt = str(state["next_prompt"])
        try:
            enforce_stop_boundary(pack, next_prompt, None)
        except StopBoundary as error:
            state["current_status"] = "boundary_reached"
            state["last_blocker"] = str(error)
            state["completion_timestamp"] = (
                state.get("completion_timestamp") or _utc_now()
            )
            self._write_state(state)
            raise
        if next_action_kind(pack, next_prompt) == "reviewer_pair":
            return self._run_reviewer_pair(pack, capabilities, state)

        if state["current_status"] == "blocked":
            state["current_status"] = "ready"
            state["last_blocker"] = None
        prompt = pack.prompt(next_prompt)
        previous_path = (
            self.config.state_dir / "handoffs" / f"{state['last_completed_prompt']}.txt"
        )
        try:
            previous_handoff = previous_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise SupervisorError(f"cannot read preceding handoff: {error}") from error
        reports: dict[str, str] | None = None
        if next_prompt == "T04-R3":
            reports = self._load_reviewer_reports(state)
        child_prompt = build_child_prompt(
            pack,
            next_prompt,
            previous_handoff,
            reviewer_reports=reports,
        )
        extra_scope_text = "\n".join(reports.values()) if reports else ""
        allowed_paths = self._allowed_paths_for_prompt(pack, prompt, extra_scope_text)
        prompt_secret = secret_violation(child_prompt)
        if prompt_secret:
            raise SupervisorError(prompt_secret)

        run_id = _run_id(next_prompt)
        paths = self._run_paths(run_id)
        _atomic_write_bytes(paths["prompt"], child_prompt.encode("utf-8"), mode=0o600)
        pre_head = _git(self.config.repository_path, "rev-parse", "HEAD")
        state["current_status"] = "running"
        state["last_run_started_at"] = _utc_now()
        state["active_run"] = {
            "prompt_id": next_prompt,
            "pre_head": pre_head,
            "run_id": run_id,
            "prompt_path": str(paths["prompt"]),
            "events_path": str(paths["events"]),
            "stderr_path": str(paths["stderr"]),
            "final_response_path": str(paths["final"]),
            "pid_path": str(paths["pid"]),
        }
        self._write_state(state)

        command = self._implementation_command(capabilities)
        command = self._guarded_command(command, run_id)
        child_env = self._child_environment()
        result = run_managed_process(
            command=command,
            prompt=child_prompt,
            cwd=self.config.repository_path,
            timeout_seconds=self.config.child_timeout_seconds,
            events_path=paths["events"],
            stderr_path=paths["stderr"],
            final_path=paths["final"],
            env=child_env,
            pid_path=paths["pid"],
            allowed_paths=allowed_paths,
        )
        if result.timed_out:
            return self._block_and_raise(state, f"{next_prompt} child timed out")
        if result.interrupted:
            return self._block_and_raise(state, f"{next_prompt} child was interrupted")
        if result.violation:
            return self._block_and_raise(
                state, f"{next_prompt} child boundary violation: {result.violation}"
            )
        if result.exit_code != 0:
            return self._block_and_raise(
                state, f"{next_prompt} child exited with status {result.exit_code}"
            )

        try:
            self._validate_completed_child(
                pack=pack,
                prompt=prompt,
                pre_head=pre_head,
                final_response=result.final_response,
                extra_scope_text=extra_scope_text,
            )
        except SupervisorError as error:
            return self._block_and_raise(state, str(error))

        actual_head = _git(self.config.repository_path, "rev-parse", "HEAD")
        _atomic_write_bytes(
            self.config.state_dir / "handoffs" / f"{next_prompt}.txt",
            result.final_response.encode("utf-8"),
            mode=0o600,
        )
        expected_next = pack.expected_next(next_prompt)
        state["last_completed_prompt"] = next_prompt
        state["last_commit"] = actual_head
        state["next_prompt"] = expected_next[0] if expected_next else "STOP"
        state["current_status"] = "ready"
        state["last_blocker"] = None
        state["active_run"] = None
        state["last_run_completed_at"] = _utc_now()
        if expected_next and expected_next[0].startswith("T18-"):
            state["completion_timestamp"] = _utc_now()
        if len(expected_next) > 1:
            state["reviewer_boundary_state"] = {
                "status": "pending",
                "reviewers": list(expected_next),
                "immutable_sha": actual_head,
                "reports": {},
            }
        self._write_state(state)
        return state

    def _validate_stored_state(
        self,
        pack: PromptPack,
        capabilities: CodexCapabilities,
        state: Mapping[str, Any],
    ) -> None:
        if (
            Path(str(state["repository_path"])).resolve()
            != self.config.repository_path.resolve()
        ):
            raise SupervisorError("stored repository path does not match configuration")
        if state["branch"] != _git(
            self.config.repository_path, "branch", "--show-current"
        ):
            raise SupervisorError("stored branch does not match Git")
        if state["prompt_pack_sha256"] != _sha256_file(self.config.prompt_pack_path):
            raise SupervisorError("stored prompt-pack SHA-256 is stale")
        if state["implementation_plan_sha256"] != _sha256_file(
            Path(pack.implementation_plan_path)
        ):
            raise SupervisorError("stored implementation-plan SHA-256 is stale")
        if (
            state["selected_codex_model"] != "gpt-5.6-sol"
            or state["reasoning_effort"] != "max"
        ):
            raise SupervisorError("stored child model/effort is invalid")
        if (
            tuple(state["child_cli_invocation_mode"])
            != capabilities.full_autonomy_flags
        ):
            raise SupervisorError(
                "stored Codex full-autonomy mode differs from installed CLI"
            )
        actual_head = _git(self.config.repository_path, "rev-parse", "HEAD")
        if actual_head != state["last_commit"]:
            raise SupervisorError(
                "stored last commit differs from Git HEAD; manual reconciliation required"
            )
        validate_dirty_entries(git_status_entries(self.config.repository_path))
        last_completed = str(state["last_completed_prompt"])
        expected = pack.expected_next(last_completed)
        reviewer_state = state.get("reviewer_boundary_state")
        if (
            isinstance(reviewer_state, dict)
            and reviewer_state.get("status") == "reports_complete"
        ):
            expected_state_next = ("T04-R3",)
        else:
            expected_state_next = expected
        if state["next_prompt"] not in expected_state_next:
            raise SupervisorError(
                f"stored next prompt {state['next_prompt']} does not follow {last_completed}"
            )
        validate_guidance_checkpoint(
            self.config.repository_path, last_completed, expected
        )

    def _validate_completed_child(
        self,
        *,
        pack: PromptPack,
        prompt: Prompt,
        pre_head: str,
        final_response: str,
        extra_scope_text: str = "",
    ) -> Handoff:
        handoff = parse_handoff(final_response)
        if handoff.prompt_id != prompt.prompt_id:
            raise SupervisorError(
                f"handoff prompt {handoff.prompt_id} does not match {prompt.prompt_id}"
            )
        if handoff.status != "COMPLETE":
            raise SupervisorError(f"{prompt.prompt_id} returned Status BLOCKED")
        if handoff.commit_sha is None or handoff.commit_subject is None:
            raise SupervisorError("writable prompt handoff does not report a commit")
        if prompt.commit_subject is None:
            raise SupervisorError(
                "selected writable prompt has no exact commit requirement"
            )
        if handoff.commit_subject != prompt.commit_subject:
            raise SupervisorError(
                "handoff commit subject does not satisfy selected prompt"
            )
        validate_commit_boundary(
            self.config.repository_path,
            handoff.commit_sha,
            handoff.commit_subject,
        )
        actual_head = handoff.commit_sha
        if actual_head == pre_head:
            raise SupervisorError("writable prompt did not create a commit")
        if (
            _git(self.config.repository_path, "rev-parse", f"{actual_head}^")
            != pre_head
        ):
            raise SupervisorError("child created an unexpected commit topology")
        if (
            _git(
                self.config.repository_path,
                "rev-list",
                "--count",
                f"{pre_head}..{actual_head}",
            )
            != "1"
        ):
            raise SupervisorError("child created more than one commit")
        expected_next = pack.expected_next(prompt.prompt_id)
        if set(handoff.next_prompt_ids) != set(expected_next):
            raise SupervisorError(
                f"handoff next prompt {handoff.next_prompt_ids} does not match {expected_next}"
            )
        validate_guidance_checkpoint(
            self.config.repository_path, prompt.prompt_id, expected_next
        )
        validate_dirty_entries(git_status_entries(self.config.repository_path))
        changed_paths = _git_lines(
            self.config.repository_path,
            "diff",
            "--name-only",
            pre_head,
            actual_head,
            "--",
        )
        if "FINDINGS.md" in changed_paths:
            raise SupervisorError("FINDINGS.md was committed")
        allowed = self._allowed_paths_for_prompt(pack, prompt, extra_scope_text)
        validate_frozen_paths(changed_paths, allowed)
        reported_paths = extract_reported_paths(handoff.fields["Files changed"])
        if set(reported_paths) != set(changed_paths):
            raise SupervisorError(
                "handoff Files changed does not match the committed paths"
            )
        staged = _git_lines(
            self.config.repository_path, "diff", "--cached", "--name-only", "--"
        )
        if staged:
            raise SupervisorError("child left staged paths after commit")
        diff = _git(
            self.config.repository_path,
            "diff",
            "--unified=0",
            pre_head,
            actual_head,
            "--",
        )
        diff_secret = secret_violation("\n".join(_added_diff_lines(diff)))
        if diff_secret:
            raise SupervisorError(diff_secret)
        evidence = (
            handoff.fields["Red evidence"] + "\n" + handoff.fields["Green evidence"]
        )
        evidence_contract = (
            prompt.text
            + "\n"
            + "\n".join(
                contract.text
                for contract in pack.required_contracts_for(prompt.prompt_id)
            )
        )
        missing_commands = [
            command
            for command in required_evidence_commands(evidence_contract)
            if _normalize_command(command) not in _normalize_command(evidence)
        ]
        if missing_commands:
            raise SupervisorError(
                "handoff omits required evidence commands: "
                + ", ".join(missing_commands)
            )
        if handoff.fields["Live/external actions"].strip().upper() != "NONE":
            raise SupervisorError(
                "local implementation prompt reported an external action"
            )
        return handoff

    def _allowed_paths_for_prompt(
        self, pack: PromptPack, prompt: Prompt, extra_scope_text: str = ""
    ) -> AllowedPathSpecs:
        contracts = pack.required_contracts_for(prompt.prompt_id)
        plan_context = ""
        if prompt.prompt_id != "T04-R3":
            try:
                plan_text = Path(pack.implementation_plan_path).read_text(
                    encoding="utf-8"
                )
            except (OSError, UnicodeError) as error:
                raise SupervisorError(
                    f"cannot read implementation plan: {error}"
                ) from error
            reference_text = (
                prompt.text + "\n" + "\n".join(item.text for item in contracts)
            )
            contexts = (
                []
                if prompt.prompt_id.startswith("T06-")
                else [extract_named_plan_context(plan_text, reference_text)]
            )
            task_numbers = {
                int(prompt.prompt_id[1:3]),
                *(item.task_number for item in contracts),
            }
            for task_number in sorted(task_numbers):
                if task_number == 6 and prompt.prompt_id.startswith("T06-"):
                    contexts.append(
                        extract_task_plan_context(plan_text, prompt.prompt_id)
                    )
                else:
                    contexts.append(
                        extract_task_plan_context(plan_text, f"T{task_number:02d}-A")
                    )
            plan_context = "\n\n".join(filter(None, contexts))
        return derive_allowed_path_specs(
            prompt, contracts, plan_context, extra_scope_text
        )

    def _implementation_command(
        self, capabilities: CodexCapabilities
    ) -> tuple[str, ...]:
        return (
            self.config.codex_executable,
            *capabilities.full_autonomy_prefix_flags,
            "exec",
            *capabilities.full_autonomy_exec_flags,
            "--model",
            self.config.model,
            "--config",
            f'model_reasoning_effort="{self.config.reasoning_effort}"',
            "--cd",
            str(self.config.repository_path.resolve()),
            "--ephemeral",
            "--json",
            "-",
        )

    def _child_environment(self) -> dict[str, str]:
        blocked_name = re.compile(
            r"(?:CLOCKIFY|RAILWAY|GITHUB|GH_TOKEN|PUMBLE|ZENDESK|NOTION|"
            r"MARKETPLACE|LIVE_|AWS_|NPM_TOKEN|DEEPSEEK|GEMINI|ANTHROPIC|"
            r"API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|SECRET|PASSWORD|PASSWD|"
            r"PRIVATE_?KEY|CREDENTIAL)",
            re.IGNORECASE,
        )
        environment = {
            name: value
            for name, value in os.environ.items()
            if not blocked_name.search(name)
        }
        node_parent = str(Path(self.config.node_executable).resolve().parent)
        environment["PATH"] = node_parent + os.pathsep + environment.get("PATH", "")
        return environment

    def _guarded_command(
        self, command: tuple[str, ...], run_id: str
    ) -> tuple[str, ...]:
        if not self.config.protect_findings:
            return command
        profile_path = (
            self.config.state_dir
            / "supervisor-checkpoints"
            / f"{run_id}-findings-deny.sb"
        )
        _write_findings_profile(
            profile_path, self.config.repository_path / "FINDINGS.md"
        )
        return ("/usr/bin/sandbox-exec", "-f", str(profile_path), *command)

    def _run_paths(self, run_id: str) -> dict[str, Path]:
        return {
            "prompt": self.config.state_dir / "child-run-prompts" / f"{run_id}.txt",
            "events": self.config.state_dir / "structured-events" / f"{run_id}.jsonl",
            "stderr": self.config.state_dir / "stderr-progress" / f"{run_id}.log",
            "final": self.config.state_dir / "final-responses" / f"{run_id}.txt",
            "pid": self.config.state_dir
            / "supervisor-checkpoints"
            / f"{run_id}-process.json",
        }

    def _block_and_raise(self, state: dict[str, Any], blocker: str) -> dict[str, Any]:
        state["current_status"] = "blocked"
        state["last_blocker"] = blocker
        state["last_failed_run"] = state.get("active_run")
        state["active_run"] = None
        state["last_run_completed_at"] = _utc_now()
        self._write_state(state)
        raise SupervisorError(blocker)

    def _load_reviewer_reports(self, state: Mapping[str, Any]) -> dict[str, str]:
        reviewer_state = state.get("reviewer_boundary_state")
        if (
            not isinstance(reviewer_state, dict)
            or reviewer_state.get("status") != "reports_complete"
        ):
            raise SupervisorError("T04-R3 requires both completed reviewer reports")
        reports = reviewer_state.get("reports")
        if not isinstance(reports, dict) or set(reports) != {"T04-R1", "T04-R2"}:
            raise SupervisorError(
                "reviewer state does not contain the complete report pair"
            )
        loaded: dict[str, str] = {}
        for reviewer_id, path_value in reports.items():
            try:
                loaded[reviewer_id] = Path(str(path_value)).read_text(encoding="utf-8")
            except (OSError, UnicodeError) as error:
                raise SupervisorError(
                    f"cannot read {reviewer_id} report: {error}"
                ) from error
        return loaded

    def _run_reviewer_pair(
        self,
        pack: PromptPack,
        capabilities: CodexCapabilities,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        expected_reviewers = pack.expected_next(str(state["last_completed_prompt"]))
        if expected_reviewers != ("T04-R1", "T04-R2"):
            raise SupervisorError("reviewer-pair execution is allowed only after T04-K")
        reviewer_state = state.get("reviewer_boundary_state")
        if (
            not isinstance(reviewer_state, dict)
            or reviewer_state.get("status") != "pending"
        ):
            raise SupervisorError("T04 reviewer pair is not in a pending state")
        immutable_sha = str(reviewer_state.get("immutable_sha", ""))
        if immutable_sha != state["last_commit"]:
            raise SupervisorError("reviewer pair is not bound to the stored T04-K SHA")
        if _git(self.config.repository_path, "rev-parse", "HEAD") != immutable_sha:
            raise SupervisorError("reviewer pair Git SHA drifted before launch")

        previous_path = self.config.state_dir / "handoffs" / "T04-K.txt"
        try:
            previous_handoff = previous_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise SupervisorError(f"cannot read T04-K handoff: {error}") from error

        launches: dict[str, tuple[tuple[str, ...], str, dict[str, Path]]] = {}
        for reviewer_id in expected_reviewers:
            reviewer_prompt = build_child_prompt(
                pack,
                reviewer_id,
                previous_handoff,
                read_only_reviewer=True,
                immutable_sha=immutable_sha,
            )
            prompt_secret = secret_violation(reviewer_prompt)
            if prompt_secret:
                raise SupervisorError(prompt_secret)
            run_id = _run_id(reviewer_id)
            paths = self._run_paths(run_id)
            _atomic_write_bytes(
                paths["prompt"], reviewer_prompt.encode("utf-8"), mode=0o600
            )
            command = self._reviewer_command(capabilities)
            launches[reviewer_id] = (
                self._guarded_command(command, run_id),
                reviewer_prompt,
                paths,
            )

        state["current_status"] = "reviewing"
        state["last_run_started_at"] = _utc_now()
        state["reviewer_boundary_state"] = {
            **reviewer_state,
            "status": "running",
            "started_at": _utc_now(),
            "reports": {},
            "runs": {
                reviewer_id: {
                    "final_response_path": str(launches[reviewer_id][2]["final"]),
                    "pid_path": str(launches[reviewer_id][2]["pid"]),
                    "events_path": str(launches[reviewer_id][2]["events"]),
                }
                for reviewer_id in expected_reviewers
            },
        }
        state["active_run"] = {
            "prompt_id": "T04-R1+T04-R2",
            "pre_head": immutable_sha,
            "run_id": "reviewer-pair",
            "final_response_path": None,
        }
        self._write_state(state)
        child_env = self._child_environment()

        def launch(
            reviewer_id: str,
        ) -> tuple[str, ChildProcessResult, dict[str, Path]]:
            command, reviewer_prompt, paths = launches[reviewer_id]
            result = run_managed_process(
                command=command,
                prompt=reviewer_prompt,
                cwd=self.config.repository_path,
                timeout_seconds=self.config.reviewer_timeout_seconds,
                events_path=paths["events"],
                stderr_path=paths["stderr"],
                final_path=paths["final"],
                env=child_env,
                pid_path=paths["pid"],
                read_only=True,
            )
            return reviewer_id, result, paths

        results: dict[str, tuple[ChildProcessResult, dict[str, Path]]] = {}
        with ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="codex-reviewer"
        ) as pool:
            futures = [
                pool.submit(launch, reviewer_id) for reviewer_id in expected_reviewers
            ]
            for future in futures:
                reviewer_id, result, paths = future.result()
                results[reviewer_id] = (result, paths)

        for reviewer_id in expected_reviewers:
            result, _paths = results[reviewer_id]
            if result.timed_out:
                return self._block_and_raise(state, f"{reviewer_id} timed out")
            if result.interrupted:
                return self._block_and_raise(state, f"{reviewer_id} was interrupted")
            if result.violation:
                return self._block_and_raise(
                    state, f"{reviewer_id} boundary violation: {result.violation}"
                )
            if result.exit_code != 0:
                return self._block_and_raise(
                    state, f"{reviewer_id} exited with status {result.exit_code}"
                )
            if not result.final_response.strip():
                return self._block_and_raise(
                    state, f"{reviewer_id} returned an empty report"
                )

        if _git(self.config.repository_path, "rev-parse", "HEAD") != immutable_sha:
            return self._block_and_raise(
                state,
                "reviewer pair changed the immutable T04-K SHA; manual reconciliation required",
            )
        try:
            validate_dirty_entries(git_status_entries(self.config.repository_path))
        except SupervisorError as error:
            return self._block_and_raise(state, str(error))

        report_paths: dict[str, str] = {}
        for reviewer_id in expected_reviewers:
            result, _paths = results[reviewer_id]
            report_path = (
                self.config.state_dir
                / "reviewer-reports"
                / f"{reviewer_id}-{immutable_sha}.txt"
            )
            _atomic_write_bytes(
                report_path, result.final_response.encode("utf-8"), mode=0o600
            )
            report_paths[reviewer_id] = str(report_path)

        state["next_prompt"] = "T04-R3"
        state["current_status"] = "review_complete"
        state["last_blocker"] = None
        state["active_run"] = None
        state["last_run_completed_at"] = _utc_now()
        state["reviewer_boundary_state"] = {
            "status": "reports_complete",
            "reviewers": list(expected_reviewers),
            "immutable_sha": immutable_sha,
            "reports": report_paths,
            "started_at": state["reviewer_boundary_state"].get("started_at"),
            "completed_at": _utc_now(),
        }
        self._write_state(state)
        return state

    def _reviewer_command(self, capabilities: CodexCapabilities) -> tuple[str, ...]:
        return (
            self.config.codex_executable,
            *capabilities.reviewer_prefix_flags,
            "exec",
            *capabilities.reviewer_exec_flags,
            "--model",
            self.config.model,
            "--config",
            f'model_reasoning_effort="{self.config.reasoning_effort}"',
            "--cd",
            str(self.config.repository_path.resolve()),
            "--ephemeral",
            "--json",
            "-",
        )

    def _validate_static_setup(self) -> tuple[PromptPack, CodexCapabilities]:
        repository = self.config.repository_path.resolve()
        state_dir = self.config.state_dir.resolve()
        if state_dir == repository or repository in state_dir.parents:
            raise SupervisorError(
                "supervisor state directory must be outside repository"
            )
        root = Path(_git(repository, "rev-parse", "--show-toplevel")).resolve()
        if root != repository:
            raise SupervisorError(
                f"configured repository {repository} is not Git root {root}"
            )
        pack = self.load_pack()
        if Path(pack.repository_path).resolve() != repository:
            raise SupervisorError(
                "prompt-pack repository path does not match configuration"
            )
        plan_path = Path(pack.implementation_plan_path).resolve()
        if _sha256_file(plan_path) != pack.declared_plan_sha256:
            raise SupervisorError(
                "implementation-plan SHA-256 does not match prompt pack"
            )
        expected_branch = _expected_branch(pack)
        branch = _git(repository, "branch", "--show-current")
        if branch != expected_branch:
            raise SupervisorError(
                f"expected branch {expected_branch!r}, found {branch!r}"
            )
        _run(
            ("git", "merge-base", "--is-ancestor", pack.baseline_commit, "HEAD"),
            cwd=repository,
        )
        validate_node22(self.config.node_executable)
        validate_dirty_entries(git_status_entries(repository))
        if self.config.protect_findings:
            validate_findings_guard_support()
        return pack, detect_codex_capabilities(self.config.codex_executable)

    def _create_state_directories(self) -> None:
        self.config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.config.state_dir.chmod(0o700)
        except OSError as error:
            raise SupervisorError(f"cannot secure state directory: {error}") from error
        for name in STATE_SUBDIRECTORIES:
            path = self.config.state_dir / name
            path.mkdir(exist_ok=True, mode=0o700)
            path.chmod(0o700)

    def _write_state(self, state: Mapping[str, Any]) -> None:
        payload = (json.dumps(state, indent=2, sort_keys=True) + "\n").encode("utf-8")
        _atomic_write_bytes(self.state_path, payload, mode=0o600)
        checkpoint_name = (
            _utc_now().replace(":", "").replace("+00:00", "Z")
            + f"-{time.time_ns()}-{state['current_status']}.json"
        )
        _atomic_write_bytes(
            self.config.state_dir / "supervisor-checkpoints" / checkpoint_name,
            payload,
            mode=0o600,
        )

    def record_interruption(self, reason: str) -> None:
        if not self.state_path.exists():
            return
        try:
            state = self.load_state(reconcile=False)
        except SupervisorError:
            return
        state["last_blocker"] = reason
        state["last_run_completed_at"] = _utc_now()
        self._write_state(state)


def validate_guidance_checkpoint(
    repository: Path, completed_prompt: str, next_prompt_ids: tuple[str, ...]
) -> None:
    observed_next: list[tuple[str, ...]] = []
    for name in ("CLAUDE.md", "AGENTS.md"):
        try:
            text = (repository / name).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise SupervisorError(f"cannot read {name}: {error}") from error
        matches = list(
            re.finditer(r"(?m)^## Current v2 implementation checkpoint\s*$", text)
        )
        if len(matches) != 1:
            raise SupervisorError(f"{name} must contain exactly one v2 checkpoint")
        start = matches[0].end()
        next_heading = re.search(r"(?m)^## ", text[start:])
        end = start + next_heading.start() if next_heading else len(text)
        checkpoint = text[start:end]
        if completed_prompt not in checkpoint:
            raise SupervisorError(
                f"{name} checkpoint does not record {completed_prompt}"
            )
        next_fragments = []
        for line in checkpoint.splitlines():
            next_match = re.search(r"\bnext\b", line, re.IGNORECASE)
            if next_match:
                next_fragments.append(line[next_match.end() :])
        ids = tuple(
            dict.fromkeys(
                prompt_id
                for fragment in next_fragments
                for prompt_id in PROMPT_ID_RE.findall(fragment)
            )
        )
        if set(ids) != set(next_prompt_ids):
            raise SupervisorError(
                f"{name} checkpoint next prompt {ids} does not match {next_prompt_ids}"
            )
        observed_next.append(ids)
    if set(observed_next[0]) != set(observed_next[1]):
        raise SupervisorError("CLAUDE.md and AGENTS.md checkpoints disagree")


def validate_node22(executable: str) -> None:
    version = _command_output((executable, "--version"), timeout=10.0).strip()
    abi = _command_output(
        (executable, "-p", "process.versions.modules"), timeout=10.0
    ).strip()
    if not re.fullmatch(r"v22\.\d+\.\d+", version) or abi != "127":
        raise SupervisorError(
            f"Node 22 with ABI 127 is required; found version={version!r}, ABI={abi!r}"
        )


def validate_findings_guard_support() -> None:
    if platform.system() != "Darwin" or not Path("/usr/bin/sandbox-exec").is_file():
        raise SupervisorError(
            "macOS sandbox-exec is required to deny FINDINGS.md content access"
        )
    with tempfile.TemporaryDirectory(prefix="codex-findings-guard-") as directory:
        root = Path(directory).resolve()
        protected = root / "FINDINGS.md"
        profile = root / "profile.sb"
        protected.write_text("guard probe\n", encoding="utf-8")
        _write_findings_profile(profile, protected)
        completed = subprocess.run(
            ("/usr/bin/sandbox-exec", "-f", str(profile), "/bin/cat", str(protected)),
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5.0,
        )
        if completed.returncode == 0:
            raise SupervisorError(
                "macOS sandbox profile did not deny FINDINGS.md content access"
            )


def _write_findings_profile(path: Path, findings_path: Path) -> None:
    canonical = str(findings_path.resolve())
    escaped = canonical.replace("\\", "\\\\").replace('"', '\\"')
    profile = (
        "(version 1)\n"
        "(allow default)\n"
        f'(deny file-read-data file-write* (literal "{escaped}"))\n'
    )
    _atomic_write_bytes(path, profile.encode("utf-8"), mode=0o600)


def extract_named_plan_context(plan_text: str, reference_text: str) -> str:
    lines = plan_text.splitlines()
    ranges: set[tuple[int, int]] = set()
    for start, end in re.findall(r"\blines?\s+(\d+)-(\d+)\b", reference_text):
        start_number = int(start)
        end_number = int(end)
        if start_number < 1 or end_number < start_number or end_number > len(lines):
            raise SupervisorError(
                f"canonical-plan line range is out of bounds: {start_number}-{end_number}"
            )
        ranges.add((start_number, end_number))
    for task_suffix in set(re.findall(r"\bTask\s+6([A-G])\b", reference_text)):
        heading = re.search(rf"(?m)^### Task 6{task_suffix}:.*$", plan_text)
        if heading is None:
            raise SupervisorError(f"canonical plan is missing Task 6{task_suffix}")
        next_heading = re.search(
            r"(?m)^### Task 6(?:[A-G]| final parity gate):|^## Task 7:",
            plan_text[heading.end() :],
        )
        end_offset = (
            heading.end() + next_heading.start()
            if next_heading is not None
            else len(plan_text)
        )
        start_line = plan_text.count("\n", 0, heading.start()) + 1
        end_line = plan_text.count("\n", 0, end_offset) + 1
        ranges.add((start_line, end_line))
    return "\n\n".join(
        "\n".join(lines[start - 1 : end]) for start, end in sorted(ranges)
    )


def extract_task_plan_context(plan_text: str, prompt_id: str) -> str:
    match = re.fullmatch(r"T(\d{2})(?:-[A-Z0-9]+)+", prompt_id)
    if match is None:
        raise SupervisorError(
            f"invalid prompt ID for canonical-plan scope: {prompt_id}"
        )
    task_number = int(match.group(1))
    heading = re.search(rf"(?m)^## Task {task_number}:.*$", plan_text)
    if heading is None:
        return ""
    next_heading = re.search(r"(?m)^## Task \d+:.*$", plan_text[heading.end() :])
    end = (
        heading.end() + next_heading.start()
        if next_heading is not None
        else len(plan_text)
    )
    return plan_text[heading.start() : end].rstrip() + "\n"


def extract_reported_paths(value: str) -> tuple[str, ...]:
    if value.strip().lower() == "none":
        return ()
    paths: list[str] = []
    for part in value.split(","):
        candidate = part.strip().strip("`")
        if not candidate or candidate.lower() == "none":
            continue
        if not re.fullmatch(r"[A-Za-z0-9_.@+*?\-/]+", candidate):
            raise SupervisorError(
                f"handoff contains a non-path Files changed entry: {candidate}"
            )
        paths.append(PurePosixPath(candidate).as_posix().removeprefix("./"))
    if len(paths) != len(set(paths)):
        raise SupervisorError("handoff Files changed contains duplicates")
    return tuple(paths)


def required_evidence_commands(prompt_text: str) -> tuple[str, ...]:
    commands: list[str] = []
    for block in re.findall(r"(?ms)```(?:bash|sh|zsh)?\s*\n(.*?)^```\s*$", prompt_text):
        for line in block.splitlines():
            candidate = line.strip()
            if (
                candidate
                and not candidate.startswith("#")
                and re.match(
                    r"^(?:PATH=|LIVE_[A-Z_]+=|npm\s|npx\s|node\s|git\s|rg\s|shasum\s)",
                    candidate,
                )
            ):
                commands.append(candidate)
    for code in re.findall(r"`([^`\n]+)`", prompt_text):
        candidate = code.strip()
        if re.match(r"^(?:npm\s|npx\s|node\s|git\s|rg\s|shasum\s)", candidate):
            commands.append(candidate)
    return tuple(dict.fromkeys(commands))


def _normalize_command(value: str) -> str:
    return " ".join(value.split())


def _added_diff_lines(diff: str) -> Iterable[str]:
    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            yield line[1:]


def _git_lines(repository: Path, *args: str) -> tuple[str, ...]:
    output = _git(repository, *args)
    return tuple(line for line in output.splitlines() if line)


def _run_id(prompt_id: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{timestamp}-{time.time_ns()}-{prompt_id}"


def _expected_branch(pack: PromptPack) -> str:
    match = re.search(r"(?m)^git switch -c ([^\s]+)\s*$", pack.prompt("T00-A").text)
    if match is None:
        raise SupervisorError("cannot derive expected implementation branch from T00-A")
    return match.group(1)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise SupervisorError(f"cannot hash {path}: {error}") from error
    return digest.hexdigest()


def _atomic_write_bytes(path: Path, payload: bytes, *, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            raise SupervisorError(f"cannot atomically write {path}: {error}") from error
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _git(repository: Path, *args: str) -> str:
    return _command_output(("git", *args), cwd=repository).strip()


def _command_output(
    command: tuple[str, ...], *, cwd: Path | None = None, timeout: float = 30.0
) -> str:
    completed = _run(command, cwd=cwd, timeout=timeout)
    assert isinstance(completed.stdout, str)
    return completed.stdout


def _run(
    command: tuple[str, ...],
    *,
    cwd: Path | None = None,
    timeout: float = 30.0,
    text: bool = True,
) -> subprocess.CompletedProcess[Any]:
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=True,
            text=text,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise SupervisorError(f"required executable not found: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise SupervisorError(f"command timed out: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        stderr = error.stderr
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        summary = (stderr or "").strip().splitlines()[-1:] or ["no stderr"]
        raise SupervisorError(
            f"command failed ({error.returncode}): {' '.join(command)}: {summary[0]}"
        ) from error


def _argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fail-closed local supervisor for the AI Assistant v2 prompt pack"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=(
            Path(os.environ["AI_ASSISTANT_V2_SUPERVISOR_CONFIG"])
            if os.environ.get("AI_ASSISTANT_V2_SUPERVISOR_CONFIG")
            else None
        ),
        help="optional JSON configuration path",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    adopt = commands.add_parser("adopt", help="adopt the completed T01-C boundary")
    adopt.add_argument("--completed", required=True)
    adopt.add_argument("--handoff", required=True, type=Path)
    commands.add_parser("status", help="show reconciled supervisor status")
    commands.add_parser("step", help="execute exactly one prompt or reviewer pair")
    run = commands.add_parser("run", help="run prompts until a hard boundary")
    run.add_argument("--stop-before", default="T18-A")
    commands.add_parser("validate", help="validate setup without launching Codex")
    return parser


def _format_state(state: Mapping[str, Any]) -> str:
    reviewer = state.get("reviewer_boundary_state")
    reviewer_status = (
        reviewer.get("status") if isinstance(reviewer, dict) else "unknown"
    )
    blocker = state.get("last_blocker") or "none"
    mode = " ".join(str(value) for value in state["child_cli_invocation_mode"])
    return "\n".join(
        (
            f"status: {state['current_status']}",
            f"last completed: {state['last_completed_prompt']}",
            f"last commit: {state['last_commit']}",
            f"next prompt: {state['next_prompt']}",
            f"branch: {state['branch']}",
            f"model: {state['selected_codex_model']} ({state['reasoning_effort']})",
            f"full-autonomy mode: {mode}",
            f"reviewer boundary: {reviewer_status}",
            f"last blocker: {blocker}",
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = _argument_parser()
    args = parser.parse_args(argv)
    instance: Supervisor | None = None

    def interrupt_handler(_signal_number: int, _frame: Any) -> None:
        _terminate_all_active_processes()
        raise KeyboardInterrupt

    prior_sigint = signal.signal(signal.SIGINT, interrupt_handler)
    prior_sigterm = signal.signal(signal.SIGTERM, interrupt_handler)
    try:
        config = SupervisorConfig.load(args.config)
        with supervisor_lock(config):
            instance = Supervisor(config)
            if args.command == "adopt":
                state = instance.adopt(
                    completed=args.completed,
                    handoff_path=args.handoff,
                )
            elif args.command == "status":
                state = instance.status()
            elif args.command == "validate":
                state = instance.validate()
            elif args.command == "step":
                state = instance.step()
            elif args.command == "run":
                state = instance.run_until(stop_before=args.stop_before)
            else:
                parser.error(f"unsupported command: {args.command}")
        print(_format_state(state))
        return 0
    except StopBoundary as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 3
    except SupervisorError as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        _terminate_all_active_processes()
        if instance is not None:
            instance.record_interruption("supervisor interrupted by signal")
        print(
            "BLOCKED: supervisor interrupted; child process groups terminated",
            file=sys.stderr,
        )
        return 130
    finally:
        signal.signal(signal.SIGINT, prior_sigint)
        signal.signal(signal.SIGTERM, prior_sigterm)


if __name__ == "__main__":
    raise SystemExit(main())
