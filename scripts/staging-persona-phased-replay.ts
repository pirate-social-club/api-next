import { Effect } from "effect";
import type { Client } from "pg";
import { applyPostgresMigrationsInTransaction } from "../packages/platform-cf/src/postgres-migrations";
import { migrationTransaction } from "./staging-persona-reconstruct";
import { prepareStagingReplayContext } from "./staging-persona-replay-context";
import { validateStagingResetArtifacts } from "./staging-persona-reset-plan";

/** One indivisible migration per admitted batch. A measured oversized migration
 * is refused, never split at semicolons. Prefix acceptance is NOT resume authority.
 */
export async function replayStagingMigrationBatch(
  admin: Pick<Client, "query">,
  artifacts: Parameters<typeof validateStagingResetArtifacts>[0],
  expected: {
    completed: number;
    transactionId: string;
    schemaOid: number;
    statementTimeoutMs: number;
    maxLockRows: number;
    maxClusterLockRows: number;
  },
) {
  const plan = validateStagingResetArtifacts(artifacts);
  if (
    !Number.isSafeInteger(expected.completed) ||
    expected.completed < 0 ||
    expected.completed >= plan.migrations.length ||
    !Number.isSafeInteger(expected.maxLockRows) ||
    expected.maxLockRows < 1 ||
    !Number.isSafeInteger(expected.maxClusterLockRows) ||
    expected.maxClusterLockRows < expected.maxLockRows
  )
    throw new Error("reset_replay_batch_input");
  await prepareStagingReplayContext(admin, expected);
  await admin.query("SET LOCAL lock_timeout='2s'");
  const exists = (
    await admin.query("SELECT to_regclass('api_next.schema_migrations') IS NOT NULL AS present")
  ).rows[0].present;
  const ledger = exists
    ? (
        await admin.query(
          "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
        )
      ).rows
    : [];
  if (
    JSON.stringify(ledger) !==
    JSON.stringify(
      plan.migrations
        .slice(0, expected.completed)
        .map(({ version, checksum }) => ({ version, checksum })),
    )
  )
    throw new Error("reset_replay_prefix_changed_restore_required");
  const checkLocks = async () => {
    const row = (
      await admin.query(`SELECT count(*) FILTER (WHERE pid=pg_backend_pid())::int AS own,
      count(*)::int AS cluster FROM pg_catalog.pg_locks WHERE NOT fastpath`)
    ).rows[0];
    if (row.own > expected.maxLockRows || row.cluster > expected.maxClusterLockRows)
      throw new Error("reset_replay_lock_budget_exceeded_restore_required");
    return row;
  };
  await checkLocks();
  await Effect.runPromise(
    applyPostgresMigrationsInTransaction(
      migrationTransaction(admin),
      plan.migrations.slice(0, expected.completed + 1),
    ),
  );
  const locks = await checkLocks();
  return { completed: expected.completed + 1, locks, committed: false };
}
