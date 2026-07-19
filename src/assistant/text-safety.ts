/**
 * Detect provider prose that asks the admin to authorize an action through chat.
 * Text is never an approval channel: risky changes use only the stored preview's
 * bound UI button, while safe writes need no approval at all.
 */
export function requestsTextApproval(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const targetClarification = /\b(?:confirm|clarify|specify)\s+(?:which|what|who|where|when|whether)\b/iu.test(normalized);
  const informationalConfirmation = /\b(?:would|could|can)\s+you\s+confirm\s+(?:the\s+(?!(?:change|action|request|approval|operation)\b)|(?:a|an|your)\s+)/iu.test(normalized);
  if (targetClarification || informationalConfirmation) return false;
  return [
    /^\s*proceed\s*[?!.]*\s*$/iu,
    /\b(?:type|enter|reply|respond|say|send|write)\b.{0,48}\b(?:yes|confirm|approve|approved|proceed|do it)\b/iu,
    /\b(?:please\s+)?(?:confirm|approve)\s*(?:[.!?]|$|this\b|that\b|it\b|the\s+(?:change|action|request)\b|to\s+(?:continue|proceed|apply|execute)\b|by\b)/iu,
    /\b(?:would|could|can|will|should)\s+you\b.{0,64}\b(?:confirm|approve|proceed|go[- ]?ahead|permission)\b/iu,
    /\bshall\s+i\b.{0,48}\b(?:confirm|approve|proceed|apply|execute|go[- ]?ahead)\b/iu,
    /\bshould\s+i\b.{0,48}\b(?:confirm|approve|proceed|apply|execute|go[- ]?ahead|create|delete|update)\b/iu,
    /\bdo\s+i\s+have\s+your\b.{0,32}\b(?:permission|approval|go[- ]?ahead)\b/iu,
    /\b(?:i|we|the\s+system|this|it|the\s+(?:change|action|request|approval))\b.{0,24}\b(?:need|needs|require|requires|await|awaits)\b.{0,32}\b(?:confirmation|approval|permission|go[- ]?ahead)\b/iu,
    /\b(?:would\s+you\s+like\s+me\s+to|shall\s+i|can\s+i|may\s+i)\b.{0,64}\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|go[- ]?ahead)\b/iu,
    /\bdo\s+you\s+want\s+me\s+to\b.{0,64}\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|go[- ]?ahead)\b/iu,
    /\blet\s+me\s+know\s+if\s+you\s+want\s+me\s+to\b.{0,64}\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|go[- ]?ahead)\b/iu,
    /\bif\s+you\s+(?:confirm|approve)\b.{0,48}\b(?:i|we)\s+(?:can|will|could|would)\b.{0,48}\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed)\b/iu,
    /\b(?:is\s+it|would\s+it\s+be)\s+(?:ok|okay)\b.{0,48}\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|run)\b/iu,
    /\b(?:ok|okay)\s+to\s+(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|run|continue)\b/iu,
    /\b(?:authorization|permission|approval)\b.{0,32}\b(?:required|needed|necessary)\b.{0,48}\b(?:run|continue|proceed|execute|apply|create|delete|update|approve)\b/iu,
    /\b(?:green\s+light|authorization|permission|go[- ]?ahead)\b.{0,48}\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|run|continue)\b/iu,
    /\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|run|continue)\b.{0,64}\b(?:green\s+light|authorization|permission|go[- ]?ahead)\b/iu,
    /\bauthorize\b.{0,48}\b(?:action|change|request|continue|proceed|run|execute|apply|create|delete|update|approve)\b/iu,
    /\bplease\s+give\s+me\s+the\s+(?:go[- ]?ahead|green\s+light|authorization|permission)\b/iu,
    /\bonce\s+you\s+(?:approve|confirm|authorize)\b.{0,48}\b(?:i|we)\s+(?:will|can|could|would)\b.{0,48}\b(?:approve|apply|execute|create|delete|update|change|submit|send|publish|proceed|run)\b/iu,
    /\bawaiting\s+(?:your\s+)?(?:confirmation|approval|authorization|permission|go[- ]?ahead)\b/iu,
  ].some((pattern) => pattern.test(normalized));
}

