import { registerReadParityDomainSuite } from "../helpers/v2-read-parity-domain-suite.js";

registerReadParityDomainSuite("structure", [
  "clockify_projects_list",
  "clockify_clients_list",
  "clockify_tags_list",
  "clockify_templates_list",
  "clockify_tasks_list",
  "clockify_projects_get",
]);
