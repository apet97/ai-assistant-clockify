import type { ToolCompletion } from "../../../src/assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../../../src/harness/api-operation.js";
import type { FakeWorkspaceSeed } from "../../helpers/fake/state.js";

/**
 * Closure-plan PR 12 (F05): the scripted-model scenarios behind the REAL-server
 * browser journeys. Each scenario is an ordered list of native-tool
 * completions — exactly the `scriptedToolModel` contract the integration
 * suites already prove against the production pipeline — plus the fake
 * workspace seed and optional one-shot host-failure injections. NOTHING here
 * authors a response frame: every byte the browser sees is produced by the
 * real server from these inputs.
 */
export interface ScenarioDefinition {
  seed: FakeWorkspaceSeed;
  script: ToolCompletion[];
  /** One-shot Clockify port failures, consumed in order per method name. */
  failures?: Array<{ method: string; message: string }>;
  /** Per-user workspace roles for the live role recheck (member journeys). */
  memberRoles?: Record<string, string>;
}

function discover(query: string, id = "tc-find"): ToolCompletion {
  return { text: "", toolCalls: [{ id, name: DISCOVERY_META_TOOL_NAME, arguments: { query } }] };
}

function call(name: string, args: Record<string, unknown>, id = "tc-call"): ToolCompletion {
  return { text: "", toolCalls: [{ id, name, arguments: args }] };
}

function answer(text: string): ToolCompletion {
  return { text, toolCalls: [] };
}

const TWO_PROJECTS: FakeWorkspaceSeed = {
  projects: [
    { id: "aaaaaaaaaaaaaaaaaaaaaa01", name: "Website launch" },
    { id: "aaaaaaaaaaaaaaaaaaaaaa02", name: "Internal tools" },
  ],
};

export const SCENARIOS: Record<string, ScenarioDefinition> = {
  "read-grounded": {
    seed: TWO_PROJECTS,
    script: [
      discover("list projects"),
      call("clockify_projects_list", {}),
      answer("You have two active projects: Website launch and Internal tools."),
    ],
  },

  "read-failure": {
    seed: TWO_PROJECTS,
    failures: [{ method: "listProjects", message: "injected e2e host failure" }],
    script: [
      discover("list projects"),
      call("clockify_projects_list", {}),
      answer("I couldn't load your projects just now. Please try again."),
      discover("list projects", "tc-find-2"),
      call("clockify_projects_list", {}, "tc-call-2"),
      answer("Second try: you have two active projects."),
    ],
  },

  "write-preview": {
    seed: {},
    script: [
      discover("create a tag"),
      call("clockify_tags_create", { name: "Billable" }),
      answer("Review the preview and confirm."),
    ],
  },

  "write-batch": {
    seed: {},
    script: [
      discover("create tag and project"),
      {
        text: "",
        toolCalls: [
          { id: "tc-a", name: "clockify_tags_create", arguments: { name: "batch-tag" } },
          { id: "tc-b", name: "clockify_projects_create", arguments: { name: "Batch Project" } },
        ],
      },
      answer("Review both previews."),
    ],
  },

  "batch-ambiguity": {
    seed: {
      clients: [
        { id: "bbbbbbbbbbbbbbbbbbbbbb01", name: "Acme Co" },
        { id: "bbbbbbbbbbbbbbbbbbbbbb02", name: "Acme Corp" },
      ],
    },
    script: [
      discover("create tag and client project"),
      {
        text: "",
        toolCalls: [
          { id: "tc-a", name: "clockify_tags_create", arguments: { name: "ambiguity-tag" } },
          {
            id: "tc-b",
            name: "clockify_projects_create",
            arguments: { name: "New Site", clientName: "Acme" },
          },
        ],
      },
      answer("Which Acme did you mean?"),
    ],
  },

  "clarify-option": {
    seed: {
      projects: [
        { id: "cccccccccccccccccccccc01", name: "Alpha One" },
        { id: "cccccccccccccccccccccc02", name: "Alpha Two" },
      ],
      entries: [
        {
          id: "dddddddddddddddddddddd01",
          description: "Alpha One work",
          projectId: "cccccccccccccccccccccc01",
          start: "2026-07-26T09:00:00Z",
          end: "2026-07-26T10:00:00Z",
        },
      ],
    },
    script: [
      discover("time entries"),
      call("clockify_entries_list", { projectName: "Alpha" }),
      answer("Alpha One has one tracked entry."),
    ],
  },

  "clarify-freetext": {
    seed: {
      projects: [
        { id: "cccccccccccccccccccccc01", name: "Alpha One" },
        { id: "cccccccccccccccccccccc02", name: "Alpha Two" },
      ],
      entries: [
        {
          id: "dddddddddddddddddddddd02",
          description: "Alpha Two work",
          projectId: "cccccccccccccccccccccc02",
          start: "2026-07-26T09:00:00Z",
          end: "2026-07-26T10:00:00Z",
        },
      ],
    },
    script: [
      discover("time entries"),
      call("clockify_entries_list", { projectName: "Alpha" }),
      call("clockify_entries_list", { projectName: "Alpha Two" }, "tc-call-2"),
      answer("Alpha Two has one tracked entry."),
    ],
  },

  "history-terminal": {
    seed: {},
    script: [
      discover("create a tag"),
      call("clockify_tags_create", { name: "History Tag" }),
      answer("Review the preview and confirm."),
    ],
  },

  "member-rejection": {
    seed: {},
    memberRoles: { "admin-user-1": "USER" },
    script: [answer("unused")],
  },
};

export type ScenarioName = keyof typeof SCENARIOS;
