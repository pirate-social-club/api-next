import type { Client } from "pg";
import { inspectStagingRemovalPlan, listResetRemovalRoots } from "./staging-persona-removal-plan";
import { validateStagingResetArtifacts } from "./staging-persona-reset-plan";

/**
 * Destructive internal primitive, NOT a live reset entrypoint. Caller must own
 * an explicit transaction, validated staging target, maintained producer fence,
 * recovery authority and rollback on any error. This function never commits.
 * It deliberately has no CLI. Admission still needs the complete executor's
 * outside-catalog/ACL verification, replay and postconditions before commit.
 */
export async function removeStagingObjectsInTransaction(
  admin: Pick<Client, "query">,
  artifacts: Parameters<typeof validateStagingResetArtifacts>[0],
) {
  validateStagingResetArtifacts(artifacts);
  const transaction = (await admin.query("SELECT pg_catalog.pg_current_xact_id()::text AS id"))
    .rows[0]?.id;
  const assertTransaction = async () => {
    const current = (await admin.query("SELECT pg_catalog.pg_current_xact_id()::text AS id"))
      .rows[0]?.id;
    if (!transaction || current !== transaction)
      throw new Error("reset_explicit_transaction_required");
  };
  // With autocommit these two reads have different transaction IDs: refuse
  // before settings, locks or destructive statements.
  await assertTransaction();
  const isolation = (await admin.query("SHOW transaction_isolation")).rows[0]
    ?.transaction_isolation;
  // Catalog closure must see dependencies committed before lock acquisition,
  // not an older REPEATABLE READ snapshot. The external DDL fence is still required.
  if (isolation !== "read committed") throw new Error("reset_read_committed_required");
  await admin.query("SET LOCAL lock_timeout = '2s'");
  await admin.query("SET LOCAL statement_timeout = '15s'");
  await admin.query("SET LOCAL search_path = pg_catalog");
  const prepared = await admin.query(
    "SELECT count(*)::int AS count FROM pg_catalog.pg_prepared_xacts WHERE database=current_database()",
  );
  if (prepared.rows[0]?.count !== 0) throw new Error("reset_prepared_transactions_present");
  const initial = await inspectStagingRemovalPlan(admin, artifacts);
  // A failure to lock any root aborts before the first DROP. Unsupported LOCK
  // relation kinds also fail closed; they are not silently skipped.
  for (const root of initial.roots.filter((root) => root.phase === 1)) {
    await admin.query(`LOCK TABLE ${root.identity} IN ACCESS EXCLUSIVE MODE`);
  }
  await assertTransaction();
  const phases: number[] = [];
  let drops = 0;
  for (const phase of [1, 2, 3, 4]) {
    await inspectStagingRemovalPlan(admin, artifacts);
    phases.push(phase);
    // Cascades may invalidate signatures and remove roots from this phase too.
    // Re-read after every DROP rather than trusting IF EXISTS on stale text.
    while (true) {
      const root = (await listResetRemovalRoots(admin, "api_next")).find(
        (root) => root.phase === phase,
      );
      if (!root) break;
      if (++drops > initial.roots.length) throw new Error("reset_removal_did_not_converge");
      await admin.query(root.statement);
    }
  }
  const final = await inspectStagingRemovalPlan(admin, artifacts);
  const remaining = await admin.query(`SELECT
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace='api_next'::regnamespace) +
    (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='api_next'::regnamespace) +
    (SELECT count(*) FROM pg_catalog.pg_type WHERE typnamespace='api_next'::regnamespace) AS count`);
  if (final.roots.length !== 0 || Number(remaining.rows[0]?.count) !== 0) {
    throw new Error("reset_namespace_not_empty");
  }
  await assertTransaction();
  return Object.freeze({
    drops,
    phases: Object.freeze(phases),
    transaction_id: transaction,
    committed: false,
  });
}
