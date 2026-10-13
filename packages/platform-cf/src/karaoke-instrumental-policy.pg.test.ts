import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import {
  AUTHOR_ID,
  AUTHOR_PERSONA_ID,
  COMMUNITY_ID,
  makeComposedActivityTimes,
  POST_ID,
} from "./activity-participation-composed.pg-fixture.ts";
import { makeKaraokeDriver } from "./activity-participation-composed-drivers.pg-fixture.ts";
import { seedFundedAssetBonus } from "./activity-participation-composed-identity.pg-fixture.ts";
import {
  assertTransitionGuards,
  insertFullMixSession,
  migrationVersion,
  policy1,
  policy2,
  prepareSinger,
  qualificationCounts,
  withPolicyDatabase,
} from "./karaoke-instrumental-policy.pg-fixture.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import {
  bytes32,
  hash,
  seedActivePoolLeg,
  seedMegapotAuthority,
} from "./rewards-composed-pool.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;

suite("Prospective instrumental Karaoke qualification", () => {
  test("guards the registry transition and preserves historical policy, session and funded-leg pins", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    await withPolicyDatabase(connectionString, true, async ({ admin, scoped, runtime }) => {
      const migrations = (await loadPostgresMigrations()).filter(
        ({ version }) => version <= migrationVersion,
      );
      const migration = migrations.find(({ version }) => version === migrationVersion);
      if (!migration) throw new Error("policy migration missing");
      await assertTransitionGuards(admin, migration.sql);
      const account = "policy-history";
      const persona = await prepareSinger(admin, runtime, account);
      const driver = makeKaraokeDriver(
        runtime,
        makeControlPlaneKaraokeRepository(),
        makeComposedActivityTimes(Date.now() - 10000).karaoke,
      );
      const historicalInstrumental = await driver.reserve(account, persona, "old-instrumental");
      expect(historicalInstrumental.qualificationPolicyVersionId).toBe(policy1);
      const historicalFullMix = await insertFullMixSession(
        admin,
        historicalInstrumental,
        "old-full-mix",
      );
      const { legId } = await seedFundedAssetBonus(admin);
      const historySql = `SELECT
        (SELECT to_jsonb(p) FROM qualification_policy_versions p WHERE qualification_policy_version_id=$1) AS policy,
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY session_id) FROM karaoke_sessions s) AS sessions,
        (SELECT to_jsonb(l) FROM song_reward_offer_legs l WHERE leg_id=$2) AS leg`;
      const history = (await admin.query(historySql, [policy1, legId])).rows;
      const applied = await runPostgresMigrations({
        connectionString: scoped,
        migrations,
        expectedLedger: migrations
          .filter(({ version }) => version < migrationVersion)
          .map(({ version, checksum }) => ({ version, checksum })),
      });
      expect(applied).toMatchObject({ dryRun: false, result: { applied: [migrationVersion] } });
      expect((await admin.query(historySql, [policy1, legId])).rows).toEqual(history);
      expect(
        (
          await admin.query(
            "SELECT current_policy_version_id FROM activity_registry WHERE activity_key='karaoke'",
          )
        ).rows,
      ).toEqual([{ current_policy_version_id: policy2 }]);
      expect(
        (
          await admin.query(
            "SELECT policy_document FROM qualification_policy_versions WHERE qualification_policy_version_id=$1",
            [policy2],
          )
        ).rows,
      ).toEqual([
        {
          policy_document: {
            minimum_scored_line_count: 5,
            minimum_coverage_bps: 8500,
            minimum_final_score_bps: 7000,
            eligible_playback_kinds: ["instrumental"],
          },
        },
      ]);
      expect(await runPostgresMigrations({ connectionString: scoped, migrations })).toMatchObject({
        dryRun: false,
        result: { applied: [] },
      });
      for (const sql of [
        "UPDATE qualification_policy_versions SET policy_document=policy_document WHERE qualification_policy_version_id='karaoke_qualification_v2@2'",
        "DELETE FROM qualification_policy_versions WHERE qualification_policy_version_id='karaoke_qualification_v2@1'",
        "UPDATE karaoke_sessions SET qualification_policy_version_id='karaoke_qualification_v2@2' WHERE qualification_policy_version_id='karaoke_qualification_v2@1'",
      ])
        await expect(admin.query(sql)).rejects.toMatchObject({ code: "P0001" });
      const legacyAttempt = await driver.finish(historicalFullMix, "policy-old-full-mix");
      expect(legacyAttempt.rank_eligible).toBe(true);
      expect(await driver.finish(historicalFullMix, "policy-old-full-mix")).toEqual(legacyAttempt);
      await expect(
        driver.finish(historicalInstrumental, "policy-old-instrumental"),
      ).rejects.toMatchObject({ _tag: "KaraokeStoreFailed", reason: "constraint" });
      const admitted = await driver.reserve(account, persona, "new-instrumental");
      expect(admitted).toMatchObject({
        playbackKind: "instrumental",
        qualificationPolicyVersionId: policy2,
      });
      const unsupported = await insertFullMixSession(admin, admitted, "new-full-mix");
      await expect(driver.finish(unsupported, "policy-new-full-mix")).rejects.toMatchObject({
        _tag: "KaraokeStoreFailed",
        reason: "constraint",
      });
      const currentAttempt = await driver.finish(admitted, "policy-new-instrumental");
      expect(currentAttempt.rank_eligible).toBe(true);
      expect(await driver.finish(admitted, "policy-new-instrumental")).toEqual(currentAttempt);
      expect(
        (
          await admin.query(
            "SELECT reward_leg_accepts_qualification($1,'karaoke',$2) AS old, reward_leg_accepts_qualification($1,'karaoke',$3) AS current",
            [legId, policy1, policy2],
          )
        ).rows,
      ).toEqual([{ old: true, current: false }]);
      expect(
        (
          await admin.query(
            "SELECT karaoke_attempt_id,qualification_policy_version_id FROM activity_qualifications ORDER BY qualification_id",
          )
        ).rows,
      ).toEqual([
        { karaoke_attempt_id: admitted.attemptId, qualification_policy_version_id: policy2 },
        {
          karaoke_attempt_id: historicalFullMix.attemptId,
          qualification_policy_version_id: policy1,
        },
      ]);
      expect(
        (await admin.query("SELECT count(*)::integer AS attempts FROM karaoke_attempts")).rows,
      ).toEqual([{ attempts: 2 }]);
    });
  }, 180_000);

  test("refuses missing stems and incompatible vocal alignment before reserving a scored take", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    await withPolicyDatabase(connectionString, false, async ({ admin, runtime }) => {
      const account = "policy-provenance";
      const persona = await prepareSinger(admin, runtime, account);
      const driver = makeKaraokeDriver(
        runtime,
        makeControlPlaneKaraokeRepository(),
        makeComposedActivityTimes(Date.now() - 10000).karaoke,
      );
      const mutate = async (sql: string, values: unknown[] = []) => {
        await admin.query("SET session_replication_role=replica");
        try {
          return await admin.query(sql, values);
        } finally {
          await admin.query("SET session_replication_role=origin");
        }
      };
      let suffix = 0;
      const refuse = async () => {
        await expect(
          driver.reserve(account, persona, `bad-source-${suffix++}`),
        ).rejects.toMatchObject({ _tag: "KaraokeCommandRejected", reason: "not-found" });
        expect(
          (await admin.query("SELECT count(*)::integer AS sessions FROM karaoke_sessions")).rows,
        ).toEqual([{ sessions: 0 }]);
      };
      for (const slot of ["instrumental_audio", "vocal_audio"]) {
        const removed = await mutate("DELETE FROM media_song_stems WHERE slot=$1 RETURNING *", [
          slot,
        ]);
        expect(removed.rows).toHaveLength(1);
        await refuse();
        await mutate(
          "INSERT INTO media_song_stems SELECT (jsonb_populate_record(NULL::media_song_stems,$1::jsonb)).*",
          [JSON.stringify(removed.rows[0])],
        );
      }
      const artifact = (
        await admin.query(
          "SELECT artifact FROM media_timed_lyrics_artifacts WHERE artifact_ref='composed-artifact'",
        )
      ).rows[0]?.artifact;
      for (const patch of [
        { alignment_source_ref: "audio-ref" },
        { alignment_source_sha256: "0".repeat(64) },
      ]) {
        await mutate(
          "UPDATE media_timed_lyrics_artifacts SET artifact=artifact||$1::jsonb WHERE artifact_ref='composed-artifact'",
          [JSON.stringify(patch)],
        );
        await refuse();
        await mutate(
          "UPDATE media_timed_lyrics_artifacts SET artifact=$1::jsonb WHERE artifact_ref='composed-artifact'",
          [JSON.stringify(artifact)],
        );
      }
      await mutate("UPDATE media_alignment_projections SET status='pending'");
      await refuse();
      await mutate("UPDATE media_alignment_projections SET status='ready'");
      const admitted = await driver.reserve(account, persona, "valid-source");
      expect(admitted).toMatchObject({
        playbackKind: "instrumental",
        qualificationPolicyVersionId: policy2,
      });
      expect(await driver.reserve(account, persona, "valid-source")).toEqual(admitted);
      expect(
        (await admin.query("SELECT count(*)::integer AS sessions FROM karaoke_sessions")).rows,
      ).toEqual([{ sessions: 1 }]);
    });
  }, 60_000);

  test("allocates one share only with a matching active leg before cutoff, preserving qualification and retry boundaries", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    await withPolicyDatabase(connectionString, false, async ({ admin, runtime }) => {
      const account = "policy-current";
      const persona = await prepareSinger(admin, runtime, account);
      const now = Date.now() - 10000;
      const times = makeComposedActivityTimes(now);
      const driver = makeKaraokeDriver(runtime, makeControlPlaneKaraokeRepository(), times.karaoke);
      const missing = await driver.reserve(account, persona, "missing-offer");
      await driver.finish(missing, "policy-missing-offer");
      expect(await qualificationCounts(admin, account)).toEqual({ qualifications: 1, shares: 0 });
      await seedMegapotAuthority(admin);
      const { legId, offerId } = await seedActivePoolLeg(
        admin,
        {
          accountId: AUTHOR_ID,
          personaId: AUTHOR_PERSONA_ID,
          communityId: COMMUNITY_ID,
          postId: POST_ID,
        },
        { fallback: false, suffix: "policy-current" },
      );
      const opened = await Effect.runPromise(
        makeControlPlaneMegapotDrawingObservationStore(runtime).recordAndOpen({
          observationId: "policy-drawing",
          attestationId: "megapot-base-sepolia-v2",
          chainId: 84532,
          drawingId: 101n,
          grossPrizePoolAtomic: 1001n,
          globalTicketsBought: 1n,
          ticketPriceAtomic: 10000n,
          drawingTime: new Date(now + 600000).toISOString(),
          ballMax: 25,
          bonusballMax: 13,
          drawingLocked: false,
          referralFeeWei: 100000000000000000n,
          referralWinShareWei: 100000000000000000n,
          blockNumber: 1000n,
          blockHash: bytes32("a"),
          blockTimestamp: new Date(now - 1000).toISOString(),
          confirmations: 3,
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 3600000).toISOString(),
          rawStateHash: hash("a"),
          legacyRawStateHash: hash("b"),
        }),
      );
      expect(opened.openedPoolLegIds).toEqual([legId]);
      expect(
        (
          await admin.query(
            "SELECT qualification_policies FROM song_reward_offer_legs WHERE leg_id=$1",
            [legId],
          )
        ).rows[0]?.qualification_policies,
      ).toMatchObject([
        { activity: "karaoke", policy: { qualification_policy_version_id: policy2 } },
        {
          activity: "study",
          policy: { qualification_policy_version_id: "study_session_first_pass_v2@1" },
        },
      ]);
      const authority = await driver.reserve(account, persona, "eligible-instrumental");
      const attempt = await driver.finish(authority, "policy-eligible");
      expect(attempt.rank_eligible).toBe(true);
      expect(await driver.finish(authority, "policy-eligible")).toEqual(attempt);
      expect(await qualificationCounts(admin, account)).toEqual({ qualifications: 2, shares: 1 });
      expect(
        (
          await admin.query(
            "SELECT qualification_id FROM megapot_pool_shares WHERE account_id=$1",
            [account],
          )
        ).rows,
      ).toEqual([{ qualification_id: "policy-eligible" }]);
      await driver.finish(
        await driver.reserve(account, persona, "second-eligible"),
        "policy-second-eligible",
      );
      expect(await qualificationCounts(admin, account)).toEqual({ qualifications: 3, shares: 1 });
      const inactiveAccount = "policy-inactive";
      const inactivePersona = await prepareSinger(admin, runtime, inactiveAccount);
      await admin.query(
        "UPDATE song_reward_offers SET status='paused',updated_at=clock_timestamp() WHERE offer_id=$1",
        [offerId],
      );
      await driver.finish(
        await driver.reserve(inactiveAccount, inactivePersona, "inactive-offer"),
        "policy-inactive-offer",
      );
      expect(await qualificationCounts(admin, inactiveAccount)).toEqual({
        qualifications: 1,
        shares: 0,
      });
      await admin.query(
        "UPDATE song_reward_offers SET status='active',updated_at=clock_timestamp() WHERE offer_id=$1",
        [offerId],
      );
      const cutoffAccount = "policy-cutoff";
      const cutoffPersona = await prepareSinger(admin, runtime, cutoffAccount);
      const atCutoff = makeKaraokeDriver(runtime, makeControlPlaneKaraokeRepository(), {
        ...times.karaoke,
        completedAt: times.cutoffAt,
      });
      expect(
        (
          await admin.query(
            "SELECT entry_cutoff_at FROM megapot_pool_drawings WHERE pool_leg_id=$1",
            [legId],
          )
        ).rows[0]?.entry_cutoff_at.toISOString(),
      ).toBe(times.cutoffAt);
      const cutoffAuthority = await atCutoff.reserve(cutoffAccount, cutoffPersona, "cutoff");
      const cutoffAttempt = await atCutoff.finish(cutoffAuthority, "policy-cutoff");
      expect(cutoffAttempt.rank_eligible).toBe(true);
      expect(await atCutoff.finish(cutoffAuthority, "policy-cutoff")).toEqual(cutoffAttempt);
      expect(await qualificationCounts(admin, cutoffAccount)).toEqual({
        qualifications: 1,
        shares: 0,
      });
    });
  }, 90_000);
});
