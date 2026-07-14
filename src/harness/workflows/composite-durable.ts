import type { ActionContext, ExternalMutationPlan, TargetSnapshot } from "../action.js";
import type { EntityRef } from "../receipts.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { sanitizedFingerprint } from "../safe-json.js";

export function dynamicMutationPlan(
  steps: Array<{
    id: string;
    kind?: "primary" | "compensation";
    strategy: "create" | "update" | "delete" | "state-command" | "composed";
    targetFingerprint?: string;
  }>,
): ExternalMutationPlan {
  return {
    mode: steps.length === 1 ? "single" : "curated",
    steps: steps.map((step) => ({
      id: step.id,
      kind: step.kind ?? "primary",
      reconciliationStrategy: step.strategy,
      ...(step.targetFingerprint ? { targetFingerprint: step.targetFingerprint } : {}),
    })),
  };
}

export function userProjection(row: { id: string; name: string; email?: string; status?: string }) {
  return { id: row.id, name: row.name, email: row.email, status: row.status };
}

export function groupProjection(row: { id: string; name: string; userIds?: string[] }) {
  return { id: row.id, name: row.name, userIds: [...(row.userIds ?? [])].sort() };
}

export async function captureUserSnapshot(
  ctx: ActionContext,
  relation: "target" | "parent",
  userId: string,
): Promise<TargetSnapshot | undefined> {
  const listed = await ctx.clockify.listUsers();
  if (listed.truncated) return undefined;
  const row = listed.rows.find((candidate) => candidate.id === userId);
  return row
    ? captureTargetSnapshot(relation, { type: "user", id: row.id, name: row.name }, userProjection(row))
    : undefined;
}

export async function captureGroupSnapshot(
  ctx: ActionContext,
  relation: "target" | "parent",
  groupId: string,
): Promise<TargetSnapshot | undefined> {
  const listed = await ctx.clockify.listGroups();
  if (listed.truncated) return undefined;
  const row = listed.rows.find((candidate) => candidate.id === groupId);
  return row
    ? captureTargetSnapshot(relation, { type: "group", id: row.id, name: row.name }, groupProjection(row))
    : undefined;
}

export async function fetchCompositeSnapshot(
  ctx: ActionContext,
  stored: TargetSnapshot,
): Promise<{ ref: EntityRef; projection?: unknown; truncated?: boolean } | undefined> {
  const { type, id } = stored.ref;
  if (type === "project") {
    const projection = await ctx.clockify.getProjectMutationState(id);
    return projection ? { ref: stored.ref, projection } : undefined;
  }
  if (type === "client") {
    const projection = await ctx.clockify.getClientMutationState(id);
    return projection ? { ref: stored.ref, projection } : undefined;
  }
  if (type === "tag") {
    try {
      return { ref: stored.ref, projection: await ctx.clockify.prepareTagUpdate(id, {}) };
    } catch {
      return undefined;
    }
  }
  if (type === "task") {
    const projectId = stored.ref.projectId;
    if (typeof projectId !== "string") return undefined;
    try {
      return { ref: stored.ref, projection: await ctx.clockify.prepareTaskUpdate(projectId, id, {}) };
    } catch {
      return undefined;
    }
  }
  if (type === "time_entry") {
    try {
      return { ref: stored.ref, projection: await ctx.clockify.prepareTimeEntryUpdate({ id }) };
    } catch {
      return undefined;
    }
  }
  if (type === "invoice") {
    const row = await ctx.clockify.getInvoice(id);
    return row ? { ref: stored.ref, projection: row } : undefined;
  }
  if (type === "expense") {
    const row = await ctx.clockify.getExpense(id);
    return row ? { ref: stored.ref, projection: row } : undefined;
  }
  if (type === "webhook") {
    const row = await ctx.clockify.getWebhook(id);
    return row ? { ref: stored.ref, projection: row } : undefined;
  }
  if (type === "group") {
    const listed = await ctx.clockify.listGroups();
    const row = listed.rows.find((candidate) => candidate.id === id);
    return row ? { ref: stored.ref, projection: groupProjection(row), truncated: listed.truncated } : undefined;
  }
  if (type === "user") {
    const listed = await ctx.clockify.listUsers();
    const row = listed.rows.find((candidate) => candidate.id === id);
    return row ? { ref: stored.ref, projection: userProjection(row), truncated: listed.truncated } : undefined;
  }
  return undefined;
}

export function exactIdsFingerprint(ids: readonly string[]): string {
  return sanitizedFingerprint([...ids].sort());
}
