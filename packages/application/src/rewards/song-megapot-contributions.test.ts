import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import * as C from "../../../contracts/src/rewards-song-contributions-v2.ts";
import {
  type ContributionState,
  digestFundingPreimageV2,
  type FundingAdmission,
  type FundingScope,
  makeSongMegapotContributions,
  type RecoveryAuthority,
  SongContributionFailure,
  type SongContributionPorts,
  type SongContributionTransaction,
  type StoredFundingCommand,
} from "./song-megapot-contributions.ts";

// Fictional V5 values solely for isolated fake-port tests.
const fixture = {
  request: {
    version: 2,
    idempotency_key: "fixture_create_key_0001",
    persona_id: "fixture-persona-a",
    funding_amount_atomic: "1000000",
    expected_context_hash: "47e14f282256168eac75d25ceeae2fe1e77eb4ad4d1c484bf9519b4539adc352",
    expected_lifecycle_revision: 0,
    context_ref: {
      version: "funding-context-reference-v1",
      slot_id: "fixture-slot",
      slot_generation: 0,
      leg_snapshot_id: null,
      schedule_witness_id: "fixture-witness",
      profile_id: "fixture-profile",
      profile_hash: "a4ed102f029f8b3f5d49ca9fe64c131c017e3471a0d388fa65bfeb4db10b97dc",
      funding_policy_hash: "1bb42413cfc2fe292c95fcab0e62436a54199ffce08360a33d789aa12773dac6",
      wallet_assignment_id: "fixture-wallet",
      wallet_assignment_revision: 1,
      lifecycle_revision: 0,
    },
    expected_terms: {
      kind: "prospective",
      prospective_terms_hash: "4d0d1092962c36cec741a0316c79f87de7898669b9d3d4eb65b364219c2eed3d",
    },
  },
  prospectus: {
    version: "shared-song-megapot-prospectus-v1",
    target: {
      community_id: "fixture-community",
      post_id: "fixture-song-post",
      canonical_song_id: "fixture-canonical-song",
      audio_revision: 1,
    },
    profile_id: "fixture-profile",
    profile_hash: "a4ed102f029f8b3f5d49ca9fe64c131c017e3471a0d388fa65bfeb4db10b97dc",
    funding_policy_revision: 1,
    funding_policy_hash: "1bb42413cfc2fe292c95fcab0e62436a54199ffce08360a33d789aa12773dac6",
    reward_policy_template_hash: "a0cd51067000c5186cb2730e726f74f5c83fd854616e591f7afa0b65f54537ba",
    start_rule: "allocation_linearization_time",
    budget_source: "leg_budget",
    empty_behavior: "no_purchase",
    eligible_activities: ["study", "karaoke", "dance"],
    dance_scope: "any_policy_accepted",
    qualification_templates: [
      {
        template_key: "fixture-template-study",
        activity: "study",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-study",
        qualification_policy_hash:
          "554bc9235abe7225d53bed756c3160310aad25a87f9d9b78d0ed4803c48aba54",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-study",
        admission_hash: "70332f4dfab8eed9a2d748e63120bdf1f2f9e81fcf0fe42c167b1e6754042a88",
        disclosure_version: "fixture-disclosure",
      },
      {
        template_key: "fixture-template-karaoke",
        activity: "karaoke",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-karaoke",
        qualification_policy_hash:
          "77daf062a46a206f001d73e762f92a436570aacc9b6cd31f6a7c904a99b4774b",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-karaoke",
        admission_hash: "038b8168ce17be82369ef9211c2f1d9c33edf1227e05fb47e88d2365084993c9",
        disclosure_version: "fixture-disclosure",
      },
      {
        template_key: "fixture-template-dance",
        activity: "dance",
        grading_family: "moderator_verdict",
        qualification_policy_id: "fixture-policy-dance",
        qualification_policy_hash:
          "d492a8a0394e718c4ae5a8195713dc8f5392aceded39ceda00544361f189c5ce",
        numeric_floor_bps: null,
        choreography_scope: "any_policy_accepted",
        admission_id: "fixture-admission-dance",
        admission_hash: "1d81efad71c0ca76bbb80302db9171ab196c451a7215b3517bf127b1f2205f36",
        disclosure_version: "fixture-disclosure",
      },
    ],
    fixed_ends_at: "2026-10-18T14:00:00.000Z",
    first_drawing_id: "101",
    last_planned_drawing_id: "101",
    planned_drawing_ids: ["101"],
    planned_schedule_hash: "d12eabade5e1ef732861ea6d571e133aaced4390acca64c472eb159e2b77e982",
    ticket_price_ceiling_atomic: "1000000",
    disclosure_version: "fixture-disclosure",
  },
  terms: {
    version: "shared-song-megapot-v2",
    profile_id: "fixture-profile",
    profile_hash: "a4ed102f029f8b3f5d49ca9fe64c131c017e3471a0d388fa65bfeb4db10b97dc",
    terms_hash: "193803d32724c8a8e7be7f973b9dd757e55b829445dfb6d22225a1bbd934592b",
    funding_policy_revision: 1,
    funding_policy_hash: "1bb42413cfc2fe292c95fcab0e62436a54199ffce08360a33d789aa12773dac6",
    budget_source: "leg_budget",
    empty_behavior: "no_purchase",
    eligible_activities: ["study", "karaoke", "dance"],
    dance_scope: "any_policy_accepted",
    starts_at: "2026-10-18T13:00:10.000Z",
    ends_at: "2026-10-18T14:00:00.000Z",
    first_drawing_id: "101",
    last_planned_drawing_id: "101",
    ticket_price_ceiling_atomic: "1000000",
    disclosure_version: "fixture-disclosure",
    origin_prospective_terms_hash:
      "4d0d1092962c36cec741a0316c79f87de7898669b9d3d4eb65b364219c2eed3d",
    origin_slot_generation: 0,
    reward_policy_hash: "d877db814f56439fa0540cf8da2468bbab800af912f0700526d622ecfde11e81",
    qualification_bindings: [
      {
        template_key: "fixture-template-study",
        activity: "study",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-study",
        qualification_policy_hash:
          "554bc9235abe7225d53bed756c3160310aad25a87f9d9b78d0ed4803c48aba54",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-study",
        admission_hash: "70332f4dfab8eed9a2d748e63120bdf1f2f9e81fcf0fe42c167b1e6754042a88",
        disclosure_version: "fixture-disclosure",
        binding_id: "fixture-binding-study",
        objective_id: "fixture-objective-study",
        offer_id: "fixture-offer",
        leg_id: "fixture-leg",
      },
      {
        template_key: "fixture-template-karaoke",
        activity: "karaoke",
        grading_family: "numeric",
        qualification_policy_id: "fixture-policy-karaoke",
        qualification_policy_hash:
          "77daf062a46a206f001d73e762f92a436570aacc9b6cd31f6a7c904a99b4774b",
        numeric_floor_bps: 7000,
        choreography_scope: "not_applicable",
        admission_id: "fixture-admission-karaoke",
        admission_hash: "038b8168ce17be82369ef9211c2f1d9c33edf1227e05fb47e88d2365084993c9",
        disclosure_version: "fixture-disclosure",
        binding_id: "fixture-binding-karaoke",
        objective_id: "fixture-objective-karaoke",
        offer_id: "fixture-offer",
        leg_id: "fixture-leg",
      },
      {
        template_key: "fixture-template-dance",
        activity: "dance",
        grading_family: "moderator_verdict",
        qualification_policy_id: "fixture-policy-dance",
        qualification_policy_hash:
          "d492a8a0394e718c4ae5a8195713dc8f5392aceded39ceda00544361f189c5ce",
        numeric_floor_bps: null,
        choreography_scope: "any_policy_accepted",
        admission_id: "fixture-admission-dance",
        admission_hash: "1d81efad71c0ca76bbb80302db9171ab196c451a7215b3517bf127b1f2205f36",
        disclosure_version: "fixture-disclosure",
        binding_id: "fixture-binding-dance",
        objective_id: "fixture-objective-dance",
        offer_id: "fixture-offer",
        leg_id: "fixture-leg",
      },
    ],
    qualification_bindings_hash: "f1db724c9fff1192044f87e861cebbb09cb69da42cfe5f9653be59cc33490dd0",
    planned_drawing_ids: ["101"],
    planned_schedule_hash: "d12eabade5e1ef732861ea6d571e133aaced4390acca64c472eb159e2b77e982",
  },
  policy: {
    object: "nonce_cancellation_recovery_policy",
    version: "nonce-cancellation-recovery-v1",
    policy_id: "fixture-recovery-policy",
    policy_hash: "aac2afb21c6adb4dd242ee7273d692f0087813ff96ab8956b5d7b7f18a46030b",
    chain_id: 84532,
    valid_from: "2026-10-18T14:00:00.000Z",
    valid_until: "2026-10-18T16:00:00.000Z",
    dispatch_ttl_seconds: 180,
    max_preparations_per_contribution: 2,
    fee_policy_id: "fixture-fee-policy",
    fee_policy_hash: "7246b3571ad5228ea98f410d9947ef7c31f9a99463d0bd1ae17df0ad7428a4c9",
    attestation_contract_version: "fixture-recovery-attestation-v1",
  },
};

