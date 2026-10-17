// Parent completed observations, 2026-10-17: disposable SCRAM PostgreSQL17.11,
// notifications-source98-scram-native-role6-and35/{results,consumption}.json
// under .archive/v1-functional-repair-successor-20261015/adopted-feature-dispatch-20261016/.
// Exact full98 SHA6271bb2a8629bb35d9146f3602edb222196d921f505250ceab200a2de70adb53.
// notifications35.log SHAa3d831cd68b33acfd4676ec6955a5346be9c0b0206cacbba629d4869331b4c24:
// 35 cases/1348 assertions; wall229.024078s rounds UP to229025ms,12 entry calls.
// hardening6.log SHAa34e2283c8ee975fad2eb37b5dc8fdd1353480c9dc65e847d49b432e719c7eb9:
// 6 cases/418 assertions; wall108.974427s rounds UP to108975ms,6 entry calls.
// Both exit0, exact fresh suite fences, cleanup0|0|0. Whole-file observations
// include the frozen transitive35/6-case fixture graphs. Imported fixture growth
// needs fresh whole-file measurement even if entry-call counts do not change.
// Source growth still scales upward; fewer calls never discount observed cost.
// Prior194323ms native35 observation and failed5/1 hardening remain historical;
// neither is relabelled. Use the latest larger completed native35 observation.
// Planning only: no future full/CI/six-shard/serving/consumer acceptance.
export const postgresNotificationsSuiteCostEstimates = {
  "packages/platform-cf/src/notifications-repository.pg.test.ts": {
    sourceCallCount: 12,
    milliseconds: 229_025,
  },
  "tests/postgres/notifications-hardening.pg.test.ts": {
    sourceCallCount: 6,
    milliseconds: 108_975,
  },
} as const;
