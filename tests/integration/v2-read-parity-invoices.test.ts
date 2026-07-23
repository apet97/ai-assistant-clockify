import { registerReadParityDomainSuite } from "../helpers/v2-read-parity-domain-suite.js";

registerReadParityDomainSuite("invoices", [
  "clockify_invoices_list",
  "clockify_invoices_get",
  "clockify_invoices_payments_list",
  "clockify_invoices_export",
]);
