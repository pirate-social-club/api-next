import type { Client } from "pg";
import { scanResetRootDependencyClosure } from "./staging-persona-dependency-scan";
import { assertSupportedResetObjects, listResetRemovalRoots } from "./staging-persona-removal-plan";
import { prepareStagingReplayContext } from "./staging-persona-replay-context";
import { validateStagingResetArtifacts } from "./staging-persona-reset-plan";

/** Same server/target/pin rehearsal must supply these limits. Counts are guard
 * rails, not an exact model of PostgreSQL's shared-memory allocator.
 */
export type RemovalBatchBudget = Readonly<{
  maxOwnLockRows: number;
  maxClusterLockRows: number;
  maxClosureObjects: number;
}>;

async function checkLocks(admin: Pick<Client, "query">, budget: RemovalBatchBudget) {
  const row = (
    await admin.query(`SELECT count(*) FILTER (WHERE pid=pg_backend_pid())::int AS own,
    count(*)::int AS cluster FROM pg_catalog.pg_locks WHERE NOT fastpath`)
  ).rows[0];
  if (row.own > budget.maxOwnLockRows || row.cluster > budget.maxClusterLockRows)
    throw new Error("reset_batch_lock_budget_exceeded_restore_required");
  return row as { own: number; cluster: number };
}

/** ONE root per caller-owned transaction. No BEGIN/COMMIT or live CLI. The
 * maintained producer fence and durable marker must already be established.
 * Any failed phase requires whole-dataset restore, not this helper's retry.
 */
export async function removeStagingRootBatch(
  admin: Pick<Client, "query">,
  artifacts: Parameters<typeof validateStagingResetArtifacts>[0],
  expected: { transactionId: string; schemaOid: number; budget: RemovalBatchBudget },
) {
  validateStagingResetArtifacts(artifacts);
  if (Object.values(expected.budget).some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error("reset_batch_budget_unproven");
  await prepareStagingReplayContext(admin, { ...expected, statementTimeoutMs: 15_000 });
  await admin.query("SET LOCAL search_path = pg_catalog");
  await admin.query("SET LOCAL lock_timeout = '2s'");
  const prepared = (
    await admin.query(`SELECT count(*)::int AS n
    FROM pg_prepared_xacts WHERE database=current_database()`)
  ).rows[0];
  if (prepared.n !== 0) throw new Error("reset_prepared_transactions_present");
  await assertSupportedResetObjects(admin);
  const root = (await listResetRemovalRoots(admin, "api_next"))[0];
  if (!root) {
    const remaining = (
      await admin.query(`SELECT
      (SELECT count(*) FROM pg_class WHERE relnamespace='api_next'::regnamespace) +
      (SELECT count(*) FROM pg_proc WHERE pronamespace='api_next'::regnamespace) +
      (SELECT count(*) FROM pg_type WHERE typnamespace='api_next'::regnamespace) AS n`)
    ).rows[0];
    if (Number(remaining.n) !== 0) throw new Error("reset_batch_namespace_not_empty");
    return { empty: true, committed: false } as const;
  }
  const closure = (await scanResetRootDependencyClosure(admin, root)).object_count;
  if (closure > expected.budget.maxClosureObjects)
    throw new Error("reset_batch_closure_budget_exceeded_restore_required");
  const before = await checkLocks(admin, expected.budget);
  if (root.phase === 1) await admin.query(`LOCK TABLE ${root.identity} IN ACCESS EXCLUSIVE MODE`);
  // Check before the irreversible-to-earlier-batches step, not after COMMIT.
  await checkLocks(admin, expected.budget);
  await admin.query(root.statement);
  const after = await checkLocks(admin, expected.budget);
  // Caller must verify outside-catalog integrity and the marker before COMMIT.
  return {
    empty: false,
    root: root.identity,
    phase: root.phase,
    closureObjects: closure,
    locksBefore: before,
    locksAfter: after,
    committed: false,
  } as const;
}
