import { registerReadParityDomainSuite } from "../helpers/v2-read-parity-domain-suite.js";

registerReadParityDomainSuite("expenses", [
  "clockify_expenses_list",
  "clockify_expenses_get",
  "clockify_expenses_categories_list",
  "clockify_custom_fields_list",
]);
