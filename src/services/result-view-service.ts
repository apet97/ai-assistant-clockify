import { Buffer } from "node:buffer";
import type { JsonValue } from "../assistant-v2/events.js";
import type { PresentedResult, PresentedResultEnvelope } from "../assistant-v2/presentation/presented-result.js";
import {
  DIAGNOSTIC_VALUE_MAX_BYTES,
  PRESENTED_RESULT_MAX_FACTS,
  PRESENTED_RESULT_MAX_WARNINGS,
} from "../assistant-v2/presentation/presented-result.js";
import { presentReadResult } from "./result-presentation-service.js";
import { defaultTitle } from "../harness/prepared-write-presentation.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import type { PendingConfirmationRecord } from "../harness/confirmations.js";

/**
 * The one action-result → `PresentedResultEnvelope` boundary (closure-plan
 * PR 3 / F05). Status, title, facts, and warnings derive ONLY from the
 * canonical stored result and reviewed catalog metadata — never model prose
 * (the receipt's own bounded message contributes only the sanitized summary).
 * An unknown or malformed stored shape presents as a deterministic FAILURE
 * with a diagnostic warning; it can never present as success.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function humanTitle(registry: ActionRegistry, actionName: string): string {
  const definition = registry.get(actionName);
  return definition ? defaultTitle(definition) : actionName;
}

function boundedWarnings(raw: unknown): PresentedResult["warnings"] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, PRESENTED_RESULT_MAX_WARNINGS).map((entry, index) => {
    const item = asRecord(entry) ?? {};
    return {
      code: typeof item.code === "string" ? item.code.slice(0, 256) : `warning_${index}`,
      message: typeof item.message === "string" ? item.message.slice(0, 256) : String(entry).slice(0, 256),
    };
  });
}

/**
 * The shared read-fact extractor the closure plan allows in place of 43
 * bespoke extractors: list size + completeness from `ListResult`-shaped data,
 * and created/updated/deleted entity counts from a receipt's `changed` block.
 * Facts are server-derived; provider prose can never add or alter one.
 */
export function factsFromReceipt(receipt: JsonRecord): PresentedResult["facts"] {
  const facts: PresentedResult["facts"] = [];
  const data = asRecord(receipt.data);
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      facts.push({ label: `${key} returned`, value: String(value.length) });
      if (facts.length >= 4) break;
    }
    if (data.truncated === true) {
      facts.push({ label: "Complete", value: "no — the list was truncated" });
    }
  }
  const changed = asRecord(receipt.changed);
  if (changed) {
    for (const verb of ["created", "updated", "deleted"] as const) {
      const entries = changed[verb];
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const names = entries
        .map((entry) => {
          const item = asRecord(entry) ?? {};
          const name = typeof item.name === "string" ? item.name : undefined;
          const type = typeof item.type === "string" ? item.type : "entity";
          return name ? `${type} “${name}”` : type;
        })
        .slice(0, 5)
        .join(", ");
      facts.push({ label: verb.charAt(0).toUpperCase() + verb.slice(1), value: names });
    }
  }
  return facts.slice(0, PRESENTED_RESULT_MAX_FACTS);
}

