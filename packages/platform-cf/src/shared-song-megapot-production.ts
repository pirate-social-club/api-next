import { Cause, Effect, Exit, type Layer, Schema } from "effect";
import {
  type ControlPlaneDb,
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
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import {
  type MegapotV2DeploymentAttestation,
  validateMegapotV2DeploymentAttestation,
} from "./megapot-v2.ts";
import type { MegapotV2FullRpcClient } from "./megapot-v2-rpc.ts";

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
    const ids = [...new Set([currentId.toString(), ...work.operations.initializedDrawingIds])];
    if (ids.length > 30) return yield* unavailable("schedule_unproven");
    const observations = [];
    for (const id of ids) {
      const row = yield* read(() => rpc.readDrawing(BigInt(id), head.blockNumber));
      const existing = work.drawingStates.find((prior) => prior.drawingId === id);
      if (
        row.ticketPrice <= 0n ||
        (row.jackpotLock && (existing === undefined || existing.state === "uncommitted"))
      )
        return yield* unavailable("schedule_unproven");
      const time = Number(row.drawingTime * 1000n);
      if (!Number.isSafeInteger(time) || time > 8640000000000000)
        return yield* unavailable("schedule_unproven");
      observations.push({
        id,
        drawingTime: time,
        entryCutoff: existing?.entryCutoffAtMs ?? time - work.operations.entryCutoffSeconds * 1000,
        purchaseDeadline: time - work.operations.purchaseLeadSeconds * 1000,
        priceAtomic: row.ticketPrice,
        proof: "initialized_state" as const,
        state: existing?.state ?? "uncommitted",
        reservedCostAtomic: BigInt(existing?.reservedCostAtomic ?? "0"),
      });
    }
    const nativeGas = yield* read(() => rpc.readNativeBalance(actor.sender_address));
    const refundNativeGas = yield* read(() => rpc.readNativeBalance(deployment.custodyAddress));
    const after = yield* read(() => rpc.readHead());
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
    if (
      nativeGas < BigInt(work.operations.inboundRequiredGasWei) ||
      refundNativeGas < BigInt(work.operations.refundEnvelopeMinimumWei)
    )
      return yield* unavailable("gas_budget_unavailable");
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
      recurrenceProven: false,
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
    const capacity = yield* decode(
      Schema.Record(Schema.String, Schema.Unknown),
      work.facts.capacityProfile,
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
        initialized: true,
        proof_kind: row.proof,
      })),
    };
    const canonicalTarget = yield* decode(C.TargetV2, work.facts.slot);
    const existingTerms =
      work.facts.committedTerms === null
        ? null
        : yield* decode(C.TermsV2, work.facts.committedTerms);
    const fundingPolicyHash =
      existingTerms?.funding_policy_hash ?? (yield* openSongFundingPolicyHashV2(canonicalTarget));
    const facts = yield* decode(
      SongFundingContextFactsSchema,
      JSON.parse(
        stringify({
          ...work.facts,
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
    }) {
      if (!options.enabled) return;
      yield* options.ensure();
      const raw = yield* txCall(
        "shared-song.context.claim",
        "SELECT claim_next_shared_song_context_v2($1) AS packet",
        [crypto.randomUUID()],
      );
      if (raw === null) return;
      const work = yield* decode(Candidate, raw);
      yield* produce(work).pipe(
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
            const code = error instanceof SongContributionFailure ? error.code : "outcome_unknown";
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
      );
    }),
  };
}
