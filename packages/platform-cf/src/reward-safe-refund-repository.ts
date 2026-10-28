import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer, Schema } from "effect";

const Deployment = Schema.Struct({
  attestationId: Schema.String,
  environment: Schema.Literals(["test", "staging", "production"]),
  chainId: Schema.Number,
  jackpotAddress: Schema.String,
  ticketNftAddress: Schema.String,
  usdcAddress: Schema.String,
  custodyAddress: Schema.String,
  referrerAddress: Schema.String,
  jackpotCodeHash: Schema.String,
  ticketNftCodeHash: Schema.String,
  usdcCodeHash: Schema.String,
});
const Candidate = Schema.Struct({
  refundId: Schema.String,
  destinationAddress: Schema.String,
  amountAtomic: Schema.BigIntFromString,
  deployment: Deployment,
});
const Settlement = Schema.Struct({
  ...Candidate.fields,
  transactionHash: Schema.String,
  safeNonce: Schema.BigIntFromString,
  calldata: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  observedAt: Schema.String,
});
const Prepared = Schema.Struct({
  effectId: Schema.String,
  data: Schema.String,
  preparedBlockNumber: Schema.BigIntFromString,
});

export class RewardSafeRefundStorageFailed extends Data.TaggedError(
  "RewardSafeRefundStorageFailed",
)<{
  readonly reason: "invalid-row" | "constraint" | "outcome-unknown" | "unavailable";
}> {}

const CANDIDATE_JSON = `jsonb_build_object(
  'refundId',r.refund_id,'destinationAddress',r.original_sender,'amountAtomic',r.amount_atomic::text,
  'deployment',jsonb_build_object('attestationId',a.attestation_id,'environment',a.environment,
    'chainId',a.chain_id,'jackpotAddress',a.jackpot_address,'ticketNftAddress',a.ticket_nft_address,
    'usdcAddress',a.usdc_address,'custodyAddress',a.custody_address,'referrerAddress',a.referrer_address,
    'jackpotCodeHash',a.jackpot_code_hash,'ticketNftCodeHash',a.ticket_nft_code_hash,'usdcCodeHash',a.usdc_code_hash))`;

export function makeControlPlaneRewardSafeRefundStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const provide = <A>(
    effect: Effect.Effect<A, ControlPlaneError | RewardSafeRefundStorageFailed, ControlPlaneDb>,
  ) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.mapError((error) => {
        if (error instanceof RewardSafeRefundStorageFailed) return error;
        return new RewardSafeRefundStorageFailed({
          reason:
            error._tag === "ControlPlaneTransactionOutcomeUnknown" ||
            ("outcomeCertainty" in error && error.outcomeCertainty === "unknown")
              ? "outcome-unknown"
              : error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null
                ? "constraint"
                : "unavailable",
        });
      }),
    );
  const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(value),
      catch: () => new RewardSafeRefundStorageFailed({ reason: "invalid-row" }),
    });
  const execute = (label: string, text: string, values: readonly unknown[], readonly: boolean) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.execute<{ value: unknown }>({ label, text, values: [...values], readonly });
    });

  return {
    seal: (attestationId: string, limit: number) =>
      provide(
        execute(
          "reward-safe-refund.seal",
          "SELECT seal_reward_safe_refunds_v1($1,$2) AS value",
          [attestationId, limit],
          false,
        ).pipe(
          Effect.flatMap((result) =>
            decode(
              Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
              result.rows[0]?.value,
            ),
          ),
        ),
      ),
    loadPending: (attestationId: string, limit: number) =>
      provide(
        Effect.gen(function* () {
          const rows = yield* execute(
            "reward-safe-refund.pending.read",
            `SELECT r.refund_id AS value
        FROM reward_safe_refunds_v1 r WHERE r.attestation_id=$1
          AND NOT EXISTS(SELECT 1 FROM reward_safe_refund_completions_v1 done WHERE done.refund_id=r.refund_id)
          AND NOT EXISTS(SELECT 1 FROM reward_safe_refund_attempts_v1 attempt
            JOIN reward_chain_effects e USING(effect_id) WHERE attempt.refund_id=r.refund_id AND e.state<>'reverted')
        ORDER BY r.created_at,r.refund_id LIMIT $2`,
            [attestationId, limit],
            true,
          );
          return yield* decode(
            Schema.Array(Schema.String),
            rows.rows.map((row) => row.value),
          );
        }),
      ),
    loadCandidate: (refundId: string) =>
      provide(
        Effect.gen(function* () {
          const rows = yield* execute(
            "reward-safe-refund.candidate.read",
            `SELECT ${CANDIDATE_JSON} AS value
        FROM reward_safe_refunds_v1 r JOIN megapot_deployment_attestations a USING(attestation_id)
        WHERE r.refund_id=$1`,
            [refundId],
            true,
          );
          return yield* decode(Candidate, rows.rows[0]?.value);
        }),
      ),
    prepare: (refundId: string, effectId: string, head: bigint) =>
      provide(
        Effect.gen(function* () {
          const rows = yield* execute(
            "reward-safe-refund.prepare",
            "SELECT prepare_reward_safe_refund_v1($1,$2,$3) AS value",
            [refundId, effectId, head.toString()],
            false,
          );
          return yield* decode(Prepared, rows.rows[0]?.value);
        }),
      ),
    loadSettlement: (effectId: string) =>
      provide(
        Effect.gen(function* () {
          const rows = yield* execute(
            "reward-safe-refund.settlement.read",
            `SELECT ${CANDIDATE_JSON} ||
        jsonb_build_object('transactionHash',e.transaction_hash,'safeNonce',e.safe_nonce::text,
          'calldata',e.calldata,'outcome',e.safe_execution_outcome,'observedAt',e.broadcast_at) AS value
        FROM reward_safe_refund_attempts_v1 attempt JOIN reward_safe_refunds_v1 r USING(refund_id)
        JOIN megapot_deployment_attestations a USING(attestation_id)
        JOIN reward_chain_effects e ON e.effect_id=attempt.effect_id
        WHERE e.effect_id=$1 AND e.execution_mode='safe_owner_v1' AND e.state='confirming'`,
            [effectId],
            true,
          );
          return rows.rows.length === 0 ? null : yield* decode(Settlement, rows.rows[0]?.value);
        }),
      ),
    settle: (evidence: Readonly<Record<string, string | number>>) =>
      provide(
        execute(
          "reward-safe-refund.settle",
          "SELECT settle_reward_safe_refund_v1($1::jsonb) AS value",
          [JSON.stringify(evidence)],
          false,
        ),
      ),
    requireReconciliation: (effectId: string, reason: string) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const effect = yield* transaction.execute<{ version: number }>({
                label: "reward-safe-refund.reconciliation.lock",
                text: `SELECT version FROM reward_chain_effects
            WHERE effect_id=$1 AND state='confirming' AND execution_mode='safe_owner_v1'
              AND effect_kind='reward_refund' FOR UPDATE`,
                values: [effectId],
                readonly: false,
              });
              if (effect.rows.length === 0) return;
              const version = Number(effect.rows[0]?.version) + 1;
              yield* transaction.execute({
                label: "reward-safe-refund.reconciliation.event",
                text: `INSERT INTO reward_chain_effect_transitions(effect_id,target_version,event_type,event)
            VALUES($1,$2,'receipt_requires_reconciliation',jsonb_build_object('reason',$3::text))`,
                values: [effectId, version, reason],
                readonly: false,
              });
              yield* transaction.execute({
                label: "reward-safe-refund.reconciliation.record",
                text: `UPDATE reward_chain_effects SET state='reconciliation_required',version=$2,
            failure_class='receipt_evidence_invalid',failure_reason=$3,updated_at=clock_timestamp() WHERE effect_id=$1`,
                values: [effectId, version, reason],
                readonly: false,
              });
            }),
          );
        }),
      ),
  };
}
