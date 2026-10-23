import { Effect, Schema } from "effect";
import * as C from "../../../contracts/src/rewards-song-contributions-v2.ts";
import {
  type AuthoritativeSchedule,
  type CapacityProfile,
  initialMegapotWindow,
  type PoolPrincipalBudget,
  songMegapotCapacity,
} from "../../../domain/src/song-megapot-capacity.ts";
import {
  digestFundingPreimageV2,
  type FundingLimitsPolicy,
  fundingContextPreimageV2,
  SongContributionFailure,
} from "./song-megapot-contributions.ts";

/** Inputs are produced by the trusted observer/store, not a browser. Every
 * operational/economic choice is explicit accepted data; no schedule recurrence,
 * gas capacity, policy admission or custody solvency is inferred here. */
export type SongFundingContextFacts = Readonly<{
  now: number;
  slot: C.EmptyTargetV2 | C.CommittedTargetV2;
  slotId: string;
  slotGeneration: number;
  committedTerms: C.TermsV2 | null;
  legSnapshotId: string | null;
  actor: C.OwnedActorV2;
  walletAssignmentRevision: number;
  lifecycleRevision: number;
  capacityRevision: number;
  profileId: string;
  profileHash: string;
  capacityProfile: CapacityProfile | null;
  limitsPolicy: FundingLimitsPolicy | null;
  schedule: AuthoritativeSchedule | null;
  wireSchedule: C.ScheduleWitnessV2;
  budget: PoolPrincipalBudget;
  costsReconciled: boolean;
  fundingPolicyRevision: number;
  fundingPolicyHash: string;
  rewardPolicyTemplateHash: string;
  qualificationTemplates: readonly C.QualificationTemplateV2[];
  disclosureVersion: string;
  feePolicyId: string;
  chainId: number;
  tokenAddress: string;
  custodyAddress: string;
  attestationId: string;
  gasReady: boolean;
  remainingEffects: number;
  pendingAccountSlots: number;
}>;
const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Natural.check(Schema.isGreaterThan(0));
const Amount = Schema.BigIntFromString.check(
  Schema.makeFilter((n) => (n >= 0n && n < 1n << 256n ? undefined : "Invalid uint256")),
);
export const SongFundingContextFactsSchema: Schema.Codec<SongFundingContextFacts, unknown> =
  Schema.Struct({
    now: Natural,
    slot: C.TargetV2,
    slotId: C.IdV2,
    slotGeneration: Natural,
    committedTerms: Schema.NullOr(C.TermsV2),
    legSnapshotId: Schema.NullOr(C.IdV2),
    actor: C.OwnedActorV2,
    walletAssignmentRevision: Natural,
    lifecycleRevision: Natural,
    capacityRevision: Natural,
    profileId: C.IdV2,
    profileHash: C.HashV2,
    capacityProfile: Schema.NullOr(
      Schema.Struct({
        maxDrawings: Positive,
        reservationMs: Positive,
        safetyMarginMs: Natural,
        maximumWitnessAgeMs: Positive,
        validUntil: Natural,
        attestationValidUntil: Natural,
        priceCeilingAtomic: Amount,
        minimumAtomic: Amount,
      }),
    ),
    limitsPolicy: Schema.NullOr(
      Schema.Struct({
        maxActiveAccount: Positive,
        maxActiveAccountLeg: Positive,
        maxLegLiabilities: Positive,
        maxAdmittedLeg: Positive,
        maxAdmittedAccountLeg: Positive,
        workPerInstruction: Positive,
        economicsPolicyHash: C.HashV2,
        gasPolicyHash: C.HashV2,
        custodyPolicyHash: C.HashV2,
      }),
    ),
    schedule: Schema.NullOr(
      Schema.Struct({
        observedAt: Natural,
        validUntil: Natural,
        ruleHash: C.HashV2,
        priceRuleHash: C.HashV2,
        recurrenceProven: Schema.Boolean,
        rows: Schema.Array(
          Schema.Struct({
            id: C.UIntV2,
            drawingTime: Natural,
            entryCutoff: Natural,
            purchaseDeadline: Natural,
            priceAtomic: Amount,
            proof: Schema.Literals(["initialized_state", "attested_recurrence"]),
            state: Schema.Literals(["uncommitted", "committed", "settled", "cancelled"]),
            reservedCostAtomic: Amount,
          }),
        ),
      }),
    ),
    wireSchedule: C.ScheduleWitnessV2,
    budget: Schema.Struct({
      funded: Amount,
      spent: Amount,
      committedPurchases: Amount,
      refunded: Amount,
      otherObligations: Amount,
      liveInboundReservations: Amount,
    }),
    costsReconciled: Schema.Boolean,
    fundingPolicyRevision: Natural,
    fundingPolicyHash: C.HashV2,
    rewardPolicyTemplateHash: C.HashV2,
    qualificationTemplates: Schema.Array(C.QualificationTemplateV2),
    disclosureVersion: C.IdV2,
    feePolicyId: C.IdV2,
    chainId: C.ChainV2,
    tokenAddress: C.AddressV2,
    custodyAddress: C.AddressV2,
    attestationId: C.IdV2,
    gasReady: Schema.Boolean,
    remainingEffects: Natural,
    pendingAccountSlots: Natural,
  });

