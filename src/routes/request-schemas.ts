import { z } from "zod";
import {
  FEATURE_GROUPS,
  permissionLevelSchema,
  type FeatureGroup,
} from "../harness/permissions.js";

/**
 * Request-body Zod schemas for the chat/confirm/permissions routes (extracted
 * from api.ts — plan 005 Phase 1). Pure schema definitions: they close over no
 * router or `deps` state, only `zod` and the permission feature-group vocabulary.
 */
export const groupsPatchSchema = z
  .record(z.enum(FEATURE_GROUPS as [FeatureGroup, ...FeatureGroup[]]), permissionLevelSchema)
  .optional();

// Cap the inputs at parse, before anything is persisted. The body parser caps
// the whole payload (server.ts); these cap the fields. A whitespace-only message
// is intentionally NOT rejected here — it stays length>=1 and flows to the
// deterministic friendly "what would you like me to do?" handler in
// executeChatTurn (live finding new-6, tested in chat-empty-message.test.ts) —
// never to the planner.
export const chatBodySchema = z
  .object({
    message: z.string().min(1).max(4000),
    requestId: z.string().uuid().optional(),
  })
  .strict();
export const confirmBodySchema = z.object({ nonce: z.string().min(1).max(256) }).strict();

// Strict `{optionId}` body for POST /api/clarifications/:id/resolve (T14-D):
// the label is never submitted, only the exact candidate id.
export const resolveClarificationBodySchema = z.object({
  optionId: z.string().min(1).max(256),
}).strict();

export const confirmBatchBodySchema = z.object({
  items: z.array(z.object({
    confirmationId: z.string().uuid(),
    nonce: z.string().min(1).max(256).optional(),
  }).strict()).min(1).max(12),
}).strict();
