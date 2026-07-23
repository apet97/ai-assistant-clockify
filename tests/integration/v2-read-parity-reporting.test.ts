import { registerReadParityDomainSuite } from "../helpers/v2-read-parity-domain-suite.js";

registerReadParityDomainSuite("reporting", [
  "clockify_reports_summary",
  "clockify_reports_detailed",
  "clockify_entity_changes_created",
  "clockify_workspace_get",
  "clockify_templates_list",
  "clockify_webhooks_list",
]);
