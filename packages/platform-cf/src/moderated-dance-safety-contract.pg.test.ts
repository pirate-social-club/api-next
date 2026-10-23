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
import {
  MODERATED_DANCE_SAFETY_CONTRACT,
  MODERATED_DANCE_SAFETY_REVISION,
  makeModeratedDanceSafetyProtocol,
} from "./moderated-dance-safety-contract.ts";
import type { VideoSafetyFrameClaimInput } from "./video-safety-provider.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe,
  reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
type Fixture = Awaited<ReturnType<typeof seed>>;
const call = (admin: Client) => async (_label: string, sql: string, values: readonly unknown[]) =>
  (await admin.query(sql, [...values])).rows[0]?.packet;
async function recording(f: Fixture, admin: Client) {
  // Synthetic sealed lineage. The provider protocol runs with all guards on;
  // this is not a real camera, storage or provider acceptance claim.
  const review = await historicalReview(f, admin, Date.now() + 604_790_000, "uploaded");
  const upload = review.capture.uploadId;
  await admin.query(
    "INSERT INTO dance_moderated_processing_v1(upload_id,state,source_identity,account_fence,work_token,provider_tag,dispatched_at,provider_deadline,observation_token) VALUES($1,'claimed','{}',1,'original-work','normalization-'||$1,clock_timestamp(),clock_timestamp()+interval '1 minute','observer')",
    [upload],
  );
  for (let i = 0; i < 3; i++)
    await admin.query(
      "INSERT INTO dance_moderated_frame_artifacts_v1(upload_id,frame_index,object_identity,sha256,timestamp_ms) VALUES($1,$2,$3::jsonb,$4,$5)",
      [
        upload,
        i,
        JSON.stringify({
          key: `moderated-dance/derived/${upload}/frame-${i}.jpg`,
          version: "v1",
          etag: "etag",
          size: 4,
        }),
        String(i + 6).repeat(64),
        [0, 1000, 7000][i],
      ],
    );
  const frame: VideoSafetyFrameClaimInput = {
    operationId: review.capture.attemptId,
    submissionId: review.capture.reviewId,
    communityId: review.capture.communityId,
    videoRevision: 1,
    creationRevision: 1,
    frameRole: "poster",
    frameArtifactRef: `moderated-dance/derived/${upload}/frame-0.jpg`,
    frameSha256: "6".repeat(64),
    timestampMs: 0,
    requestedTimestampMs: 0,
    requestId: "private-screen-request",
  };
  return { upload, frame, review };
}
async function withFixture(
  use: (f: Fixture, admin: Client, r: Awaited<ReturnType<typeof recording>>) => Promise<void>,
) {
  if (url === undefined) throw new Error("Isolated native target missing");
  await reusableSchema.run({
    baseConnectionString: url,
    schemaName: "moderated_dance_safety_contract_pg_v1",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      const f = await seed(admin, scoped.toString(), undefined, {
        safetyRevision: MODERATED_DANCE_SAFETY_REVISION,
      });
      await use(f, admin, await recording(f, admin));
    },
  });
}
const protocol = (admin: Client, uploadId: string) =>
  makeModeratedDanceSafetyProtocol({ call: call(admin), uploadId, token: "observer" });
const result = (frame: VideoSafetyFrameClaimInput) => ({
  provider_id: "openai",
  requested_model: MODERATED_DANCE_SAFETY_CONTRACT.model,
  returned_model: MODERATED_DANCE_SAFETY_CONTRACT.model,
  input_sha256: frame.frameSha256,
});

