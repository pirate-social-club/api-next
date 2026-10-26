import { Effect } from "effect";
import {
  buildSongMegapotFundingContext,
  type SongFundingContextFacts,
} from "../../application/src/rewards/song-megapot-context.ts";
import type * as C from "../../contracts/src/rewards-song-contributions-v2.ts";

const h = "a".repeat(64);
const iso = (ms: number) => new Date(ms).toISOString();
/** Fictional selected inputs only. These values are never runtime defaults. */
export function songFundingContextFixture(): SongFundingContextFacts {
  const rows = [42, 43].map((id, index) => ({
    id: String(id),
    drawingTime: 12000 + index * 10000,
    entryCutoff: 10000 + index * 10000,
    purchaseDeadline: 11000 + index * 10000,
    priceAtomic: 1000000n,
    proof: "initialized_state" as const,
    state: "uncommitted" as const,
    reservedCostAtomic: 0n,
  }));
  return {
    now: 1000,
    slot: {
      kind: "empty",
      community_id: "community",
      post_id: "song",
      canonical_song_id: "canonical",
      audio_revision: 1,
      slot_id: "slot",
      slot_generation: 0,
      offer_id: null,
      pool_leg_id: null,
    },
    slotId: "slot",
    slotGeneration: 0,
    committedTerms: null,
    legSnapshotId: null,
    actor: {
      account_id: "A",
      persona_id: "persona",
      community_id: "community",
      wallet_assignment_id: "assignment",
      wallet_index: 0,
      sender_address: `0x${"11".repeat(20)}`,
    },
    walletAssignmentRevision: 1,
    lifecycleRevision: 1,
    capacityRevision: 0,
    profileId: "profile",
    profileHash: h,
    capacityProfile: {
      maxDrawings: 30,
      reservationMs: 1000,
      safetyMarginMs: 1000,
      maximumWitnessAgeMs: 2000,
      validUntil: 50000,
      attestationValidUntil: 50000,
      priceCeilingAtomic: 1000000n,
      minimumAtomic: 100000n,
    },
    limitsPolicy: {
      maxActiveAccount: 4,
      maxActiveAccountLeg: 2,
      maxLegLiabilities: 5,
      maxAdmittedLeg: 5,
      maxAdmittedAccountLeg: 5,
      workPerInstruction: 1,
      economicsPolicyHash: h,
      gasPolicyHash: h,
      custodyPolicyHash: h,
    },
    schedule: {
      observedAt: 1000,
      validUntil: 50000,
      ruleHash: h,
      priceRuleHash: h,
      recurrenceProven: false,
      rows,
    },
    wireSchedule: {
      version: "song-megapot-schedule-v1",
      rule_id: "initialized-drawings",
      rule_hash: h,
      contract_code_hash: h,
      anchor: {
        chain_id: 84532,
        block_number: "100",
        block_hash: `0x${h}`,
        block_timestamp: iso(1000),
        observed_at: iso(1000),
        finality_policy_id: "selected-finality",
        attestation_id: "attestation",
        attestation_hash: h,
      },
      cadence_seconds: "1",
      price_rule_hash: h,
      valid_until: iso(50000),
      schedule_witness_id: "witness",
      rows: rows.map((row) => ({
        drawing_id: row.id,
        drawing_time: iso(row.drawingTime),
        entry_cutoff_at: iso(row.entryCutoff),
        purchase_deadline_at: iso(row.purchaseDeadline),
        price_atomic: row.priceAtomic.toString(),
        price_ceiling_atomic: "1000000",
        initialized: true,
        proof_kind: row.proof,
      })),
    },
    budget: {
      funded: 0n,
      spent: 0n,
      committedPurchases: 0n,
      refunded: 0n,
      otherObligations: 0n,
      liveInboundReservations: 0n,
    },
    costsReconciled: true,
    fundingPolicyRevision: 1,
    fundingPolicyHash: h,
    rewardPolicyTemplateHash: h,
    qualificationTemplates: ["study", "karaoke", "dance"].map((activity) => ({
      template_key: `template-${activity}`,
      activity,
      grading_family: activity === "dance" ? "moderator_verdict" : "numeric",
      qualification_policy_id: `q-${activity}`,
      qualification_policy_hash: h,
      numeric_floor_bps: activity === "dance" ? null : 7000,
      choreography_scope: activity === "dance" ? "any_policy_accepted" : "not_applicable",
      admission_id: `admission-${activity}`,
      admission_hash: h,
      disclosure_version: "disclosure",
    })) as C.QualificationTemplateV2[],
    disclosureVersion: "disclosure",
    feePolicyId: "accepted-fees",
    chainId: 84532,
    tokenAddress: `0x${"22".repeat(20)}`,
    custodyAddress: `0x${"33".repeat(20)}`,
    attestationId: "attestation",
    gasReady: true,
    remainingEffects: 5,
    pendingAccountSlots: 4,
  };
}

export function readySongFundingContextFixture(accountId: string) {
  const facts = songFundingContextFixture();
  return Effect.runPromise(
    buildSongMegapotFundingContext({ ...facts, actor: { ...facts.actor, account_id: accountId } }),
  );
}
