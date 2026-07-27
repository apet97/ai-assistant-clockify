import type { RestCore } from "./core.js";
import type { ProjectPort } from "../ports/projects.js";
import type { ProjectSummary } from "../types.js";

/**
 * Typed project REST module (goclmcp §2.2). I/O only — risk/policy/confirmation
 * stay in the harness. Methods mirror the Go reference's operations and shapes:
 * estimate and memberships use PATCH (not PUT); rate writes the raw integer
 * `amount` to the `.../{userId}/{hourly-rate|cost-rate}` endpoint; delete
 * archives first because Clockify rejects deleting an active project.
 */
/** Project row fields read by {@link makeProjectRest} `map`. */
type ProjectRow = {
  id: string;
  name: string;
  clientId?: string;
  archived?: boolean;
  billable?: boolean;
  isPublic?: boolean;
  public?: boolean;
};

type ProjectRateRequest = { amount: number };
const MEMBERSHIP_STATUSES = new Set(["PENDING", "ACTIVE", "DECLINED", "INACTIVE"]);
const MEMBERSHIP_TYPES = new Set(["WORKSPACE", "PROJECT", "USERGROUP"]);

function decodeMembershipRate(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw malformedProjectField(field);
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.amount) || (row.amount as number) < 0 || (row.amount as number) > 2_147_483_647) {
    throw malformedProjectField(`${field}.amount`);
  }
  if (row.since !== undefined && (
    typeof row.since !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(row.since)
    || Number.isNaN(Date.parse(row.since))
  )) throw malformedProjectField(`${field}.since`);
  return {
    amount: row.amount,
    ...(typeof row.since === "string" ? { since: row.since } : {}),
  };
}

/** Decode response DTOs into the closed request shape accepted by PATCH
 * /projects/{id}/memberships. Response-only targetId and unknown fields never
 * enter a prepared mutation. Stable ordering also makes reconciliation immune
 * to Clockify returning the same set in a different order. */
export function decodeProjectMembershipRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw malformedProjectField("memberships");
  const normalized = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw malformedProjectField(`memberships[${index}]`);
    const row = item as Record<string, unknown>;
    if (typeof row.userId !== "string" || row.userId.length === 0) throw malformedProjectField(`memberships[${index}].userId`);
    const hourlyRate = decodeMembershipRate(row.hourlyRate, `memberships[${index}].hourlyRate`);
    const costRate = decodeMembershipRate(row.costRate, `memberships[${index}].costRate`);
    if (row.membershipStatus !== undefined && (
      typeof row.membershipStatus !== "string" || !MEMBERSHIP_STATUSES.has(row.membershipStatus)
    )) throw malformedProjectField(`memberships[${index}].membershipStatus`);
    if (row.membershipType !== undefined && (
      typeof row.membershipType !== "string" || !MEMBERSHIP_TYPES.has(row.membershipType)
    )) throw malformedProjectField(`memberships[${index}].membershipType`);
    return {
      userId: row.userId,
      ...(typeof row.membershipStatus === "string" ? { membershipStatus: row.membershipStatus } : {}),
      ...(typeof row.membershipType === "string" ? { membershipType: row.membershipType } : {}),
      ...(hourlyRate ? { hourlyRate } : {}),
      ...(costRate ? { costRate } : {}),
    };
  }).sort((left, right) => String(left.userId).localeCompare(String(right.userId)));
  if (new Set(normalized.map((row) => row.userId)).size !== normalized.length) {
    throw malformedProjectField("memberships[].userId");
  }
  return normalized;
}
type ProjectUpdateRequest = {
  archived?: boolean;
  billable?: boolean;
  clientId?: string;
  color?: string;
  costRate?: ProjectRateRequest;
  hourlyRate?: ProjectRateRequest;
  isPublic?: boolean;
  name?: string;
  note?: string;
};

const PROJECT_UPDATE_TEXT_FIELDS = ["clientId", "color", "name", "note"] as const;
const PROJECT_UPDATE_BOOLEAN_FIELDS = ["archived", "billable"] as const;

function malformedProjectField(field: string): TypeError {
  return new TypeError(`Clockify returned a malformed project field: ${field}.`);
}

