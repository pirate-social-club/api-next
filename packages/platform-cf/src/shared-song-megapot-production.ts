import { Cause, Effect, Exit, type Layer, Schema } from "effect";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import {
  buildSongMegapotFundingContext,
  openSongFundingPolicyHashV2,
  SongFundingContextFactsSchema,
} from "../../application/src/rewards/song-megapot-context.ts";
import {
  digestFundingPreimageV2,
  SongContributionFailure,
} from "../../application/src/rewards/song-megapot-contributions.ts";
import type { FrozenSongMegapotDrawing } from "../../application/src/rewards/song-megapot-frozen-plan.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import type { DrawingCapacityRow } from "../../domain/src/song-megapot-capacity.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import {
  type MegapotV2DeploymentAttestation,
  validateMegapotV2DeploymentAttestation,
} from "./megapot-v2.ts";
import type { MegapotV2FullRpcClient } from "./megapot-v2-rpc.ts";
import { loadFrozenSharedSongDrawing } from "./shared-song-frozen-plan.ts";
import {
  hasSharedSongSuccessorFundingWindow,
  projectSharedSongSuccessor,
  SHARED_SONG_SUCCESSOR_PRICE_RULE,
  SHARED_SONG_SUCCESSOR_RULE,
  SHARED_SONG_SUCCESSOR_RULE_ID,
} from "./shared-song-successor-schedule.ts";

const unavailable = (code: SongContributionFailure["code"]) =>
  new SongContributionFailure({ code });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
    catch: () => unavailable("policy_unavailable"),
  });
const stringify = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
const call = Effect.fn("SharedSongProduction.call")(function* (
  db: Pick<ControlPlaneTransaction, "execute">,
  label: string,
  sql: string,
  values: readonly unknown[],
  readonly = false,
) {
  const result = yield* db.execute<{ packet: unknown }>({ label, text: sql, values, readonly });
  if (
    result.rows.length !== 1 ||
    result.rows[0] === undefined ||
    !Object.hasOwn(result.rows[0], "packet")
  )
    return yield* unavailable("outcome_unknown");
  return result.rows[0].packet;
});

/** Actual policy_versions/claim uniqueness producer inside the original command
 * transaction. The template is independently admitted immutable data. There is
 * no membership/funder/owner selector, replacement nonce or new claim evaluator.
 */
export const instantiateSharedSongRewardPolicyIn = Effect.fn(
  "SharedSongProduction.instantiatePolicy",
)(function* (
  db: ControlPlaneTransaction,
  identity: { accountId: string; communityId: string },
  snapshotId: string,
  offerId: string,
  templateHash: string,
) {
  const packet = yield* call(
    db,
    "shared-song.policy.template",
    "SELECT jsonb_build_object('reward_policy',load_shared_song_reward_template_v2($1,$2)->'reward_policy') AS packet",
    [snapshotId, templateHash],
    false,
  );
  const template = yield* decode(
    Schema.Struct({ reward_policy: Schema.Record(Schema.String, Schema.Unknown) }),
    packet,
  );
  const policy = {
    ...template.reward_policy,
    community_id: identity.communityId,
    offer_id: offerId,
    uniqueness: { kind: "single_authority", authority_id: offerId },
  };
  const hash = yield* canonicalBodyHash(policy).pipe(
    Effect.mapError(() => unavailable("policy_unavailable")),
  );
  const result = yield* call(
    db,
    "shared-song.policy.instantiate",
    "SELECT instantiate_shared_song_reward_policy_v2($1::jsonb,$2,$3,$4,$5::jsonb,$6) AS packet",
    [JSON.stringify(identity), snapshotId, offerId, templateHash, JSON.stringify(policy), hash],
  );
  if (result !== hash) return yield* unavailable("outcome_unknown");
  return hash;
});

