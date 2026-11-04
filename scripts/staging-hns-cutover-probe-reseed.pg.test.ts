import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "./postgres-test-baseline.ts";
import { reseedWithinTransaction } from "./staging-hns-cutover-probe-reseed.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

const SERVICE = "pirate-hns-authority-provisioner-v2";
const OLD_ATTEMPT = "staging-old-attempt-0001";
const FAILED_ATTEMPT = "staging-failed-attempt-0002";
const NEW_ATTEMPT = "staging-new-attempt-0003";
const OLD_SHA = "a".repeat(64);
const FAILED_SHA = "b".repeat(64);
const NEW_SHA = "c".repeat(64);

pgTest(
  "a re-seed reconciles the failed attempt and lets only the fresh reviewed attempt serve",
  async () => {
    if (!url) throw new Error("Postgres required");
    const schema = `probe_reseed_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: url });
    const scoped = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      const client = new Client({ connectionString: scoped });
      await client.connect();
      try {
        const who = (await client.query("SELECT current_database() AS d, current_user AS u"))
          .rows[0];
        const probe = async (attempt: string, sha: string) =>
          (
            await client.query(
              "SELECT run_hns_lifecycle_readiness_cutover_probe_v1('pirate-hns-staging-provisioner-1', $1, $2, $3, $3, clock_timestamp()) AS r",
              [attempt, SERVICE, sha],
            )
          ).rows[0].r;
        const jobCount = async () =>
          (await client.query("SELECT count(*)::int AS n FROM hns_root_import_lifecycle_jobs"))
            .rows[0].n;
        const reseed = (
          execute: boolean,
          reconcile: string | undefined,
          attempt = NEW_ATTEMPT,
          history: readonly string[] | undefined = execute ? ["1:completed"] : undefined,
        ): Promise<Record<string, unknown> | string | undefined> =>
          reseedWithinTransaction(client, {
            schema,
            sql_database: who.d,
            expected_role: who.u,
            release: { attempt_id: attempt, bundle_sha256: NEW_SHA },
            reconcile_failed_attempt: reconcile,
            expected_probe_jobs: history,
            execute,
            ledger_migrations: 0,
            ledger_head: null,
          }).catch((error: { code?: string }) => error.code);

        // Reproduce staging: first seed, the old release's completed probe,
        // then a new release that started without a re-seed.
        expect(
          (await client.query("SELECT seed_hns_lifecycle_readiness_cutover_probe_v1() AS r"))
            .rows[0].r,
        ).toBe("seeded");
        expect(await probe(OLD_ATTEMPT, OLD_SHA)).toBe("ready");
        expect(await probe(FAILED_ATTEMPT, FAILED_SHA)).toBe("failed");
        expect(
          (
            await client.query(
              "SELECT attempt_id, probe_outcome, probe_reason FROM hns_lifecycle_service_identity",
            )
          ).rows[0],
        ).toEqual({
          attempt_id: FAILED_ATTEMPT,
          probe_outcome: "failed",
          probe_reason: "attempt_mismatch",
        });

        // The failed attempt must be named, and the release attempt must be fresh.
        expect(await reseed(false, undefined)).toBe("failed_attempt_unacknowledged");
        expect(await reseed(false, OLD_ATTEMPT)).toBe("failed_attempt_unacknowledged");
        expect(await reseed(false, FAILED_ATTEMPT, FAILED_ATTEMPT)).toBe("attempt_not_fresh");

        // A dry run reads and plans without writing.
        const before = await jobCount();
        const dry = (await reseed(false, FAILED_ATTEMPT)) as Record<string, unknown>;
        expect(dry.outcome).toBe("staging_probe_reseed_dry_run");
        expect(dry.attempt_id).toBe(NEW_ATTEMPT);
        expect(await jobCount()).toBe(before);

        expect(dry.probe_jobs).toEqual(["1:completed"]);
        // Execution without the dry run's history, or with a different one, refuses.
        expect(await reseed(true, FAILED_ATTEMPT, NEW_ATTEMPT, [])).toBe(
          "probe_history_unexpected",
        );
        expect(
          await reseed(true, FAILED_ATTEMPT, NEW_ATTEMPT, ["1:completed", "2:completed"]),
        ).toBe("probe_history_unexpected");
        // Execution queues exactly one fresh probe job through the maintained
        // function and leaves the completed history in place.
        const executed = (await reseed(true, FAILED_ATTEMPT)) as Record<string, unknown>;
        expect(executed.outcome).toBe("staging_probe_reseeded");
        expect(executed.probe_jobs).toEqual([
          expect.stringMatching(/^\d+:completed$/u),
          expect.stringMatching(/^\d+:queued$/u),
        ]);
        expect(await jobCount()).toBe(before + 1);

        // A second execute while the fresh probe is queued is a competing probe.
        expect(await reseed(true, FAILED_ATTEMPT)).toBe("probe_job_competing");

        // Only the fresh reviewed attempt completes the probe; it then replays,
        // and neither earlier attempt can be satisfied by it.
        expect(await probe(NEW_ATTEMPT, NEW_SHA)).toBe("ready");
        expect(await probe(NEW_ATTEMPT, NEW_SHA)).toBe("replayed");
        expect(await probe(OLD_ATTEMPT, OLD_SHA)).toBe("failed");
      } finally {
        await client.end();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.end();
    }
  },
  120_000,
);
