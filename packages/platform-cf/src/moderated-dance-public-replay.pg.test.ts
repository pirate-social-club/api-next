import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { prepareModeratedDancePolicyPublication } from "../../application/src/use-cases/dance/moderated-policy.ts";
import { historicalReview, runBlockedQuery } from "./moderated-dance-authority.pg-fixture.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import { moderatedDanceReplayDigests } from "./moderated-dance-normalization.ts";
import {
  bindModeratedDanceReplayKeys,
  makeModeratedDancePublicReplay,
} from "./moderated-dance-public-replay.ts";
import {
  preparePublishedModeratedReference,
  publishedModeratedDanceVideo,
} from "./moderated-dance-reference.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
type Fixture = Awaited<ReturnType<typeof seed>>;
async function withFixture(use: (f: Fixture, admin: Client) => Promise<void>) {
  if (url === undefined) throw new Error("Isolated target missing");
  await reusableSchema.run({
    baseConnectionString: url,
    schemaName: "moderated_dance_public_replay_pg_v1",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await use(await seed(admin, scoped.toString()), admin);
    },
  });
}
const call = (admin: Client) => async (_label: string, sql: string, values: readonly unknown[]) =>
  (await admin.query(sql, [...values])).rows[0]?.packet;
const newer = "test-next-epoch";
const keys = (f: Fixture) => new Map([...f.replayKeys, [newer, new Uint8Array(32).fill(2)]]);
async function publish(
  f: Fixture,
  admin: Client,
  id: string,
  compatible = [f.facts.profile.replayKeyEpoch, newer],
) {
  const document = await Effect.runPromise(
    prepareModeratedDancePolicyPublication({
      ...f.publication,
      policy_id: id,
      profile: { ...f.facts.profile, replayKeyEpoch: newer, replayCompatibleEpochs: compatible },
    }),
  );
  await admin.query("SELECT publish_moderated_dance_policy_v1($1::jsonb)", [
    JSON.stringify(document),
  ]);
  return document;
}
const ready = async (f: Fixture, admin: Client, epoch: string) =>
  (
    await admin.query("SELECT moderated_dance_public_replay_ready_v1($1,$2,$3) ready", [
      f.facts.profile.replayScope,
      f.publication.policy.normalizationHash,
      epoch,
    ])
  ).rows[0]?.ready;
const drain = async (admin: Client) =>
  (await admin.query("SELECT drain_moderated_dance_compatible_replay_v1() packet")).rows[0]?.packet;