function sanitizeProjectRate(value: unknown, field: string): ProjectRateRequest | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw malformedProjectField(field);
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.amount) || (row.amount as number) < 0 || (row.amount as number) > 2_147_483_647) {
    throw malformedProjectField(`${field}.amount`);
  }
  return { amount: row.amount as number };
}

function sanitizeProjectUpdateSource(
  source: Record<string, unknown>,
  options: { allowPublicAlias: boolean },
): ProjectUpdateRequest {
  const body: ProjectUpdateRequest = {};
  for (const field of PROJECT_UPDATE_TEXT_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw malformedProjectField(field);
    if (field === "color" && !/^#[0-9a-fA-F]{6}$/.test(value)) throw malformedProjectField(field);
    if (field === "name" && (value.length < 2 || value.length > 250)) throw malformedProjectField(field);
    if (field === "note" && value.length > 16_384) throw malformedProjectField(field);
    body[field] = value;
  }
  for (const field of PROJECT_UPDATE_BOOLEAN_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw malformedProjectField(field);
    body[field] = value;
  }
  const isPublic = source.isPublic;
  const legacyPublic = options.allowPublicAlias ? source.public : undefined;
  if (isPublic !== undefined && typeof isPublic !== "boolean") {
    throw malformedProjectField("isPublic");
  }
  if (legacyPublic !== undefined && typeof legacyPublic !== "boolean") {
    throw malformedProjectField("public");
  }
  if (typeof isPublic === "boolean" && typeof legacyPublic === "boolean" && isPublic !== legacyPublic) {
    throw malformedProjectField("public/isPublic");
  }
  if (typeof isPublic === "boolean" || typeof legacyPublic === "boolean") {
    body.isPublic = typeof isPublic === "boolean" ? isPublic : legacyPublic as boolean;
  }
  const hourlyRate = sanitizeProjectRate(source.hourlyRate, "hourlyRate");
  const costRate = sanitizeProjectRate(source.costRate, "costRate");
  if (hourlyRate) body.hourlyRate = hourlyRate;
  if (costRate) body.costRate = costRate;
  return body;
}

export function makeProjectRest(core: RestCore, workspaceId: string): ProjectPort {
  const ws = `/workspaces/${workspaceId}`;
  const map = (p: ProjectRow): ProjectSummary => ({
    id: p.id,
    name: p.name,
    clientId: p.clientId,
    archived: p.archived,
    billable: p.billable,
    isPublic: p.isPublic ?? p.public,
  });

  const createProjectAtomic: ProjectPort["createProjectAtomic"] = async (input) => map((await core.mutate("api", "POST", `${ws}/projects`, {
    name: input.name,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.billable !== undefined ? { billable: input.billable } : {}),
    ...(input.color ? { color: input.color } : {}),
    ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
    ...(input.hourlyRate ? { hourlyRate: input.hourlyRate } : {}),
    ...(input.costRate ? { costRate: input.costRate } : {}),
  })) as ProjectRow);
  const prepareProjectUpdate: ProjectPort["prepareProjectUpdate"] = async (id, patch) => {
    const body: ProjectUpdateRequest = {
      ...sanitizeProjectUpdateSource(
        (await core.call("api", "GET", `${ws}/projects/${id}`)) as Record<string, unknown>,
        { allowPublicAlias: true },
      ),
      ...sanitizeProjectUpdateSource(patch, { allowPublicAlias: false }),
    };
    if (typeof body.name !== "string") throw malformedProjectField("name");
    return body;
  };
  const updateProjectAtomic: ProjectPort["updateProjectAtomic"] = async (id, body) =>
    map((await core.mutate("api", "PUT", `${ws}/projects/${id}`, body)) as ProjectRow);
  const archiveProjectAtomic: ProjectPort["archiveProjectAtomic"] = updateProjectAtomic;
  const deleteProjectAtomic: ProjectPort["deleteProjectAtomic"] = async (projectId) => {
    await core.mutate("api", "DELETE", `${ws}/projects/${projectId}`);
  };
  const createProjectFromTemplateAtomic: ProjectPort["createProjectFromTemplateAtomic"] = async (input) =>
    map((await core.mutate("api", "POST", `${ws}/projects/from-template`, input)) as ProjectRow);
  const updateProjectRateAtomic: ProjectPort["updateProjectRateAtomic"] = async (input) => {
    const kind = input.rateKind === "COST" ? "cost-rate" : "hourly-rate";
    await core.mutate("api", "PUT", `${ws}/projects/${input.projectId}/users/${input.userId}/${kind}`, {
      amount: input.amountMinor,
      ...(input.since ? { since: input.since } : {}),
    });
  };
  const updateProjectMemberHourlyRateAtomic: ProjectPort["updateProjectMemberHourlyRateAtomic"] = async (input) => {
    await core.mutate("api", "PUT", `${ws}/projects/${input.projectId}/users/${input.userId}/hourly-rate`, {
      amount: input.amountMinor,
      ...(input.since ? { since: input.since } : {}),
    });
  };
  const updateProjectMemberCostRateAtomic: ProjectPort["updateProjectMemberCostRateAtomic"] = async (input) => {
    await core.mutate("api", "PUT", `${ws}/projects/${input.projectId}/users/${input.userId}/cost-rate`, {
      amount: input.amountMinor,
      ...(input.since ? { since: input.since } : {}),
    });
  };
  const updateProjectEstimateAtomic: ProjectPort["updateProjectEstimateAtomic"] = async (id, patch) => {
    await core.mutate("api", "PATCH", `${ws}/projects/${id}/estimate`, patch);
  };
  const updateProjectMembershipsAtomic: ProjectPort["updateProjectMembershipsAtomic"] = async (id, patch) => {
    await core.mutate("api", "PATCH", `${ws}/projects/${id}/memberships`, patch);
  };

  return {
    async listProjects(filter) {
      const params: Record<string, string> = { archived: String(filter?.archived ?? false) };
      if (filter?.name) params.name = filter.name;
      if (filter?.clientIds?.length) params.clients = filter.clientIds.join(",");
      const result = await core.paginate("api", `${ws}/projects`, params);
      return { ...result, rows: (result.rows as ProjectRow[]).map(map) };
    },
    async getProject(id) {
      const p = (await core.call("api", "GET", `${ws}/projects/${id}`, undefined, true)) as ProjectRow | null;
      return p ? map(p) : null;
    },
    async getProjectMutationState(id) {
      return await core.call("api", "GET", `${ws}/projects/${id}`, undefined, true) as Record<string, unknown> | null;
    },
    async createProject(input) {
      return createProjectAtomic(input);
    },
    createProjectAtomic,
    async updateProject(id, patch) {
      return updateProjectAtomic(id, await prepareProjectUpdate(id, patch));
    },
    prepareProjectUpdate,
    updateProjectAtomic,
    async archiveProject(id) {
      return archiveProjectAtomic(id, await prepareProjectUpdate(id, { archived: true }));
    },
    archiveProjectAtomic,
    async deleteProject(id) {
      await archiveProjectAtomic(id, await prepareProjectUpdate(id, { archived: true }));
      await deleteProjectAtomic(id);
    },
    deleteProjectAtomic,
    async createProjectFromTemplate(input) {
      // CreateProjectFromTemplateV1: required [name, templateProjectId]; no `templateId` key.
      return createProjectFromTemplateAtomic(input);
    },
    createProjectFromTemplateAtomic,
    async updateProjectRate(input) {
      await updateProjectRateAtomic(input);
    },
    updateProjectRateAtomic,
    updateProjectMemberHourlyRateAtomic,
    updateProjectMemberCostRateAtomic,
    async updateProjectEstimate(id, patch) {
      // PATCH, per the goclmcp reference (the plan's "PUT" predates that check).
      await updateProjectEstimateAtomic(id, patch);
    },
    updateProjectEstimateAtomic,
    async updateProjectMemberships(id, patch) {
      // PATCH, per the goclmcp reference. Replaces the membership set.
      await updateProjectMembershipsAtomic(id, patch);
    },
    updateProjectMembershipsAtomic,
    async getProjectMemberships(projectId) {
      const p = await core.call("api", "GET", `${ws}/projects/${projectId}`, undefined, true) as unknown;
      if (!p || typeof p !== "object" || Array.isArray(p) ||
          !Object.prototype.hasOwnProperty.call(p, "memberships")) {
        throw malformedProjectField("memberships");
      }
      return {
        rows: decodeProjectMembershipRows((p as { memberships: unknown }).memberships),
        truncated: false,
      };
    },
  };
}