/** Deterministic structural signal used only to suppress untrusted provider
 * prose when a valid-but-empty declaration contradicts an explicit write
 * command. It grants no authority. Keep the grammar command-shaped so genuine
 * read questions (for example, "What did I track today?") remain untouched. */
export function hasExplicitWriteRequest(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const writeVerb =
    "(?:create|add|make|start|begin|stop|end|clock|delete|remove|archive|unarchive|rename|update|edit|change|approve|reject|submit|resubmit|invite|deactivate|assign|schedule|publish|record|log|set|mark|import|pay)";
  const writeGerund =
    "(?:creating|adding|making|starting|beginning|stopping|ending|clocking|deleting|removing|archiving|unarchiving|renaming|updating|editing|changing|approving|rejecting|submitting|resubmitting|inviting|deactivating|assigning|scheduling|publishing|recording|logging|setting|marking|importing|paying)";
  const polite = "(?:please(?:[\\s,;:]+))?";
  return [
    new RegExp(`^${polite}${writeVerb}\\b`, "iu"),
    new RegExp(`\\b(?:and|then)[\\s,;:]+${polite}${writeVerb}\\b`, "iu"),
    new RegExp(`\\b(?:can|could|would|will)\\s+you\\s+${polite}${writeVerb}\\b`, "iu"),
    new RegExp(`\\b(?:i\\s+)?(?:want|need|would\\s+like)\\s+(?:you\\s+)?to\\s+${writeVerb}\\b`, "iu"),
    new RegExp(`\\bi(?:['’]d|\\s+would)\\s+like\\s+(?:you\\s+)?to\\s+${writeVerb}\\b`, "iu"),
    new RegExp(`\\bwould\\s+you\\s+mind\\s+${polite}${writeGerund}\\b`, "iu"),
  ].some((pattern) => pattern.test(normalized));
}

/** Defense-in-depth truthfulness classifier. The product catalog, not provider
 * prose, is authoritative about whether a supported action surface exists. This
 * grants no write authority and deliberately keys on tool-surface language, so
 * ordinary factual read answers such as "there are no matching projects" pass. */
export function claimsUnsupportedToolAbsence(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const surface = "(?:tool|action|abilit(?:y|ies)|capabilit(?:y|ies)|operation(?:\\s+surface)?|function(?:ality)?|feature|endpoint|interface)";
  const absent = "(?:absent|unavailable|unsupported|unable|impossible|missing|omitted|not\\s+(?:available|supported|exposed|provided|included))";
  return [
    new RegExp(`\\b(?:no|without)\\b.{0,48}\\b${surface}\\b`, "iu"),
    new RegExp(`\\b(?:do\\s+not|don't|cannot|can't)\\s+(?:have|access|use|find|see)\\b.{0,64}\\b${surface}\\b`, "iu"),
    new RegExp(`\\b${surface}\\b.{0,64}\\b${absent}\\b`, "iu"),
    new RegExp(`\\b${absent}\\b.{0,64}\\b${surface}\\b`, "iu"),
    /\b(?:creation|deletion|update|assignment|scheduling|approval|export|timer)\b.{0,48}\b(?:unavailable|unsupported|not\s+supported)\b/iu,
    /\boutside\b.{0,32}\b(?:my|the)\s+capabilit(?:y|ies)\b/iu,
    /\bnot\s+supported\s+by\b.{0,40}\b(?:actions?|tools?|capabilit(?:y|ies))\b/iu,
    /\bi\s+(?:am|'m)\s+unable\s+to\b.{0,64}\b(?:create|update|delete|start|stop|log|schedule|assign)\b/iu,
  ].some((pattern) => pattern.test(normalized));
}

export const NO_TEXT_APPROVAL_REPLY =
  "No change has been prepared. State the change you want in one fresh message.";

export const NO_VERIFIED_TOOL_RESULT_REPLY =
  "I could not produce a verified Clockify result for that request. Please restate it in one fresh message.";
