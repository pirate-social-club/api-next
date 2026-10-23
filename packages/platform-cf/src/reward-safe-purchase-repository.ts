import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import { Data, Effect } from "effect";
import type { Hex } from "viem";
import { mapRewardReservationFailure } from "./control-plane-error-classification.ts";

type Row = Readonly<Record<string, unknown>>;

export class RewardSafePurchaseStoreFailed extends Data.TaggedError(
  "RewardSafePurchaseStoreFailed",
)<{
  readonly reason:
    | "conflict"
    | "constraint"
    | "effect-conflict"
    | "insufficient-budget"
    | "invalid-row"
    | "not-found"
    | "not-safe-custody"
    | "outcome-unknown"
    | "recovery-not-isolated"
    | "recovery-refused"
    | "unavailable";
}> {}

const failed = (reason: RewardSafePurchaseStoreFailed["reason"]) =>
  new RewardSafePurchaseStoreFailed({ reason });

// The owner-only late purchase recovery names why it refused.
const recoveryRefusals: Readonly<Record<string, RewardSafePurchaseStoreFailed["reason"]>> = {
  PR004: "recovery-not-isolated",
  PR005: "recovery-refused",
};

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapRewardReservationFailure<E, RewardSafePurchaseStoreFailed>(error, failed),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function bigint(row: Row, field: string): bigint {
  const value = row[field];
  if (
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    !/^[0-9]+$/u.test(String(value))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return BigInt(value);
}

function instant(row: Row, field: string): string {
  const value = row[field];
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${field}`);
  return date.toISOString();
}

const deploymentColumns = `attestation.attestation_id, attestation.environment,
  attestation.chain_id, attestation.jackpot_address, attestation.ticket_nft_address,
  attestation.usdc_address, attestation.custody_address, attestation.referrer_address,
  attestation.source_tag, attestation.jackpot_code_hash, attestation.ticket_nft_code_hash,
  attestation.usdc_code_hash`;

function deployment(row: Row) {
  const environment = text(row, "environment");
  if (environment !== "test" && environment !== "staging" && environment !== "production") {
    throw new Error("invalid environment");
  }
  return {
    attestationId: text(row, "attestation_id"),
    environment,
    chainId: Number(bigint(row, "chain_id")),
    jackpotAddress: text(row, "jackpot_address"),
    ticketNftAddress: text(row, "ticket_nft_address"),
    usdcAddress: text(row, "usdc_address"),
    custodyAddress: text(row, "custody_address"),
    referrerAddress: text(row, "referrer_address"),
    jackpotCodeHash: text(row, "jackpot_code_hash"),
    ticketNftCodeHash: text(row, "ticket_nft_code_hash"),
    usdcCodeHash: text(row, "usdc_code_hash"),
  } as const;
}

/**
 * A ticket-first leg and the newest usable drawing observation for it. Purchase is
 * prepared only for a drawing that still leaves `minimumEntrySeconds` of entry window
 * after its own cutoff margin, so participants have time to qualify once the ticket
 * is confirmed.
 */
type RewardSafePurchaseCandidate = Readonly<{
  legId: string;
  drawingId: bigint;
  observationId: string;
  drawingTime: string;
  entryCutoffAt: string;
  ticketPriceAtomic: bigint;
  ballMax: number;
  bonusballMax: number;
  sourceTag: Hex;
  deployment: ReturnType<typeof deployment>;
}>;

const SETTLEMENT_SELECT = `
  SELECT effect.effect_id, effect.version, effect.failure_reason, effect.transaction_hash,
         effect.reserved_amount_atomic,
         effect.safe_nonce, effect.calldata, effect.safe_execution_outcome, effect.broadcast_at,
         purchase.pool_leg_id, purchase.drawing_id, purchase.normal_one, purchase.normal_two,
         purchase.normal_three, purchase.normal_four, purchase.normal_five, purchase.bonusball,
         drawing.status AS drawing_status, drawing.terminal_reason AS drawing_terminal_reason,
         ${deploymentColumns}
    FROM reward_chain_effects effect
    JOIN megapot_ticket_purchase_effects purchase
      ON purchase.purchase_effect_id=effect.effect_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=purchase.attestation_id
    LEFT JOIN megapot_pool_drawings drawing
      ON drawing.purchase_effect_id=effect.effect_id`;

function settlementFromRow(effectId: string, row: Row) {
  return {
    effectId,
    transactionHash: text(row, "transaction_hash"),
    observedAt: instant(row, "broadcast_at"),
    safeNonce: bigint(row, "safe_nonce"),
    calldata: text(row, "calldata") as Hex,
    outcome: text(row, "safe_execution_outcome") as "success" | "failure",
    legId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    ticket: {
      normals: [
        Number(bigint(row, "normal_one")),
        Number(bigint(row, "normal_two")),
        Number(bigint(row, "normal_three")),
        Number(bigint(row, "normal_four")),
        Number(bigint(row, "normal_five")),
      ] as const,
      bonusball: Number(bigint(row, "bonusball")),
    },
    sourceTag: text(row, "source_tag") as Hex,
    deployment: deployment(row),
  };
}

export function makeControlPlaneRewardSafePurchaseStore() {
  return {
    /** Where the Safe's execution scan resumes; null before the Safe is registered. */
    scanCursor: (input: { readonly chainId: number; readonly safeAddress: string }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-safe-purchase.scan-cursor.read",
            text: `SELECT next_block_number FROM reward_safe_execution_cursors
                    WHERE chain_id=$1 AND safe_address=$2`,
            values: [input.chainId, input.safeAddress],
            readonly: true,
          });
          const row = result.rows[0];
          return row === undefined ? null : bigint(row as Row, "next_block_number");
        }),
      ),

    loadCandidate: (input: { readonly legId: string; readonly minimumEntrySeconds: number }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-safe-purchase.candidate.read",
            text: `SELECT leg.leg_id, observation.drawing_id, observation.observation_id,
                          observation.drawing_time, observation.ticket_price_atomic,
                          observation.ball_max, observation.bonusball_max,
                          observation.drawing_time
                            - make_interval(secs => leg.entry_cutoff_seconds) AS entry_cutoff_at,
                          ${deploymentColumns}
                     FROM song_reward_offer_legs leg
                     JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
                     JOIN megapot_deployment_attestations attestation
                       ON attestation.attestation_id=leg.attestation_id
                     JOIN LATERAL (
                       SELECT * FROM megapot_drawing_observations candidate
                        WHERE candidate.attestation_id=leg.attestation_id
                          AND candidate.expires_at > clock_timestamp()
                          AND NOT candidate.drawing_locked
                          -- A shared-song leg buys only the drawings its terms planned;
                          -- participation is admitted for no other drawing.
                          AND (leg.qualification_family_v2 IS DISTINCT FROM 'shared_song'
                            OR (leg.shared_song_terms_v2->'planned_drawing_ids')
                                 @> jsonb_build_array(candidate.drawing_id::TEXT))
                        ORDER BY candidate.drawing_id DESC, candidate.observed_at DESC
                        LIMIT 1
                     ) observation ON true
                    WHERE leg.leg_id=$1 AND leg.purchase_order='ticket_first_v1'
                      AND leg.kind='megapot_pool' AND leg.status='active'
                      AND offer.status='active'
                      AND observation.drawing_id >= leg.participation_starts_drawing_id
                      AND observation.ticket_price_atomic <= leg.max_ticket_price_atomic
                      AND observation.drawing_time
                            - make_interval(secs => leg.entry_cutoff_seconds + $2::integer)
                          > clock_timestamp()
                      AND observation.drawing_time
                            - make_interval(secs => leg.entry_cutoff_seconds) <= offer.ends_at
                      AND NOT EXISTS (
                        SELECT 1 FROM megapot_pool_drawings drawing
                         WHERE drawing.pool_leg_id=leg.leg_id
                           AND drawing.drawing_id=observation.drawing_id
                      )`,
            values: [input.legId, input.minimumEntrySeconds],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          const row = result.rows[0] as Row;
          return yield* Effect.try({
            try: () =>
              ({
                legId: text(row, "leg_id"),
                drawingId: bigint(row, "drawing_id"),
                observationId: text(row, "observation_id"),
                drawingTime: instant(row, "drawing_time"),
                entryCutoffAt: instant(row, "entry_cutoff_at"),
                ticketPriceAtomic: bigint(row, "ticket_price_atomic"),
                ballMax: Number(bigint(row, "ball_max")),
                bonusballMax: Number(bigint(row, "bonusball_max")),
                sourceTag: text(row, "source_tag") as Hex,
                deployment: deployment(row),
              }) satisfies RewardSafePurchaseCandidate,
            catch: () => failed("invalid-row"),
          });
        }),
      ),

    /**
     * Prepare the owner-executed purchase and create its ticket-first drawing in one
     * transaction. The ticket price is reserved from the Safe-funded leg budget now; it
     * is spent when the ticket confirms and stays reserved while the call is unresolved.
     */
    prepare: (input: {
      readonly effectId: string;
      readonly candidate: RewardSafePurchaseCandidate;
      readonly ticket: Readonly<{ normals: readonly number[]; bonusball: number }>;
      readonly calldata: Hex;
      readonly calldataHash: string;
      readonly headBlockNumber: bigint;
    }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const { candidate } = input;
              const custody = candidate.deployment.custodyAddress;
              const leg = yield* transaction.execute<Row>({
                label: "reward-safe-purchase.leg.lock",
                text: `SELECT funded_atomic-reserved_atomic-spent_atomic-fulfilled_atomic
                              -refunded_atomic AS available_atomic
                         FROM song_reward_offer_legs
                        WHERE leg_id=$1 AND purchase_order='ticket_first_v1'
                          AND status='active' FOR UPDATE`,
                values: [candidate.legId],
                readonly: false,
              });
              if (leg.rows.length !== 1) return yield* failed("effect-conflict");
              if (bigint(leg.rows[0] as Row, "available_atomic") < candidate.ticketPriceAtomic) {
                return yield* failed("insufficient-budget");
              }
              const authority = yield* transaction.execute<Row>({
                label: "reward-safe-purchase.authority.read",
                text: `SELECT nonce_authority FROM reward_signer_nonces
                        WHERE chain_id=$1 AND signer_address=$2`,
                values: [candidate.deployment.chainId, custody],
                readonly: false,
              });
              if (
                authority.rows.length !== 1 ||
                (authority.rows[0] as Row).nonce_authority !== "safe_owner_v1"
              ) {
                return yield* failed("not-safe-custody");
              }
              yield* transaction.execute({
                label: "reward-safe-purchase.cursor.create",
                text: `INSERT INTO reward_safe_execution_cursors (
                         chain_id, safe_address, next_block_number
                       ) VALUES ($1,$2,$3)
                       ON CONFLICT (chain_id, safe_address) DO NOTHING`,
                values: [candidate.deployment.chainId, custody, input.headBlockNumber.toString()],
                readonly: false,
              });
              const cursor = yield* transaction.execute<Row>({
                label: "reward-safe-purchase.cursor.lock",
                text: `SELECT next_block_number FROM reward_safe_execution_cursors
                        WHERE chain_id=$1 AND safe_address=$2 FOR UPDATE`,
                values: [candidate.deployment.chainId, custody],
                readonly: false,
              });
              if (cursor.rows.length !== 1) return yield* failed("invalid-row");
              const cursorBlock = bigint(cursor.rows[0] as Row, "next_block_number");
              // The first block in which an execution may be this call: never the mined
              // head, which already held any identical transfer before this call existed.
              const firstEligibleBlock = input.headBlockNumber + 1n;
              const preparedBlock =
                cursorBlock > firstEligibleBlock ? cursorBlock : firstEligibleBlock;
              const created = yield* transaction.execute({
                label: "reward-safe-purchase.effect.create",
                text: `INSERT INTO reward_chain_effects (
                         effect_id, effect_kind, state, chain_id, signer_address,
                         target_address, reserved_amount_atomic, execution_mode
                       ) VALUES ($1,'ticket_purchase','planned',$2,$3,$4,$5,'safe_owner_v1')`,
                values: [
                  input.effectId,
                  candidate.deployment.chainId,
                  custody,
                  candidate.deployment.jackpotAddress,
                  candidate.ticketPriceAtomic.toString(),
                ],
                readonly: false,
              });
              if (created.rowCount !== 1) return yield* failed("effect-conflict");
              yield* transaction.execute({
                label: "reward-safe-purchase.prepared-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,2,'safe_call_prepared',jsonb_build_object(
                         'calldata_hash',$2::text,'drawing_id',$3::text,
                         'safe_prepared_block_number',$4::text
                       ))`,
                values: [
                  input.effectId,
                  input.calldataHash,
                  candidate.drawingId.toString(),
                  preparedBlock.toString(),
                ],
                readonly: false,
              });
              const prepared = yield* transaction.execute({
                label: "reward-safe-purchase.effect.prepare",
                text: `UPDATE reward_chain_effects
                          SET state='prepared', version=2, calldata=$2, calldata_hash=$3,
                              prepared_at=clock_timestamp(), safe_prepared_block_number=$4,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1 AND state='planned' AND version=1`,
                values: [
                  input.effectId,
                  input.calldata,
                  input.calldataHash,
                  preparedBlock.toString(),
                ],
                readonly: false,
              });
              if (prepared.rowCount !== 1) return yield* failed("effect-conflict");
              yield* transaction.execute({
                label: "reward-safe-purchase.drawing.create",
                // The cutoff comes from the stored observation, exactly as the guard
                // recomputes it; a client timestamp would lose its sub-millisecond part.
                text: `INSERT INTO megapot_pool_drawings (
                         pool_leg_id, drawing_id, observation_id, status, entry_cutoff_at,
                         ticket_price_ceiling_atomic, reserved_ticket_cost_atomic,
                         purchase_effect_id, purchase_order
                       )
                       SELECT leg.leg_id, observation.drawing_id, observation.observation_id,
                              'ticket_pending',
                              observation.drawing_time
                                - make_interval(secs => leg.entry_cutoff_seconds),
                              leg.max_ticket_price_atomic, $3, $4, 'ticket_first_v1'
                         FROM song_reward_offer_legs leg
                         JOIN megapot_drawing_observations observation
                           ON observation.observation_id=$2
                        WHERE leg.leg_id=$1`,
                values: [
                  candidate.legId,
                  candidate.observationId,
                  candidate.ticketPriceAtomic.toString(),
                  input.effectId,
                ],
                readonly: false,
              });
              const [one, two, three, four, five] = input.ticket.normals;
              yield* transaction.execute({
                label: "reward-safe-purchase.detail.create",
                text: `INSERT INTO megapot_ticket_purchase_effects (
                         purchase_effect_id, pool_leg_id, drawing_id, attestation_id,
                         drawing_observation_id, snapshot_id, commitment_effect_id, source_tag,
                         recipient_address, ticket_price_atomic, normal_one, normal_two,
                         normal_three, normal_four, normal_five, bonusball
                       ) VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                values: [
                  input.effectId,
                  candidate.legId,
                  candidate.drawingId.toString(),
                  candidate.deployment.attestationId,
                  candidate.observationId,
                  candidate.sourceTag,
                  custody,
                  candidate.ticketPriceAtomic.toString(),
                  one,
                  two,
                  three,
                  four,
                  five,
                  input.ticket.bonusball,
                ],
                readonly: false,
              });
              const reserved = yield* transaction.execute({
                label: "reward-safe-purchase.leg-budget.reserve",
                text: `UPDATE song_reward_offer_legs
                          SET reserved_atomic=reserved_atomic+$2, updated_at=clock_timestamp()
                        WHERE leg_id=$1`,
                values: [candidate.legId, candidate.ticketPriceAtomic.toString()],
                readonly: false,
              });
              if (reserved.rowCount !== 1) return yield* failed("effect-conflict");
              return preparedBlock;
            }),
          );
        }),
      ),

    /** A ticket purchase that reconciliation has bound to an owner execution. */
    loadSettlement: (effectId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-safe-purchase.settlement.read",
            text: `${SETTLEMENT_SELECT}
                    WHERE effect.effect_id=$1 AND effect.execution_mode='safe_owner_v1'
                      AND effect.state='confirming'`,
            values: [effectId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          return yield* Effect.try({
            try: () => settlementFromRow(effectId, result.rows[0] as Row),
            catch: () => failed("invalid-row"),
          });
        }),
      ),

    /**
     * Bound ticket purchases held for reconciliation, with why they were held and where
     * their drawing stands; one effect, or every one on an attestation.
     */
    loadHeld: (input: { readonly effectId: string } | { readonly attestationId: string }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const byEffect = "effectId" in input;
          const result = yield* db.execute<Row>({
            label: "reward-safe-purchase.held.read",
            text: `${SETTLEMENT_SELECT}
                    WHERE ${byEffect ? "effect.effect_id=$1" : "purchase.attestation_id=$1"}
                      AND effect.execution_mode='safe_owner_v1'
                      AND effect.effect_kind='ticket_purchase'
                      AND effect.state='reconciliation_required'
                    ORDER BY effect.effect_id`,
            values: [byEffect ? input.effectId : input.attestationId],
            readonly: true,
          });
          return yield* Effect.try({
            try: () =>
              (result.rows as Row[]).map((row) => ({
                ...settlementFromRow(text(row, "effect_id"), row),
                effectVersion: bigint(row, "version"),
                reservedAtomic: bigint(row, "reserved_amount_atomic"),
                failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
                drawingStatus: typeof row.drawing_status === "string" ? row.drawing_status : null,
                drawingTerminalReason:
                  typeof row.drawing_terminal_reason === "string"
                    ? row.drawing_terminal_reason
                    : null,
              })),
            catch: () => failed("invalid-row"),
          });
        }),
      ),

    /**
     * Settle one late purchase through the owner-only database function, which checks
     * the stopped system, the exact effect version and everything Pirate recorded.
     */
    recoverLate: (input: {
      readonly effectId: string;
      readonly effectVersion: bigint;
      readonly brakeRevision: bigint;
      readonly ticketId: bigint;
      readonly purchaseLogIndex: number;
      readonly mintLogIndex: number;
      readonly blockNumber: bigint;
      readonly blockHash: string;
      readonly receiptHash: string;
      readonly confirmations: number;
      readonly referralFeesAtomic: bigint;
      readonly lpEarningsAtomic: bigint;
      readonly verifiedAt: string;
    }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.execute({
          label: "reward-safe-purchase.late-recovery.apply",
          text: `SELECT recover_late_safe_purchase_v1(
                   $1,$2::bigint,$3::bigint,$4::numeric,$5,$6,$7::bigint,$8,$9,$10,
                   $11::numeric,$12::numeric,$13::timestamptz)`,
          values: [
            input.effectId,
            input.effectVersion.toString(),
            input.brakeRevision.toString(),
            input.ticketId.toString(),
            input.purchaseLogIndex,
            input.mintLogIndex,
            input.blockNumber.toString(),
            input.blockHash,
            input.receiptHash,
            input.confirmations,
            input.referralFeesAtomic.toString(),
            input.lpEarningsAtomic.toString(),
            input.verifiedAt,
          ],
          readonly: false,
        });
      }).pipe(
        Effect.mapError((error) => {
          const refusal =
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            error._tag === "ControlPlaneStatementFailed" &&
            "sqlState" in error &&
            typeof error.sqlState === "string"
              ? recoveryRefusals[error.sqlState]
              : undefined;
          return refusal === undefined
            ? mapRewardReservationFailure<never, RewardSafePurchaseStoreFailed>(error, failed)
            : failed(refusal);
        }),
      ),

    /**
     * A confirmed ExecutionFailure bought nothing: the effect is recorded as reverted
     * with its successful outer receipt and the reservation returns to the leg, once.
     * A drawing still waiting for this ticket closes without ever opening entries. One
     * that already closed at its deadline, before the owner's late execution, stays
     * exactly as it closed.
     */
    releaseFailedExecution: (input: {
      readonly effectId: string;
      readonly transactionHash: string;
      readonly blockNumber: bigint;
      readonly blockHash: string;
      readonly receiptHash: string;
      readonly confirmations: number;
      readonly confirmedAt: string;
    }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const result = yield* transaction.execute<Row>({
                label: "reward-safe-purchase.failure.read",
                text: `SELECT effect.version, effect.transaction_hash,
                              effect.safe_execution_outcome, effect.reserved_amount_atomic,
                              drawing.pool_leg_id, drawing.drawing_id,
                              drawing.version AS drawing_version, drawing.status AS drawing_status
                         FROM reward_chain_effects effect
                         JOIN megapot_pool_drawings drawing
                           ON drawing.purchase_effect_id=effect.effect_id
                          AND drawing.purchase_order='ticket_first_v1'
                        WHERE effect.effect_id=$1 AND effect.execution_mode='safe_owner_v1'
                          AND effect.state='confirming'
                          AND (drawing.status='ticket_pending'
                            OR (drawing.status='closed_purchase_unavailable'
                              AND drawing.terminal_reason='safe_purchase_not_executed'))
                        FOR UPDATE OF effect, drawing`,
                values: [input.effectId],
                readonly: false,
              });
              if (result.rows.length !== 1) return yield* failed("effect-conflict");
              const row = result.rows[0] as Row;
              if (
                text(row, "transaction_hash") !== input.transactionHash ||
                row.safe_execution_outcome !== "failure"
              ) {
                return yield* failed("effect-conflict");
              }
              const version = Number(bigint(row, "version")) + 1;
              yield* transaction.execute({
                label: "reward-safe-purchase.failure-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'safe_execution_failed',jsonb_build_object(
                         'transaction_hash',$3::text
                       ))`,
                values: [input.effectId, version, input.transactionHash],
                readonly: false,
              });
              const reverted = yield* transaction.execute({
                label: "reward-safe-purchase.effect.revert",
                text: `UPDATE reward_chain_effects
                          SET state='reverted', version=$2, receipt_status='success',
                              receipt_block_number=$3, receipt_block_hash=$4,
                              receipt_hash=$5, confirmations=$6, confirmed_at=$7,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1`,
                values: [
                  input.effectId,
                  version,
                  input.blockNumber.toString(),
                  input.blockHash,
                  input.receiptHash,
                  input.confirmations,
                  input.confirmedAt,
                ],
                readonly: false,
              });
              if (reverted.rowCount !== 1) return yield* failed("effect-conflict");
              const released = yield* transaction.execute({
                label: "reward-safe-purchase.leg-budget.release",
                text: `UPDATE song_reward_offer_legs
                          SET reserved_atomic=reserved_atomic-$2, updated_at=clock_timestamp()
                        WHERE leg_id=$1 AND reserved_atomic >= $2`,
                values: [
                  text(row, "pool_leg_id"),
                  bigint(row, "reserved_amount_atomic").toString(),
                ],
                readonly: false,
              });
              if (released.rowCount !== 1) return yield* failed("effect-conflict");
              if (row.drawing_status !== "ticket_pending") return;
              yield* closeDrawing(transaction, {
                legId: text(row, "pool_leg_id"),
                drawingId: bigint(row, "drawing_id"),
                version: Number(bigint(row, "drawing_version")),
                status: "closed_purchase_unavailable",
                reason: "safe_purchase_execution_failed",
              });
            }),
          );
        }),
      ),

    /** Hold a drawing whose purchase needs reconciliation; entries never open for it. */
    holdDrawing: (input: { readonly effectId: string; readonly reason: string }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const result = yield* transaction.execute<Row>({
                label: "reward-safe-purchase.hold.read",
                text: `SELECT pool_leg_id, drawing_id, version FROM megapot_pool_drawings
                        WHERE purchase_effect_id=$1 AND purchase_order='ticket_first_v1'
                          AND status='ticket_pending' FOR UPDATE`,
                values: [input.effectId],
                readonly: false,
              });
              if (result.rows.length !== 1) return;
              const row = result.rows[0] as Row;
              yield* closeDrawing(transaction, {
                legId: text(row, "pool_leg_id"),
                drawingId: bigint(row, "drawing_id"),
                version: Number(bigint(row, "version")),
                status: "operational_hold",
                reason: input.reason,
              });
            }),
          );
        }),
      ),

    /**
     * Close ticket-first drawings whose purchase was not executed while a full entry
     * window was still possible. The prepared call stays watched and keeps its
     * reservation: the owner may still execute it, and that execution is reconciled.
     */
    closeUnexecuted: (input: { readonly minimumEntrySeconds: number; readonly limit: number }) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const due = yield* transaction.execute<Row>({
                label: "reward-safe-purchase.unexecuted.read",
                text: `SELECT drawing.pool_leg_id, drawing.drawing_id, drawing.version
                         FROM megapot_pool_drawings drawing
                         JOIN reward_chain_effects effect
                           ON effect.effect_id=drawing.purchase_effect_id
                        WHERE drawing.purchase_order='ticket_first_v1'
                          AND drawing.status='ticket_pending' AND effect.state='prepared'
                          AND drawing.entry_cutoff_at - make_interval(secs => $1::integer)
                              <= clock_timestamp()
                        ORDER BY drawing.entry_cutoff_at, drawing.pool_leg_id
                        LIMIT $2 FOR UPDATE OF drawing`,
                values: [input.minimumEntrySeconds, input.limit],
                readonly: false,
              });
              for (const row of due.rows as Row[]) {
                yield* closeDrawing(transaction, {
                  legId: text(row, "pool_leg_id"),
                  drawingId: bigint(row, "drawing_id"),
                  version: Number(bigint(row, "version")),
                  status: "closed_purchase_unavailable",
                  reason: "safe_purchase_not_executed",
                });
              }
              return due.rows.length;
            }),
          );
        }),
      ),
  };
}

function closeDrawing(
  transaction: ControlPlaneTransaction,
  input: {
    readonly legId: string;
    readonly drawingId: bigint;
    readonly version: number;
    readonly status: "closed_purchase_unavailable" | "operational_hold";
    readonly reason: string;
  },
) {
  return Effect.gen(function* () {
    yield* transaction.execute({
      label: "reward-safe-purchase.drawing-close-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,$4,jsonb_build_object('reason',$5::text))`,
      values: [
        input.legId,
        input.drawingId.toString(),
        input.version + 1,
        input.status,
        input.reason,
      ],
      readonly: false,
    });
    const closed = yield* transaction.execute({
      label: "reward-safe-purchase.drawing.close",
      text: `UPDATE megapot_pool_drawings
                SET status=$4, version=$3, terminal_reason=$5,
                    terminal_at=clock_timestamp(), updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2 AND version=$3-1`,
      values: [
        input.legId,
        input.drawingId.toString(),
        input.version + 1,
        input.status,
        input.reason,
      ],
      readonly: false,
    });
    if (closed.rowCount !== 1) return yield* failed("effect-conflict");
  });
}
