/**
 * Composed never-joined acceptance regressions for the accepted happy-path
 * candidate (API 2133c423). Local integration proofs only: wallet attestations
 * and speech grades are deterministic fixtures, not live Privy, provider or
 * funding evidence. The suite composes explicit activity-persona preparation,
 * the ordinary wallet confirmation, Study v2 and Karaoke completion, and the
 * independent monetary admission guards on one fixture song with accepted
 * lyrics, exercises and a ready timed-lyrics alignment. The M1 instrumental
 * song cannot satisfy these checks.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  makeKaraokeDriver,
  makeStudyDriver,
} from "./activity-participation-composed-drivers.pg-fixture.ts";
import {
  confirmWallet,
  prepareIdentity,
  seedFundedAssetBonus,
  seedVeryRewardEvidence,
} from "./activity-participation-composed-identity.pg-fixture.ts";
import { seedActivitySong } from "./activity-participation-composed-song.pg-fixture.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const COMMUNITY_ID = "composed-community";
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};
const sideEffectCounts = async (admin: Client, accountId: string) => {
  const result = await admin.query(
    `SELECT
       (SELECT count(*)::integer FROM community_memberships WHERE user_id=$1) AS memberships,
       (SELECT count(*)::integer FROM community_follows WHERE user_id=$1) AS follows,
       (SELECT count(*)::integer FROM posts WHERE author_user_id=$1) AS posts,
       (SELECT count(*)::integer FROM data_registration_operations
         WHERE actor_user_id=$1) AS data_operations,
       (SELECT count(*)::integer FROM persona_activity_preparation_actions
         WHERE account_id=$1) AS preparation_actions,
       active_community_effect($1,$2) AS posting_authority`,
    [accountId, COMMUNITY_ID],
  );
  return result.rows[0] as Readonly<{
    memberships: number;
    follows: number;
    posts: number;
    data_operations: number;
    preparation_actions: number;
    posting_authority: boolean;
  }>;
};

suite("Composed never-joined activity and reward acceptance", () => {
  test("prepares, activates and completes Study with independent monetary admission and no replay duplication", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_composed_study_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query(
        "INSERT INTO users (user_id) VALUES ('composed-unverified'),('composed-eligible')",
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await seedActivitySong(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const { offerId } = await seedFundedAssetBonus(admin);
      await seedVeryRewardEvidence(admin, "composed-eligible", "eligible");

      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const study = makeControlPlaneStudyV2Repository();
      const prepare = prepareIdentity(runtime);
      const confirm = confirmWallet(runtime);
      const driver = makeStudyDriver(runtime, study);

      const unverified = await prepare("composed-unverified", "unverified-prepare");
      expect(unverified).toMatchObject({ persona_status: "pending_wallet" });
      const pendingState = await admin.query(
        `SELECT persona.status, assignment.status AS wallet_status,
                binding.binding_source,
                (SELECT count(*)::integer FROM persona_pending_profiles draft
                  WHERE draft.persona_id=persona.persona_id) AS profile_drafts
           FROM personas AS persona
           JOIN persona_wallet_assignments AS assignment
             ON assignment.persona_id=persona.persona_id
           JOIN persona_community_bindings AS binding
             ON binding.persona_id=persona.persona_id
          WHERE persona.persona_id=$1`,
        [unverified.persona_id],
      );
      expect(pendingState.rows).toEqual([
        {
          status: "pending_wallet",
          wallet_status: "pending",
          binding_source: "activity_participation",
          profile_drafts: 1,
        },
      ]);
      // A pending persona cannot start before the ordinary confirmation.
      await expect(
        driver.startSession("composed-unverified", unverified.persona_id, "pending-attempt"),
      ).rejects.toMatchObject({ _tag: "StudyV2CommandRejected", reason: "not-found" });

      const reservedIndex = await admin.query<{ readonly hd_wallet_index: string }>(
        "SELECT hd_wallet_index::text FROM persona_wallet_assignments WHERE persona_id=$1 AND status='pending'",
        [unverified.persona_id],
      );
      const confirmed = await confirm("composed-unverified", unverified.persona_id);
      expect(confirmed.hd_wallet_index).toBe(Number(reservedIndex.rows[0]?.hd_wallet_index));
      expect(confirmed.address).toMatch(/^0x[0-9a-f]{40}$/u);
      expect(
        (
          await admin.query(
            `SELECT persona.status,
                    (SELECT count(*)::integer FROM persona_profiles profile
                      WHERE profile.persona_id=persona.persona_id) AS profiles,
                    (SELECT count(*)::integer FROM persona_pending_profiles draft
                      WHERE draft.persona_id=persona.persona_id) AS profile_drafts
               FROM personas AS persona WHERE persona.persona_id=$1`,
            [unverified.persona_id],
          )
        ).rows,
      ).toEqual([{ status: "active", profiles: 1, profile_drafts: 0 }]);

      const eligible = await prepare("composed-eligible", "eligible-prepare");
      expect(eligible.persona_status).toBe("pending_wallet");
      await confirm("composed-eligible", eligible.persona_id);

      const unverifiedRun = await driver.completeSession(
        "composed-unverified",
        unverified.persona_id,
        "unverified",
      );
      expect(unverifiedRun.final.result.session).toMatchObject({
        status: "completed",
        lesson: { completion_reason: "all_resolved" },
      });

      const unverifiedMoney = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id=$1) AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id=$1) AS credits,
           (SELECT count(*)::integer FROM megapot_pool_shares
             WHERE account_id=$1) AS shares,
           (SELECT outcome FROM reward_eligibility_decisions
             WHERE leg_id=(SELECT leg_id FROM song_reward_offer_legs
                            WHERE offer_id=$2)
               AND account_id=$1) AS outcome,
           (SELECT reason FROM reward_eligibility_decisions
             WHERE leg_id=(SELECT leg_id FROM song_reward_offer_legs
                            WHERE offer_id=$2)
               AND account_id=$1) AS reason`,
        ["composed-unverified", offerId],
      );
      expect(unverifiedMoney.rows).toEqual([
        {
          qualifications: 1,
          credits: 0,
          shares: 0,
          outcome: "ineligible",
          reason: "verification_missing",
        },
      ]);

      const eligibleRun = await driver.completeSession(
        "composed-eligible",
        eligible.persona_id,
        "eligible",
      );
      expect(eligibleRun.final.result.session).toMatchObject({
        status: "completed",
        lesson: { completion_reason: "all_resolved" },
      });
      const allocated = await admin.query(
        `SELECT account_id, amount_atomic::text AS amount, state
           FROM reward_ledger_credits ORDER BY account_id`,
      );
      expect(allocated.rows).toEqual([
        { account_id: "composed-eligible", amount: "100", state: "credited" },
      ]);

      // An exact replay of the final completion command keeps one qualification
      // and one allocation.
      const replayed = await driver.replaySpokenCommand(eligibleRun.final.command);
      expect(replayed.session.status).toBe("completed");
      const afterReplay = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-eligible') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-eligible') AS credits`,
      );
      expect(afterReplay.rows).toEqual([{ qualifications: 1, credits: 1 }]);

      // A second qualifying completion by the same account inserts a second
      // qualification but cannot allocate the funded leg twice.
      const second = await driver.completeSession(
        "composed-eligible",
        eligible.persona_id,
        "eligible-second",
      );
      expect(second.final.result.session).toMatchObject({ status: "completed" });
      const afterSecond = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-eligible') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-eligible') AS credits,
           (SELECT count(*)::integer FROM song_reward_bundle_claims
             WHERE account_id='composed-eligible') AS claims`,
      );
      expect(afterSecond.rows).toEqual([{ qualifications: 2, credits: 1, claims: 1 }]);

      for (const accountId of ["composed-unverified", "composed-eligible"]) {
        expect(await sideEffectCounts(admin, accountId)).toEqual({
          memberships: 0,
          follows: 0,
          posts: 0,
          data_operations: 0,
          preparation_actions: 1,
          posting_authority: false,
        });
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 120_000);

  test("completes Karaoke with a qualifying score and allocates one funded credit across a finalization replay", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_composed_karaoke_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query(
        "INSERT INTO users (user_id) VALUES ('composed-karaoke-unverified'),('composed-karaoke-eligible')",
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await seedActivitySong(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await seedFundedAssetBonus(admin);
      await seedVeryRewardEvidence(admin, "composed-karaoke-eligible", "karaoke-eligible");

      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const repository = makeControlPlaneKaraokeRepository();
      const prepare = prepareIdentity(runtime);
      const confirm = confirmWallet(runtime);
      const driver = makeKaraokeDriver(runtime, repository);

      const unverified = await prepare("composed-karaoke-unverified", "karaoke-unverified-prepare");
      const eligible = await prepare("composed-karaoke-eligible", "karaoke-eligible-prepare");
      expect(unverified.persona_status).toBe("pending_wallet");
      expect(eligible.persona_status).toBe("pending_wallet");

      // A pending persona cannot reserve a scored take.
      await expect(
        driver.reserve("composed-karaoke-unverified", unverified.persona_id, "pending-reserve"),
      ).rejects.toMatchObject({ _tag: "KaraokeCommandRejected", reason: "invalid-input" });

      await confirm("composed-karaoke-unverified", unverified.persona_id);
      await confirm("composed-karaoke-eligible", eligible.persona_id);

      const eligibleAuthority = await driver.reserve(
        "composed-karaoke-eligible",
        eligible.persona_id,
        "eligible",
      );
      const eligibleAttempt = await driver.finish(
        eligibleAuthority,
        "composed-karaoke-qualification",
      );
      expect(eligibleAttempt).toMatchObject({
        completion_reason: "completed",
        rank_eligible: true,
        scored_line_count: 5,
      });
      expect(eligibleAttempt.final_score).toBeGreaterThanOrEqual(7000);
      const eligibleReplay = await driver.finish(
        eligibleAuthority,
        "composed-karaoke-qualification",
      );
      expect(eligibleReplay).toEqual(eligibleAttempt);

      const karaokeAllocation = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-karaoke-eligible'
               AND activity_key='karaoke') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-karaoke-eligible') AS credits,
           (SELECT count(*)::integer FROM reward_ledger_credits) AS credits_total`,
      );
      expect(karaokeAllocation.rows).toEqual([{ qualifications: 1, credits: 1, credits_total: 1 }]);

      const unverifiedAuthority = await driver.reserve(
        "composed-karaoke-unverified",
        unverified.persona_id,
        "unverified",
      );
      const unverifiedAttempt = await driver.finish(
        unverifiedAuthority,
        "composed-karaoke-unverified-qualification",
      );
      expect(unverifiedAttempt).toMatchObject({ completion_reason: "completed" });
      const unverifiedKaraoke = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-karaoke-unverified') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-karaoke-unverified') AS credits,
           (SELECT count(*)::integer FROM reward_ledger_credits) AS credits_total,
           (SELECT outcome FROM reward_eligibility_decisions
             WHERE account_id='composed-karaoke-unverified') AS outcome,
           (SELECT reason FROM reward_eligibility_decisions
             WHERE account_id='composed-karaoke-unverified') AS reason`,
      );
      expect(unverifiedKaraoke.rows).toEqual([
        {
          qualifications: 1,
          credits: 0,
          credits_total: 1,
          outcome: "ineligible",
          reason: "verification_missing",
        },
      ]);

      for (const accountId of ["composed-karaoke-unverified", "composed-karaoke-eligible"]) {
        expect(await sideEffectCounts(admin, accountId)).toEqual({
          memberships: 0,
          follows: 0,
          posts: 0,
          data_operations: 0,
          preparation_actions: 1,
          posting_authority: false,
        });
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 120_000);
});