const run = Effect.runPromise;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture state");
  return value;
}
const baseScope: FundingScope = {
  communityId: "fixture-community",
  postId: "fixture-song-post",
  contributionId: null,
};
const hash = (s: string) => run(digestFundingPreimageV2(s));
const h = "a".repeat(64);
const iso = (s: string) => `2026-10-18T${s}.000Z`;
const asContribution = (v: unknown): C.ContributionReceiptV2 =>
  Schema.decodeUnknownSync(C.ContributionReceiptV2, { onExcessProperty: "error" })(v);
const asClaim = (v: unknown) => Schema.decodeUnknownSync(C.SubmissionClaimDeliveryV2)(v);
const asPlan = (v: unknown) => Schema.decodeUnknownSync(C.CancellationReceiptV2)(v);

/** In-memory transactional FAKE only. This is not a repository/nonce allocator implementation. */
function fixtureStore() {
  const states = new Map<string, ContributionState>();
  const commands = new Map<string, StoredFundingCommand>();
  const queuedWork = new Map<string, string>();
  let reconciliationCharges = 0;
  let commandUpdateCharges = 0;
  let beforeRecoveryLock: (() => void) | undefined;
  const quotes = new Map<string, C.ContextReadyV2>();
  const nonces = new Map<string, number>();
  let now = iso("13:00:10");
  let ids = 0;
  let target: C.CommittedTargetV2 | null = null;
  let terms: C.TermsV2 | null = null;
  let funded = 0n;
  let refusal: C.ErrorV2["code"] | null = null;
  let missingPolicy = false;
  let maxActiveAccount = 2;
  let workRemaining = 100;
  let costsReconciled = true;
  let livePrice = 1000000n;
  let loseNextCommit = false;
  let pauseAfterCommit = false;
  let authorizations = 0;
  let preflights = 0;
  let recovery: RecoveryAuthority = {
    policy: Schema.decodeUnknownSync(C.CancellationRecoveryPolicyV2)(fixture.policy),
    attestationId: "recovery_attestation",
    attestationHash: h,
    attestationValidUntil: iso("16:00:00"),
    originalWalletStillOwned: true,
    currentSigningRefusal: null,
    boundedWorkAvailable: true,
  };
  let tail = Promise.resolve();
  const actors = (account: string, persona = `persona_${account}`): C.OwnedActorV2 => ({
    account_id: account,
    persona_id: persona,
    community_id: baseScope.communityId,
    wallet_assignment_id: `wallet_${persona}`,
    wallet_index: 0,
    sender_address: `0x${(persona === "second_persona" ? "5" : account === "a" ? "1" : "4").repeat(40)}`,
  });
  const schedule: C.ScheduleWitnessV2 = {
    version: "song-megapot-schedule-v1",
    rule_id: "rule",
    rule_hash: h,
    contract_code_hash: h,
    anchor: {
      chain_id: 84532,
      block_number: "100",
      block_hash: `0x${h}`,
      block_timestamp: iso("13:00:00"),
      observed_at: iso("13:00:00"),
      finality_policy_id: "finality",
      attestation_id: "attestation",
      attestation_hash: h,
    },
    cadence_seconds: "3600",
    price_rule_hash: h,
    valid_until: iso("13:02:00"),
    schedule_witness_id: "witness",
    rows: Array.from({ length: 6 }, (_, i) => ({
      drawing_id: String(101 + i),
      drawing_time: iso(`${14 + i}:00:00`),
      entry_cutoff_at: iso(`${13 + i}:30:00`),
      purchase_deadline_at: iso(`${13 + i}:45:00`),
      price_atomic: "1000000",
      price_ceiling_atomic: "1000000",
      initialized: true,
      proof_kind: "initialized_state",
    })),
  };
  async function quote(
    account = "a",
    persona = `persona_${account}`,
    transform?: (context: C.ContextReadyV2) => Promise<C.ContextReadyV2>,
  ) {
    const actor = actors(account, persona);
    const prospectus = Schema.decodeUnknownSync(C.ProspectiveTermsV2)({
      ...fixture.prospectus,
      fixed_ends_at: iso("19:00:00"),
      last_planned_drawing_id: "106",
      planned_drawing_ids: schedule.rows.map((r) => r.drawing_id),
    });
    const prospectiveHash = await hash(C.prospectiveTermsPreimageV2(prospectus));
    let c: C.ContextReadyV2 = {
      object: "song_megapot_funding_context",
      version: 2,
      readiness: "ready",
      context_hash: h,
      context_expires_at: iso("13:02:00"),
      lifecycle_revision: 0,
      target: target ?? {
        ...prospectus.target,
        kind: "empty",
        slot_id: "fixture-slot",
        slot_generation: 0,
        offer_id: null,
        pool_leg_id: null,
      },
      actor,
      schedule,
      limits: {
        profile_id: "fixture-profile",
        minimum_atomic: "1000000",
        maximum_atomic: "6000000",
        usable_capacity_atomic: "6000000",
        capacity_revision: 0,
        max_admitted_effects_per_leg: 10,
        remaining_effect_slots: 10,
        account_pending_slots_available: 2,
        fee_policy_id: "fixture-fee-policy",
        reservation_ttl_seconds: 600,
        latest_allocation_at: iso("13:02:00"),
        reservation_deadline_upper_bound: iso("13:12:00"),
      },
      chain_id: 84532,
      token_address: `0x${"2".repeat(40)}`,
      custody_address: `0x${"3".repeat(40)}`,
      attestation_id: "attestation",
      fees: {
        inbound_payer: "selected_persona_wallet",
        outbound_policy_id: "fixture-fee-policy",
        gas_ready: true,
      },
      context_ref: {
        ...fixture.request.context_ref,
        version: "funding-context-reference-v1",
        schedule_witness_id: schedule.schedule_witness_id,
        wallet_assignment_id: actor.wallet_assignment_id,
        leg_snapshot_id: terms === null ? null : "snapshot",
        slot_generation: terms === null ? 0 : 1,
      },
      quote:
        terms === null
          ? {
              kind: "prospective",
              prospective_terms: prospectus,
              prospective_terms_hash: prospectiveHash,
            }
          : { kind: "committed", committed_terms: terms, committed_terms_hash: terms.terms_hash },
      submission_protocol: "single_fresh_delivery_v1",
    };
    if (transform !== undefined) c = await transform(c);
    // Pure authoritative context hash from exact V5 preimage, no quote/financial allocation.
    const keys = [
      "profile_id",
      "minimum_atomic",
      "maximum_atomic",
      "usable_capacity_atomic",
      "capacity_revision",
      "max_admitted_effects_per_leg",
      "fee_policy_id",
      "reservation_ttl_seconds",
      "latest_allocation_at",
      "reservation_deadline_upper_bound",
    ] as const;
    c = {
      ...c,
      context_hash: await hash(
        C.fundingHashPreimageV2("pirate.song-megapot-funding-context.v2", [
          C.projectContextReference(c.context_ref),
          C.projectTarget(c.target),
          C.projectOwnedActor(actor),
          c.chain_id,
          c.token_address,
          c.custody_address,
          c.attestation_id,
          c.quote.kind,
          c.quote.kind === "prospective"
            ? c.quote.prospective_terms_hash
            : c.quote.committed_terms_hash,
          keys.map((k) => [k, c.limits[k]]),
          c.context_expires_at,
        ]),
      ),
    };
    quotes.set(c.context_hash, c);
    const request: C.ContributionRequestV2 = {
      ...fixture.request,
      version: 2,
      persona_id: actor.persona_id,
      expected_context_hash: c.context_hash,
      context_ref: c.context_ref,
      expected_terms:
        c.quote.kind === "prospective"
          ? { kind: "prospective", prospective_terms_hash: c.quote.prospective_terms_hash }
          : { kind: "committed", terms_hash: c.quote.committed_terms_hash },
    };
    return request;
  }
  function ports(account: string): SongContributionPorts {
    const key = (i: Parameters<SongContributionPorts["lookup"]>[0]) =>
      `${i.accountId}/${i.operation}/${i.key}`;
    return {
      authorize: () =>
        Effect.sync(() => {
          authorizations++;
          return { accountId: account };
        }),
      lookup: (i) => Effect.sync(() => commands.get(key(i)) ?? null),
      preflight: () =>
        Effect.sync(() => {
          preflights++;
        }),
      transaction: (identity, use) =>
        Effect.tryPromise({
          try: async () => {
            const previous = tail;
            let unlock: () => void = () => {};
            tail = new Promise<void>((resolve) => {
              unlock = resolve;
            });
            await previous;
            const tx: SongContributionTransaction = {
              lookup: () => Effect.succeed(commands.get(key(identity)) ?? null),
              now: () => Effect.succeed(now),
              id: (kind) => Effect.sync(() => `${kind}_${++ids}`),
              instantiateRewardPolicy: () => Effect.succeed(h),
              fundingAdmission: (request) =>
                Effect.sync(() => {
                  const c = required(quotes.get(request.expected_context_hash));
                  const actor = c.actor;
                  const all = [...states.values()];
                  const active = all.filter((s) => !s.nonceFinalized);
                  const admitted = all.filter((s) => s.fundingState === "pool_credited");
                  const admission: FundingAdmission = {
                    context: c,
                    actor,
                    currentTarget: target,
                    currentTerms: terms,
                    currentSlotGeneration: target === null ? 0 : 1,
                    originEmptyGeneration: target === null ? null : 0,
                    capacityProfile: {
                      maxDrawings: 6,
                      reservationMs: 600000,
                      safetyMarginMs: 60000,
                      maximumWitnessAgeMs: 120000,
                      validUntil: Date.parse(schedule.valid_until),
                      attestationValidUntil: Date.parse(iso("20:00:00")),
                      priceCeilingAtomic: 1000000n,
                      minimumAtomic: 1000000n,
                    },
                    schedule: {
                      observedAt: Date.parse(schedule.anchor.observed_at),
                      validUntil: Date.parse(schedule.valid_until),
                      ruleHash: h,
                      priceRuleHash: h,
                      recurrenceProven: false,
                      rows: schedule.rows.map((r) => ({
                        id: r.drawing_id,
                        drawingTime: Date.parse(r.drawing_time),
                        entryCutoff: Date.parse(r.entry_cutoff_at),
                        purchaseDeadline: Date.parse(r.purchase_deadline_at),
                        priceAtomic: livePrice,
                        proof: r.proof_kind,
                        state: "uncommitted",
                        reservedCostAtomic: 0n,
                      })),
                    },
                    budget: {
                      funded,
                      spent: 0n,
                      committedPurchases: 0n,
                      refunded: 0n,
                      otherObligations: 0n,
                      liveInboundReservations: active.reduce(
                        (n, s) => n + BigInt(s.receipt.instruction.amount_atomic),
                        0n,
                      ),
                    },
                    costsReconciled,
                    policy: missingPolicy
                      ? null
                      : {
                          maxActiveAccount,
                          maxActiveAccountLeg: 2,
                          maxLegLiabilities: 10,
                          maxAdmittedLeg: 10,
                          maxAdmittedAccountLeg: 10,
                          workPerInstruction: 1,
                          economicsPolicyHash: h,
                          gasPolicyHash: h,
                          custodyPolicyHash: h,
                        },
                    counters: {
                      activeAccount: active.filter((s) => s.owner.account_id === account).length,
                      activeAccountLeg: active.filter((s) => s.owner.account_id === account).length,
                      legLiabilities: all.length,
                      admittedLeg: admitted.length,
                      admittedAccountLeg: admitted.filter((s) => s.owner.account_id === account)
                        .length,
                      accountWorkRemaining: workRemaining,
                      legWorkRemaining: workRemaining,
                      globalWorkRemaining: workRemaining,
                      refundEnvelopeReady: true,
                      unresolvedV1Wallet: false,
                    },
                    refusal,
                    confirmedNonce: String(nonces.get(actor.sender_address) ?? 7),
                    pendingNonce: String(nonces.get(actor.sender_address) ?? 7),
                    nonceWitnessFresh: true,
                    sharedNonceLeaseAvailable: !active.some(
                      (s) => s.owner.sender_address === actor.sender_address,
                    ),
                  };
                  return admission;
                }),
              ownedContribution: () => {
                const s = states.get(identity.contributionId ?? "");
                return s === undefined ||
                  s.owner.account_id !== account ||
                  s.receipt.target.community_id !== identity.communityId ||
                  s.receipt.target.post_id !== identity.postId
                  ? Effect.fail(new SongContributionFailure({ code: "not_found" }))
                  : Effect.succeed(s);
              },
              recoveryAuthority: () =>
                Effect.sync(() => {
                  const beforeLock = beforeRecoveryLock;
                  beforeRecoveryLock = undefined;
                  beforeLock?.();
                  return recovery;
                }),
              recordReconciliationRequest: (state, command, hint) => {
                const recognized =
                  hint === null ||
                  hint.instructionHash === state.receipt.instruction.instruction_hash ||
                  [...commands.values()].some(
                    (c) =>
                      c.receipt.object === "contribution_cancellation_command_receipt" &&
                      c.receipt.contribution_id === state.receipt.contribution_id &&
                      c.receipt.instruction_hash === hint.instructionHash,
                  );
                return recognized
                  ? Effect.sync(() => {
                      commands.set(key(identity), command);
                      const r = command.receipt;
                      if (r.object === "contribution_recovery_command_receipt")
                        queuedWork.set(r.work_item_id, r.command_id);
                      reconciliationCharges++;
                    })
                  : Effect.fail(new SongContributionFailure({ code: "receipt_mismatch" }));
              },
              create: (s) =>
                Effect.sync(() => {
                  states.set(s.receipt.contribution_id, s);
                  target = s.receipt.target;
                  terms = s.receipt.committed_terms;
                  commands.set(key(identity), { requestHash: identity.hash, receipt: s.receipt });
                }),
              update: (before, after, command) =>
                Effect.sync(() => {
                  if (states.get(before.receipt.contribution_id) !== before)
                    throw new Error("Fake revision conflict");
                  commandUpdateCharges++;
                  states.set(after.receipt.contribution_id, after);
                  commands.set(key(identity), command);
                }),
            };
            try {
              const result = await run(use(tx));
              if (pauseAfterCommit) refusal = "paused";
              if (loseNextCommit) {
                loseNextCommit = false;
                throw new SongContributionFailure({ code: "outcome_unknown" });
              }
              return result;
            } finally {
              unlock();
            }
          },
          catch: (e) =>
            e instanceof SongContributionFailure
              ? e
              : new SongContributionFailure({ code: "outcome_unknown" }),
        }),
    };
  }
  const service = (account = "a") => makeSongMegapotContributions(ports(account));
  const create = async (
    account = "a",
    amount = "2000000",
    key = "new_contribution_key_01",
    request?: C.ContributionRequestV2,
  ) =>
    asContribution(
      await run(
        service(account).execute("CreateSongMegapotContributionV2", baseScope, {
          ...(request ?? (await quote(account))),
          idempotency_key: key,
          funding_amount_atomic: amount,
        }),
      ),
    );
  const scope = (id: string) => ({ ...baseScope, contributionId: id });
  const claim = async (
    r: C.ContributionReceiptV2,
    key = "claim_submission_key_01",
    purpose: "funding_transfer" | "nonce_cancellation" = "funding_transfer",
    hash = r.instruction.instruction_hash,
    revision = required(states.get(r.contribution_id)).revision,
  ) =>
    asClaim(
      await run(
        service(required(states.get(r.contribution_id)).owner.account_id).execute(
          "ClaimSongMegapotContributionSubmissionV2",
          scope(r.contribution_id),
          {
            idempotency_key: key,
            client_instance_id: "client_instance_one",
            submission_attempt_id: "submission_attempt_one",
            purpose,
            expected_state_revision: revision,
            instruction_hash: hash,
          },
        ),
      ),
    );
  const prepare = async (
    r: C.ContributionReceiptV2,
    key = "cancellation_plan_key_01",
    revision = required(states.get(r.contribution_id)).revision,
  ) =>
    asPlan(
      await run(
        service().execute(
          "PrepareSongMegapotContributionCancellationV2",
          scope(r.contribution_id),
          {
            idempotency_key: key,
            expected_state_revision: revision,
            purpose: "cancel_original_nonce",
          },
        ),
      ),
    );
  const finalize = (r: C.ContributionReceiptV2) => {
    const s = required(states.get(r.contribution_id));
    states.set(r.contribution_id, {
      ...s,
      revision: s.revision + 1,
      fundingState: "pool_credited",
      nonceFinalized: true,
    });
    funded += BigInt(r.instruction.amount_atomic);
    nonces.set(s.owner.sender_address, Number(r.instruction.nonce) + 1);
  };
  return {
    states,
    queuedWork,
    reconciliationCharges: () => reconciliationCharges,
    commandUpdateCharges: () => commandUpdateCharges,
    atRecoveryLock: (commit: () => void) => {
      beforeRecoveryLock = commit;
    },
    quotes,
    quote,
    service,
    create,
    scope,
    claim,
    prepare,
    finalize,
    setNow: (v: string) => {
      now = v;
    },
    setRefusal: (v: C.ErrorV2["code"] | null) => {
      refusal = v;
    },
    setPolicyMissing: () => {
      missingPolicy = true;
    },
    setMaxActive: (n: number) => {
      maxActiveAccount = n;
    },
    setWork: (n: number) => {
      workRemaining = n;
    },
    loseCommit: () => {
      loseNextCommit = true;
    },
    pauseOnCommit: () => {
      pauseAfterCommit = true;
    },
    setLivePrice: (n: bigint) => {
      livePrice = n;
    },
    setCostsReconciled: (value: boolean) => {
      costsReconciled = value;
    },
    changeOriginalEnd: async (rehash = true) => {
      if (terms !== null) {
        const changed = { ...terms, ends_at: iso("20:00:00") };
        terms = rehash
          ? { ...changed, terms_hash: await hash(C.committedTermsPreimageV2(changed)) }
          : changed;
      }
    },
    setRecovery: (v: Partial<RecoveryAuthority>) => {
      recovery = { ...recovery, ...v };
    },
    counts: () => ({ ids, authorizations, preflights, size: states.size }),
  };
}

