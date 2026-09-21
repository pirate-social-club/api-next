/**
 * PostgreSQL repository/coordinator proof, not browser/provider/chain E2E.
 * SQL seeds source, verification and prerequisite authority/policy/funded-leg fixtures.
 * Grading, wallet attestations and prevalidated simulated store-boundary chain facts are deterministic.
 * Production repositories create qualifications/shares, freeze beneficiaries,
 * persist the simulated win and pay all three resulting credits.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  goldenContentSql,
  goldenIdentitySql,
  observeGoldenDrawing,
} from "../../../scripts/megapot-golden-readonly.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  AUTHOR_ID,
  AUTHOR_PERSONA_ID,
  addressFor,
  COMMUNITY_ID,
  digest,
  makeComposedActivityTimes,
  POST_ID,
} from "./activity-participation-composed.pg-fixture.ts";
import {
  makeKaraokeDriver,
  makeStudyDriver,
} from "./activity-participation-composed-drivers.pg-fixture.ts";
import {
  confirmWallet,
  prepareIdentity,
  seedVeryRewardEvidence,
} from "./activity-participation-composed-identity.pg-fixture.ts";
import { seedActivitySong } from "./activity-participation-composed-song.pg-fixture.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import { makeMegapotCommitmentCoordinator } from "./megapot-commitment-coordinator.ts";
import { makeControlPlaneMegapotCommitmentStore } from "./megapot-commitment-repository.ts";
import { makeMegapotCutoffCoordinator } from "./megapot-cutoff-coordinator.ts";
import { makeControlPlaneMegapotCutoffStore } from "./megapot-cutoff-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { completeComposedWinningChain } from "./rewards-composed-chain.pg-fixture.ts";
import {
  bytes32,
  hash,
  seedActivePoolLeg,
  seedMegapotAuthority,
} from "./rewards-composed-pool.pg-fixture.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

suite("Composed current-policy Megapot settlement", () => {
  test("admits Study and Karaoke once per account and pays a simulated win to three frozen beneficiaries", async () => {
    if (!connectionString) throw new Error("test URL was not configured");
    const schema = `rewards_composed_win_${Date.now()}`;
    const scoped = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      try {
        await seedActivitySong(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(
        admin,
        {
          accountId: AUTHOR_ID,
          personaId: AUTHOR_PERSONA_ID,
          communityId: COMMUNITY_ID,
          postId: POST_ID,
        },
        { fallback: false, suffix: "composed-winning" },
      );
      const policyRows = await admin.query(
        `SELECT qualification_policies,
                qualification_policies=reward_current_qualification_policies(eligible_activities) AS current
           FROM song_reward_offer_legs WHERE leg_id=$1`,
        [legId],
      );
      expect(policyRows.rows[0]?.current).toBe(true);
      expect(policyRows.rows[0]?.qualification_policies).toHaveLength(2);
      expect(policyRows.rows[0]?.qualification_policies).toMatchObject([
        {
          activity: "karaoke",
          policy: { qualification_policy_version_id: "karaoke_qualification_v2@1" },
        },
        {
          activity: "study",
          policy: { qualification_policy_version_id: "study_session_first_pass_v2@1" },
        },
      ]);

      const layer = makeDirectPostgresControlPlaneLayer(scoped);
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
      const people = ["study", "karaoke", "both", "unverified", "below", "late"] as const;
      const personas = new Map<string, string>();
      for (const person of people) {
        const account = `winner-${person}`;
        await admin.query("INSERT INTO users (user_id) VALUES ($1)", [account]);
        const prepared = await prepareIdentity(layer)(account, `prepare-${person}`);
        await confirmWallet(layer)(account, prepared.persona_id);
        personas.set(person, prepared.persona_id);
        if (person !== "unverified") {
          await seedVeryRewardEvidence(admin, account, person, await digest(`subject-${person}`));
        }
      }
      const persona = (person: string) => {
        const value = personas.get(person);
        if (!value) throw new Error("missing fixture persona");
        return value;
      };
      // Activity timestamps must not pin the account streak clock in the future.
      const now = Date.now() - 10000;
      const times = makeComposedActivityTimes(now);
      const observations = makeControlPlaneMegapotDrawingObservationStore(layer);
      const opened = await run(
        observations.recordAndOpen({
          observationId: "composed-drawing",
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
      const drawing = await admin.query(
        "SELECT entry_cutoff_at FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=101",
        [legId],
      );
      expect(drawing.rows[0]?.entry_cutoff_at.toISOString()).toBe(times.cutoffAt);
      const study = makeStudyDriver(layer, makeControlPlaneStudyV2Repository(), times.study);
      const karaoke = makeKaraokeDriver(layer, makeControlPlaneKaraokeRepository(), times.karaoke);
      const first = await study.completeSession("winner-study", persona("study"), "winner-study");
      expect(await study.replaySpokenCommand(first.final.command)).toEqual(first.final.result);
      await study.completeSession("winner-both", persona("both"), "winner-both");
      for (const person of ["karaoke", "both", "unverified"]) {
        const authority = await karaoke.reserve(
          `winner-${person}`,
          persona(person),
          `winner-${person}`,
        );
        const result = await karaoke.finish(authority, `winner-qualification-${person}`);
        expect(result).toMatchObject({ completion_reason: "completed", scored_line_count: 5 });
        expect(result.final_score).toBeGreaterThanOrEqual(7000);
        expect(await karaoke.finish(authority, `winner-qualification-${person}`)).toEqual(result);
      }
      // Resolve all four cards, but only two on the first attempt: completion
      // is real and successful, while the qualifying threshold is not met.
      const below = await study.startSession("winner-below", persona("below"), "winner-below");
      for (let index = 0; index < 4; index++) {
        const item = below.items[index];
        if (!item) throw new Error("missing study item");
        await study.answerSpoken({
          accountId: "winner-below",
          sessionId: below.session_id,
          sessionItemId: item.session_item_id,
          attemptNumber: 1,
          correct: index >= 2,
          commandId: `below-first-${index}`,
        });
      }
      for (let index = 0; index < 2; index++) {
        const item = below.items[index];
        if (!item) throw new Error("missing study item");
        await study.answerSpoken({
          accountId: "winner-below",
          sessionId: below.session_id,
          sessionItemId: item.session_item_id,
          attemptNumber: 2,
          correct: true,
          commandId: `below-retry-${index}`,
        });
      }
      const shares = await admin.query(
        `SELECT share.account_id, q.activity_key, q.score_bps, q.qualification_policy_version_id,
                reward_leg_accepts_qualification(share.pool_leg_id,q.activity_key,q.qualification_policy_version_id) AS bound
           FROM megapot_pool_shares share JOIN activity_qualifications q USING (qualification_id)
          WHERE share.pool_leg_id=$1 ORDER BY share.account_id`,
        [legId],
      );
      expect(shares.rows.map((row) => row.account_id)).toEqual([
        "winner-both",
        "winner-karaoke",
        "winner-study",
      ]);
      expect(shares.rows.every((row) => row.bound && row.score_bps >= 7000)).toBe(true);
      expect(shares.rows.map((row) => row.qualification_policy_version_id)).toEqual([
        "study_session_first_pass_v2@1",
        "karaoke_qualification_v2@1",
        "study_session_first_pass_v2@1",
      ]);
      expect(shares.rows.map((row) => row.activity_key).sort()).toEqual([
        "karaoke",
        "study",
        "study",
      ]);
      expect(
        (
          await admin.query(
            "SELECT outcome,reason FROM reward_eligibility_decisions WHERE account_id='winner-unverified' AND leg_id=$1",
            [legId],
          )
        ).rows,
      ).toEqual([{ outcome: "ineligible", reason: "verification_missing" }]);
      expect(
        (
          await admin.query("SELECT status FROM study_sessions_v2 WHERE session_id=$1", [
            below.session_id,
          ])
        ).rows,
      ).toEqual([{ status: "completed" }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM activity_qualifications WHERE account_id='winner-below'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM activity_qualifications WHERE account_id='winner-both'",
          )
        ).rows,
      ).toEqual([{ count: 2 }]);

      const freezeAt = Date.parse(times.cutoffAt) + 1;
      const cutoff = makeMegapotCutoffCoordinator({
        store: makeControlPlaneMegapotCutoffStore(layer),
        now: () => freezeAt,
        externalSponsorDailyTicketCeiling: 10,
        externalSponsorDailySpendCeilingAtomic: 1000000n,
        sharedSponsorDailyTicketCeiling: 10,
        sharedSponsorDailySpendCeilingAtomic: 1000000n,
      });
      const frozen = await run(cutoff.freezeDue());
      expect(frozen).toHaveLength(1);
      expect(frozen[0]).toMatchObject({
        status: "cutoff_frozen",
        frozenShareCount: 3,
        fallback: false,
      });
      expect(await run(cutoff.freezeDue())).toEqual([]);
      const leaves = await admin.query(
        `SELECT ordinal,account_id,persona_id,leaf_commitment FROM megapot_pool_snapshot_private_leaves
          WHERE snapshot_id=$1 ORDER BY ordinal`,
        [frozen[0]?.snapshotId],
      );
      expect(leaves.rows).toHaveLength(3);
      expect(leaves.rows.map((row) => row.account_id).sort()).toEqual([
        "winner-both",
        "winner-karaoke",
        "winner-study",
      ]);
      // A subsequent qualifying attempt cannot enter an already frozen set.
      await study.completeSession("winner-late", persona("late"), "winner-late");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM activity_qualifications WHERE account_id='winner-late'",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM megapot_pool_shares WHERE pool_leg_id=$1",
            [legId],
          )
        ).rows,
      ).toEqual([{ count: 3 }]);
      expect(
        (
          await admin.query(
            "SELECT ordinal,account_id,persona_id,leaf_commitment FROM megapot_pool_snapshot_private_leaves WHERE snapshot_id=$1 ORDER BY ordinal",
            [frozen[0]?.snapshotId],
          )
        ).rows,
      ).toEqual(leaves.rows);
      const commitment = makeMegapotCommitmentCoordinator({
        store: makeControlPlaneMegapotCommitmentStore(layer),
        now: () => freezeAt + 1000,
        signer: {
          sign: async () => ({ signingKeyId: "fixture-key", signature: "fixture-signature" }),
        },
        publisher: {
          publish: async () => ({
            publicReference: "urn:test:composed-commitment",
            publishedAt: new Date(freezeAt + 2000).toISOString(),
          }),
        },
      });
      const committed = await run(commitment.commit({ poolLegId: legId, drawingId: 101n }));
      expect(await run(commitment.commit({ poolLegId: legId, drawingId: 101n }))).toEqual(
        committed,
      );
      const chain = await completeComposedWinningChain({
        scopedConnection: scoped,
        poolLegId: legId,
        drawingId: 101n,
        settlementAtMs: freezeAt + 3000,
      });
      const paid = await admin.query(
        `SELECT a.ordinal,a.account_id,a.persona_id,a.amount_atomic::text,
                c.state,c.paid_atomic::text,e.state AS effect_state,
                r.amount_atomic::text AS receipt_amount,r.recipient_address AS destination_address,
                p.destination_address AS frozen_destination
           FROM megapot_allocations a JOIN reward_ledger_credits c USING (credit_id)
           JOIN reward_payout_effects p USING (credit_id)
           JOIN reward_chain_effects e ON e.effect_id=p.payout_effect_id
           JOIN reward_erc20_transfer_receipt_evidence r ON r.effect_id=e.effect_id
          WHERE a.allocation_batch_id=$1 ORDER BY a.ordinal`,
        [chain.allocation.allocationBatchId],
      );
      expect(paid.rows).toHaveLength(3);
      expect(paid.rows.map((row) => row.account_id)).toEqual(
        leaves.rows.map((row) => row.account_id),
      );
      expect(paid.rows.map((row) => row.amount_atomic)).toEqual(["301", "300", "300"]);
      for (const row of paid.rows) {
        expect(row.frozen_destination).toBe(
          await addressFor(`${row.account_id}:${row.persona_id}`),
        );
        expect(row).toMatchObject({
          state: "sent",
          effect_state: "confirmed",
          paid_atomic: row.amount_atomic,
          receipt_amount: row.amount_atomic,
          destination_address: row.frozen_destination,
        });
      }
      expect(
        (
          await admin.query(
            `SELECT funded_atomic::text,reserved_atomic::text,spent_atomic::text,refunded_atomic::text
           FROM song_reward_offer_legs WHERE leg_id=$1`,
            [legId],
          )
        ).rows,
      ).toEqual([
        {
          funded_atomic: "100000",
          reserved_atomic: "0",
          spent_atomic: "10000",
          refunded_atomic: "0",
        },
      ]);
      expect(
        (
          await admin.query(
            `SELECT gross_winnings_atomic::text,referral_accrual_atomic::text,net_winnings_atomic::text
           FROM megapot_claim_receipt_evidence WHERE claim_effect_id=$1`,
            [chain.claimEffectId],
          )
        ).rows,
      ).toEqual([
        {
          gross_winnings_atomic: "1001",
          referral_accrual_atomic: "100",
          net_winnings_atomic: "901",
        },
      ]);
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS count,sum(paid_atomic)::text AS paid,sum(reserved_atomic)::text AS reserved
           FROM reward_ledger_credits`,
          )
        ).rows,
      ).toEqual([{ count: 3, paid: "901", reserved: "0" }]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM reward_chain_effects")).rows,
      ).toEqual([{ count: 5 }]);
      expect(chain.custodyBalance).toBe(100000n - 10000n + 901n - 901n);
      const observed = await observeGoldenDrawing(admin, legId, "101");
      expect(observed.shares).toHaveLength(3);
      expect(observed.beneficiaries).toHaveLength(3);
      expect(observed.credits.map((credit) => credit.amount_atomic)).toEqual(["301", "300", "300"]);
      expect(observed.credits.every((credit) => credit.receipt_confirmed)).toBe(true);
      expect(observed.unresolved_effect_count).toBe(0);
      expect(observed.refunded_atomic).toBe("0");
      expect(observed.qualifications.filter((q) => q.account_id === "winner-both")).toHaveLength(2);
      const witness = await admin.query(goldenIdentitySql, ["winner-study", personas.get("study")]);
      expect(witness.rows).toHaveLength(1);
      expect(witness.rows[0]?.evidence).toHaveLength(1);
      const content = await admin.query(goldenContentSql, [COMMUNITY_ID, POST_ID]);
      expect(content.rows).toHaveLength(1);
      expect(content.rows[0]?.study_exercise_count).toBeGreaterThanOrEqual(4);
      // Remaining 90,000 atoms are sponsor funds, not an unexplained delta.
      // Offer expiry/refund and live receipt decoding are separate coverage.
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 120000);
});
