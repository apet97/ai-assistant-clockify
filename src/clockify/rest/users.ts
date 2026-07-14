import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { UserPort, UserSummary, GroupSummary, CalendarContext } from "../ports/users.js";

/** A workspace role entry as read by {@link makeUserRest} `getWorkspaceMemberRole`. */
type RoleEntry = {
  role?: string;
  name?: string;
  entity?: { type?: string };
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

  return {
    async listUsers() {
      // Paginate: the bare GET returns only the server default page-size (50), which
      // silently breaks member name resolution in any workspace with >50 members.
      const rows = (await core.paginate("api", `${ws}/users`)) as UserRow[];
      return rows.map(mapUser);
    },
    async getWorkspaceMemberRole(userId): Promise<string | undefined> {
      // I/O only. Single-member read for the opt-in per-request admin re-check
      // (authz-surface-01). The /users list is the working member source (same
      // paginate as listUsers); we find the caller and read the workspace-scoped
      // role from the raw member object. Clockify member shapes vary by
      // API/version, so read the common spots defensively: a top-level `role`, or
      // a `roles: [{ role, entity?:{type} }]` array (prefer a WORKSPACE-scoped
      // entry), falling back to the first role. Returns undefined when the member
      // or a role string can't be resolved (the rechecker treats undefined as
      // "no verdict" / fail-open). LIVE-VERIFY against a prod member doc before
      // relying on ROLE_RECHECK=1 in production (T62).
      const rows = (await core.paginate("api", `${ws}/users`)) as UserRow[];
      const raw = rows.find((u) => u?.id === userId);
      if (!raw) return undefined;
      if (typeof raw.role === "string" && raw.role.length > 0) return raw.role;
      const roles = Array.isArray(raw.roles) ? raw.roles : [];
      const workspaceRole = roles.find(
        (r) => String(r?.entity?.type ?? r?.sourceType ?? "").toUpperCase() === "WORKSPACE",
      );
      const picked = workspaceRole ?? roles[0];
      const roleValue = picked?.role ?? picked?.name;
      return typeof roleValue === "string" && roleValue.length > 0 ? roleValue : undefined;
    },
    async getCalendarContext(userId) {
      const [rows, workspace] = await Promise.all([
        core.paginate("api", `${ws}/users`) as Promise<UserRow[]>,
        core.call("api", "GET", ws, undefined, true),
      ]);
      const admin = calendarFrom(rows.find((user) => user.id === userId));
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
    async inviteUser(email, sendEmail): Promise<EntitySummary> {
      const qs = new URLSearchParams({ "send-email": String(sendEmail) });
      const u = (await core.call("api", "POST", `${ws}/users?${qs.toString()}`, { email })) as { id?: string; name?: string };
      return { id: u?.id ?? email, name: u?.name ?? email };
    },
    async updateUserRole(userId, role, entityId, sourceType): Promise<EntitySummary> {
      // POST /users/{recipient}/roles {entityId, role, sourceType?}. entityId is the
      // SCOPE: workspaceId (ADMIN), projectId (PROJECT_MANAGER), or a group id with
      // sourceType=USER_GROUP (TEAM_MANAGER of a group). Live-verified 2026-06-12.
      await core.call("api", "POST", `${ws}/users/${userId}/roles`, {
        entityId,
        role,
        ...(sourceType ? { sourceType } : {}),
      });
      return { id: userId, name: role };
    },
    async updateWorkspaceMemberRate(input) {
      // PUT /workspaces/{ws}/users/{userId}/{hourly-rate|cost-rate} {amount, since?}.
      // This is the Team-section default rate for the member (distinct from the
      // per-project member rate). Live-verified 2026-06-12 (200, returns the
      // workspace doc). `amount` is integer minor units.
      const kind = input.rateKind === "COST" ? "cost-rate" : "hourly-rate";
      await core.call("api", "PUT", `${ws}/users/${input.userId}/${kind}`, {
        amount: input.amountMinor,
        ...(input.since ? { since: input.since } : {}),
      });
    },
    async deactivateUser(userId): Promise<EntitySummary> {
      const u = (await core.call("api", "PUT", `${ws}/users/${userId}`, { status: "INACTIVE" })) as { id?: string } | null;
      return { id: u?.id ?? userId, name: "INACTIVE" };
    },
    async listGroups() {
      const rows = (await core.paginate("api", `${ws}/user-groups`)) as GroupRow[];
      return rows.map(mapGroup);
    },
    async getGroup(id) {
      // Single-GET-by-id 404s for groups (CLAUDE.md) → scan the paginated list so a
      // group past page 1 is still found.
      const rows = (await core.paginate("api", `${ws}/user-groups`)) as GroupRow[];
      const raw = rows.find((g) => g.id === id);
      return raw ? mapGroup(raw) : null;
    },
    async createGroup(name): Promise<EntitySummary> {
      const g = (await core.call("api", "POST", `${ws}/user-groups`, { name })) as { id: string; name?: string };
      return { id: g.id, name: g.name ?? name };
    },
    async updateGroup(id, name): Promise<EntitySummary> {
      const g = (await core.call("api", "PUT", `${ws}/user-groups/${id}`, { name })) as { id?: string; name?: string };
      return { id: g?.id ?? id, name: g?.name ?? name };
    },
    async deleteGroup(id) {
      await core.call("api", "DELETE", `${ws}/user-groups/${id}`);
    },
    async addUserToGroup(groupId, userId) {
      await core.call("api", "POST", `${ws}/user-groups/${groupId}/users`, { userId });
    },
    async removeUserFromGroup(groupId, userId) {
      await core.call("api", "DELETE", `${ws}/user-groups/${groupId}/users/${userId}`);
    },
  };
}