suite("native private frame provider contract and irreversible dispatch claims", () => {
  test("the exact contract commits before provider I/O and the original response remains recordable after erasure without fresh authority", async () =>
    withFixture(async (f, admin, r) => {
      const p = protocol(admin, r.upload),
        grant = await p.frame("claim", r.frame, { claimToken: "original-frame" });
      expect(grant).toEqual({ status: "dispatch", claimToken: "original-frame" });
      const observer = new Client({ connectionString: f.connection });
      await observer.connect();
      try {
        // An independent connection observes the committed snapshot BEFORE the
        // offline transport is allowed to run. No external request is issued.
        const snapshot = (
          await observer.query(
            "SELECT provider_contract,state,claim_token FROM dance_moderated_provider_calls_v1 WHERE upload_id=$1",
            [r.upload],
          )
        ).rows;
        expect(snapshot).toEqual([
          {
            provider_contract: MODERATED_DANCE_SAFETY_CONTRACT,
            state: "sending",
            claim_token: "original-frame",
          },
        ]);
        expect(await p.frame("claim", r.frame, { claimToken: "replacement" })).toEqual({
          status: "unresolved",
        });
        await admin.query(
          "UPDATE dance_review_account_fences_v1 SET erasing=TRUE,revision=revision+1 WHERE account_id=$1",
          [f.facts.accountId],
        );
        expect(
          await p.frame("succeed", r.frame, {
            claimToken: "original-frame",
            result: result(r.frame),
          }),
        ).toEqual(result(r.frame));
        expect(
          await p.frame("succeed", r.frame, {
            claimToken: "original-frame",
            result: result(r.frame),
          }),
        ).toEqual(result(r.frame));
        await expect(
          p.frame(
            "claim",
            {
              ...r.frame,
              frameRole: "first",
              frameArtifactRef: `moderated-dance/derived/${r.upload}/frame-1.jpg`,
              frameSha256: "7".repeat(64),
              timestampMs: 1000,
            },
            { claimToken: "after-erasure" },
          ),
        ).rejects.toMatchObject({ code: "DRV05" });
        expect(
          (
            await admin.query(
              "SELECT state,count(*) OVER()::INTEGER n FROM dance_moderated_provider_calls_v1",
            )
          ).rows,
        ).toEqual([{ state: "succeeded", n: 1 }]);
      } finally {
        await observer.end();
      }
    }));
  test("missing/foreign contracts cannot dispatch; a bound purpose cannot change its model, token or retention promise", async () =>
    withFixture(async (_f, admin, r) => {
      let payload: Record<string, unknown> | undefined;
      await makeModeratedDanceSafetyProtocol({
        uploadId: r.upload,
        token: "observer",
        call: async (_label, _sql, values) => {
          payload = JSON.parse(String(values[3]));
          return null;
        },
      }).frame("claim", r.frame, { claimToken: "original-frame" });
      if (payload === undefined) throw new Error("Payload missing");
      for (const providerContract of [
        null,
        { ...MODERATED_DANCE_SAFETY_CONTRACT, endpoint: "https://other.invalid" },
        { ...MODERATED_DANCE_SAFETY_CONTRACT, model: "other-model" },
      ])
        await expect(
          admin.query(
            "SELECT moderated_dance_safety_protocol_v1($1,'observer','claim',$2::jsonb)",
            [r.upload, JSON.stringify({ ...payload, providerContract })],
          ),
        ).rejects.toMatchObject({ code: "DRV07" });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_provider_calls_v1"))
          .rows[0]?.n,
      ).toBe(0);
      const p = protocol(admin, r.upload);
      await p.frame("claim", r.frame, { claimToken: "original-frame" });
      await expect(
        admin.query("UPDATE dance_moderated_provider_calls_v1 SET provider_contract='{}'"),
      ).rejects.toMatchObject({ code: "DRV01" });
      await expect(
        p.frame("succeed", r.frame, { claimToken: "foreign-token", result: result(r.frame) }),
      ).rejects.toMatchObject({ code: "DRV05" });
      await expect(
        p.frame("succeed", r.frame, {
          claimToken: "original-frame",
          result: { ...result(r.frame), returned_model: "other-model" },
        }),
      ).rejects.toMatchObject({ code: "DRV06" });
      expect(
        (await admin.query("SELECT state FROM dance_moderated_provider_calls_v1")).rows,
      ).toEqual([{ state: "sending" }]);
    }));
  test("a lost COMMIT response cannot mint a second dispatch authorization", async () =>
    withFixture(async (_f, admin, r) => {
      const uncertain = makeModeratedDanceSafetyProtocol({
        uploadId: r.upload,
        token: "observer",
        call: async (label, sql, values) => {
          await admin.query("BEGIN");
          const packet = await call(admin)(label, sql, values);
          await admin.query("COMMIT");
          throw new Error(`offline acknowledgement lost: ${String(packet !== null)}`);
        },
      });
      await expect(
        uncertain.frame("claim", r.frame, { claimToken: "original-frame" }),
      ).rejects.toThrow("offline acknowledgement lost");
      expect(
        await protocol(admin, r.upload).frame("claim", r.frame, { claimToken: "retry-frame" }),
      ).toEqual({ status: "unresolved" });
      expect(
        (
          await admin.query(
            "SELECT claim_token,count(*) OVER()::INTEGER n FROM dance_moderated_provider_calls_v1",
          )
        ).rows,
      ).toEqual([{ claim_token: "original-frame", n: 1 }]);
    }));
  test("erasure committed during the actual account-lock wait prevents a safety dispatch", async () =>
    withFixture(async (f, admin, r) => {
      let payload: unknown;
      await makeModeratedDanceSafetyProtocol({
        uploadId: r.upload,
        token: "observer",
        call: async (_label, _sql, values) => {
          payload = JSON.parse(String(values[3]));
          return null;
        },
      }).frame("claim", r.frame, { claimToken: "waiting-frame" });
      const response = await runBlockedQuery(
        f.connection,
        admin,
        { text: "SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE", values: [f.facts.accountId] },
        {
          text: "SELECT moderated_dance_safety_protocol_v1($1,'observer','claim',$2::jsonb)",
          values: [r.upload, JSON.stringify(payload)],
        },
        async () => {
          await admin.query(
            "UPDATE dance_review_account_fences_v1 SET erasing=TRUE,revision=revision+1 WHERE account_id=$1",
            [f.facts.accountId],
          );
          await admin.query("COMMIT");
        },
      );
      expect("error" in response && response.error).toMatchObject({ code: "DRV05" });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_provider_calls_v1"))
          .rows[0]?.n,
      ).toBe(0);
    }));
  test("the actual 0300-to-0301 upgrade preserves an unbound dispatch and never backfills an erasure promise", async () => {
    if (url === undefined) throw new Error("Isolated target missing");
    const admin = new Client({ connectionString: url }),
      schema = `dance_safety_upgrade_${process.pid}_${Date.now()}`,
      scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await admin.connect();
    let confined: Client | undefined, role: string | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)};SET search_path TO ${quote(schema)}`);
      // The complete loader verifies current source, but this historical proof
      // must still apply exactly 0300 then 0301 as later migrations are added.
      const all = (await loadPostgresMigrations()).slice(0, 301),
        prefix = all.slice(0, -1);
      expect(all.at(-1)?.version).toBe("0301_moderated_dance_safety_retention.sql");
      await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: prefix,
        expectedLedger: [],
      });
      const f = await seed(admin, scoped.toString(), undefined, {
          historicalReferenceSchema: "pre-0307",
        }),
        r = await recording(f, admin);
      const original = { frame: r.frame, requestHash: "a".repeat(64), claimToken: "legacy-frame" };
      expect(
        (
          await admin.query(
            "SELECT moderated_dance_safety_protocol_v1($1,'observer','claim',$2::jsonb) packet",
            [r.upload, JSON.stringify(original)],
          )
        ).rows[0]?.packet,
      ).toEqual({ status: "dispatch", claimToken: "legacy-frame" });
      const upgraded = await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: all,
        expectedLedger: prefix,
      });
      if (upgraded.dryRun) throw new Error("Expected actual upgrade");
      expect(upgraded.result.applied).toEqual(["0301_moderated_dance_safety_retention.sql"]);
      expect(
        (
          await admin.query(
            "SELECT provider_contract,state,claim_token FROM dance_moderated_provider_calls_v1",
          )
        ).rows,
      ).toEqual([{ provider_contract: null, state: "sending", claim_token: "legacy-frame" }]);
      expect(
        (
          await admin.query(
            "SELECT moderated_dance_safety_protocol_v1($1,'observer','claim',$2::jsonb) packet",
            [r.upload, JSON.stringify(original)],
          )
        ).rows[0]?.packet,
      ).toEqual({ status: "unresolved" });
      await expect(
        admin.query("UPDATE dance_moderated_provider_calls_v1 SET provider_contract=$1::jsonb", [
          JSON.stringify(MODERATED_DANCE_SAFETY_CONTRACT),
        ]),
      ).rejects.toMatchObject({ code: "DRV01" });
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
      await expect(
        admin.query("SELECT load_moderated_dance_sealed_capture_v1($1,'observer')", [r.upload]),
      ).rejects.toMatchObject({ code: "DRV07" });
      role = `dance_safety_${crypto.randomUUID().replaceAll("-", "")}`;
      const password = crypto.randomUUID();
      await admin.query(
        `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
      await admin.query("SELECT grant_moderated_dance_runtime_v1($1,'media')", [role]);
      const login = new URL(scoped);
      login.username = role;
      login.password = password;
      confined = new Client({ connectionString: login.toString() });
      await confined.connect();
      await expect(
        confined.query("SELECT provider_contract FROM dance_moderated_provider_calls_v1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        confined.query("SELECT moderated_dance_safety_contract_v1()"),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await confined.query(
            "SELECT moderated_dance_safety_protocol_v1($1,'observer','inspect',$2::jsonb) packet",
            [r.upload, JSON.stringify(original)],
          )
        ).rows[0]?.packet,
      ).toEqual({ status: "unresolved" });
    } finally {
      await confined?.end();
      if (role !== undefined) {
        await admin.query(`DROP OWNED BY ${quote(role)}`);
        await admin.query(`DROP ROLE ${quote(role)}`);
      }
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await admin.end();
    }
  });
});