const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Natural.check(Schema.isGreaterThan(0));
const Operations = Schema.Struct({
  emptyBehavior: Schema.optionalKey(
    Schema.Literals([
      "no_purchase",
      "single_funder_ticket_first_v1",
      "safe_treasury_ticket_first_v1",
    ]),
  ),
  disclosureVersion: C.IdV2,
  feePolicyId: C.IdV2,
  scheduleRuleId: C.IdV2,
  scheduleRuleHash: C.HashV2,
  priceRuleHash: C.HashV2,
  finalityPolicyId: C.IdV2,
  cadenceSeconds: C.AtomicV2,
  entryCutoffSeconds: Positive,
  purchaseLeadSeconds: Positive,
  maximumContextAttempts: Positive,
  contextLeaseMs: Positive,
  maximumContextWorkPerAccount: Positive,
  maximumContextWorkGlobal: Positive,
  contextWorkPerAttempt: Positive,
  inboundRequiredGasWei: C.AtomicV2,
  refundEnvelopeMinimumWei: C.AtomicV2,
  legalActivationGate: Schema.Literals(["test_only", "production_approved"]),
  initializedDrawingIds: Schema.Array(C.UIntV2).check(Schema.isMaxLength(30)),
});
const Candidate = Schema.Struct({
  workId: C.IdV2,
  token: C.IdV2,
  attempt: Positive,
  templateHash: C.HashV2,
  profileId: C.IdV2,
  validUntil: C.InstantV2,
  noncePolicy: Schema.Struct({ hash: C.HashV2, maxAgeMs: Positive }),
  operations: Operations,
  deployment: Schema.Unknown,
  attestationBlock: C.UIntV2,
  attestationBlockHash: C.TxHashV2,
  facts: Schema.Record(Schema.String, Schema.Unknown),
  qualificationDocuments: Schema.Array(
    Schema.Struct({
      policyId: C.IdV2,
      activity: Schema.Literals(["study", "karaoke", "dance"]),
      kind: C.IdV2,
      document: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ).check(Schema.isMinLength(3), Schema.isMaxLength(3)),
  drawingStates: Schema.Array(
    Schema.Struct({
      drawingId: C.UIntV2,
      state: Schema.Literals(["uncommitted", "committed", "settled", "cancelled"]),
      reservedCostAtomic: C.UIntV2,
      entryCutoffAtMs: Natural,
    }),
  ),
});
type Candidate = typeof Candidate.Type;
type ContextRpc = Pick<
  MegapotV2FullRpcClient,
  | "deployment"
  | "attestDeploymentAt"
  | "readHead"
  | "readBlock"
  | "readCurrentDrawingId"
  | "readDrawing"
  | "readDrawingRecurrence"
  | "readTransactionCount"
  | "readPendingNonce"
  | "readNativeBalance"
>;

/** Concrete read-only-provider producer. No provider access occurs inside any
 * database transaction. A durable bounded attempt precedes reads; uncertainty
 * retains that charge and cannot mint a signing or cancellation permission.
 */
export function makeControlPlaneSharedSongContextProducer(input: {
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  rpcFor: (deployment: MegapotV2DeploymentAttestation) => ContextRpc;
  now: () => string;
}) {
  const provided = <A, E>(effect: Effect.Effect<A, E | ControlPlaneError, ControlPlaneDb>) =>
    effect.pipe(Effect.provide(input.runtime));
  const txCall = (label: string, sql: string, values: readonly unknown[]) =>
    provided(withRetainedControlPlaneCommandTransaction((db) => call(db, label, sql, values)));
  const read = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: () => unavailable("outcome_unknown") });
  const produce = Effect.fn("SharedSongContext.produce")(function* (work: Candidate) {
    const deployment = yield* Effect.try({
      try: () =>
        validateMegapotV2DeploymentAttestation(work.deployment as MegapotV2DeploymentAttestation),
      catch: () => unavailable("attestation_unavailable"),
    });
    const rpc = input.rpcFor(deployment),
      attest = rpc.attestDeploymentAt;
    if (
      attest === undefined ||
      rpc.deployment === undefined ||
      [
        "attestationId",
        "environment",
        "chainId",
        "jackpotAddress",
        "ticketNftAddress",
        "usdcAddress",
        "custodyAddress",
        "referrerAddress",
        "jackpotCodeHash",
        "ticketNftCodeHash",
        "usdcCodeHash",
      ].some((key) => {
        const k = key as keyof MegapotV2DeploymentAttestation;
        return rpc.deployment?.[k] !== deployment[k];
      })
    )
      return yield* unavailable("attestation_unavailable");
    const templates = yield* decode(
      Schema.Array(C.QualificationTemplateV2),
      work.facts.qualificationTemplates,
    );
    for (const template of templates) {
      const document = work.qualificationDocuments.find(
        (q) => q.policyId === template.qualification_policy_id && q.activity === template.activity,
      );
      if (document === undefined) return yield* unavailable("mixed_objective_unavailable");
      const { policy_hash: _hash, ...body } = document.document;
      const hash = yield* canonicalBodyHash([
        "pirate.shared-song-qualification-policy.v1",
        document.policyId,
        document.activity,
        document.kind,
        body,
      ]).pipe(Effect.mapError(() => unavailable("policy_unavailable")));
      if (
        hash !== template.qualification_policy_hash ||
        (template.activity === "dance" && document.document.policy_hash !== hash)
      )
        return yield* unavailable("mixed_objective_unavailable");
    }
    const actor = yield* decode(C.OwnedActorV2, work.facts.actor);
    const canonicalTarget = yield* decode(C.TargetV2, work.facts.slot);
    const existingTerms =
      work.facts.committedTerms === null
        ? null
        : yield* decode(C.TermsV2, work.facts.committedTerms);
    if ((canonicalTarget.kind === "committed") !== (existingTerms !== null))
      return yield* unavailable("terms_mismatch");
    const successor = work.operations.scheduleRuleId === SHARED_SONG_SUCCESSOR_RULE_ID;
    if (successor) {
      const rule = SHARED_SONG_SUCCESSOR_RULE;
      const ruleHash = yield* canonicalBodyHash(["pirate.shared-song-schedule-rule.v2", rule]);
      const priceHash = yield* canonicalBodyHash([
        "pirate.shared-song-price-rule.v2",
        SHARED_SONG_SUCCESSOR_PRICE_RULE,
      ]);
      if (
        work.operations.scheduleRuleHash !== ruleHash ||
        work.operations.priceRuleHash !== priceHash ||
        work.operations.cadenceSeconds !== String(rule.durationSeconds) ||
        work.operations.entryCutoffSeconds !== rule.entryCutoffSeconds ||
        work.operations.purchaseLeadSeconds !== rule.purchaseLeadSeconds ||
        deployment.environment === "production" ||
        deployment.chainId !== rule.chainId ||
        deployment.jackpotAddress !== rule.jackpotAddress ||
        deployment.jackpotCodeHash !== rule.jackpotCodeHash ||
        work.operations.legalActivationGate !== "test_only" ||
        work.operations.initializedDrawingIds.length !== 0
      )
        return yield* unavailable("schedule_unproven");
    }
    const head = yield* read(() => rpc.readHead());
    const originalAnchor = yield* read(() => rpc.readBlock(BigInt(work.attestationBlock)));
    if (
      originalAnchor.blockHash !== work.attestationBlockHash ||
      head.blockTimestamp === undefined ||
      head.blockNumber < BigInt(work.attestationBlock)
    )
      return yield* unavailable("attestation_unavailable");
    yield* read(() => attest(head.blockNumber));
    const confirmed = yield* read(() =>
      rpc.readTransactionCount(actor.sender_address, head.blockNumber),
    );
    const pending = yield* read(() => rpc.readPendingNonce(actor.sender_address));
    if (confirmed !== pending || confirmed < 0n || confirmed > 9223372036854775807n)
      return yield* unavailable("wallet_nonce_busy");
    const currentId = yield* read(() => rpc.readCurrentDrawingId(head.blockNumber));
    const ids =
      existingTerms !== null
        ? existingTerms.planned_drawing_ids
        : successor
          ? [(currentId + 1n).toString()]
          : [...new Set([currentId.toString(), ...work.operations.initializedDrawingIds])];
    if (ids.length > 30) return yield* unavailable("schedule_unproven");
    const observations: DrawingCapacityRow[] = [];
    const plans: FrozenSongMegapotDrawing[] = [];
    let projected: FrozenSongMegapotDrawing | null = null;
    if (successor && (existingTerms === null || ids.some((id) => BigInt(id) === currentId + 1n))) {
      const recurrence = rpc.readDrawingRecurrence;
      if (recurrence === undefined) return yield* unavailable("schedule_unproven");
      const current = yield* read(() => rpc.readDrawing(currentId, head.blockNumber));
      const settings = yield* read(() => recurrence(head.blockNumber));
      projected = projectSharedSongSuccessor({
        deployment,
        currentId,
        current,
        recurrence: settings,
      });
      if (projected === null) return yield* unavailable("schedule_unproven");
    }
    for (const id of ids) {
      const existing = work.drawingStates.find((prior) => prior.drawingId === id);
      let plan: FrozenSongMegapotDrawing;
      if (existingTerms !== null && canonicalTarget.kind === "committed") {
        const frozen = yield* provided(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* loadFrozenSharedSongDrawing(db, canonicalTarget.pool_leg_id, BigInt(id));
          }),
        );
        if (frozen === null) return yield* unavailable("schedule_unproven");
        plan = frozen;
        if (plan.proofKind === "attested_recurrence" && !successor)
          return yield* unavailable("schedule_unproven");
      } else if (projected !== null && projected.drawingId === id) plan = projected;
      else {
        const row = yield* read(() => rpc.readDrawing(BigInt(id), head.blockNumber));
        const time = Number(row.drawingTime * 1000n);
        if (
          row.ticketPrice <= 0n ||
          !Number.isSafeInteger(time) ||
          time > 8640000000000000 ||
          (row.jackpotLock && (existing === undefined || existing.state === "uncommitted"))
        )
          return yield* unavailable("schedule_unproven");
        plan = {
          drawingId: id,
          drawingTimeMs: time,
          entryCutoffAtMs: time - work.operations.entryCutoffSeconds * 1000,
          purchaseDeadlineAtMs: time - work.operations.purchaseLeadSeconds * 1000,
          priceAtomic: row.ticketPrice,
          proofKind: "initialized_state",
        };
      }
      if (existingTerms !== null) {
        if (
          BigInt(id) === currentId ||
          (!successor && work.operations.initializedDrawingIds.includes(id))
        ) {
          const row = yield* read(() => rpc.readDrawing(BigInt(id), head.blockNumber));
          if (
            row.drawingTime * 1000n !== BigInt(plan.drawingTimeMs) ||
            row.ticketPrice !== plan.priceAtomic ||
            (row.jackpotLock && (existing === undefined || existing.state === "uncommitted"))
          )
            return yield* unavailable("schedule_unproven");
        } else if (
          projected === null ||
          plan.proofKind !== "attested_recurrence" ||
          projected.drawingId !== plan.drawingId ||
          projected.drawingTimeMs !== plan.drawingTimeMs ||
          projected.priceAtomic !== plan.priceAtomic
        )
          return yield* unavailable("schedule_unproven");
      }
      if (
        plan.entryCutoffAtMs !== plan.drawingTimeMs - work.operations.entryCutoffSeconds * 1000 ||
        plan.purchaseDeadlineAtMs !==
          plan.drawingTimeMs - work.operations.purchaseLeadSeconds * 1000 ||
        (existing !== undefined && existing.entryCutoffAtMs !== plan.entryCutoffAtMs)
      )
        return yield* unavailable("schedule_unproven");
      plans.push(plan);
      observations.push({
        id,
        drawingTime: plan.drawingTimeMs,
        entryCutoff: plan.entryCutoffAtMs,
        purchaseDeadline: plan.purchaseDeadlineAtMs,
        priceAtomic: plan.priceAtomic,
        proof: plan.proofKind,
        state: existing?.state ?? "uncommitted",
        reservedCostAtomic: BigInt(existing?.reservedCostAtomic ?? "0"),
      });
    }
    const nativeGas = yield* read(() =>
      rpc.readNativeBalance(actor.sender_address, head.blockNumber),
    );
    const refundNativeGas = yield* read(() =>
      rpc.readNativeBalance(deployment.custodyAddress, head.blockNumber),
    );
    const pendingAfter = yield* read(() => rpc.readPendingNonce(actor.sender_address));
    // A new head is normal while these bounded reads run. Re-read the pinned
    // height to reject a replaced snapshot block without requiring a quiet chain.
    const after = yield* read(() => rpc.readBlock(head.blockNumber));
    const now = yield* decode(C.InstantV2, input.now()),
      observed = Date.parse(now),
      headMs = Number(head.blockTimestamp * 1000n);
    if (
      head.blockHash !== after.blockHash ||
      head.blockNumber !== after.blockNumber ||
      head.blockTimestamp !== after.blockTimestamp ||
      !Number.isSafeInteger(headMs) ||
      headMs > observed ||
      observed - headMs > work.noncePolicy.maxAgeMs
    )
      return yield* unavailable("observation_stale");
    if (pendingAfter !== confirmed) return yield* unavailable("wallet_nonce_busy");
    if (
      nativeGas < BigInt(work.operations.inboundRequiredGasWei) ||
      refundNativeGas < BigInt(work.operations.refundEnvelopeMinimumWei)
    )
      return yield* unavailable("gas_budget_unavailable");
    const capacity = yield* decode(
      Schema.Record(Schema.String, Schema.Unknown),
      work.facts.capacityProfile,
    );
    if (
      successor &&
      (capacity.maxDrawings !== 1 ||
        capacity.priceCeilingAtomic !== SHARED_SONG_SUCCESSOR_PRICE_RULE.ticketAtomic ||
        plans.some(
          (plan) =>
            !hasSharedSongSuccessorFundingWindow({
              plan,
              observedAtMs: observed,
              quoteMaxAgeMs: work.noncePolicy.maxAgeMs,
              reservationMs: Number(capacity.reservationMs),
              safetyMarginMs: Number(capacity.safetyMarginMs),
            }),
        ))
    )
      return yield* unavailable("quote_expired");
    const validUntil = Math.min(
      Date.parse(work.validUntil),
      observed + work.noncePolicy.maxAgeMs,
      headMs + work.noncePolicy.maxAgeMs,
    );
    const witnessHash = yield* digestFundingPreimageV2(
      C.fundingHashPreimageV2("pirate.shared-song-context-witness.v2", [
        work.workId,
        work.attempt,
        work.profileId,
        work.templateHash,
        actor.wallet_assignment_id,
        head.blockNumber.toString(),
        head.blockHash,
        confirmed.toString(),
        pending.toString(),
        now,
        observations.map((row) => [
          row.id,
          row.drawingTime,
          row.entryCutoff,
          row.purchaseDeadline,
          row.priceAtomic.toString(),
        ]),
        nativeGas.toString(),
        refundNativeGas.toString(),
        validUntil,
      ]),
    );
    const witnessId = `schedule:${witnessHash}`;
    const schedule = {
      observedAt: observed,
      validUntil,
      ruleHash: work.operations.scheduleRuleHash,
      priceRuleHash: work.operations.priceRuleHash,
      recurrenceProven: observations.some((row) => row.proof === "attested_recurrence"),
      rows: observations,
    };
    const nonce = {
      id: witnessHash,
      chainId: deployment.chainId,
      senderAddress: actor.sender_address,
      observedAtMs: observed,
      confirmed: {
        nonce: confirmed,
        blockNumber: head.blockNumber,
        blockHash: head.blockHash.slice(2),
      },
      pending: {
        nonce: pending,
        baseBlockNumber: head.blockNumber,
        baseBlockHash: head.blockHash.slice(2),
      },
    };
    const attestationHash = yield* canonicalBodyHash(deployment).pipe(
      Effect.mapError(() => unavailable("outcome_unknown")),
    );
    const wireSchedule = {
      version: "song-megapot-schedule-v1",
      rule_id: work.operations.scheduleRuleId,
      rule_hash: work.operations.scheduleRuleHash,
      contract_code_hash: deployment.jackpotCodeHash.slice(2),
      anchor: {
        chain_id: deployment.chainId,
        block_number: head.blockNumber.toString(),
        block_hash: head.blockHash,
        block_timestamp: new Date(headMs).toISOString(),
        observed_at: now,
        finality_policy_id: work.operations.finalityPolicyId,
        attestation_id: deployment.attestationId,
        attestation_hash: attestationHash,
      },
      cadence_seconds: work.operations.cadenceSeconds,
      price_rule_hash: work.operations.priceRuleHash,
      valid_until: new Date(validUntil).toISOString(),
      schedule_witness_id: witnessId,
      rows: observations.map((row) => ({
        drawing_id: row.id,
        drawing_time: new Date(row.drawingTime).toISOString(),
        entry_cutoff_at: new Date(row.entryCutoff).toISOString(),
        purchase_deadline_at: new Date(row.purchaseDeadline).toISOString(),
        price_atomic: row.priceAtomic.toString(),
        price_ceiling_atomic: capacity.priceCeilingAtomic,
        initialized: row.proof === "initialized_state",
        proof_kind: row.proof,
      })),
    };
    const fundingPolicyHash =
      existingTerms?.funding_policy_hash ??
      (yield* openSongFundingPolicyHashV2(canonicalTarget, work.operations.emptyBehavior));
    const facts = yield* decode(
      SongFundingContextFactsSchema,
      JSON.parse(
        stringify({
          ...work.facts,
          emptyBehavior: work.operations.emptyBehavior ?? "no_purchase",
          now: observed,
          schedule,
          wireSchedule,
          fundingPolicyHash,
          fundingPolicyRevision: existingTerms?.funding_policy_revision ?? 1,
        }),
      ),
    );
    const context = yield* buildSongMegapotFundingContext(facts);
    yield* txCall(
      "shared-song.context.persist",
      "SELECT persist_shared_song_context_v2($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6) AS packet",
      [
        work.workId,
        work.token,
        stringify(context),
        stringify({ witnessId, hash: witnessHash, schedule, nonce }),
        stringify(facts.budget),
        facts.costsReconciled,
      ],
    );
  });
  return {
    run: Effect.fn("SharedSongContext.run")(function* (options: {
      enabled: boolean;
      ensure: () => Effect.Effect<void, unknown>;
      limit?: number;
    }) {
      if (!options.enabled) return;
      const limit = options.limit ?? 1;
      if (!Number.isInteger(limit) || limit < 1 || limit > 6)
        throw Error("Context batch limit must be an integer from 1 to 6");
      const candidates: Candidate[] = [];
      // Claims remain serialized and individually charged/fenced. Only provider
      // reads and their independent snapshot transactions may overlap.
      for (let index = 0; index < limit; index++) {
        yield* options.ensure();
        const raw = yield* txCall(
          "shared-song.context.claim",
          "SELECT claim_next_shared_song_context_v2($1) AS packet",
          [crypto.randomUUID()],
        );
        if (raw === null) break;
        candidates.push(yield* decode(Candidate, raw));
      }
      yield* Effect.forEach(
        candidates,
        (work) =>
          produce(work).pipe(
            Effect.catch(
              Effect.fn("SharedSongContext.retainFailure")(function* (error: unknown) {
                // A failed COMMIT has unknown outcome. Do not repeat provider reads,
                // allocation, the transaction callback or its already-consumed attempt.
                if (
                  error instanceof ControlPlaneTransactionOutcomeUnknown ||
                  (error instanceof ControlPlaneOperationTimedOut &&
                    error.outcomeCertainty === "unknown")
                )
                  return yield* Effect.fail(error);
                const code =
                  error instanceof SongContributionFailure ? error.code : "outcome_unknown";
                const recorded = yield* Effect.exit(
                  txCall(
                    "shared-song.context.finish-unavailable",
                    "SELECT finish_shared_song_context_failure_v2($1,$2,$3) AS packet",
                    [work.workId, work.token, code],
                  ),
                );
                if (Exit.isFailure(recorded))
                  return yield* Effect.failCause(Cause.combine(Cause.fail(error), recorded.cause));
              }),
            ),
          ),
        { concurrency: 3, discard: true },
      );
    }),
  };
}
