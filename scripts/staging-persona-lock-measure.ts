import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import { removeStagingObjectsInTransaction } from "./staging-persona-remove-objects";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

/** Disposable local measurement, never a provider reset command. Sampling can
 * miss transient peaks; these observations are lower bounds, not batch budgets.
 */
async function measureLocalLocks() {
  if (Bun.argv.length !== 3 || Bun.argv[2] !== "--local-measure")
    throw new Error("local_measure_flag_required");
  const source = localRecoveryTestUrl(process.env.CONTROL_PLANE_POSTGRES_TEST_URL ?? "");
  const artifacts = loadStagingResetArtifacts();
  const plan = validateStagingResetArtifacts(artifacts);
  const observer = new Client({ connectionString: source.toString() });
  await observer.connect();
  try {
    const settings = (
      await observer.query(`SELECT current_setting('server_version_num')::int AS version,
      current_setting('max_locks_per_transaction')::int AS max_locks_per_transaction,
      current_setting('max_connections')::int AS max_connections,
      current_setting('max_prepared_transactions')::int AS max_prepared_transactions`)
    ).rows[0];
    if (settings.version < 170000 || settings.version >= 180000)
      throw new Error("postgres17_required");
    for (const phase of ["removal", "replay"] as const) {
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const database = `lock_measure_${suffix}`;
      const application = `lock_measure_${phase}_${suffix}`;
      const url = new URL(source);
      url.pathname = `/${database}`;
      url.searchParams.set(
        "options",
        `-c search_path=api_next,pg_catalog -c application_name=${application}`,
      );
      const admin = new Client({ connectionString: url.toString() });
      let samples = 0;
      let peakRows = 0;
      let peakNonFastpath = 0;
      let peakObjects = 0;
      let finished = false;
      let monitor: Promise<void> | undefined;
      let samplingFailed = false;
      const sample = async () => {
        const row = (
          await observer.query(
            `SELECT count(*)::int AS rows,
          count(*) FILTER (WHERE NOT fastpath)::int AS non_fastpath,
          count(DISTINCT (locktype,database,relation,page,tuple,virtualxid,transactionid::text,classid,objid,objsubid))::int AS objects
          FROM pg_catalog.pg_locks WHERE pid IN
          (SELECT pid FROM pg_catalog.pg_stat_activity WHERE application_name=$1)`,
            [application],
          )
        ).rows[0];
        samples++;
        peakRows = Math.max(peakRows, row.rows);
        peakNonFastpath = Math.max(peakNonFastpath, row.non_fastpath);
        peakObjects = Math.max(peakObjects, row.objects);
      };
      try {
        await observer.query(`CREATE DATABASE "${database}"`);
        await admin.connect();
        await admin.query("CREATE SCHEMA api_next");
        if (phase === "removal") {
          await runPostgresMigrations({
            connectionString: url.toString(),
            migrations: plan.migrations.slice(0, 109),
          });
          await admin.query("INSERT INTO api_next.users(user_id) VALUES ('lock-measure-fixture')");
        }
        const started = performance.now();
        monitor = (async () => {
          while (!finished) {
            await sample();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })().catch(() => {
          samplingFailed = true;
        });
        if (phase === "removal") {
          await admin.query("BEGIN");
          await removeStagingObjectsInTransaction(admin, artifacts);
          await sample();
          await admin.query("ROLLBACK");
          const retained = (
            await admin.query("SELECT count(*)::int AS count FROM api_next.schema_migrations")
          ).rows[0].count;
          if (retained !== 109) throw new Error("measurement_rollback_failed");
        } else {
          await runPostgresMigrations({
            connectionString: url.toString(),
            migrations: plan.migrations,
          });
        }
        finished = true;
        await monitor;
        if (samplingFailed) throw new Error("lock_sampling_failed");
        console.log(
          JSON.stringify({
            phase,
            source_sha: plan.sourceSha,
            settings,
            sampled_peak_rows: peakRows,
            sampled_peak_non_fastpath: peakNonFastpath,
            sampled_peak_distinct_objects: peakObjects,
            samples,
            elapsed_ms: Math.round(performance.now() - started),
            sampling_interval_ms: 20,
            transient_peaks_may_be_missed: true,
            provider_budget_proven: false,
            execution_authorized: false,
          }),
        );
      } finally {
        finished = true;
        await monitor?.catch(() => undefined);
        await admin.query("ROLLBACK").catch(() => undefined);
        await admin.end();
        // Only the UUID-named local database created by this invocation.
        await observer.query(`DROP DATABASE IF EXISTS "${database}"`);
      }
    }
  } finally {
    await observer.end();
  }
}

if (import.meta.main) {
  await measureLocalLocks().catch(() => {
    console.error("local_lock_measurement_unproven");
    process.exitCode = 1;
  });
}
