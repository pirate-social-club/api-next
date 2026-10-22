import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { historicalReview, runBlockedQuery } from "./moderated-dance-authority.pg-fixture.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import { makeModeratedDanceMaintenance } from "./moderated-dance-maintenance.ts";
import { makeModeratedDancePublicReplay } from "./moderated-dance-public-replay.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

// Real PostgreSQL/retained transactions with synthetic private-review lineage
// and intercepted provider requests. No real recording, provider or erasure claim.
const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe,
  reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Seed = Awaited<ReturnType<typeof seed>>;
async function withFixture(use: (f: Seed, admin: Client, upload: string) => Promise<void>) {
  if (url === undefined) throw new Error("Isolated native target missing");
  return reusableSchema.run({
    baseConnectionString: url,
    schemaName: "moderated_dance_provider_cleanup_pg_v1",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      const f = await seed(admin, scoped.toString()),
        review = await historicalReview(f, admin, Date.now() + 604_790_000);
      await use(f, admin, review.capture.uploadId);
    },
  });
}
type FixtureUse = (f: Seed, admin: Client, upload: string) => Promise<void>;
async function withFreshFixture(use: FixtureUse, beforeUpgrade?: FixtureUse) {
  if (url === undefined) throw new Error("Isolated native target missing");
  const admin = new Client({ connectionString: url }),
    schema = `dance_cleanup_acl_${process.pid}_${Date.now()}`,
    scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}; SET search_path TO ${quote(schema)}`);
    const all = await loadPostgresMigrations(),
      target = all.findIndex((m) => m.version === "0297_moderated_dance_provider_disposition.sql");
    expect(target).toBeGreaterThan(0);
    const selected = beforeUpgrade ? all.slice(0, target + 1) : all,
      prefix = beforeUpgrade ? all.slice(0, target) : selected;
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: prefix,
      expectedLedger: [],
    });
    const f = await seed(admin, scoped.toString(), undefined, { publicReplay: !beforeUpgrade }),
      review = await historicalReview(f, admin, Date.now() + 604_790_000);
    if (beforeUpgrade) {
      await beforeUpgrade(f, admin, review.capture.uploadId);
      const upgraded = await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: selected,
        expectedLedger: prefix,
      });
      if (upgraded.dryRun) throw new Error("Expected an actual migration upgrade");
      expect(upgraded.result.applied).toEqual(["0297_moderated_dance_provider_disposition.sql"]);
    }
    await use(f, admin, review.capture.uploadId);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await admin.end();
  }
}
async function processing(
  admin: Client,
  upload: string,
  normalized = true,
  deadline = Date.now() + 60_000,
) {
  await admin.query(
    `INSERT INTO dance_moderated_processing_v1(upload_id,state,source_identity,account_fence,work_token,provider_tag,provider_job_id,dispatched_at,provider_deadline,observation_token,normalization_claimed_at)
    SELECT upload_id,$2,immutable_object_identity,1,'original-work','dance-'||upload_id,$3,clock_timestamp(),to_timestamp($4::NUMERIC/1000),'observer',CASE WHEN $5 THEN clock_timestamp() ELSE NULL END FROM dance_moderated_uploads_v1 WHERE upload_id=$1`,
    [
      upload,
      normalized ? "screened" : "claimed",
      normalized ? "bound-job" : null,
      deadline,
      normalized,
    ],
  );
}
const claim = (admin: Client, token = "cleanup-token") =>
  admin
    .query("SELECT claim_moderated_dance_provider_cleanup_v1($1) AS packet", [token])
    .then((r) => r.rows[0]?.packet);

suite("moderated Dance provider disposition", () => {
  test("the real 0296-to-0297 upgrade backfills both old provider purposes without clearing uncertainty", async () =>
    withFreshFixture(
      async (_f, admin) => {
        expect(
          (
            await admin.query(
              "SELECT purpose,provider,provider_job_id,state FROM dance_moderated_provider_effects_v1 ORDER BY purpose",
            )
          ).rows,
        ).toEqual([
          {
            purpose: "normalization",
            provider: "cloudconvert",
            provider_job_id: "bound-job",
            state: "registered",
          },
          {
            purpose: "probe",
            provider: "qencode",
            provider_job_id: "legacy-probe",
            state: "registered",
          },
        ]);
      },
      async (_f, admin, upload) => {
        expect(
          (
            await admin.query(
              "SELECT to_regclass('dance_moderated_provider_effects_v1') AS table_name",
            )
          ).rows[0]?.table_name,
        ).toBeNull();
        await processing(admin, upload);
        await admin.query(
          "UPDATE dance_moderated_processing_v1 SET probe_phase='unknown',probe_attempt=$2::jsonb WHERE upload_id=$1",
          [upload, JSON.stringify({ providerJobId: "legacy-probe" })],
        );
      },
    ));
  test("actual probe and normalization grant transactions register distinct liabilities before dispatch", async () =>
    withFixture(async (_f, admin, upload) => {
      await processing(admin, upload, false);
      const first = (
        await admin.query("SELECT claim_moderated_dance_probe_v1($1,'observer') AS packet", [
          upload,
        ])
      ).rows[0]?.packet;
      expect(first.fresh).toBe(true);
      expect(first.phase).toBe("allocating");
      expect(
        (
          await admin.query(
            "SELECT purpose,provider,provider_job_id FROM dance_moderated_provider_effects_v1",
          )
        ).rows,
      ).toEqual([{ purpose: "probe", provider: "qencode", provider_job_id: null }]);
      // Synthetic completed-probe bootstrap; this is not provider/media acceptance.
      await admin.query(
        "UPDATE dance_moderated_processing_v1 SET probe_phase='complete',probe_attempt=$2::jsonb WHERE upload_id=$1",
        [upload, JSON.stringify({ providerJobId: "legacy-probe" })],
      );
      await admin.query("BEGIN");
      expect(
        (
          await admin.query(
            "SELECT claim_moderated_dance_normalization_v1($1,'observer') AS granted",
            [upload],
          )
        ).rows[0]?.granted,
      ).toBe(true);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_provider_effects_v1"))
          .rows[0]?.n,
      ).toBe(2);
      await admin.query("ROLLBACK");
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_provider_effects_v1"))
          .rows[0]?.n,
      ).toBe(1);
      await admin.query("SELECT claim_moderated_dance_normalization_v1($1,'observer')", [upload]);
      await admin.query("SELECT attach_moderated_dance_provider_v1($1,'observer','bound-job',$2)", [
        upload,
        `dance-${upload}`,
      ]);
      expect(
        (
          await admin.query(
            "SELECT purpose,provider,provider_job_id FROM dance_moderated_provider_effects_v1 ORDER BY purpose",
          )
        ).rows,
      ).toEqual([
        { purpose: "normalization", provider: "cloudconvert", provider_job_id: "bound-job" },
        { purpose: "probe", provider: "qencode", provider_job_id: "legacy-probe" },
      ]);
    }));
  test("a mismatched provider identity cannot rewrite a registered effect", async () =>
    withFixture(async (_f, admin, upload) => {
      await processing(admin, upload);
      await expect(
        admin.query(
          "UPDATE dance_moderated_processing_v1 SET provider_job_id='foreign-job' WHERE upload_id=$1",
          [upload],
        ),
      ).rejects.toMatchObject({ code: "DRV05" });
      expect(
        (await admin.query("SELECT provider_job_id FROM dance_moderated_provider_effects_v1"))
          .rows[0]?.provider_job_id,
      ).toBe("bound-job");
    }));
  test("real retained cleanup recovers a lost DELETE reply through the same job's 404", async () =>
    withFixture(async (f, admin, upload) => {
      await processing(admin, upload);
      let exists = true;
      const requests: string[] = [];
      const provider = makeSongVideoCloudConvertTransport({
        apiKey: "test-only",
        fetch: async (_url, init) => {
          requests.push(init.method ?? "GET");
          if (init.method === "DELETE") {
            exists = false;
            throw new Error("lost reply after deletion");
          }
          return exists
            ? Response.json({
                data: { id: "bound-job", tag: `dance-${upload}`, status: "finished" },
              })
            : new Response(null, { status: 404 });
        },
      });
      const forbidden = async () => {
        throw new Error("No raw storage effect in provider fixtures");
      };
      const maintenance = makeModeratedDanceMaintenance({
        runtime: f.runtime,
        ingress: { head: forbidden, put: forbidden },
        originals: { head: forbidden, put: forbidden },
        provider,
      });
      await maintenance.run();
      expect(
        (await admin.query("SELECT state FROM dance_moderated_provider_effects_v1")).rows[0]?.state,
      ).toBe("unknown");
      await admin.query(
        "UPDATE dance_moderated_provider_effects_v1 SET lease_until=clock_timestamp()-interval '1 second'",
      );
      await maintenance.run();
      expect(requests).toEqual(["GET", "DELETE", "GET"]);
      expect(
        (
          await admin.query(
            "SELECT state,observed_result->>'outcome' outcome FROM dance_moderated_provider_effects_v1",
          )
        ).rows,
      ).toEqual([{ state: "completed", outcome: "observed_absent" }]);
    }));
  test("unbound or invented deletion evidence cannot complete a liability", async () =>
    withFixture(async (_f, admin, upload) => {
      await processing(admin, upload);
      const selected = await claim(admin);
      expect(selected.jobId).toBe("bound-job");
      await expect(
        admin.query("SELECT finish_moderated_dance_provider_cleanup_v1($1,$2,$3::jsonb)", [
          selected.effectId,
          selected.token,
          JSON.stringify({ outcome: "deleted", jobId: "foreign-job", tag: selected.tag }),
        ]),
      ).rejects.toMatchObject({ code: "DRV06" });
      await expect(
        admin.query("SELECT finish_moderated_dance_provider_cleanup_v1($1,$2,$3::jsonb)", [
          selected.effectId,
          selected.token,
          JSON.stringify({
            outcome: "deleted",
            jobId: selected.jobId,
            tag: selected.tag,
            url: "private-url",
          }),
        ]),
      ).rejects.toMatchObject({ code: "DRV06" });
      expect(
        (await admin.query("SELECT state FROM dance_moderated_provider_effects_v1")).rows[0]?.state,
      ).toBe("leased");
    }));
  test("a hold committed during a real lock wait prevents the cleanup grant", async () =>
    withFixture(async (f, admin, upload) => {
      await processing(admin, upload);
      const response = await runBlockedQuery(
        f.connection,
        admin,
        { text: "SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE", values: [f.facts.accountId] },
        {
          text: "SELECT claim_moderated_dance_provider_cleanup_v1('waiting-cleanup') AS packet",
          values: [],
        },
        async () => {
          await admin.query(
            "UPDATE dance_moderated_processing_v1 SET state='held' WHERE upload_id=$1",
            [upload],
          );
          await admin.query("COMMIT");
        },
      );
      expect("result" in response && response.result.rows[0]?.packet).toBeNull();
      expect(
        (await admin.query("SELECT state FROM dance_moderated_provider_effects_v1")).rows[0]?.state,
      ).toBe("registered");
    }));
  test("overdue unsupported probe liabilities revoke intake readiness without being erased", async () =>
    withFixture(async (f, admin, upload) => {
      await processing(
        admin,
        upload,
        false,
        Date.now() - f.publication.disposition.temporaryCleanupWithinMs - 1000,
      );
      await admin.query(
        "UPDATE dance_moderated_processing_v1 SET probe_phase='unknown',probe_attempt=$2::jsonb WHERE upload_id=$1",
        [upload, JSON.stringify({ providerJobId: "legacy-probe" })],
      );
      await f.ready();
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_maintenance_readiness_v1",
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_processor_readiness_v1",
          )
        ).rows[0]?.n,
      ).toBe(0);
      const selected = await claim(admin);
      expect(selected.provider).toBe("qencode");
      await expect(
        admin.query("SELECT finish_moderated_dance_provider_cleanup_v1($1,$2,$3::jsonb)", [
          selected.effectId,
          selected.token,
          JSON.stringify({ outcome: "observed_absent", jobId: selected.jobId, tag: null }),
        ]),
      ).rejects.toMatchObject({ code: "DRV06" });
    }));
  test("restricted media LOGIN can drain through functions but cannot read raw custody or call private registration", async () =>
    withFreshFixture(async (f, admin, upload) => {
      await processing(admin, upload);
      const role = `dance_cleanup_${crypto.randomUUID().replaceAll("-", "")}`,
        password = crypto.randomUUID();
      await admin.query(
        `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      );
      const login = new URL(f.connection);
      login.username = role;
      login.password = password;
      let client: Client | undefined;
      try {
        const schema = (await admin.query("SELECT current_schema() AS name")).rows[0]?.name;
        await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
        await admin.query("SELECT grant_moderated_dance_runtime_v1($1,'media')", [role]);
        client = new Client({ connectionString: login.toString() });
        await client.connect();
        await expect(
          client.query("SELECT * FROM dance_moderated_provider_effects_v1"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query(
            "SELECT register_moderated_dance_provider_effect_v1(NULL,NULL,'probe','qencode',NULL,NULL,repeat('a',64),clock_timestamp(),'{}','{}')",
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query("SELECT lock_moderated_dance_processing_authority_v1('unowned')"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query("SELECT * FROM dance_moderated_replay_retirements_v1"),
        ).rejects.toMatchObject({ code: "42501" });
        for (const table of [
          "dance_moderated_public_replay_v1",
          "dance_moderated_public_replay_indexes_v1",
          "dance_moderated_replay_epochs_v1",
          "dance_moderated_replay_epoch_retirements_v1",
        ])
          await expect(client.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
            code: "42501",
          });
        await expect(
          client.query("SELECT retire_moderated_dance_replay_epoch_v1('unused','forbidden')"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query("SELECT moderated_dance_public_replay_ready_v1('scope','hash','epoch')"),
        ).rejects.toMatchObject({ code: "42501" });
        const confined = client;
        expect(
          await makeModeratedDancePublicReplay({
            call: async (_label, sql, values) =>
              (await confined.query(sql, [...values])).rows[0]?.packet,
            keys: f.replayKeys,
          }).run(),
        ).toEqual({ outcome: "empty" });
        expect(
          (await client.query("SELECT drain_moderated_dance_compatible_replay_v1() packet")).rows[0]
            ?.packet,
        ).toEqual({ removedClaims: 0, removedPublicIndexes: 0 });
        expect(
          (await client.query("SELECT drain_moderated_dance_replay_v1() packet")).rows[0]?.packet,
        ).toEqual({ retiredAttempts: 0 });
        const selected = (
          await client.query(
            "SELECT claim_moderated_dance_provider_cleanup_v1('confined-cleanup') AS packet",
          )
        ).rows[0]?.packet;
        expect(selected.jobId).toBe("bound-job");
        await client.query("SELECT finish_moderated_dance_provider_cleanup_v1($1,$2,$3::jsonb)", [
          selected.effectId,
          selected.token,
          JSON.stringify({ outcome: "deleted", jobId: selected.jobId, tag: selected.tag }),
        ]);
        expect(
          (await admin.query("SELECT state FROM dance_moderated_provider_effects_v1")).rows[0]
            ?.state,
        ).toBe("completed");
      } finally {
        await client?.end();
        await admin.query(`DROP OWNED BY ${quote(role)}`);
        await admin.query(`DROP ROLE ${quote(role)}`);
      }
    }));
});
