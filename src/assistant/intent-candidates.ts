import { selectActionsForMessage } from "../harness/tool-select.js";

/** Build the declaration's recall hint from the same bounded selection context
 * used by the planner, intersected with the trusted write-action allowlist. */
export function buildCandidateWriteActionNames(
  selectionContext: string,
  trustedWriteActionNames: readonly string[],
): string[] {
  const trustedWrites = new Set(trustedWriteActionNames);
  return selectActionsForMessage(selectionContext)
    .filter((actionName) => trustedWrites.has(actionName));
}