suite("native public reference reindex and actual epoch retirement", () => {
  test("real reference publication retains validated public descriptors and restores trusted paths on every replaced function", async () =>
    withFixture(async (f, admin) => {
      const video = await publishedModeratedDanceVideo(
        admin,
        f.connection,
        f.facts.communityId,
        6000,
      );
      const reference = await preparePublishedModeratedReference(admin, f, video);
      const frames = reference.frames;
      await reference.publish();
      expect(
        (
          await admin.query(
            "SELECT frames FROM dance_moderated_public_replay_v1 WHERE choreography_id='published-choreography'",
          )
        ).rows[0]?.frames,
      ).toEqual(frames);
      expect(
        (
          await admin.query(
            "SELECT result FROM dance_moderated_reference_commands_v1 WHERE choreography_id='published-choreography'",
          )
        ).rows[0]?.result,
      ).not.toHaveProperty("publicFrames");
      expect(await ready(f, admin, f.facts.profile.replayKeyEpoch)).toBe(true);
      const schema = (await admin.query("SELECT current_schema() schema")).rows[0]?.schema;
      const paths = (
        await admin.query(
          "SELECT proname,proconfig FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1::TEXT[])",
          [
            [
              "publish_moderated_dance_policy_v1",
              "publish_moderated_dance_reference_v1",
              "load_moderated_dance_creation_facts_v1",
              "persist_moderated_dance_normalization_v1",
              "read_moderated_dance_capture_options_v1",
              "grant_moderated_dance_runtime_v1",
            ],
          ],
        )
      ).rows;
      expect(paths).toHaveLength(6);
      for (const row of paths)
        expect(row.proconfig).toContain(`search_path=${schema}, pg_catalog, pg_temp`);
    }));
  test("a new epoch closes intake until the actual public body is reindexed; the old epoch then drains and retires without losing reference history", async () =>
    withFixture(async (f, admin) => {
      const old = f.facts.profile.replayKeyEpoch;
      expect(await ready(f, admin, old)).toBe(true);
      const dual = await publish(f, admin, "dual-policy");
      expect(await ready(f, admin, newer)).toBe(false);
      await f.ready();
      const options = (
        await admin.query("SELECT read_moderated_dance_capture_options_v1($1,$2,$3,NULL) packet", [
          f.facts.accountId,
          f.facts.communityId,
          f.facts.songPostId,
        ])
      ).rows[0]?.packet;
      expect(options.ready).toBe(false);
      expect(options.unavailable_code).toBe("processor_unavailable");
      const runtime = makeModeratedDancePublicReplay({ call: call(admin), keys: keys(f) });
      expect(await runtime.run()).toEqual({ outcome: "indexed" });
      expect(await ready(f, admin, newer)).toBe(true);
      const expected = await moderatedDanceReplayDigests({
        scope: f.facts.profile.replayScope,
        sourceSha256: "a".repeat(64),
        frames: f.publicFrames,
        keys: new Map([[newer, keys(f).get(newer) ?? new Uint8Array()]]),
      });
      expect(
        (
          await admin.query(
            "SELECT kind,digest FROM dance_moderated_replay_claims_v1 WHERE key_epoch=$1 ORDER BY kind",
            [newer],
          )
        ).rows,
      ).toEqual(
        expected.claims
          .map(({ kind, digest }) => ({ kind, digest }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
      );
      expect(await drain(admin)).toEqual({ removedClaims: 2, removedPublicIndexes: 1 });
      expect(await ready(f, admin, newer)).toBe(true);
      await expect(
        admin.query("SELECT retire_moderated_dance_replay_epoch_v1($1,'test-retirement')", [old]),
      ).rejects.toMatchObject({ code: "DRV07" });
      await publish(f, admin, "new-only-policy", [newer]);
      const receipt = (
        await admin.query(
          "SELECT retire_moderated_dance_replay_epoch_v1($1,'test-retirement') receipt",
          [old],
        )
      ).rows[0]?.receipt;
      expect(receipt.epoch).toBe(old);
      expect(
        (
          await admin.query(
            "SELECT retire_moderated_dance_replay_epoch_v1($1,'test-retirement') receipt",
            [old],
          )
        ).rows[0]?.receipt,
      ).toEqual(receipt);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderator_reference_revisions_v1",
          )
        ).rows[0]?.n,
      ).toBe(1);
      await expect(
        admin.query("SELECT publish_moderated_dance_policy_v1($1::jsonb)", [
          JSON.stringify({ ...dual, policy_id: "closed-epoch-policy" }),
        ]),
      ).rejects.toMatchObject({ code: "DRV07" });
      expect(await runtime.run()).toEqual({ outcome: "empty" });
      await expect(
        bindModeratedDanceReplayKeys(call(admin), new Map([[old, new Uint8Array(32).fill(3)]])),
      ).rejects.toMatchObject({ code: "DRV05" });
    }));
  test("a captured old-current private identity cannot be pruned by compatible replacements or omitted from a new policy", async () =>
    withFixture(async (f, admin) => {
      const r = await historicalReview(f, admin, Date.now() + 60_000);
      const old = f.facts.profile.replayKeyEpoch;
      await publish(f, admin, "dual-policy");
      await makeModeratedDancePublicReplay({ call: call(admin), keys: keys(f) }).run();
      for (const epoch of [old, newer])
        for (const kind of ["raw", "body"])
          await admin.query(
            "INSERT INTO dance_moderated_replay_claims_v1 VALUES($1,$2,$3,$4,'attempt',$5,clock_timestamp()+interval '1 day',clock_timestamp())",
            [
              f.facts.profile.replayScope,
              epoch,
              kind,
              kind === "body" ? r.capture.normalizedDigest : "e".repeat(64),
              r.capture.uploadId,
            ],
          );
      await drain(admin);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_replay_claims_v1 WHERE source_kind='attempt' AND key_epoch=$1",
            [old],
          )
        ).rows[0]?.n,
      ).toBe(2);
      await expect(publish(f, admin, "premature-new-only", [newer])).rejects.toMatchObject({
        code: "DRV07",
      });
      await expect(
        admin.query("SELECT retire_moderated_dance_replay_epoch_v1($1,'too-early')", [old]),
      ).rejects.toMatchObject({ code: "DRV07" });
    }));
  test("an expired lease cannot install a public index and a rolled-back index cannot open intake", async () =>
    withFixture(async (f, admin) => {
      await publish(f, admin, "dual-policy");
      await bindModeratedDanceReplayKeys(call(admin), keys(f));
      const work = (
        await admin.query(
          "SELECT claim_moderated_dance_public_reindex_v1('leased',$1::jsonb) packet",
          [JSON.stringify([newer])],
        )
      ).rows[0]?.packet;
      const computed = await moderatedDanceReplayDigests({
        scope: work.scope,
        sourceSha256: work.sourceSha256,
        frames: work.frames,
        keys: new Map([[newer, keys(f).get(newer) ?? new Uint8Array()]]),
      });
      await admin.query(
        "UPDATE dance_moderated_public_replay_indexes_v1 SET work_until=clock_timestamp()-interval '1 second' WHERE key_epoch=$1",
        [newer],
      );
      await expect(
        admin.query("SELECT finish_moderated_dance_public_reindex_v1($1,1,$2,'leased',$3::jsonb)", [
          f.facts.choreographyId,
          newer,
          JSON.stringify(computed.claims),
        ]),
      ).rejects.toMatchObject({ code: "DRV05" });
      expect(await ready(f, admin, newer)).toBe(false);
      await admin.query("BEGIN");
      await makeModeratedDancePublicReplay({ call: call(admin), keys: keys(f) }).run();
      expect(await ready(f, admin, newer)).toBe(true);
      await admin.query("ROLLBACK");
      expect(await ready(f, admin, newer)).toBe(false);
      await expect(
        admin.query("UPDATE dance_moderated_public_replay_v1 SET frames='[]'::jsonb"),
      ).rejects.toMatchObject({ code: "DRV01" });
    }));
  test("an old current epoch selected by another community prevents the public claim drain", async () =>
    withFixture(async (f, admin) => {
      const other = "other-public-community";
      await admin.query(
        "INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES($1,'Other','active','private-test-owner',clock_timestamp(),clock_timestamp())",
        [other],
      );
      await admin.query(
        "INSERT INTO dance_review_policy_admissions_v1 SELECT $1,policy_id,accepted,accepted_by,effective_at,valid_until FROM dance_review_policy_admissions_v1 WHERE community_id=$2",
        [other, f.facts.communityId],
      );
      await publish(f, admin, "dual-policy");
      await makeModeratedDancePublicReplay({ call: call(admin), keys: keys(f) }).run();
      expect(await drain(admin)).toEqual({ removedClaims: 0, removedPublicIndexes: 0 });
      await expect(publish(f, admin, "unsafe-new-only", [newer])).rejects.toMatchObject({
        code: "DRV07",
      });
      expect(await ready(f, admin, f.facts.profile.replayKeyEpoch)).toBe(true);
    }));
  test("a real late writer waits on epoch retirement and is refused after its receipt commits", async () =>
    withFixture(async (f, admin) => {
      const response = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0))",
          values: [],
        },
        {
          text: "INSERT INTO dance_moderated_replay_claims_v1 VALUES('global-body-v1','unused-epoch','body',repeat('e',64),'reference','late',clock_timestamp()+interval '1 day',clock_timestamp())",
          values: [],
        },
        async () => {
          await admin.query(
            "SELECT retire_moderated_dance_replay_epoch_v1('unused-epoch','isolated-retirement')",
          );
          await admin.query("COMMIT");
        },
      );
      expect("error" in response && response.error).toMatchObject({ code: "DRV05" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_replay_claims_v1 WHERE key_epoch='unused-epoch'",
          )
        ).rows[0]?.n,
      ).toBe(0);
    }));
});
