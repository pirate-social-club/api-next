// Parent completed observations, 2026-10-17: disposable SCRAM PostgreSQL17.11,
// notifications-trigger158-focused-pg/{result,*-terminal}.json
// under .archive/v1-functional-repair-successor-20261015/adopted-feature-dispatch-20261016/.
// Exact full158 SHA fccb962d8b8f2f71400898946ff5651fc9e86d559abd401a41ea2248d7ae89b3.
// native39.log SHA d904e82e09239f1cedfd6239e478f90c9cad4ed85822cd083689ab7d317023ab:
// 39 cases/1496 assertions; wall237.111330s rounds UP to237112ms,12 entry calls.
// hardening7.log SHA 9b499e245b917c138f57ecd5b225891a620708b9689a0ac25bff6830db2d3821:
// 7 cases/918 assertions; wall124.262532s rounds UP to124263ms,6 entry calls.
// Both exit0, exact fresh suite fences, cleanup0|0|0|0. Whole-file observations
// include the frozen transitive39/7-case fixture graphs. Imported fixture growth
// needs fresh whole-file measurement even if entry-call counts do not change.
// Source growth still scales upward; fewer calls never discount observed cost.
// Prior194323/229025ms native35 and108975ms hardening6 observations and failed
// hardening runs remain historical. These expanded-graph observations are larger.
// Planning only: no future full/CI/six-shard/serving/consumer acceptance.
export const postgresNotificationsSuiteCostEstimates = {
  "packages/platform-cf/src/notifications-repository.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 237_112,
  },
  "tests/postgres/notifications-hardening.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 124_263,
  },
} as const;
