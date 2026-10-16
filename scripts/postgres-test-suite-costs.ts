import { postgresEntrypointSuiteCostEstimates } from "./postgres-test-suite-costs-entrypoints.ts";
import { postgresHnsSuiteCostEstimates } from "./postgres-test-suite-costs-hns.ts";
import { postgresLearningSuiteCostEstimates } from "./postgres-test-suite-costs-learning.ts";
import { postgresPlatformSuiteCostEstimates } from "./postgres-test-suite-costs-platform.ts";

// Closed required-CI group costs from run38370048198 (2ebccd53), plus five
// historical estimates whose test-file bytes match (not transitive fixtures) from run38353040821. Source
// and safe timing receipts are retained in the reviewed coordinator packet.
// Planning estimates only: no test acceptance, skip, deadline or runtime authority.
// Activity preparation is an explicitly incomplete-tail98s estimate (two passes
// plus the remaining90s callback); nationality is unobserved4*30s=120s.
// The two environment-specific skipped profiles keep the ordinary count model.
export const postgresGeneralSuiteCostEstimates: Readonly<
  Record<string, Readonly<{ sourceCallCount: number; milliseconds: number }>>
> = {
  ...postgresHnsSuiteCostEstimates,
  ...postgresLearningSuiteCostEstimates,
  ...postgresPlatformSuiteCostEstimates,
  ...postgresEntrypointSuiteCostEstimates,
};
