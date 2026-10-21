import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as C from "../../../contracts/src/rewards-song-contributions-v2.ts";
import {
  buildSongMegapotFundingContext,
  type SongFundingContextFacts,
} from "./song-megapot-context.ts";
import { digestFundingPreimageV2, fundingContextPreimageV2 } from "./song-megapot-contributions.ts";

const h = "a".repeat(64);
const iso = (ms: number) => new Date(ms).toISOString();
/** Fictional selected inputs only. These values are never runtime defaults. */
function fixture(): SongFundingContextFacts {
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
const build = (f: SongFundingContextFacts) => Effect.runPromise(buildSongMegapotFundingContext(f));
describe("trusted shared song context producer", () => {
  test("empty quote has stable identity/hash after time advances, three frozen activities and no allocated pot/start", async () => {
    const f = fixture();
    const a = await build(f),
      b = await build({ ...f, now: 3000 });
    expect(a).toEqual(b);
    expect(a.target.kind).toBe("empty");
    expect(a.target.offer_id).toBeNull();
    expect(a.quote.kind).toBe("prospective");
    if (a.quote.kind !== "prospective") throw new Error("prospective quote required");
    expect(a.quote.prospective_terms).not.toHaveProperty("starts_at");
    expect(a.quote.prospective_terms.eligible_activities).toEqual(["study", "karaoke", "dance"]);
    expect(
      a.quote.prospective_terms.qualification_templates.find((t) => t.activity === "dance")
        ?.numeric_floor_bps,
    ).toBeNull();
    expect(a.context_hash).toBe(
      await Effect.runPromise(digestFundingPreimageV2(fundingContextPreimageV2(a))),
    );
    expect(a.quote.prospective_terms_hash).toBe(
      await Effect.runPromise(
        digestFundingPreimageV2(C.prospectiveTermsPreimageV2(a.quote.prospective_terms)),
      ),
    );
    expect(a.limits.maximum_atomic).toBe("2000000");
  });
  test("one authoritative drawing retains its last row and cutoff equality, without inventing future capacity", async () => {
    const f = fixture();
    const first = f.schedule?.rows[0];
    const wire = f.wireSchedule.rows[0];
    if (!first || !wire || !f.schedule) throw new Error("test schedule required");
    const context = await build({
      ...f,
      schedule: { ...f.schedule, rows: [{ ...first, entryCutoff: first.drawingTime }] },
      wireSchedule: { ...f.wireSchedule, rows: [{ ...wire, entry_cutoff_at: wire.drawing_time }] },
    });
    expect(context.limits.maximum_atomic).toBe("1000000");
    expect(context.quote.kind).toBe("prospective");
    if (context.quote.kind !== "prospective") throw new Error("prospective quote required");
    expect(context.quote.prospective_terms.fixed_ends_at).toBe(wire.drawing_time);
    expect(context.quote.prospective_terms.planned_drawing_ids).toEqual(["42"]);
  });
  test("missing policy, unknown costs, stale witness, conflicting wire proof and unproved recurrence stay unavailable", async () => {
    const f = fixture();
    for (const [input, code] of [
      [{ ...f, capacityProfile: null }, "policy_unavailable"],
      [{ ...f, costsReconciled: false }, "recovery_required"],
      [{ ...f, now: 4000 }, "observation_stale"],
      [{ ...f, gasReady: false }, "gas_budget_unavailable"],
      [
        {
          ...f,
          schedule: {
            ...f.schedule!,
            rows: f.schedule!.rows.map((row) => ({
              ...row,
              proof: "attested_recurrence" as const,
            })),
          },
          wireSchedule: {
            ...f.wireSchedule,
            rows: f.wireSchedule.rows.map((row) => ({
              ...row,
              proof_kind: "attested_recurrence" as const,
            })),
          },
        },
        "schedule_unproven",
      ],
      [
        {
          ...f,
          wireSchedule: {
            ...f.wireSchedule,
            rows: f.wireSchedule.rows.map((row) => ({ ...row, price_atomic: "2000000" })),
          },
        },
        "schedule_unproven",
      ],
    ] as const)
      await expect(build(input)).rejects.toMatchObject({ code });
  });
  test("another account's own community persona yields its own context without a membership/funder selector", async () => {
    const f = fixture();
    const a = await build(f);
    const b = await build({
      ...f,
      actor: {
        ...f.actor,
        account_id: "B",
        persona_id: "persona-B",
        wallet_assignment_id: "assignment-B",
        sender_address: `0x${"44".repeat(20)}`,
      },
    });
    expect(b.actor.account_id).toBe("B");
    expect(b.context_hash).not.toBe(a.context_hash);
    expect(b.target).toEqual(a.target);
    expect(b.quote).toEqual(a.quote);
    expect(b).not.toHaveProperty("membership");
    expect(b).not.toHaveProperty("owner_only");
  });
});
