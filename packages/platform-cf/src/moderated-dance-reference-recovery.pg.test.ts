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
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import {
  moderatedReferenceCommand,
  preparePublishedModeratedReference,
  publishedModeratedDanceVideo,
} from "./moderated-dance-reference.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("Isolated native Postgres target required");
const suite = url === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(120000);
afterAll(async () => {
  await reusableSchema.dispose();
});
type Intake = Awaited<ReturnType<typeof seed>>;
async function withFixture(use: (f: Intake, db: Client) => Promise<void>) {
  if (url === undefined) throw new Error("Isolated target required");
  await reusableSchema.run({
    baseConnectionString: url,
    schemaName: "dance_reference_recovery_v1",
    use: async ({ admin, schema }) => {
      const connection = new URL(url);
      connection.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: connection.toString() });
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await use(await seed(admin, connection.toString()), admin);
    },
  });
}
async function withUpgradeFixture(use: (f: Intake, db: Client) => Promise<void>) {
  if (url === undefined) throw new Error("Isolated target required");
  const db = new Client({ connectionString: url }),
    schema = `dance_recovery_upgrade_${process.pid}_${Date.now()}`;
  const connection = new URL(url);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA "${schema}";SET search_path TO "${schema}"`);
    const prefix = (await loadPostgresMigrations()).slice(0, 308);
    expect(prefix.at(-1)?.version).toBe("0308_moderated_dance_reference_queue.sql");
    await runPostgresMigrations({
      connectionString: connection.toString(),
      migrations: prefix,
      expectedLedger: [],
    });
    await use(await seed(db, connection.toString()), db);
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  }
}

suite("native recovery of the same published Dance reference", () => {
  test("a fresh command waits for provider disposal, preserves failed evidence and cannot duplicate live work", async () =>
    withUpgradeFixture(async (f, db) => {
      const video = await publishedModeratedDanceVideo(db, f.connection, f.facts.communityId);
      const original = await preparePublishedModeratedReference(db, f, video);
      const command = await moderatedReferenceCommand(video, "explicit-recovery");
      const create = async (key = command, choreography = "recovered-choreography") =>
        (
          await db.query(
            "SELECT create_moderated_dance_reference_v1($1,$2::jsonb,$3,$4,'new-segment') packet",
            [video.actor, JSON.stringify(key.body), key.hash, choreography],
          )
        ).rows[0]?.packet;
      await db.query(
        "SELECT record_moderated_dance_reference_provider_v1($1,'observer',$2::jsonb)",
        [
          original.choreography,
          JSON.stringify({
            status: "error",
            id: "fixture-provider-job",
            tag: original.work.providerTag,
            taskFailures: [
              { name: "dance-fingerprint", operation: "command", code: "INVALID_DATA" },
            ],
          }),
        ],
      );
      const snapshot = async () =>
        (
          await db.query(
            "SELECT to_jsonb(c) command,(SELECT jsonb_agg(to_jsonb(r) ORDER BY idempotency_key) FROM dance_moderated_reference_receipts_v1 r WHERE r.choreography_id=c.choreography_id) receipts FROM dance_moderated_reference_commands_v1 c WHERE choreography_id=$1",
            [original.choreography],
          )
        ).rows[0];
      const before = await snapshot();
      expect(before.command.state).toBe("failed");
      const all = (await loadPostgresMigrations()).slice(0, 309);
      const upgraded = await runPostgresMigrations({
        connectionString: f.connection,
        migrations: all,
        expectedLedger: all.slice(0, 308),
      });
      if (upgraded.dryRun) throw new Error("Actual recovery upgrade required");
      expect(upgraded.result.applied).toEqual(["0309_moderated_dance_reference_recovery.sql"]);
      expect(await snapshot()).toEqual(before);
      await expect(original.publish()).rejects.toMatchObject({ code: "DRV05" });
      expect(await snapshot()).toEqual(before);
      expect(await original.create()).toEqual(original.receipt);
      await expect(create()).rejects.toMatchObject({ code: "DRV07" });
      await db.query("BEGIN");
      try {
        await db.query("DELETE FROM dance_moderated_provider_effects_v1 WHERE choreography_id=$1", [
          original.choreography,
        ]);
        await expect(create()).rejects.toMatchObject({ code: "DRV07" });
      } finally {
        await db.query("ROLLBACK");
      }
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM dance_moderated_reference_receipts_v1 WHERE idempotency_key='explicit-recovery'",
          )
        ).rows[0]?.n,
      ).toBe(0);
      const cleanup = (
        await db.query(
          "SELECT claim_moderated_dance_provider_cleanup_v1('dispose-original') packet",
        )
      ).rows[0]?.packet;
      expect(cleanup).toMatchObject({
        jobId: "fixture-provider-job",
        tag: original.work.providerTag,
      });
      await db.query(
        "SELECT finish_moderated_dance_provider_cleanup_v1($1,'dispose-original',$2::jsonb)",
        [
          cleanup.effectId,
          JSON.stringify({
            outcome: "unknown",
            jobId: cleanup.jobId,
            tag: cleanup.tag,
            reason: "provider_unknown",
          }),
        ],
      );
      await expect(create()).rejects.toMatchObject({ code: "DRV07" });
      await db.query(
        "UPDATE dance_moderated_provider_effects_v1 SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE effect_id=$1",
        [cleanup.effectId],
      );
      await db.query("SELECT claim_moderated_dance_provider_cleanup_v1('dispose-confirmed')");
      await db.query(
        "SELECT finish_moderated_dance_provider_cleanup_v1($1,'dispose-confirmed',$2::jsonb)",
        [
          cleanup.effectId,
          JSON.stringify({ outcome: "deleted", jobId: cleanup.jobId, tag: cleanup.tag }),
        ],
      );
      const recovered = await create();
      expect(recovered).toMatchObject({
        choreography_id: "recovered-choreography",
        status: "pending",
        reference_post_id: video.postId,
      });
      expect(await create()).toEqual(recovered);
      const duplicate = await moderatedReferenceCommand(video, "duplicate-recovery");
      expect(await create(duplicate, "must-not-create")).toEqual(recovered);
      expect(
        (await db.query("SELECT count(*)::int n FROM dance_moderated_reference_commands_v1"))
          .rows[0]?.n,
      ).toBe(2);
      expect(await snapshot()).toEqual(before);
      expect(await original.create()).toEqual(original.receipt);
      await expect(original.publish()).rejects.toMatchObject({ code: "DRV05" });
      const next = (
        await db.query(
          "SELECT claim_moderated_dance_reference_media_v1('new-observer',$1,$2::jsonb) packet",
          [
            f.facts.profile.mediaRuntimeRevision,
            JSON.stringify(f.facts.profile.replayCompatibleEpochs),
          ],
        )
      ).rows[0]?.packet;
      expect(next).toMatchObject({
        choreographyId: "recovered-choreography",
        normalizationClaimed: false,
        providerJobId: null,
      });
      expect(next.providerTag).not.toBe(original.work.providerTag);
      expect(next.source).toEqual(original.work.source);
      expect(
        (
          await db.query(
            "SELECT state,worker_deadline-created_at AS bound FROM dance_moderated_reference_commands_v1 WHERE choreography_id='recovered-choreography'",
          )
        ).rows[0]?.state,
      ).toBe("copying");
    }));

  test("an expired unconsumed reference may recover, but current access and policy remain required", async () =>
    withFixture(async (f, db) => {
      const video = await publishedModeratedDanceVideo(db, f.connection, f.facts.communityId);
      const first = await moderatedReferenceCommand(video, "expired-original");
      const create = async (command: typeof first, choreography: string) =>
        (
          await db.query(
            "SELECT create_moderated_dance_reference_v1($1,$2::jsonb,$3,$4,'segment') packet",
            [video.actor, JSON.stringify(command.body), command.hash, choreography],
          )
        ).rows[0]?.packet;
      const receipt = await create(first, "expired-choreography");
      await db.query(
        "UPDATE dance_moderated_reference_commands_v1 SET worker_deadline=clock_timestamp()-interval '1 millisecond' WHERE choreography_id='expired-choreography'",
      );
      await db.query(
        "SELECT claim_moderated_dance_reference_media_v1('expired-observer',$1,$2::jsonb)",
        [
          f.facts.profile.mediaRuntimeRevision,
          JSON.stringify(f.facts.profile.replayCompatibleEpochs),
        ],
      );
      expect(
        (
          await db.query(
            "SELECT state,normalization_claimed_at FROM dance_moderated_reference_commands_v1 WHERE choreography_id='expired-choreography'",
          )
        ).rows[0],
      ).toMatchObject({ state: "failed", normalization_claimed_at: null });
      const next = await moderatedReferenceCommand(video, "recover-expired");
      await db.query("UPDATE posts SET status='hidden' WHERE post_id=$1", [video.postId]);
      await expect(create(next, "new-choreography")).rejects.toMatchObject({ code: "DRV07" });
      expect(await create(first, "ignored-replay")).toEqual(receipt);
      await db.query("UPDATE posts SET status='published' WHERE post_id=$1", [video.postId]);
      await db.query(
        "UPDATE dance_review_policy_admissions_v1 SET accepted=FALSE WHERE community_id=$1",
        [f.facts.communityId],
      );
      await expect(create(next, "new-choreography")).rejects.toMatchObject({ code: "DRV07" });
      await db.query(
        "UPDATE dance_review_policy_admissions_v1 SET accepted=TRUE WHERE community_id=$1",
        [f.facts.communityId],
      );
      expect(await create(next, "new-choreography")).toMatchObject({
        choreography_id: "new-choreography",
        status: "pending",
      });
      const clocks = (
        await db.query(
          "SELECT floor(extract(epoch FROM (worker_deadline-created_at))*1000)::int width FROM dance_moderated_reference_commands_v1 WHERE choreography_id='new-choreography'",
        )
      ).rows[0];
      expect(clocks.width).toBe(f.facts.profile.providerWaitMs);
    }));
});