const refuse = (code: SongContributionFailure["code"]) => new SongContributionFailure({ code });
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
    catch: () => refuse("policy_unavailable"),
  });
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

/** V2 funding authority deliberately excludes V1 owner-only/pool-decline and
 * derivative-video settings. The versioned rule is fixed, not an owner toggle.
 * Historical V1 policy hashes/rows remain untouched.
 */
export const openSongFundingPolicyHashV2 = (target: C.SongTargetV2) =>
  digestFundingPreimageV2(
    C.fundingHashPreimageV2("pirate.open-song-funding-policy.v2", [
      C.projectSongTarget(target),
      1,
      "any_active_account_own_community_wallet",
      "leg_budget",
      "no_purchase",
      ["study", "karaoke", "dance"],
      "one_shared_song_pot",
      "verification_at_claim",
    ]),
  );

/** Produce an immutable prospective/committed quote. It allocates no identities,
 * financial slot, wallet nonce, command, reservation or instruction. Persistence
 * is an explicit trusted background producer step; GET only reads its result. */
export const buildSongMegapotFundingContext = Effect.fn("SongFundingContext.build")(function* (
  f: SongFundingContextFacts,
) {
  const p = f.capacityProfile,
    limits = f.limitsPolicy;
  if (p === null || limits === null || f.schedule === null)
    return yield* refuse("policy_unavailable");
  if (f.actor.community_id !== f.slot.community_id) return yield* refuse("persona_wrong_community");
  if (!f.gasReady) return yield* refuse("gas_budget_unavailable");
  if (!f.costsReconciled) return yield* refuse("recovery_required");
  if (f.remainingEffects <= 0 || f.pendingAccountSlots <= 0) return yield* refuse("effect_limit");
  const wire = yield* parse(C.ScheduleWitnessV2, f.wireSchedule);
  if (
    wire.rows.length !== f.schedule.rows.length ||
    wire.rule_hash !== f.schedule.ruleHash ||
    wire.price_rule_hash !== f.schedule.priceRuleHash ||
    wire.rows.some((row) => {
      const source = f.schedule?.rows.find((r) => r.id === row.drawing_id);
      return (
        source === undefined ||
        source.drawingTime !== Date.parse(row.drawing_time) ||
        source.entryCutoff !== Date.parse(row.entry_cutoff_at) ||
        source.purchaseDeadline !== Date.parse(row.purchase_deadline_at) ||
        source.priceAtomic.toString() !== row.price_atomic ||
        source.proof !== row.proof_kind
      );
    })
  )
    return yield* refuse("schedule_unproven");
  let quote: C.EmptyQuoteV2 | C.ExistingQuoteV2;
  let end: number;
  let ids: readonly string[];
  let latest: number;
  let upper: number;
  if (f.slot.kind === "empty") {
    if (
      f.committedTerms !== null ||
      f.legSnapshotId !== null ||
      f.slot.slot_id !== f.slotId ||
      f.slot.slot_generation !== f.slotGeneration ||
      Object.values(f.budget).some((amount) => amount !== 0n)
    )
      return yield* refuse("recovery_required");
    const window = initialMegapotWindow({ now: f.now, profile: p, schedule: f.schedule });
    if (!window.ok) return yield* refuse(window.reason);
    end = window.fixedEndsAt;
    ids = window.plannedDrawingIds;
    latest = window.latestAllocationAt;
    upper = window.reservationDeadlineUpperBound;
    const plannedHash = yield* digestFundingPreimageV2(
      C.fundingHashPreimageV2(
        "pirate.shared-song-planned-schedule.v1",
        ids.map((id) => {
          const row = wire.rows.find((r) => r.drawing_id === id);
          return [
            id,
            row?.drawing_time,
            row?.entry_cutoff_at,
            row?.purchase_deadline_at,
            row?.price_atomic,
            row?.proof_kind,
          ];
        }),
      ),
    );
    const prospective = yield* parse(C.ProspectiveTermsV2, {
      version: "shared-song-megapot-prospectus-v1",
      target: {
        community_id: f.slot.community_id,
        post_id: f.slot.post_id,
        canonical_song_id: f.slot.canonical_song_id,
        audio_revision: f.slot.audio_revision,
      },
      profile_id: f.profileId,
      profile_hash: f.profileHash,
      funding_policy_revision: f.fundingPolicyRevision,
      funding_policy_hash: f.fundingPolicyHash,
      reward_policy_template_hash: f.rewardPolicyTemplateHash,
      start_rule: "allocation_linearization_time",
      budget_source: "leg_budget",
      empty_behavior: "no_purchase",
      eligible_activities: ["study", "karaoke", "dance"],
      dance_scope: "any_policy_accepted",
      qualification_templates: f.qualificationTemplates,
      fixed_ends_at: iso(end),
      first_drawing_id: ids[0],
      last_planned_drawing_id: ids.at(-1),
      planned_drawing_ids: ids,
      planned_schedule_hash: plannedHash,
      ticket_price_ceiling_atomic: p.priceCeilingAtomic.toString(),
      disclosure_version: f.disclosureVersion,
    });
    quote = {
      kind: "prospective",
      prospective_terms: prospective,
      prospective_terms_hash: yield* digestFundingPreimageV2(
        C.prospectiveTermsPreimageV2(prospective),
      ),
    };
  } else {
    const terms = yield* parse(C.TermsV2, f.committedTerms);
    if (
      f.legSnapshotId === null ||
      terms.qualification_bindings.some(
        (b) => b.offer_id !== f.slot.offer_id || b.leg_id !== f.slot.pool_leg_id,
      ) ||
      terms.profile_id !== f.profileId ||
      terms.profile_hash !== f.profileHash ||
      (yield* digestFundingPreimageV2(C.committedTermsPreimageV2(terms))) !== terms.terms_hash
    )
      return yield* refuse("terms_mismatch");
    end = Date.parse(terms.ends_at);
    ids = terms.planned_drawing_ids;
    const relevant = f.schedule.rows.filter(
      (row) => ids.includes(row.id) && row.state === "uncommitted",
    );
    if (relevant.length === 0) return yield* refuse("capacity_exhausted");
    latest = Math.min(
      f.schedule.validUntil,
      p.validUntil,
      p.attestationValidUntil,
      end - p.reservationMs,
      ...relevant.flatMap((row) => [
        row.entryCutoff - p.reservationMs - p.safetyMarginMs,
        row.purchaseDeadline - p.reservationMs - p.safetyMarginMs,
      ]),
    );
    upper = latest + p.reservationMs;
    quote = { kind: "committed", committed_terms: terms, committed_terms_hash: terms.terms_hash };
  }
  const capacity = songMegapotCapacity({
    now: f.now,
    profile: p,
    schedule: f.schedule,
    budget: f.budget,
    fixedEndsAt: end,
    plannedDrawingIds: ids,
    reservationDeadlineUpperBound: upper,
    outboundCostsReconciled: f.costsReconciled,
  });
  if (!capacity.ok) return yield* refuse(capacity.reason);
  if (capacity.availableAtomic < p.minimumAtomic) return yield* refuse("capacity_exhausted");
  const context = yield* parse(C.ContextReadyV2, {
    object: "song_megapot_funding_context",
    version: 2,
    readiness: "ready",
    context_hash: "0".repeat(64),
    context_expires_at: iso(latest),
    lifecycle_revision: f.lifecycleRevision,
    target: f.slot,
    actor: f.actor,
    schedule: wire,
    limits: {
      profile_id: f.profileId,
      minimum_atomic: p.minimumAtomic.toString(),
      maximum_atomic: capacity.availableAtomic.toString(),
      usable_capacity_atomic: capacity.availableAtomic.toString(),
      capacity_revision: f.capacityRevision,
      max_admitted_effects_per_leg: limits.maxAdmittedLeg,
      remaining_effect_slots: f.remainingEffects,
      account_pending_slots_available: f.pendingAccountSlots,
      fee_policy_id: f.feePolicyId,
      reservation_ttl_seconds: p.reservationMs / 1000,
      latest_allocation_at: iso(latest),
      reservation_deadline_upper_bound: iso(upper),
    },
    chain_id: f.chainId,
    token_address: f.tokenAddress,
    custody_address: f.custodyAddress,
    attestation_id: f.attestationId,
    fees: {
      inbound_payer: "selected_persona_wallet",
      outbound_policy_id: f.feePolicyId,
      gas_ready: f.gasReady,
    },
    context_ref: {
      version: "funding-context-reference-v1",
      slot_id: f.slotId,
      slot_generation: f.slotGeneration,
      leg_snapshot_id: f.legSnapshotId,
      schedule_witness_id: wire.schedule_witness_id,
      profile_id: f.profileId,
      profile_hash: f.profileHash,
      funding_policy_hash: f.fundingPolicyHash,
      wallet_assignment_id: f.actor.wallet_assignment_id,
      wallet_assignment_revision: f.walletAssignmentRevision,
      lifecycle_revision: f.lifecycleRevision,
    },
    quote,
    submission_protocol: "single_fresh_delivery_v1",
  });
  return {
    ...context,
    context_hash: yield* digestFundingPreimageV2(fundingContextPreimageV2(context)),
  };
});
