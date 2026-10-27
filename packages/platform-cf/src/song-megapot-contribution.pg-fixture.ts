/** Synthetic SQL fixture shared by persistence and isolated purpose tests.
 * This selects no real policy, wallet, provider or financial authority. */
import { Effect, Schema } from "effect";
import type { Client } from "pg";
import { digestFundingPreimageV2 } from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";

const h = "a".repeat(64),
  token = `0x${"22".repeat(20)}`,
  custody = `0x${"33".repeat(20)}`;
const sender = (a: string) => `0x${(a === "a" ? "11" : "44").repeat(20)}`;
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const digest = (s: string) => Effect.runPromise(digestFundingPreimageV2(s));

export async function seedSongContributionFixture(
  admin: Client,
  options?: { accountsAlreadyBorn?: boolean; environment?: "test" | "staging" },
) {
  let terms: C.TermsV2;
  let target: C.CommittedTargetV2;
  let start: number;
  start = Date.now();
  const iso = (n: number) => new Date(start + n).toISOString();
  target = {
    kind: "committed",
    community_id: "community",
    post_id: "post",
    canonical_song_id: "song",
    audio_revision: 1,
    offer_id: "offer",
    pool_leg_id: "leg",
  };
  const bindings = ["study", "karaoke", "dance"].map((activity) => ({
    template_key: `template-${activity}`,
    activity,
    grading_family: activity === "dance" ? "moderator_verdict" : "numeric",
    qualification_policy_id: `policy-${activity}`,
    qualification_policy_hash: h,
    numeric_floor_bps: activity === "dance" ? null : 7000,
    choreography_scope: activity === "dance" ? "any_policy_accepted" : "not_applicable",
    admission_id: `admission-${activity}`,
    admission_hash: h,
    disclosure_version: "fixture",
    binding_id: `binding-${activity}`,
    objective_id: `objective-${activity}`,
    offer_id: "offer",
    leg_id: "leg",
  }));
  const bindingHash = await digest(
    C.fundingHashPreimageV2(
      "pirate.shared-song-qualification-bindings.v1",
      bindings.map((b) =>
        C.projectQualificationBinding(Schema.decodeUnknownSync(C.QualificationBindingV2)(b)),
      ),
    ),
  );
  terms = Schema.decodeUnknownSync(C.TermsV2)({
    version: "shared-song-megapot-v2",
    profile_id: "profile",
    profile_hash: h,
    terms_hash: h,
    funding_policy_revision: 1,
    funding_policy_hash: h,
    budget_source: "leg_budget",
    empty_behavior: "no_purchase",
    eligible_activities: ["study", "karaoke", "dance"],
    dance_scope: "any_policy_accepted",
    starts_at: iso(-60_000),
    ends_at: iso(21_600_000),
    first_drawing_id: "101",
    last_planned_drawing_id: "106",
    ticket_price_ceiling_atomic: "1000000",
    disclosure_version: "fixture",
    origin_prospective_terms_hash: h,
    origin_slot_generation: 0,
    reward_policy_hash: h,
    qualification_bindings: bindings,
    qualification_bindings_hash: bindingHash,
    planned_drawing_ids: ["101", "102", "103", "104", "105", "106"],
    planned_schedule_hash: h,
  });
  terms = { ...terms, terms_hash: await digest(C.committedTermsPreimageV2(terms)) };
  await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
  try {
    for (const [index, a] of ["a", "b"].entries()) {
      if (!options?.accountsAlreadyBorn)
        await admin.query("INSERT INTO users(user_id) VALUES($1)", [a]);
      await admin.query("INSERT INTO personas(persona_id,account_id) VALUES($1,$2)", [
        `persona-${a}`,
        a,
      ]);
      await admin.query(
        "INSERT INTO persona_wallet_assignments(assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,address,status,reservation_idempotency_key,assigned_at,created_at,updated_at) VALUES($1,$2,$3,'evm',$4,$5,'active',$1,now(),now(),now())",
        [
          `wallet-${a}`,
          `persona-${a}`,
          a,
          index + (options?.accountsAlreadyBorn ? 1 : 0),
          sender(a),
        ],
      );
      await admin.query(
        "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES($1,$2,'community','activity_participation')",
        [`persona-${a}`, a],
      );
    }
    await admin.query("SET LOCAL session_replication_role=origin; COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
  await admin.query(
    "SELECT set_reward_operations_paused_v1(revision,FALSE,'isolated_cp3_fixture') FROM reward_operations_control WHERE singleton",
  );
  const policy = {
    reconciliation: {
      maxAttempts: 3,
      leaseMs: 60_000,
      maximumBlocks: 10,
      maximumLogs: 5,
      receipt: {
        policyHash: h,
        requiredConfirmations: 1,
        maximumClockSkewMs: 1000,
        maximumObservationAgeMs: 120_000,
      },
    },
    maxActiveAccount: 4,
    maxActiveAccountLeg: 4,
    maxLegLiabilities: 10,
    maxAdmittedLeg: 10,
    maxAdmittedAccountLeg: 10,
    workPerInstruction: 10,
    economicsPolicyHash: h,
    gasPolicyHash: h,
    custodyPolicyHash: h,
  };
  let recoveryPolicy = Schema.decodeUnknownSync(C.CancellationRecoveryPolicyV2)({
    object: "nonce_cancellation_recovery_policy",
    version: "nonce-cancellation-recovery-v1",
    policy_id: "fixture-recovery",
    policy_hash: h,
    chain_id: 84532,
    valid_from: iso(-60_000),
    valid_until: iso(86_400_000),
    dispatch_ttl_seconds: 180,
    max_preparations_per_contribution: 2,
    fee_policy_id: "fixture-fee",
    fee_policy_hash: h,
    attestation_contract_version: "megapot-v2-current-recovery-v1",
  });
  recoveryPolicy = {
    ...recoveryPolicy,
    policy_hash: await digest(C.cancellationPolicyPreimageV2(recoveryPolicy)),
  };
  await admin.query(
    "INSERT INTO megapot_deployment_attestations(attestation_id,environment,chain_id,jackpot_address,usdc_address,ticket_nft_address,custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,ticket_nft_code_hash,attestation_block_number,attestation_block_hash,abi_version,status,verified_at) VALUES('attestation',$8,84532,$1,$2,$3,$4,$5,$6,$6,$6,$6,1,$6,'megapot_v2','active',$7)",
    [
      `0x${"55".repeat(20)}`,
      token,
      `0x${"66".repeat(20)}`,
      custody,
      `0x${"77".repeat(20)}`,
      `0x${h}`,
      iso(-60_000),
      options?.environment ?? "test",
    ],
  );
  const capacity = {
    maxDrawings: 6,
    reservationMs: 60_000,
    safetyMarginMs: 1_000,
    maximumWitnessAgeMs: 120_000,
    validUntil: start + 86_400_000,
    attestationValidUntil: start + 86_400_000,
    priceCeilingAtomic: "1000000",
    minimumAtomic: "1000000",
  };
  await admin.query(
    "INSERT INTO reward_funding_profiles_v2(profile_id,profile_hash,accepted,valid_until,policy,capacity_profile,nonce_policy,recovery_policy) VALUES('profile',$1,TRUE,$2,$3,$4,$5,$6)",
    [
      h,
      iso(86_400_000),
      json(policy),
      json(capacity),
      json({ hash: h, maxAgeMs: 120_000 }),
      json(recoveryPolicy),
    ],
  );
  await admin.query(
    "INSERT INTO reward_song_slots_v2(slot_id,community_id,post_id,generation,target,terms,reward_policy_ready,status) VALUES('slot','community','post',1,$1,$2,TRUE,'open')",
    [json(target), json(terms)],
  );
  for (const [scope, key] of [
    ["account", "a"],
    ["account", "b"],
    ["leg", "leg"],
    ["global", "funding"],
  ])
    await admin.query(
      "INSERT INTO reward_funding_work_envelopes_v2 VALUES($1,$2,$3,'profile',NULL,100,0,0,$4,NULL)",
      [`${scope}:${key}`, scope, key, iso(86_400_000)],
    );
  async function request(a: string, key: string, nonce = "4") {
    const now = Date.now();
    const iso = (n: number) => new Date(now + n).toISOString();
    const id = `${a}:${key}`;
    const actor: C.OwnedActorV2 = {
      account_id: a,
      community_id: "community",
      persona_id: `persona-${a}`,
      wallet_assignment_id: `wallet-${a}`,
      wallet_index: (a === "a" ? 0 : 1) + (options?.accountsAlreadyBorn ? 1 : 0),
      sender_address: sender(a),
    };
    const schedule: C.ScheduleWitnessV2 = {
      schedule_witness_id: id,
      version: "song-megapot-schedule-v1",
      rule_id: "fixture-initialized-rows",
      contract_code_hash: h,
      cadence_seconds: "3600",
      rule_hash: h,
      price_rule_hash: h,
      valid_until: iso(120_000),
      anchor: {
        chain_id: 84532,
        finality_policy_id: "fixture-finality",
        attestation_id: "attestation",
        block_number: "20",
        block_hash: `0x${h}`,
        block_timestamp: iso(-1_000),
        observed_at: iso(0),
        attestation_hash: h,
      },
      rows: terms.planned_drawing_ids.map((drawing_id, index) => ({
        drawing_id,
        drawing_time: new Date(start + (index + 1) * 3_600_000).toISOString(),
        entry_cutoff_at: new Date(start + (index + 1) * 3_600_000 - 60_000).toISOString(),
        purchase_deadline_at: new Date(start + (index + 1) * 3_600_000 - 30_000).toISOString(),
        price_atomic: "1000000",
        price_ceiling_atomic: "1000000",
        initialized: true,
        proof_kind: "initialized_state",
      })),
    };
    let c = Schema.decodeUnknownSync(C.ContextReadyV2)({
      object: "song_megapot_funding_context",
      version: 2,
      readiness: "ready",
      context_hash: h,
      context_expires_at: iso(60_000),
      lifecycle_revision: 0,
      target,
      actor,
      schedule,
      limits: {
        profile_id: "profile",
        minimum_atomic: "1000000",
        maximum_atomic: "6000000",
        usable_capacity_atomic: "6000000",
        capacity_revision: 0,
        max_admitted_effects_per_leg: 10,
        remaining_effect_slots: 10,
        account_pending_slots_available: 4,
        fee_policy_id: "fixture-fee",
        reservation_ttl_seconds: 60,
        latest_allocation_at: iso(60_000),
        reservation_deadline_upper_bound: iso(121_000),
      },
      chain_id: 84532,
      token_address: token,
      custody_address: custody,
      attestation_id: "attestation",
      fees: {
        inbound_payer: "selected_persona_wallet",
        outbound_policy_id: "fixture-fee",
        gas_ready: true,
      },
      context_ref: {
        version: "funding-context-reference-v1",
        slot_id: "slot",
        slot_generation: 1,
        leg_snapshot_id: id,
        schedule_witness_id: id,
        profile_id: "profile",
        profile_hash: h,
        funding_policy_hash: h,
        wallet_assignment_id: `wallet-${a}`,
        wallet_assignment_revision: 1,
        lifecycle_revision: 0,
      },
      quote: {
        kind: "committed",
        committed_terms: terms,
        committed_terms_hash: terms.terms_hash,
      },
      submission_protocol: "single_fresh_delivery_v1",
    });
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
      context_hash: await digest(
        C.fundingHashPreimageV2("pirate.song-megapot-funding-context.v2", [
          C.projectContextReference(c.context_ref),
          C.projectTarget(c.target),
          C.projectOwnedActor(c.actor),
          c.chain_id,
          c.token_address,
          c.custody_address,
          c.attestation_id,
          c.quote.kind,
          terms.terms_hash,
          keys.map((k) => [k, c.limits[k]]),
          c.context_expires_at,
        ]),
      ),
    };
    const witnessed = {
      observedAt: now,
      validUntil: now + 120_000,
      ruleHash: h,
      priceRuleHash: h,
      recurrenceProven: false,
      rows: schedule.rows.map((r) => ({
        id: r.drawing_id,
        drawingTime: Date.parse(r.drawing_time),
        entryCutoff: Date.parse(r.entry_cutoff_at),
        purchaseDeadline: Date.parse(r.purchase_deadline_at),
        priceAtomic: r.price_atomic,
        proof: r.proof_kind,
        state: "uncommitted",
        reservedCostAtomic: "0",
      })),
    };
    const nonceWitness = {
      // Distinct chain observations/reservations have distinct valid witness
      // identities. Exact command replay reuses this original body/snapshot.
      id: await digest(C.fundingHashPreimageV2("fixture.nonce-witness.v2", [id, a, nonce, now, h])),
      chainId: 84532,
      senderAddress: sender(a),
      observedAtMs: now,
      confirmed: { nonce, blockNumber: "20", blockHash: h },
      pending: { nonce, baseBlockNumber: "20", baseBlockHash: h },
    };
    const funded = (
      await admin.query(
        "SELECT coalesce(sum(amount_atomic),0)::text AS n FROM reward_incoming_receipts_v2 WHERE category='pool_principal'",
      )
    ).rows[0].n;
    await admin.query(
      "INSERT INTO reward_funding_schedule_witnesses_v2(witness_id,profile_id,witness_hash,schedule,nonce_witness,valid_until) VALUES($1,'profile',$2,$3,$4,$5)",
      [id, h, json(witnessed), json(nonceWitness), iso(120_000)],
    );
    await admin.query(
      "INSERT INTO reward_funding_leg_snapshots_v2(snapshot_id,slot_id,profile_id,witness_id,context_hash,context,budget,costs_reconciled,recovery_authority) VALUES($1,'slot','profile',$1,$2,$3,$4,TRUE,$5)",
      [
        id,
        c.context_hash,
        json(c),
        json({
          funded,
          spent: "0",
          committedPurchases: "0",
          refunded: "0",
          otherObligations: "0",
          liveInboundReservations: "0",
        }),
        json({
          policy: null,
          attestationId: "attestation",
          attestationHash: h,
          attestationValidUntil: iso(86_400_000),
          originalWalletStillOwned: true,
          currentSigningRefusal: null,
          boundedWorkAvailable: true,
        }),
      ],
    );
    return {
      version: 2,
      idempotency_key: key,
      persona_id: `persona-${a}`,
      funding_amount_atomic: "2000000",
      expected_context_hash: c.context_hash,
      expected_lifecycle_revision: 0,
      context_version: c.context_ref.version,
      context_slot_id: c.context_ref.slot_id,
      context_slot_generation: c.context_ref.slot_generation,
      context_leg_snapshot_id: c.context_ref.leg_snapshot_id ?? "",
      context_schedule_witness_id: c.context_ref.schedule_witness_id,
      context_profile_id: c.context_ref.profile_id,
      context_profile_hash: c.context_ref.profile_hash,
      context_funding_policy_hash: c.context_ref.funding_policy_hash,
      context_wallet_assignment_id: c.context_ref.wallet_assignment_id,
      context_wallet_assignment_revision: c.context_ref.wallet_assignment_revision,
      context_lifecycle_revision: c.context_ref.lifecycle_revision,
      expected_terms_kind: "committed",
      expected_terms_hash: terms.terms_hash,
    };
  }
  return { terms, target, start, request };
}
