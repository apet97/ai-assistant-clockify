import { registerReadParityDomainSuite } from "../helpers/v2-read-parity-domain-suite.js";

registerReadParityDomainSuite("time", [
  "clockify_entries_list",
  "clockify_entries_get",
]);
