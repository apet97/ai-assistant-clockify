import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { UserPort, UserSummary, GroupSummary, CalendarContext, UserRoleAssignment } from "../ports/users.js";
import { assertCompleteAbsence } from "./list-pages.js";
import { AmbiguousWriteOutcome } from "../write-outcome.js";

/** A workspace role entry as read by {@link makeUserRest} `getWorkspaceMemberRole`. */
type RoleEntry = {
  role?: string;
  name?: string;
  formatterRoleName?: string;
  entityId?: string;
  entity?: { id?: string; type?: string };
  entities?: Array<{ id?: string }>;
  sourceType?: string;
};

/** Member row fields read by {@link mapUser} + the per-member role read. */
type UserRow = {
  id: string;
  name?: string;
  email?: string;
  status?: string;
  role?: string;
  roles?: RoleEntry[];
  timeZone?: string;
  timezone?: string;
  weekStartsOn?: number | string;
  weekStart?: number | string;
  startOfWeek?: number | string;
  settings?: Record<string, unknown>;
  hourlyRate?: { amount?: number; since?: string };
  costRate?: { amount?: number; since?: string };
};

/** Group row fields read by {@link mapGroup}. */
type GroupRow = {
  id: string;
  name?: string;
  userIds?: string[];
};

function mapUser(raw: UserRow): UserSummary {
  const out: UserSummary = { id: raw.id, name: raw.name ?? raw.email ?? raw.id };
  if (raw.email !== undefined) out.email = raw.email;
  if (raw.status !== undefined) out.status = raw.status;
  return out;
}

function mapGroup(raw: GroupRow): GroupSummary {
  const out: GroupSummary = { id: raw.id, name: raw.name ?? raw.id };
  if (Array.isArray(raw.userIds)) out.userIds = raw.userIds;
  return out;
}

/** Normalize the two live workspace authority names into the session gate's
 * canonical vocabulary. Preserve other strings so they remain an explicit
 * non-admin verdict rather than becoming an availability error. */
function normalizeWorkspaceRole(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "WORKSPACE_OWN" || normalized === "WORKSPACE_OWNER" || normalized === "OWNER") {
    return "OWNER";
  }
  if (normalized === "WORKSPACE_ADMIN" || normalized === "ADMINISTRATOR" || normalized === "ADMIN") {
    return "ADMIN";
  }
  return value;
}

const WEEKDAY_NUMBER: Record<string, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

function calendarFrom(value: unknown): Partial<CalendarContext> {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  const settings = row.settings && typeof row.settings === "object"
    ? row.settings as Record<string, unknown>
    : {};
  const timeZone = [row.timeZone, row.timezone, settings.timeZone, settings.timezone]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  const rawWeek = row.weekStartsOn ?? row.weekStart ?? row.startOfWeek
    ?? settings.weekStartsOn ?? settings.weekStart ?? settings.startOfWeek;
  const numeric = typeof rawWeek === "number"
    ? rawWeek
    : typeof rawWeek === "string"
      ? WEEKDAY_NUMBER[rawWeek.toUpperCase()]
      : undefined;
  return {
    ...(timeZone ? { timeZone } : {}),
    ...(typeof numeric === "number" && Number.isInteger(numeric) && numeric >= 1 && numeric <= 7
      ? { weekStartsOn: numeric }
      : {}),
  };
}

/**
 * Typed user & group REST module (goclmcp §2.13). I/O only. Shapes pinned by the
 * unit tests: invite is `POST /users?send-email={bool}`; role is
 * `POST /users/{id}/roles {entityId,role}` (the route has no PUT — spec +
 * goclmcp, which live-pinned the POST); deactivate is `PUT /users/{id}
 * {status:INACTIVE}`; groups live under `/user-groups` (single GET is a
 * list-scan), members under `…/{id}/users`.
 */
