import { registerReadParityDomainSuite } from "../helpers/v2-read-parity-domain-suite.js";

registerReadParityDomainSuite("users", [
  "clockify_users_list",
  "clockify_groups_list",
]);
