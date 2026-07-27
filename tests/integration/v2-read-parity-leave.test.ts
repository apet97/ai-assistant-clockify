import { registerReadParityDomainSuite } from "../helpers/v2-read-parity-domain-suite.js";

registerReadParityDomainSuite("leave", [
  "clockify_time_off_policies_list",
  "clockify_time_off_requests_list",
  "clockify_holidays_list",
  "clockify_scheduling_assignments_list",
  "clockify_scheduling_user_totals",
  "clockify_approvals_list",
]);