export function makeUserRest(core: RestCore, workspaceId: string): UserPort {
  const ws = `/workspaces/${workspaceId}`;
  // Live-probed 2026-07-19: a by-id GET on /users/{userId} is 405 (PUT-only),
  // while this workspace-membership query returns role-bearing rows and the
  // OpenAPI permits page-size=5000. One bounded page keeps every mutation role
  // gate exactly one physical call. A member absent from that page remains an
  // unknown verdict (fail closed); we never paginate inside a prepared step.
  const roleLookupQuery = new URLSearchParams({
    page: "1",
    "page-size": "5000",
    memberships: "WORKSPACE",
    "include-roles": "true",
  }).toString();

  async function rawUser(userId: string): Promise<{ row?: UserRow; truncated: boolean }> {
    const result = await core.paginate("api", `${ws}/users`);
    return { row: (result.rows as UserRow[]).find((user) => user.id === userId), truncated: result.truncated };
  }

  function roleAssignments(raw: UserRow): UserRoleAssignment[] {
    const rows = (Array.isArray(raw.roles) ? raw.roles : []).flatMap((entry) => {
      const role = entry.role ?? entry.name;
      const entityId = entry.entityId ?? entry.entity?.id;
      if (!role || !entityId) return [];
      return [{ role, entityId, ...(entry.sourceType !== undefined ? { sourceType: entry.sourceType } : {}) }];
    });
    if (typeof raw.role === "string" && raw.role.length > 0 && !rows.some((row) => row.entityId === workspaceId)) {
      rows.push({ role: raw.role, entityId: workspaceId });
    }
    return rows;
  }

  async function inviteUserAtomic(email: string, sendEmail: boolean): Promise<EntitySummary> {
    const qs = new URLSearchParams({ "send-email": String(sendEmail) });
    const row = (await core.mutate("api", "POST", `${ws}/users?${qs.toString()}`, { email })) as { id?: unknown; name?: unknown } | null;
    if (typeof row?.id !== "string" || row.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/users`, "Clockify accepted the invitation without a usable user id.");
    }
    return { id: row.id, name: typeof row.name === "string" ? row.name : email };
  }

  async function updateUserRoleAtomic(userId: string, role: string, entityId: string, sourceType?: string): Promise<EntitySummary> {
    await core.mutate("api", "POST", `${ws}/users/${userId}/roles`, {
      entityId,
      role,
      ...(sourceType ? { sourceType } : {}),
    });
    return { id: userId, name: role };
  }

  async function updateWorkspaceMemberRateAtomic(input: Parameters<UserPort["updateWorkspaceMemberRateAtomic"]>[0]): Promise<void> {
    const kind = input.rateKind === "COST" ? "cost-rate" : "hourly-rate";
    await core.mutate("api", "PUT", `${ws}/users/${input.userId}/${kind}`, {
      amount: input.amountMinor,
      ...(input.since ? { since: input.since } : {}),
    });
  }

  async function deactivateUserAtomic(userId: string): Promise<EntitySummary> {
    const row = (await core.mutate("api", "PUT", `${ws}/users/${userId}`, { status: "INACTIVE" })) as { id?: unknown } | null;
    if (row?.id !== undefined && typeof row.id !== "string") {
      throw new AmbiguousWriteOutcome("PUT", `${ws}/users/${userId}`, "Clockify returned a malformed user id.");
    }
    return { id: typeof row?.id === "string" && row.id.length > 0 ? row.id : userId, name: "INACTIVE" };
  }

  async function createGroupAtomic(name: string): Promise<EntitySummary> {
    const row = (await core.mutate("api", "POST", `${ws}/user-groups`, { name })) as { id?: unknown; name?: unknown } | null;
    if (typeof row?.id !== "string" || row.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/user-groups`, "Clockify accepted the group create without a usable id.");
    }
    return { id: row.id, name: typeof row.name === "string" ? row.name : name };
  }

  async function updateGroupAtomic(id: string, name: string): Promise<EntitySummary> {
    const row = (await core.mutate("api", "PUT", `${ws}/user-groups/${id}`, { name })) as { id?: unknown; name?: unknown } | null;
    if (row?.id !== undefined && typeof row.id !== "string") {
      throw new AmbiguousWriteOutcome("PUT", `${ws}/user-groups/${id}`, "Clockify returned a malformed group id.");
    }
    return { id: typeof row?.id === "string" && row.id.length > 0 ? row.id : id, name: typeof row?.name === "string" ? row.name : name };
  }

  async function deleteGroupAtomic(id: string): Promise<void> {
    await core.mutate("api", "DELETE", `${ws}/user-groups/${id}`);
  }

  async function addUserToGroupAtomic(groupId: string, userId: string): Promise<void> {
    await core.mutate("api", "POST", `${ws}/user-groups/${groupId}/users`, { userId });
  }

  async function removeUserFromGroupAtomic(groupId: string, userId: string): Promise<void> {
    await core.mutate("api", "DELETE", `${ws}/user-groups/${groupId}/users/${userId}`);
  }

  return {
    async listUsers() {
      // Paginate: the bare GET returns only the server default page-size (50), which
      // silently breaks member name resolution in any workspace with >50 members.
      const result = await core.paginate("api", `${ws}/users`);
      return { ...result, rows: (result.rows as UserRow[]).map(mapUser) };
    },
    async getWorkspaceMemberRole(userId): Promise<string | undefined> {
      // I/O only. Read the caller from the single bounded role-bearing page.
      // Clockify member shapes vary by API/version, so accept a top-level role or
      // an explicitly WORKSPACE-scoped role entry. Never pick a project/group
      // role merely because it happens to be first.
      const rows = await core.call("api", "GET", `${ws}/users?${roleLookupQuery}`);
      if (!Array.isArray(rows)) {
        throw new Error(`Clockify GET ${ws}/users returned an invalid role lookup response; expected a JSON array.`);
      }
      const raw = (rows as UserRow[]).find((u) => u?.id === userId);
      if (!raw) return undefined;
      const topLevelRole = normalizeWorkspaceRole(raw.role);
      if (topLevelRole) return topLevelRole;
      const roles = Array.isArray(raw.roles) ? raw.roles : [];
      const workspaceRole = roles.find(
        (r) => r?.entityId === workspaceId ||
          r?.entities?.some((entity) => entity?.id === workspaceId) === true ||
          String(r?.entity?.type ?? r?.sourceType ?? "").toUpperCase() === "WORKSPACE",
      );
      const onlyUnscopedRole = roles.length === 1 && !roles[0]?.entityId &&
        !roles[0]?.entity?.id && !roles[0]?.entity?.type && !roles[0]?.sourceType &&
        !(roles[0]?.entities?.length)
        ? roles[0]
        : undefined;
      const picked = workspaceRole ?? onlyUnscopedRole;
      const roleValue = picked?.role ?? picked?.name;
      const normalizedRole = normalizeWorkspaceRole(roleValue);
      if (normalizedRole) return normalizedRole;
      // `include-roles=true` returning an explicit empty/scoped-non-admin array
      // is a current negative verdict, not an outage. This lets the route gate
      // invalidate every assistant session immediately after Clockify demotion.
      return Array.isArray(raw.roles) ? "MEMBER" : undefined;
    },
    async listUserRoleAssignments(userId) {
      const found = await rawUser(userId);
      if (!found.row) return { rows: [], truncated: found.truncated };
      return { rows: roleAssignments(found.row), truncated: false };
    },
    async getWorkspaceMemberRate(userId, rateKind) {
      const found = await rawUser(userId);
      if (!found.row) {
        assertCompleteAbsence(found.truncated, "workspace-member", userId);
        return null;
      }
      const rate = rateKind === "COST" ? found.row.costRate : found.row.hourlyRate;
      return {
        userId,
        rateKind,
        amountMinor: typeof rate?.amount === "number" ? rate.amount : null,
        ...(typeof rate?.since === "string" ? { since: rate.since } : {}),
      };
    },
    async getCalendarContext(userId) {
      const [members, workspace] = await Promise.all([
        core.paginate("api", `${ws}/users`),
        core.call("api", "GET", ws, undefined, true),
      ]);
      const member = (members.rows as UserRow[]).find((user) => user.id === userId);
      if (!member) assertCompleteAbsence(members.truncated, "workspace-member", userId);
      const admin = calendarFrom(member);
      const fallback = calendarFrom(workspace);
      const timeZone = admin.timeZone ?? fallback.timeZone;
      const weekStartsOn = admin.weekStartsOn ?? fallback.weekStartsOn;
      if (!timeZone || weekStartsOn === undefined) return undefined;
      try {
        new Intl.DateTimeFormat("en", { timeZone }).format(0);
      } catch {
        return undefined;
      }
      return { timeZone, weekStartsOn };
    },
    inviteUserAtomic,
    updateUserRoleAtomic,
    updateWorkspaceMemberRateAtomic,
    deactivateUserAtomic,
    inviteUser: inviteUserAtomic,
    updateUserRole: updateUserRoleAtomic,
    updateWorkspaceMemberRate: updateWorkspaceMemberRateAtomic,
    deactivateUser: deactivateUserAtomic,
    async listGroups() {
      const result = await core.paginate("api", `${ws}/user-groups`);
      return { ...result, rows: (result.rows as GroupRow[]).map(mapGroup) };
    },
    async getGroup(id) {
      // Single-GET-by-id 404s for groups (CLAUDE.md) → scan the paginated list so a
      // group past page 1 is still found.
      const result = await core.paginate("api", `${ws}/user-groups`);
      const raw = (result.rows as GroupRow[]).find((g) => g.id === id);
      if (!raw) assertCompleteAbsence(result.truncated, "user-group", id);
      return raw ? mapGroup(raw) : null;
    },
    createGroupAtomic,
    updateGroupAtomic,
    deleteGroupAtomic,
    addUserToGroupAtomic,
    removeUserFromGroupAtomic,
    createGroup: createGroupAtomic,
    updateGroup: updateGroupAtomic,
    deleteGroup: deleteGroupAtomic,
    addUserToGroup: addUserToGroupAtomic,
    removeUserFromGroup: removeUserFromGroupAtomic,
  };
}