function presentationFromStored(
  registry: ActionRegistry,
  actionName: string,
  stored: unknown,
): PresentedResult {
  const title = humanTitle(registry, actionName);
  const row = asRecord(stored);
  const receipt = row ? asRecord(row.receipt) : undefined;
  if (row?.kind === "receipt" && receipt) {
    if (receipt.ok === true) {
      return presentReadResult({
        title,
        providerSummary: typeof receipt.message === "string" ? receipt.message : undefined,
        facts: factsFromReceipt(receipt),
        warnings: boundedWarnings(receipt.warnings),
      });
    }
    return {
      status: "failed",
      title,
      summary: typeof receipt.message === "string" ? receipt.message.slice(0, 4_096) : "",
      facts: [],
      warnings: [
        {
          code: typeof receipt.code === "string" ? receipt.code.slice(0, 256) : "action_failed",
          message: "The action did not complete.",
        },
        ...boundedWarnings(receipt.warnings),
      ].slice(0, PRESENTED_RESULT_MAX_WARNINGS),
      references: [],
    };
  }
  if (row?.kind === "clarify") {
    // A clarify payload means the action did NOT execute — it resolved to a
    // question. Live clarifications render through the dedicated
    // pending_clarification attachment; a stored clarify reaching a result
    // card must degrade truthfully.
    return {
      status: "failed",
      title,
      summary: typeof row.message === "string" ? row.message.slice(0, 4_096) : "",
      facts: [],
      warnings: [{ code: "clarification_required", message: "The action needs clarification and was not performed." }],
      references: [],
    };
  }
  // FAIL CLOSED (F05): an unrecognized stored shape must never present as
  // success — the old fallback reported "succeeded" for anything.
  return {
    status: "failed",
    title,
    summary: "",
    facts: [],
    warnings: [{ code: "unrecognized_result_shape", message: "The stored result could not be interpreted." }],
    references: [],
  };
}

function boundedDiagnostic(stored: unknown): PresentedResultEnvelope["diagnostic"] {
  const encoded = JSON.stringify(stored ?? null);
  const byteLength = Buffer.byteLength(encoded, "utf8");
  // An oversized receipt is OMITTED rather than truncated: a diagnostic is a
  // verbatim sanitized copy or nothing (truncating JSON silently would show a
  // corrupt receipt as if it were the canonical one).
  if (byteLength > DIAGNOSTIC_VALUE_MAX_BYTES) return undefined;
  return {
    kind: "sanitized_receipt",
    byteLength,
    value: (stored ?? null) as JsonValue,
  };
}

export interface ResultViewDeps {
  registry: ActionRegistry;
}

export function createResultViewService(deps: ResultViewDeps) {
  return {
    /** Envelope for a CANONICAL stored action result (terminal card). */
    presentActionResult(actionName: string, actionResultId: string, stored: unknown): PresentedResultEnvelope {
      const diagnostic = boundedDiagnostic(stored);
      return {
        presentation: presentationFromStored(deps.registry, actionName, stored),
        actionResultId,
        ...(diagnostic ? { diagnostic } : {}),
      };
    },
    /** Presentation (no live control) for a stored pending-confirmation
     * preview. The caller owns nonce rotation and attaches the confirmation
     * block itself — this derives only the descriptive content. */
    presentPendingConfirmation(record: PendingConfirmationRecord): PresentedResult {
      const preview = asRecord(record.preview) ?? {};
      const facts: PresentedResult["facts"] = [];
      if (Array.isArray(preview.targets)) {
        for (const target of preview.targets.slice(0, 5)) {
          const item = asRecord(target) ?? {};
          const name = typeof item.name === "string" && item.name.length > 0
            ? item.name
            : typeof item.id === "string" ? item.id : "";
          const type = typeof item.type === "string" ? item.type : "target";
          if (name) facts.push({ label: `Target ${type}`, value: name });
        }
      }
      if (Array.isArray(preview.riskLabels) && preview.riskLabels.length > 0) {
        facts.push({ label: "Risk", value: preview.riskLabels.slice(0, 4).map(String).join(", ").slice(0, 2_048) });
      }
      return {
        status: "pending_confirmation",
        title: typeof preview.actionLabel === "string" && preview.actionLabel.length > 0
          ? preview.actionLabel
          : "Pending change",
        summary: Array.isArray(preview.expectedChanges)
          ? preview.expectedChanges.slice(0, 12).map(String).join("; ").slice(0, 4_096)
          : "",
        facts: facts.slice(0, PRESENTED_RESULT_MAX_FACTS),
        warnings: Array.isArray(preview.warnings)
          ? preview.warnings.slice(0, PRESENTED_RESULT_MAX_WARNINGS).map((w, index) => ({
              code: `preview_${index}`,
              message: String(w).slice(0, 256),
            }))
          : [],
        references: [],
      };
    },
  };
}

export type ResultViewService = ReturnType<typeof createResultViewService>;
