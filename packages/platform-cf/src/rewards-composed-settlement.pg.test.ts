/**
 * PostgreSQL repository/coordinator proof, not browser/provider/chain E2E.
 * SQL seeds source, verification and prerequisite authority/policy/funded-leg fixtures.
 * Grading, wallet attestations and prevalidated simulated store-boundary chain facts are deterministic.
 * Production repositories create qualifications/shares, freeze beneficiaries,
 * persist the simulated win and pay only the three credits whose claims were accepted.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { onePalmRehearsalInput } from "../../../scripts/megapot-golden-multi.fixture.ts";
import {
  goldenContentSql,
  goldenDrawingRecoverySql,
  goldenIdentitySql,
  observeGoldenDrawing,
} from "../../../scripts/megapot-golden-readonly.ts";
import {
  assertGoldenAdmission,
  goldenAdmissionProgress,
} from "../../../scripts/megapot-golden-reconciliation.ts";
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
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
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
  test("admits Study and Karaoke once per account and pays a simulated win only to claimed credits of six frozen beneficiaries", async () => {
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
      const people = [
        "study",
        "karaoke",
        "both",
        "unverified",
        "expired",
        "failed",
        "below",
        "late",
      ] as const;
      const personas = new Map<string, string>();
      for (const person of people) {
        const account = `winner-${person}`;
        await admin.query("INSERT INTO users (user_id) VALUES ($1)", [account]);
        const prepared = await prepareIdentity(layer)(account, `prepare-${person}`);
        await confirmWallet(layer)(account, prepared.persona_id);
        personas.set(person, prepared.persona_id);
        if (person !== "unverified") {
          await seedVeryRewardEvidence(
            admin,
            account,
            person,
            await digest(`subject-${person}`),
            person === "expired" ? "expired" : "current",
          );
        }
        if (person === "failed") {
          // Two independently valid subjects are ambiguous, never two reward identities.
          await seedVeryRewardEvidence(
            admin,
            account,
            "failed-second",
            await digest("subject-failed-second"),
          );
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
      for (const person of ["karaoke", "both", "unverified", "expired", "failed"]) {
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
      // Spec 015 §5.2a: entry needs no Very evidence, so unverified, stale and
      // ambiguous-evidence accounts hold shares beside the verified ones.
      expect(shares.rows.map((row) => row.account_id)).toEqual([
        "winner-both",
        "winner-expired",
        "winner-failed",
        "winner-karaoke",
        "winner-study",
        "winner-unverified",
      ]);
      expect(shares.rows.every((row) => row.bound && row.score_bps >= 7000)).toBe(true);
      expect(
        shares.rows.map((row) => [
          row.account_id,
          row.activity_key,
          row.qualification_policy_version_id,
        ]),
      ).toEqual([
        ["winner-both", "study", "study_session_first_pass_v2@1"],
        ["winner-expired", "karaoke", "karaoke_qualification_v2@1"],
        ["winner-failed", "karaoke", "karaoke_qualification_v2@1"],
        ["winner-karaoke", "karaoke", "karaoke_qualification_v2@1"],
        ["winner-study", "study", "study_session_first_pass_v2@1"],
        ["winner-unverified", "karaoke", "karaoke_qualification_v2@1"],
      ]);
      expect(
        (
          await admin.query(
            `SELECT e.account_id,e.outcome,e.reason,d.outcome AS decision_outcome
               FROM reward_eligibility_decisions e JOIN decision_records d USING (decision_record_id)
              WHERE e.account_id IN ('winner-unverified','winner-expired','winner-failed')
                AND e.leg_id=$1 ORDER BY e.account_id`,
            [legId],
          )
        ).rows,
      ).toEqual(
        ["winner-expired", "winner-failed", "winner-unverified"].map((account_id) => ({
          account_id,
          outcome: "eligible",
          reason: null,
          decision_outcome: "pass",
        })),
      );
      for (const account of ["winner-expired", "winner-failed", "winner-unverified"]) {
        const counts = await admin.query(
          `SELECT
             (SELECT count(*)::int FROM activity_qualifications WHERE account_id=$1) AS qualifications,
             (SELECT count(*)::int FROM megapot_pool_shares WHERE account_id=$1) AS shares,
             (SELECT count(*)::int FROM reward_subject_consumptions WHERE user_id=$1) AS consumptions`,
          [account],
        );
        expect(counts.rows).toEqual([{ qualifications: 1, shares: 1, consumptions: 0 }]);
      }
      expect(
        (
          await admin.query(
            `SELECT
               (SELECT count(*)::int FROM evidence_receipts
                 WHERE user_id='winner-expired' AND expires_at < clock_timestamp()) AS receipts,
               (SELECT count(*)::int FROM assertions
                 WHERE user_id='winner-expired' AND expires_at < clock_timestamp()) AS assertions,
               (SELECT count(*)::int FROM proof_sessions
                 WHERE actor_id='winner-expired' AND status='completed'
                   AND completed_at < expires_at) AS completed_sessions,
               (SELECT count(*)::int FROM assertion_revalidation_events
                 WHERE user_id='winner-expired') AS revalidations`,
          )
        ).rows,
      ).toEqual([{ receipts: 1, assertions: 2, completed_sessions: 1, revalidations: 0 }]);
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
        frozenShareCount: 6,
        fallback: false,
      });
      expect(await run(cutoff.freezeDue())).toEqual([]);
      const leaves = await admin.query(
        `SELECT ordinal,account_id,persona_id,leaf_commitment FROM megapot_pool_snapshot_private_leaves
          WHERE snapshot_id=$1 ORDER BY ordinal`,
        [frozen[0]?.snapshotId],
      );
      expect(leaves.rows).toHaveLength(6);
      expect(leaves.rows.map((row) => row.account_id).sort()).toEqual(
        shares.rows.map((row) => row.account_id),
      );
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
      ).toEqual([{ count: 6 }]);
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
      // Net 901 over six frozen beneficiaries: ordinal 0 takes the remainder.
      const amountFor = (ordinal: number) => (ordinal === 0 ? "151" : "150");
      const claimOutcomes = new Map<string, string>();
      const claimFor = async (creditId: string, accountId: string) => {
        const result = await admin.query(
          "SELECT outcome, claim_status FROM accept_megapot_participant_claim_v1($1,$2)",
          [creditId, accountId],
        );
        return result.rows[0] as { outcome: string; claim_status: string | null };
      };
      const chain = await completeComposedWinningChain({
        scopedConnection: scoped,
        poolLegId: legId,
        drawingId: 101n,
        settlementAtMs: freezeAt + 3000,
        expectedAllocationsAtomic: [151n, 150n, 150n, 150n, 150n, 150n],
        claim: async ({ creditId, accountId }) => {
          const claimed = await claimFor(creditId, accountId);
          claimOutcomes.set(accountId, claimed.outcome);
          if (claimed.outcome === "accepted") {
            // A repeated claim returns the same claim and consumes nothing new.
            expect(await claimFor(creditId, accountId)).toEqual(claimed);
          }
          return claimed.outcome === "accepted";
        },
      });
      expect(Object.fromEntries(claimOutcomes)).toEqual({
        "winner-both": "accepted",
        "winner-expired": "verification_stale",
        "winner-failed": "verification_failed",
        "winner-karaoke": "accepted",
        "winner-study": "accepted",
        "winner-unverified": "verification_missing",
      });
      expect(
        (
          await admin.query(
            `SELECT
               (SELECT count(*)::int FROM megapot_participant_claims WHERE status='accepted') AS claims,
               (SELECT count(*)::int FROM megapot_participant_claim_guards) AS guards`,
          )
        ).rows,
      ).toEqual([{ claims: 3, guards: 3 }]);
      expect(chain.heldCreditIds).toHaveLength(3);
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
      expect(paid.rows.map((row) => row.account_id).sort()).toEqual([
        "winner-both",
        "winner-karaoke",
        "winner-study",
      ]);
      for (const row of paid.rows) {
        expect(row.amount_atomic).toBe(amountFor(row.ordinal));
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
      const paidTotal = paid.rows.reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n);
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS count,sum(paid_atomic)::text AS paid,sum(reserved_atomic)::text AS reserved
           FROM reward_ledger_credits`,
          )
        ).rows,
      ).toEqual([{ count: 6, paid: paidTotal.toString(), reserved: "0" }]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM reward_chain_effects")).rows,
      ).toEqual([{ count: 5 }]);
      // Unclaimed credits stay in custody as owed liabilities.
      expect(chain.custodyBalance).toBe(100000n - 10000n + 901n - paidTotal);
      const observed = await observeGoldenDrawing(admin, legId, "101");
      expect(
        (await admin.query(goldenDrawingRecoverySql, [legId, COMMUNITY_ID, POST_ID, 1])).rows,
      ).toEqual([{ drawing_id: "101" }]);
      expect(
        (await admin.query(goldenDrawingRecoverySql, [legId, COMMUNITY_ID, "wrong-song", 1])).rows,
      ).toEqual([]);
      expect(
        (await admin.query(goldenDrawingRecoverySql, ["wrong-leg", COMMUNITY_ID, POST_ID, 1])).rows,
      ).toEqual([]);
      expect(observed.shares).toHaveLength(6);
      expect(observed.beneficiaries).toHaveLength(6);
      for (const credit of observed.credits) {
        const claimed = claimOutcomes.get(credit.account_id) === "accepted";
        expect(credit).toMatchObject({
          amount_atomic: amountFor(credit.ordinal),
          paid_atomic: claimed ? amountFor(credit.ordinal) : "0",
          receipt_confirmed: claimed,
          claim_status: claimed ? "accepted" : null,
        });
      }
      expect(observed.unresolved_effect_count).toBe(0);
      expect(observed.refunded_atomic).toBe("0");
      expect(observed.qualifications.filter((q) => q.account_id === "winner-both")).toHaveLength(2);
      // The staging observer must accept what the real 0203 projection wrote:
      // winner-both qualified twice but holds one decision and one share.
      expect(observed.decisions.filter((d) => d.account_id === "winner-both")).toHaveLength(1);
      const fixtureInput = onePalmRehearsalInput();
      const template = fixtureInput.participants[0];
      if (!template) throw new Error("missing fixture participant");
      const participant = (
        key: string,
        account: string,
        person: string,
        activities: readonly ("study" | "karaoke")[],
        expected: "eligible" | "verification_missing",
      ) => ({
        ...template,
        key,
        account_id: account,
        persona_id: persona(person),
        activities: [...activities] as ["study" | "karaoke", ...("study" | "karaoke")[]],
        expected_admission: expected,
      });
      const observerInput = {
        ...fixtureInput,
        community_id: COMMUNITY_ID,
        post_id: POST_ID,
        audio_revision: observed.audio_revision,
        participants: [
          participant("study", "winner-study", "study", ["study"], "eligible"),
          participant("karaoke", "winner-karaoke", "karaoke", ["karaoke"], "eligible"),
          participant("both", "winner-both", "both", ["study", "karaoke"], "eligible"),
          participant("expired", "winner-expired", "expired", ["karaoke"], "verification_missing"),
          participant("failed", "winner-failed", "failed", ["karaoke"], "verification_missing"),
          participant(
            "negative",
            "winner-unverified",
            "unverified",
            ["karaoke"],
            "verification_missing",
          ),
        ],
      };
      expect(goldenAdmissionProgress(observerInput, observed)).toBe("complete");
      expect(() => assertGoldenAdmission(observerInput, observed)).not.toThrow();
      const witness = await admin.query(goldenIdentitySql, ["winner-study", personas.get("study")]);
      expect(witness.rows).toHaveLength(1);
      expect(witness.rows[0]?.evidence).toHaveLength(1);
      const content = await admin.query(goldenContentSql, [COMMUNITY_ID, POST_ID]);
      expect(content.rows).toHaveLength(1);
      expect(content.rows[0]?.study_exercise_count).toBeGreaterThanOrEqual(4);

      // Spec 015 §5.2a claim cases on the credits the chain left held.
      const creditOf = new Map(
        chain.allocation.allocations.map((row) => [row.accountId, row.creditId ?? ""]),
      );
      const credit = (account: string) => {
        const value = creditOf.get(account);
        if (!value) throw new Error("missing fixture credit");
        return value;
      };
      const payout = makeControlPlaneRewardPayoutStore(layer);
      const outstanding = async () =>
        (
          await admin.query(
            "SELECT sum(amount_atomic - paid_atomic)::text AS owed FROM reward_ledger_credits",
          )
        ).rows[0]?.owed;
      const owedBefore = (901n - paidTotal).toString();
      expect(await outstanding()).toBe(owedBefore);
      // The study winner's Very subject is recovered onto the unverified
      // account. Its claim finds the subject already consumed in this pool and
      // drawing, so the credit is held as subject_conflict, never paid.
      await seedVeryRewardEvidence(
        admin,
        "winner-unverified",
        "unverified-recovered",
        await digest("receipt-study-recovered"),
        "current",
        "study",
      );
      const conflict = { outcome: "subject_conflict", claim_status: "subject_conflict" };
      expect(await claimFor(credit("winner-unverified"), "winner-unverified")).toEqual(conflict);
      expect(await claimFor(credit("winner-unverified"), "winner-unverified")).toEqual(conflict);
      await expect(
        Effect.runPromise(payout.loadCandidate(credit("winner-unverified"))),
      ).rejects.toMatchObject({ reason: "credit-not-payable" });
      expect(await outstanding()).toBe(owedBefore);
      // A refused claim is claimable later once valid evidence exists.
      await seedVeryRewardEvidence(
        admin,
        "winner-expired",
        "expired-renewed",
        await digest("subject-expired-renewed"),
      );
      expect(await claimFor(credit("winner-expired"), "winner-expired")).toEqual({
        outcome: "accepted",
        claim_status: "accepted",
      });
      expect((await claimFor(credit("winner-failed"), "winner-failed")).outcome).toBe(
        "verification_failed",
      );
      // The audited operator exception moves the conflict to accepted through
      // the same claim record, without consuming or releasing any guard.
      const guardsBefore = await admin.query(
        "SELECT pool_leg_id,drawing_id::text,subject_key_id,credit_id FROM megapot_participant_claim_guards ORDER BY credit_id",
      );
      expect(guardsBefore.rows).toHaveLength(4);
      const operatorAccept = (reason: string) =>
        admin.query(
          "SELECT operator_accept_megapot_participant_claim_v1($1,'operator',$2,'review:composed-conflict') AS outcome",
          [credit("winner-unverified"), reason],
        );
      await expect(operatorAccept("   ")).rejects.toThrow();
      expect((await operatorAccept("reviewed recovered subject")).rows).toEqual([
        { outcome: "accepted" },
      ]);
      await expect(operatorAccept("second decision")).rejects.toThrow("subject_conflict");
      expect(
        (
          await admin.query(
            "SELECT pool_leg_id,drawing_id::text,subject_key_id,credit_id FROM megapot_participant_claim_guards ORDER BY credit_id",
          )
        ).rows,
      ).toEqual(guardsBefore.rows);
      expect(
        (
          await admin.query(
            `SELECT account_id,status,operator_actor_role,operator_reason,operator_evidence_reference
               FROM megapot_participant_claims ORDER BY account_id`,
          )
        ).rows.map((row) => [row.account_id, row.status, row.operator_actor_role]),
      ).toEqual([
        ["winner-both", "accepted", null],
        ["winner-expired", "accepted", null],
        ["winner-karaoke", "accepted", null],
        ["winner-study", "accepted", null],
        ["winner-unverified", "accepted", "operator"],
      ]);
      expect(await claimFor(credit("winner-unverified"), "winner-unverified")).toEqual({
        outcome: "accepted",
        claim_status: "accepted",
      });
      for (const account of ["winner-unverified", "winner-expired"]) {
        expect(await Effect.runPromise(payout.loadCandidate(credit(account)))).toMatchObject({
          amountAtomic: BigInt(
            amountFor(
              chain.allocation.allocations.find((row) => row.accountId === account)?.ordinal ?? -1,
            ),
          ),
        });
      }
      await expect(
        Effect.runPromise(payout.loadCandidate(credit("winner-failed"))),
      ).rejects.toMatchObject({ reason: "credit-not-payable" });
      expect(await outstanding()).toBe(owedBefore);
      // Under the operational role template the serving role can claim but
      // cannot write claims or guards directly, and only the operator role can
      // reach the audited exception.
      const roleSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const runtimeRole = `claims_runtime_${roleSuffix}`;
      const operatorRole = `claims_operator_${roleSuffix}`;
      const roleTemplate = (
        await Bun.file(new URL("../../../db/postgres/roles.sql.example", import.meta.url)).text()
      )
        .replaceAll("api_next_operator", operatorRole)
        .replaceAll("api_next_app", runtimeRole)
        .replaceAll("SCHEMA public", `SCHEMA "${schema}"`);
      await admin.query(roleTemplate);
      const asRole = (role: string) =>
        new Client({
          connectionString: `${scoped}${encodeURIComponent(` -c role=${role}`)}`,
        });
      const runtimeClient = asRole(runtimeRole);
      const operatorClient = asRole(operatorRole);
      try {
        await Promise.all([runtimeClient.connect(), operatorClient.connect()]);
        expect(
          (
            await runtimeClient.query(
              "SELECT outcome FROM accept_megapot_participant_claim_v1($1,'winner-failed')",
              [credit("winner-failed")],
            )
          ).rows,
        ).toEqual([{ outcome: "verification_failed" }]);
        await expect(
          runtimeClient.query(
            `INSERT INTO megapot_participant_claims (
               credit_id,account_id,pool_leg_id,drawing_id,status,subject_key_id,
               evidence_receipt_id,accepted_at
             ) VALUES ($1,'winner-failed',$2,101,'accepted','composed-subject-failed','forged',now())`,
            [credit("winner-failed"), legId],
          ),
        ).rejects.toThrow("permission denied");
        await expect(
          runtimeClient.query("DELETE FROM megapot_participant_claim_guards"),
        ).rejects.toThrow("permission denied");
        await expect(
          runtimeClient.query(
            "SELECT operator_accept_megapot_participant_claim_v1($1,'operator','forged','forged')",
            [credit("winner-failed")],
          ),
        ).rejects.toThrow("permission denied");
        await expect(
          operatorClient.query(
            "SELECT operator_accept_megapot_participant_claim_v1($1,'operator','no conflict','review:none')",
            [credit("winner-failed")],
          ),
        ).rejects.toThrow("subject_conflict");
      } finally {
        await Promise.all([
          runtimeClient.end().catch(() => undefined),
          operatorClient.end().catch(() => undefined),
        ]);
        for (const role of [runtimeRole, operatorRole]) {
          await admin.query(`DROP OWNED BY "${role}"`);
          await admin.query(`DROP ROLE "${role}"`);
        }
      }
      expect(await outstanding()).toBe(owedBefore);
      // Remaining 90,000 atoms are sponsor funds, not an unexplained delta.
      // Offer expiry/refund and live receipt decoding are separate coverage.
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 120000);
});
