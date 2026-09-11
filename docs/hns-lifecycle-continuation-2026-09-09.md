# HNS lifecycle continuation receipt

The workspace_coordinator resumed the clean backend lane from 7c318985 on
2026-09-09. The service loop still calls the older authority executor; the
new lifecycle runner has no service-loop caller. Live adapter and runtime
wiring remain the next implementation checkpoint. Retirement stays guarded.

## Lease acceptance and atomic completion

Commit fece9ce49ac647e9f8ec53d462a73717ba319799 repairs a prerequisite for that
wiring. Previously a stale worker could commit lifecycle evidence and successor
jobs before the separate finalizer rejected its lease. Regression tests against
PostgreSQL reproduced this for both an expired lease and a reclaimed lease:
the runner reported current_inclusion_confirmed instead of lease_conflict.

The runner now locks and validates the exact job, session, kind, executor,
lease fence and lease expiry before accepting evidence. Lifecycle transitions,
history, successor jobs and successful job finalization share one transaction.
An injected finalization failure rolls all those writes back together.

The expanded real PostgreSQL execution suite passes 12 tests with 41
assertions. The first full run under concurrent gate load hit the default
five-second timeout in an existing current-observation sequence (11 pass,
1 timeout). The rerun used:

`CONTROL_PLANE_POSTGRES_TEST_URL=<local-test-url> bun test --timeout 30000 packages/platform-cf/src/hns-root-import-lifecycle-execution.pg.test.ts`

It passed all 12. The disposable postgres:17 container used host networking
on port 5464 and only generated test schemas. No production database was used.

## Live HSD reorg and republication

Commit b21823596bcf9e29b7d89f6dfa7a41fc1fe24c8e extends the controlled harness
with production-observer assertions, loopback/genesis guards and explicit
--execute admission. The exact executed command was:

`HSD_REGTEST_NAME=t03resumec bun scripts/hsd-regtest-progression.ts --execute`

It passed against the retained hsd 8.0.0 regtest node. Inclusion at 598 gave
current presence and safe absence; safe remained absent at 603 and converged
at 608. Invalidating the inclusion block removed the current resource.
Rebroadcasting the exact retained transaction bytes restored current evidence
and later safe convergence. The script asserts each observation and transaction
identity; the adjacent harness README records the transaction and digest.

Two preceding attempts reached the reorg assertion but failed the assumption
that the wallet resend RPC would list the orphaned UPDATE. Raw rebroadcast of
the retained approved transaction avoids a second spend of pending credit.
Those attempts used t03resumea and t03resumeb on the disposable chain.

This closes observer reorg/republication coverage, not end-to-end lifecycle
execution through the service loop or wall-clock slow-block deadline coverage.
The older RPC defects remain attributable to new branch code, not deployment.

## Gates and remaining work

`bun run check` returned zero after the final code changes. It reported existing
Biome warnings. `bun run test` returned zero: 3,760 unit tests, 20 Node tests,
and Workerd suite counts of 80, 73, 2, 10 and 15. Workerd emitted missing-secret
warnings and expected error-path diagnostics while all suites passed.
The workspace script checker in changed mode returned zero findings; focused
Biome and git diff hygiene checks passed.

Continue by building the real lifecycle observer adapter and database ports,
persisting actual evidence, and calling the runner from the service loop with
fair scheduling. Distinguish the observer's canonical-JSON resource digest from
the plan's encoded-resource digest when matching. Prove this complete path
against HSD and PostgreSQL before treating observer coverage as runtime proof.
Then finish the evidence-backed retention reviewer, HTTP lifecycle emission,
Solid projection, and incident recovery. The canonical task ledger was left
untouched because it contained unrelated concurrent edits; this committed
receipt is the coordinator's source for its next task-record update.