describe("fake-port contribution application", () => {
  test("observation receipts acknowledge a private locator without asserting payment and replay after pause", async () => {
    const f = fixtureStore();
    const r = await f.create();
    const before = required(f.states.get(r.contribution_id));
    const request = {
      idempotency_key: "observation_key_0001",
      instruction_hash: r.instruction.instruction_hash,
      transaction_hash: `0x${"ab".repeat(32)}`,
    };
    const first = await run(
      f.service().execute("ObserveSongMegapotContributionV2", f.scope(r.contribution_id), request),
    );
    expect(first).toMatchObject({
      object: "contribution_observation_command_receipt",
      accepted_candidate_hash: request.transaction_hash,
    });
    expect(f.states.get(r.contribution_id)).toEqual(before);
    f.setRefusal("paused");
    expect(
      await run(
        f
          .service()
          .execute("ObserveSongMegapotContributionV2", f.scope(r.contribution_id), request),
      ),
    ).toEqual(first);
    await expect(
      run(
        f
          .service("b")
          .execute("ObserveSongMegapotContributionV2", f.scope(r.contribution_id), request),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  test("unknown instruction hints never become principal evidence", async () => {
    const f = fixtureStore();
    const r = await f.create();
    await expect(
      run(
        f.service().execute("ObserveSongMegapotContributionV2", f.scope(r.contribution_id), {
          idempotency_key: "unknown_hint_key_001",
          instruction_hash: "f".repeat(64),
          transaction_hash: `0x${"ab".repeat(32)}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "receipt_mismatch" });
    expect(f.states.get(r.contribution_id)?.nonceFinalized).toBe(false);
  });
  test("lost recovery ACK replays the original work identity without signing or releasing expiry liabilities", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    const request = {
      idempotency_key: "recover_original_key_01",
      expected_state_revision: 0,
      purpose: "reconcile_original",
    };
    f.loseCommit();
    await expect(
      run(
        f
          .service()
          .execute("RecoverSongMegapotContributionV2", f.scope(r.contribution_id), request),
      ),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    const replay = await run(
      f.service().execute("RecoverSongMegapotContributionV2", f.scope(r.contribution_id), request),
    );
    expect(replay).toMatchObject({
      object: "contribution_recovery_command_receipt",
      semantics: "reconcile_only_no_send",
    });
    expect(
      await run(
        f
          .service()
          .execute("RecoverSongMegapotContributionV2", f.scope(r.contribution_id), request),
      ),
    ).toEqual(replay);
    expect(f.states.get(r.contribution_id)?.nonceFinalized).toBe(false);
    const recovered = Schema.decodeUnknownSync(C.RecoveryReceiptV2)(replay);
    expect([...f.queuedWork]).toEqual([[recovered.work_item_id, recovered.command_id]]);
    expect(f.reconciliationCharges()).toBe(1);
  });
  test("otherwise valid rehashed prospectus must match context and command song identity", async () => {
    for (const change of [
      { community_id: "another_community" },
      { post_id: "another_post" },
      { canonical_song_id: "another_song" },
      { audio_revision: 2 },
    ]) {
      const f = fixtureStore();
      const q = await f.quote("a", "persona_a", async (c) => {
        if (c.quote.kind !== "prospective") throw new Error("Expected prospective fixture");
        const p = {
          ...c.quote.prospective_terms,
          target: { ...c.quote.prospective_terms.target, ...change },
        };
        return {
          ...c,
          quote: {
            kind: "prospective",
            prospective_terms: p,
            prospective_terms_hash: await hash(C.prospectiveTermsPreimageV2(p)),
          },
        };
      });
      await expect(f.create("a", "1000000", "contradictory_target_key", q)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(f.counts().ids).toBe(0);
      expect(f.states.size).toBe(0);
    }
  });
  test("rehashed prospective profile/funding facts and empty slot must agree with context reference", async () => {
    for (const change of [
      { profile_id: "other_profile" },
      { profile_hash: "b".repeat(64) },
      { funding_policy_hash: "b".repeat(64) },
    ]) {
      const f = fixtureStore();
      const q = await f.quote("a", "persona_a", async (c) => {
        if (c.quote.kind !== "prospective") throw new Error("Expected prospective fixture");
        const p = { ...c.quote.prospective_terms, ...change };
        return {
          ...c,
          quote: {
            kind: "prospective",
            prospective_terms: p,
            prospective_terms_hash: await hash(C.prospectiveTermsPreimageV2(p)),
          },
        };
      });
      await expect(f.create("a", "1000000", "contradictory_profile_key", q)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(f.counts().ids).toBe(0);
    }
    const f = fixtureStore();
    const q = await f.quote("a", "persona_a", async (c) => {
      if (c.target.kind !== "empty") throw new Error("Expected empty fixture");
      return { ...c, target: { ...c.target, slot_id: "other_slot" } };
    });
    await expect(f.create("a", "1000000", "contradictory_slot_key", q)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.counts().ids).toBe(0);
  });
  test("committed quote payload is rehashed before using its end, planned IDs or bindings", async () => {
    const changes: readonly ((terms: C.TermsV2) => C.TermsV2)[] = [
      (t) => ({ ...t, ends_at: iso("20:00:00") }),
      (t) => ({
        ...t,
        first_drawing_id: "102",
        planned_drawing_ids: t.planned_drawing_ids.slice(1),
      }),
      (t) => ({
        ...t,
        qualification_bindings: t.qualification_bindings.map((b, i) =>
          i === 0 ? { ...b, objective_id: "other_objective" } : b,
        ),
      }),
    ];
    for (const change of changes) {
      const f = fixtureStore();
      const first = await f.create();
      f.finalize(first);
      const q = await f.quote("a", "persona_a", async (c) => {
        if (c.quote.kind !== "committed") throw new Error("Expected committed fixture");
        return { ...c, quote: { ...c.quote, committed_terms: change(c.quote.committed_terms) } };
      });
      const before = f.counts();
      await expect(f.create("a", "1000000", "contradictory_terms_key", q)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(f.counts().ids).toBe(before.ids);
      expect(f.states.size).toBe(1);
    }
  });
  test("self-consistent rehashed quoted terms cannot replace the locked committed terms", async () => {
    const f = fixtureStore();
    const first = await f.create();
    f.finalize(first);
    const q = await f.quote("a", "persona_a", async (c) => {
      if (c.quote.kind !== "committed") throw new Error("Expected committed fixture");
      const altered = { ...c.quote.committed_terms, ends_at: iso("20:00:00") };
      const terms_hash = await hash(C.committedTermsPreimageV2(altered));
      return {
        ...c,
        quote: {
          kind: "committed",
          committed_terms: { ...altered, terms_hash },
          committed_terms_hash: terms_hash,
        },
      };
    });
    const before = f.counts();
    await expect(f.create("a", "1000000", "rehashed_terms_conflict", q)).rejects.toMatchObject({
      code: "terms_mismatch",
    });
    expect(f.counts().ids).toBe(before.ids);
    expect(f.states.size).toBe(1);
  });
  test("locked current terms integrity is checked before capacity even with a valid quoted packet", async () => {
    const f = fixtureStore();
    const first = await f.create();
    f.finalize(first);
    const q = await f.quote();
    await f.changeOriginalEnd(false);
    f.setCostsReconciled(false);
    const before = f.counts();
    await expect(f.create("a", "1000000", "bad_current_terms_key", q)).rejects.toMatchObject({
      code: "terms_mismatch",
    });
    expect(f.counts().ids).toBe(before.ids);
    expect(f.states.size).toBe(1);
  });
  test("A2/B2/A2 use same songwide pool/terms/end, fresh A needs no unsigned proof", async () => {
    const f = fixtureStore();
    const a = await f.create();
    f.finalize(a);
    const b = await f.create("b");
    f.finalize(b);
    const again = await f.create("a", "2000000", "new_contribution_key_02");
    expect(b.target).toEqual(a.target);
    expect(again.target).toEqual(a.target);
    expect(again.committed_terms).toEqual(a.committed_terms);
    expect(again.instruction.nonce).toBe("8");
    expect(again.funding_effect_id).not.toBe(a.funding_effect_id);
    await expect(f.create("b", "1000000", "over_capacity_key_01")).rejects.toMatchObject({
      code: "capacity_exhausted",
    });
  });
  test("same-key replay returns immutable receipt after pause/stale quote, changed body conflicts", async () => {
    const f = fixtureStore();
    const request = await f.quote();
    const r = await f.create("a", "2000000", "new_contribution_key_01", request);
    f.setRefusal("paused");
    f.setNow(iso("15:00:00"));
    f.setPolicyMissing();
    const before = f.counts();
    expect(await f.create("a", "2000000", "new_contribution_key_01", request)).toEqual(r);
    expect(f.counts().preflights).toBe(before.preflights);
    await expect(
      f.create("a", "1000000", "new_contribution_key_01", request),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  test("concurrent same-key misses serialize and replay before paused business guards", async () => {
    const f = fixtureStore();
    const q = await f.quote();
    f.pauseOnCommit();
    const [a, b] = await Promise.all([
      f.create("a", "1000000", "same_contribution_key_01", q),
      f.create("a", "1000000", "same_contribution_key_01", q),
    ]);
    expect(a).toEqual(b);
    expect(f.counts().size).toBe(1);
  });
  test("concurrent compatible empty creators bind one target and current remaining capacity", async () => {
    const f = fixtureStore();
    const qa = await f.quote("a"),
      qb = await f.quote("b");
    const [a, b] = await Promise.all([
      f.create("a", "4000000", "first_creator_key_001", qa),
      f.create("b", "2000000", "second_creator_key_01", qb),
    ]);
    expect(a.target).toEqual(b.target);
    expect(a.terms_hash).toBe(b.terms_hash);
  });
  test("lost create commit acknowledgement recovers original identity without another allocation", async () => {
    const f = fixtureStore();
    const q = await f.quote();
    f.loseCommit();
    await expect(f.create("a", "1000000", "lost_create_ack_key_01", q)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    const before = f.counts();
    const recovered = await f.create("a", "1000000", "lost_create_ack_key_01", q);
    expect(f.counts().ids).toBe(before.ids);
    expect(f.states.has(recovered.contribution_id)).toBe(true);
  });
  test("changed authoritative price invalidates old quote before allocating", async () => {
    const f = fixtureStore();
    const q = await f.quote();
    f.setLivePrice(900000n);
    await expect(f.create("a", "1000000", "stale_price_key_001", q)).rejects.toMatchObject({
      code: "context_stale",
    });
    expect(f.counts().ids).toBe(0);
  });
  test("concurrent empty quote cannot bind changed fixed end", async () => {
    const f = fixtureStore();
    const qb = await f.quote("b");
    await f.create();
    await f.changeOriginalEnd();
    await expect(f.create("b", "1000000", "wrong_origin_key_001", qb)).rejects.toMatchObject({
      code: "context_stale",
    });
    expect(f.states.size).toBe(1);
  });
  test("one fresh purpose grant, replay recovery_only, other tab/device cannot reclaim", async () => {
    const f = fixtureStore();
    const r = await f.create();
    const first = await f.claim(r);
    expect(first.delivery.kind).toBe("fresh_grant");
    f.setRefusal("paused");
    const replay = await f.claim(
      r,
      "claim_submission_key_01",
      "funding_transfer",
      r.instruction.instruction_hash,
      0,
    );
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.delivery.kind).toBe("recovery_only");
    await expect(f.claim(r, "another_device_key_01")).rejects.toMatchObject({
      code: "submission_already_claimed",
    });
  });
  test("racing devices receive at most one fresh submission grant", async () => {
    const f = fixtureStore();
    const r = await f.create();
    const make = (device: string) =>
      run(
        f
          .service()
          .execute("ClaimSongMegapotContributionSubmissionV2", f.scope(r.contribution_id), {
            idempotency_key: `device_claim_key_${device}`,
            client_instance_id: `client_instance_${device}`,
            submission_attempt_id: `submission_attempt_${device}`,
            purpose: "funding_transfer",
            expected_state_revision: 0,
            instruction_hash: r.instruction.instruction_hash,
          }),
      );
    const results = await Promise.allSettled([make("one"), make("two")]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const success = results.find((x) => x.status === "fulfilled");
    if (success?.status === "fulfilled")
      expect(asClaim(success.value).delivery.kind).toBe("fresh_grant");
    const rejected = results.find((x) => x.status === "rejected");
    if (rejected?.status === "rejected")
      expect(rejected.reason).toMatchObject({ code: "submission_already_claimed" });
  });
  test("claim rereads after the recovery fence: consumed purpose is distinct from another lifecycle change", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    const plan = await f.prepare(r);
    const beforeWinner = required(f.states.get(r.contribution_id));
    const winnerKey = "fenced_cancel_winner_01";
    const winner = await f.claim(r, winnerKey, "nonce_cancellation", plan.instruction_hash, 1);
    const winnerState = required(f.states.get(r.contribution_id));
    const charged = f.commandUpdateCharges();
    // Model the admissible read-then-wait interleaving: the first read sees the
    // old snapshot, then the existing authority fence observes winner commit.
    f.states.set(r.contribution_id, beforeWinner);
    f.atRecoveryLock(() => {
      f.states.set(r.contribution_id, winnerState);
    });
    await expect(
      f.claim(r, "fenced_cancel_loser_001", "nonce_cancellation", plan.instruction_hash, 1),
    ).rejects.toMatchObject({ code: "submission_already_claimed" });
    expect(f.commandUpdateCharges()).toBe(charged);
    expect(required(f.states.get(r.contribution_id)).cancellationGrant).toEqual(winner.receipt);
    f.setRecovery({
      policy: null,
      currentSigningRefusal: "paused",
      originalWalletStillOwned: false,
    });
    const replay = await f.claim(r, winnerKey, "nonce_cancellation", plan.instruction_hash, 1);
    expect(replay).toMatchObject({ receipt: winner.receipt, delivery: { kind: "recovery_only" } });
    await expect(
      f.claim(r, "fenced_cancel_loser_002", "nonce_cancellation", plan.instruction_hash, 1),
    ).rejects.toMatchObject({ code: "submission_already_claimed" });
    expect(f.commandUpdateCharges()).toBe(charged);

    const g = fixtureStore();
    const other = await g.create();
    g.setNow(iso("14:20:00"));
    const otherPlan = await g.prepare(other);
    const otherCharged = g.commandUpdateCharges();
    g.atRecoveryLock(() => g.finalize(other));
    await expect(
      g.claim(other, "fenced_lifecycle_00001", "nonce_cancellation", otherPlan.instruction_hash, 1),
    ).rejects.toMatchObject({ code: "lifecycle_changed" });
    expect(required(g.states.get(other.contribution_id)).cancellationGrant).toBeNull();
    expect(g.commandUpdateCharges()).toBe(otherCharged);
  });
  test("lost grant commit ACK consumes authority even if the app made zero provider calls", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.loseCommit();
    await expect(f.claim(r)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(
      (
        await f.claim(
          r,
          "claim_submission_key_01",
          "funding_transfer",
          r.instruction.instruction_hash,
          0,
        )
      ).delivery.kind,
    ).toBe("recovery_only");
    f.setNow(iso("15:00:00"));
    await expect(f.claim(r, "later_claim_key_001")).rejects.toMatchObject({
      code: "submission_already_claimed",
    });
  });
  test("funding expiry preserves liability and cannot reissue the original funding grant", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(r.instruction.expires_at);
    await expect(f.claim(r)).rejects.toMatchObject({ code: "instruction_expired" });
    await expect(f.create("a", "1000000", "fresh_while_unknown_01")).rejects.toMatchObject({
      code: "quote_expired",
    });
    expect(required(f.states.get(r.contribution_id)).nonceFinalized).toBe(false);
  });
  test("required economics/work are unavailable before any financial allocation", async () => {
    const f = fixtureStore();
    f.setPolicyMissing();
    await expect(f.create()).rejects.toMatchObject({ code: "policy_unavailable" });
    expect(f.counts().ids).toBe(0);
    const g = fixtureStore();
    g.setWork(0);
    await expect(g.create()).rejects.toMatchObject({ code: "work_budget_exhausted" });
    expect(g.counts().ids).toBe(0);
  });
  test("account-wide counter cannot be bypassed by another persona", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setMaxActive(1);
    const q = await f.quote("a", "second_persona");
    // Different owned wallet does not evade the same account limit.
    await expect(f.create("a", "1000000", "another_persona_key_01", q)).rejects.toMatchObject({
      code: "effect_limit",
    });
    expect(f.states.size).toBe(1);
    expect(r.instruction.from).toBe(`0x${"1".repeat(40)}`);
  });
  test("private contribution commands never grant another account original sender authority", async () => {
    const f = fixtureStore();
    const r = await f.create();
    await expect(
      run(
        f
          .service("b")
          .execute("PrepareSongMegapotContributionCancellationV2", f.scope(r.contribution_id), {
            idempotency_key: "foreign_private_key_01",
            expected_state_revision: 0,
            purpose: "cancel_original_nonce",
          }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("purpose-specific cancellation", () => {
  test("changed current attestation cannot authorize a stored plan; immutable preparation replay survives", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    const plan = await f.prepare(r);
    f.setRecovery({ attestationHash: "f".repeat(64) });
    await expect(
      f.claim(r, "changed_attestation_claim_01", "nonce_cancellation", plan.instruction_hash),
    ).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
    expect(await f.prepare(r, "cancellation_plan_key_01", 0)).toEqual(plan);
    expect(f.states.get(r.contribution_id)?.cancellationGrant).toBeNull();
  });
  test("expired funding can prepare cancellation without reviving funding or moving principal", async () => {
    const f = fixtureStore();
    const r = await f.create();
    const s = required(f.states.get(r.contribution_id));
    f.states.set(r.contribution_id, { ...s, fundingState: "expired_reconciling", revision: 3 });
    f.setNow(iso("14:20:00"));
    const plan = await f.prepare(r);
    expect(plan.nonce).toBe(r.instruction.nonce);
    expect(plan.sender).toBe(plan.recipient);
    expect(plan.original_funding_instruction_hash).toBe(r.instruction.instruction_hash);
    expect(plan.dispatch_expires_at).toBe(iso("14:23:00"));
    const claim = await f.claim(
      r,
      "cancellation_claim_key_01",
      "nonce_cancellation",
      plan.instruction_hash,
    );
    expect(claim.receipt.valid_until).toBe(plan.dispatch_expires_at);
    expect(claim.delivery.kind).toBe("fresh_grant");
    expect(required(f.states.get(r.contribution_id)).fundingState).toBe("expired_reconciling");
    expect(required(f.states.get(r.contribution_id)).receipt).toEqual(r);
    f.setNow(iso("15:00:00"));
    await expect(f.prepare(r, "cannot_regrant_key_01")).rejects.toMatchObject({
      code: "submission_already_claimed",
    });
  });
  test("unclaimed expired plan replacement links immutable history, old hash is stale", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    const old = await f.prepare(r);
    f.setNow(old.dispatch_expires_at);
    await expect(
      f.claim(r, "expired_plan_claim_01", "nonce_cancellation", old.instruction_hash),
    ).rejects.toMatchObject({ code: "cancellation_plan_expired" });
    const next = await f.prepare(r, "replacement_plan_key_01");
    expect(next.previous_preparation_id).toBe(old.preparation_id);
    expect(next.previous_preparation_instruction_hash).toBe(old.instruction_hash);
    expect(next.preparation_revision).toBe(2);
    await expect(
      f.claim(r, "stale_plan_claim_key_01", "nonce_cancellation", old.instruction_hash, 1),
    ).rejects.toMatchObject({ code: "cancellation_plan_stale" });
    f.setNow(next.dispatch_expires_at);
    await expect(f.prepare(r, "third_plan_key_0001")).rejects.toMatchObject({
      code: "cancellation_preparation_limit",
    });
  });
  test("lost cancellation preparation/grant ACK preserves exact plan and consumed purpose", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    f.loseCommit();
    await expect(f.prepare(r)).rejects.toMatchObject({ code: "outcome_unknown" });
    const plan = await f.prepare(r, "cancellation_plan_key_01", 0);
    f.loseCommit();
    await expect(
      f.claim(r, "lost_cancel_grant_001", "nonce_cancellation", plan.instruction_hash),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    // Current authority may disappear after the immutable grant committed.
    f.setRecovery({ policy: null });
    const recovered = await f.claim(
      r,
      "lost_cancel_grant_001",
      "nonce_cancellation",
      plan.instruction_hash,
      1,
    );
    expect(recovered.delivery.kind).toBe("recovery_only");
    await expect(
      f.claim(r, "no_second_grant_key_01", "nonce_cancellation", plan.instruction_hash),
    ).rejects.toMatchObject({ code: "submission_already_claimed" });
  });
  test("missing recovery authority refuses; funding expiry is never recovery TTL", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    f.setRecovery({ policy: null });
    await expect(f.prepare(r)).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
    expect(required(f.states.get(r.contribution_id)).cancellationHead).toBeNull();
  });
  test("retired current evidence blocks a fresh cancel claim but not immutable plan replay", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    const plan = await f.prepare(r);
    const before = required(f.states.get(r.contribution_id));
    // The original snapshot and plan still have future attestation validity.
    // The trusted port can no longer verify CURRENT attestation/nonce evidence.
    f.setRecovery({ policy: null });
    expect(plan.recovery_attestation_valid_until > plan.prepared_at).toBe(true);
    await expect(
      f.claim(r, "retired_current_claim_01", "nonce_cancellation", plan.instruction_hash),
    ).rejects.toMatchObject({ code: "cancellation_recovery_unavailable" });
    expect(await f.prepare(r, "cancellation_plan_key_01", 0)).toEqual(plan);
    expect(f.states.get(r.contribution_id)).toEqual(before);
    f.setNow(plan.dispatch_expires_at);
    await expect(f.prepare(r, "no_current_replacement_01")).rejects.toMatchObject({
      code: "cancellation_recovery_unavailable",
    });
    expect(f.states.get(r.contribution_id)).toEqual(before);
  });
  test("final nonce winner prevents later cancellation grant and preserves funding instruction", async () => {
    const f = fixtureStore();
    const r = await f.create();
    f.setNow(iso("14:20:00"));
    const plan = await f.prepare(r);
    // Shared interpreter adapter is deferred. This fixture supplies its finalized transfer outcome.
    f.finalize(r);
    await expect(
      f.claim(r, "after_nonce_race_key_01", "nonce_cancellation", plan.instruction_hash),
    ).rejects.toMatchObject({ code: "lifecycle_changed" });
    expect(required(f.states.get(r.contribution_id)).receipt.instruction).toEqual(r.instruction);
    expect(required(f.states.get(r.contribution_id)).cancellationGrant).toBeNull();
  });
});
