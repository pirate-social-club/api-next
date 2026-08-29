import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotPurchaseCandidate,
  type MegapotPurchaseFailure,
  type MegapotPurchaseProgress,
  MegapotPurchaseRejected,
  MegapotPurchaseStorageFailed,
  type MegapotPurchaseStore,
  type MegapotReservedPurchase,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import { sha256, toBytes } from "viem";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: MegapotPurchaseStorageFailed["reason"]): MegapotPurchaseStorageFailed =>
  new MegapotPurchaseStorageFailed({ reason });
const rejected = (reason: MegapotPurchaseRejected["reason"]): MegapotPurchaseRejected =>
  new MegapotPurchaseRejected({ reason });

function mapError(error: ControlPlaneError): MegapotPurchaseStorageFailed {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return storage("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storage("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState === "23505") {
    return storage("conflict");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return storage("constraint");
  }
  return storage("unavailable");
}

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapError(error as ControlPlaneError)
          : (error as E)
        : (error as E),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function integer(row: Row, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${field}`);
  return parsed;
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

function instantMillis(row: Row, field: string): number {
  const value = row[field];
  const millis = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(millis)) throw new Error(`invalid ${field}`);
  return millis;
}

function hashDocument(value: unknown): string {
  return sha256(toBytes(JSON.stringify(value))).slice(2);
}

function nullableText(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function candidateFromRow(row: Row): MegapotPurchaseCandidate {
  const environment = text(row, "environment");
  if (environment !== "test" && environment !== "staging" && environment !== "production") {
    throw new Error("invalid environment");
  }
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    drawingVersion: integer(row, "drawing_version"),
    observationId: text(row, "observation_id"),
    snapshotId: text(row, "snapshot_id"),
    commitmentEffectId: text(row, "commitment_effect_id"),
    ticketPriceAtomic: bigint(row, "ticket_price_atomic"),
    ballMax: integer(row, "ball_max"),
    bonusballMax: integer(row, "bonusball_max"),
    sourceTag: text(row, "source_tag"),
    attestationId: text(row, "attestation_id"),
    environment,
    chainId: integer(row, "chain_id"),
    jackpotAddress: text(row, "jackpot_address"),
    usdcAddress: text(row, "usdc_address"),
    ticketNftAddress: text(row, "ticket_nft_address"),
    custodyAddress: text(row, "custody_address"),
    referrerAddress: text(row, "referrer_address"),
    jackpotCodeHash: text(row, "jackpot_code_hash"),
    usdcCodeHash: text(row, "usdc_code_hash"),
    ticketNftCodeHash: text(row, "ticket_nft_code_hash"),
  };
}

const PURCHASE_CANDIDATE_SELECT = `
  SELECT drawing.pool_leg_id, drawing.drawing_id,
         drawing.version AS drawing_version, drawing.observation_id,
         drawing.snapshot_id, drawing.commitment_effect_id,
         observation.ticket_price_atomic, observation.ball_max,
         observation.bonusball_max, attestation.source_tag,
         attestation.attestation_id, attestation.environment,
         attestation.chain_id, attestation.jackpot_address,
         attestation.usdc_address, attestation.ticket_nft_address,
         attestation.custody_address, attestation.referrer_address,
         attestation.jackpot_code_hash, attestation.usdc_code_hash,
         attestation.ticket_nft_code_hash
    FROM megapot_pool_drawings drawing
    JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
    JOIN megapot_drawing_observations observation
      ON observation.observation_id=drawing.observation_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=leg.attestation_id`;

const PURCHASE_PROGRESS_SELECT = `
  SELECT effect.effect_id, effect.state, effect.version AS effect_version,
         effect.nonce, effect.calldata, effect.calldata_hash,
         effect.signed_transaction, effect.signed_transaction_hash,
         effect.transaction_hash,
         drawing.pool_leg_id, drawing.drawing_id,
         drawing.version - 1 AS drawing_version, drawing.observation_id,
         drawing.snapshot_id, drawing.commitment_effect_id,
         observation.ticket_price_atomic, observation.ball_max,
         observation.bonusball_max, attestation.source_tag,
         attestation.attestation_id, attestation.environment,
         attestation.chain_id, attestation.jackpot_address,
         attestation.usdc_address, attestation.ticket_nft_address,
         attestation.custody_address, attestation.referrer_address,
         attestation.jackpot_code_hash, attestation.usdc_code_hash,
         attestation.ticket_nft_code_hash,
         purchase.normal_one, purchase.normal_two, purchase.normal_three,
         purchase.normal_four, purchase.normal_five, purchase.bonusball,
         evidence.ticket_id, evidence.block_number AS receipt_block_number,
         evidence.block_hash AS receipt_block_hash,
         evidence.confirmations AS receipt_confirmations
    FROM reward_chain_effects effect
    JOIN megapot_ticket_purchase_effects purchase
      ON purchase.purchase_effect_id=effect.effect_id
    JOIN megapot_pool_drawings drawing
      ON drawing.pool_leg_id=purchase.pool_leg_id AND drawing.drawing_id=purchase.drawing_id
    JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
    JOIN megapot_drawing_observations observation
      ON observation.observation_id=drawing.observation_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=purchase.attestation_id
    LEFT JOIN megapot_purchase_receipt_evidence evidence
      ON evidence.purchase_effect_id=effect.effect_id`;

function sameCandidate(left: MegapotPurchaseCandidate, right: MegapotPurchaseCandidate): boolean {
  return (
    left.poolLegId === right.poolLegId &&
    left.drawingId === right.drawingId &&
    left.drawingVersion === right.drawingVersion &&
    left.observationId === right.observationId &&
    left.snapshotId === right.snapshotId &&
    left.commitmentEffectId === right.commitmentEffectId &&
    left.ticketPriceAtomic === right.ticketPriceAtomic &&
    left.ballMax === right.ballMax &&
    left.bonusballMax === right.bonusballMax &&
    left.sourceTag === right.sourceTag &&
    left.attestationId === right.attestationId &&
    left.chainId === right.chainId &&
    left.jackpotAddress === right.jackpotAddress &&
    left.usdcAddress === right.usdcAddress &&
    left.ticketNftAddress === right.ticketNftAddress &&
    left.custodyAddress === right.custodyAddress &&
    left.referrerAddress === right.referrerAddress &&
    left.jackpotCodeHash === right.jackpotCodeHash &&
    left.usdcCodeHash === right.usdcCodeHash &&
    left.ticketNftCodeHash === right.ticketNftCodeHash
  );
}

function sameTicket(
  left: MegapotReservedPurchase["ticket"],
  right: MegapotReservedPurchase["ticket"],
): boolean {
  return (
    left.bonusball === right.bonusball &&
    left.normals.every((normal, index) => normal === right.normals[index])
  );
}

function loadCandidateIn(
  transaction: ControlPlaneTransaction,
  input: { readonly poolLegId: string; readonly drawingId: bigint; readonly lock: boolean },
): Effect.Effect<MegapotPurchaseCandidate, MegapotPurchaseFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "megapot-purchase.candidate.read",
      text: `${PURCHASE_CANDIDATE_SELECT}
              WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                AND drawing.status='committed'
                AND leg.status='active' AND leg.kind='megapot_pool'
                AND attestation.status='active'
                AND observation.ticket_price_atomic <= drawing.reserved_ticket_cost_atomic
                AND observation.ticket_price_atomic <= drawing.ticket_price_ceiling_atomic
                AND (leg.funding_source='shared_sponsor_budget'
                  OR leg.reserved_atomic >= drawing.reserved_ticket_cost_atomic)
              ${input.lock ? "FOR UPDATE OF drawing, leg" : ""}`,
      values: [input.poolLegId, input.drawingId.toString()],
      readonly: !input.lock,
    });
    if (result.rows.length === 0) return yield* rejected("drawing-not-committed");
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => candidateFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

function progressFromRow(row: Row): MegapotPurchaseProgress {
  const state = text(row, "state");
  const effectId = text(row, "effect_id");
  const candidate = candidateFromRow(row);
  if (state === "confirmed") {
    const transactionHash = text(row, "transaction_hash");
    return {
      state,
      effectId,
      poolLegId: candidate.poolLegId,
      drawingId: candidate.drawingId,
      transactionHash,
      ticketId: bigint(row, "ticket_id"),
      blockNumber: bigint(row, "receipt_block_number"),
      blockHash: text(row, "receipt_block_hash"),
      confirmations: integer(row, "receipt_confirmations"),
    };
  }
  const reservation: MegapotReservedPurchase = {
    ...candidate,
    effectId,
    nonce: bigint(row, "nonce"),
    effectVersion: integer(row, "effect_version"),
    ticket: {
      normals: [
        integer(row, "normal_one"),
        integer(row, "normal_two"),
        integer(row, "normal_three"),
        integer(row, "normal_four"),
        integer(row, "normal_five"),
      ],
      bonusball: integer(row, "bonusball"),
    },
  };
  if (state === "nonce_reserved") return { state, reservation };
  if (
    state !== "prepared" &&
    state !== "broadcast_pending" &&
    state !== "confirming" &&
    state !== "reconciliation_required"
  ) {
    throw new Error("invalid purchase effect state");
  }
  const transactionHash = nullableText(row, "transaction_hash");
  if (state === "prepared" ? transactionHash !== null : transactionHash === null) {
    throw new Error("invalid purchase transaction identity");
  }
  return {
    ...reservation,
    state,
    calldata: text(row, "calldata"),
    calldataHash: text(row, "calldata_hash"),
    signedTransaction: text(row, "signed_transaction"),
    signedTransactionHash: text(row, "signed_transaction_hash"),
    transactionHash,
  };
}

function findProgressIn(
  transaction: ControlPlaneTransaction,
  effectId: string,
): Effect.Effect<MegapotPurchaseProgress | null, MegapotPurchaseStorageFailed | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "megapot-purchase.progress.read",
      text: `${PURCHASE_PROGRESS_SELECT} WHERE effect.effect_id=$1`,
      values: [effectId],
      readonly: true,
    });
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => progressFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

function reserveNonceIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<MegapotPurchaseStore["reserveNonce"]>[0],
) {
  return Effect.gen(function* () {
    const candidate = yield* loadCandidateIn(transaction, {
      poolLegId: input.candidate.poolLegId,
      drawingId: input.candidate.drawingId,
      lock: true,
    });
    if (!sameCandidate(candidate, input.candidate)) return yield* rejected("effect-conflict");
    const existingNonce = yield* transaction.execute<Row>({
      label: "megapot-purchase.nonce.read",
      text: `SELECT next_nonce, fence_version, observed_block_number, observed_at
               FROM reward_signer_nonces
              WHERE chain_id=$1 AND signer_address=$2 FOR UPDATE`,
      values: [candidate.chainId, candidate.custodyAddress],
      readonly: false,
    });
    let reservedNonce: bigint;
    if (existingNonce.rows.length === 0) {
      reservedNonce = input.observedPendingNonce;
      const nonceUpdated = yield* transaction.execute({
        label: "megapot-purchase.nonce.create",
        text: `INSERT INTO reward_signer_nonces (
                 chain_id, signer_address, next_nonce, observed_pending_nonce,
                 observed_block_number, observed_block_hash, observed_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [
          candidate.chainId,
          candidate.custodyAddress,
          (reservedNonce + 1n).toString(),
          input.observedPendingNonce.toString(),
          input.observedBlockNumber.toString(),
          input.observedBlockHash,
          input.observedAt,
        ],
        readonly: false,
      });
      if (nonceUpdated.rowCount !== 1) return yield* rejected("effect-conflict");
    } else {
      if (existingNonce.rows.length !== 1) return yield* storage("invalid-row");
      const nonceRow = existingNonce.rows[0] as Row;
      const previousBlock = bigint(nonceRow, "observed_block_number");
      const previousObservedAt = instantMillis(nonceRow, "observed_at");
      if (
        input.observedBlockNumber < previousBlock ||
        Date.parse(input.observedAt) < previousObservedAt
      ) {
        return yield* rejected("nonce-observation-stale");
      }
      reservedNonce = bigint(nonceRow, "next_nonce");
      if (input.observedPendingNonce > reservedNonce) reservedNonce = input.observedPendingNonce;
      const nonceUpdated = yield* transaction.execute({
        label: "megapot-purchase.nonce.reserve",
        text: `UPDATE reward_signer_nonces
                  SET next_nonce=$3, observed_pending_nonce=$4,
                      observed_block_number=$5, observed_block_hash=$6,
                      observed_at=$7, fence_version=fence_version+1,
                      updated_at=clock_timestamp()
                WHERE chain_id=$1 AND signer_address=$2`,
        values: [
          candidate.chainId,
          candidate.custodyAddress,
          (reservedNonce + 1n).toString(),
          input.observedPendingNonce.toString(),
          input.observedBlockNumber.toString(),
          input.observedBlockHash,
          input.observedAt,
        ],
        readonly: false,
      });
      if (nonceUpdated.rowCount !== 1) return yield* rejected("effect-conflict");
    }
    const effectReserved = yield* transaction.execute({
      label: "megapot-purchase.effect.create",
      text: `INSERT INTO reward_chain_effects (
               effect_id, effect_kind, state, chain_id, signer_address,
               target_address, reserved_amount_atomic
             ) VALUES ($1,'ticket_purchase','planned',$2,$3,$4,$5)`,
      values: [
        input.effectId,
        candidate.chainId,
        candidate.custodyAddress,
        candidate.jackpotAddress,
        candidate.ticketPriceAtomic.toString(),
      ],
      readonly: false,
    });
    if (effectReserved.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* transaction.execute({
      label: "megapot-purchase.effect.nonce-transition.create",
      text: `INSERT INTO reward_chain_effect_transitions (
               effect_id, target_version, event_type, event
             ) VALUES ($1,2,'nonce_reserved',jsonb_build_object('nonce',$2::text))`,
      values: [input.effectId, reservedNonce.toString()],
      readonly: false,
    });
    const effectNonceReserved = yield* transaction.execute({
      label: "megapot-purchase.effect.nonce-reserve",
      text: `UPDATE reward_chain_effects
                SET state='nonce_reserved', version=2, nonce=$2,
                    updated_at=clock_timestamp()
              WHERE effect_id=$1 AND state='planned' AND version=1`,
      values: [input.effectId, reservedNonce.toString()],
      readonly: false,
    });
    if (effectNonceReserved.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* transaction.execute({
      label: "megapot-purchase.detail.create",
      text: `INSERT INTO megapot_ticket_purchase_effects (
               purchase_effect_id, pool_leg_id, drawing_id, attestation_id,
               drawing_observation_id, snapshot_id, commitment_effect_id,
               source_tag, recipient_address, ticket_price_atomic,
               normal_one, normal_two, normal_three, normal_four, normal_five,
               bonusball
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      values: [
        input.effectId,
        candidate.poolLegId,
        candidate.drawingId.toString(),
        candidate.attestationId,
        candidate.observationId,
        candidate.snapshotId,
        candidate.commitmentEffectId,
        candidate.sourceTag,
        candidate.custodyAddress,
        candidate.ticketPriceAtomic.toString(),
        ...input.ticket.normals,
        input.ticket.bonusball,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "megapot-purchase.drawing-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'purchase_reserved',jsonb_build_object(
               'purchase_effect_id',$4::text
             ))`,
      values: [
        candidate.poolLegId,
        candidate.drawingId.toString(),
        candidate.drawingVersion + 1,
        input.effectId,
      ],
      readonly: false,
    });
    const drawingUpdated = yield* transaction.execute({
      label: "megapot-purchase.drawing.reserve",
      text: `UPDATE megapot_pool_drawings
                SET status='purchase_pending', version=version+1,
                    purchase_effect_id=$3, updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2
                AND status='committed' AND version=$4`,
      values: [
        candidate.poolLegId,
        candidate.drawingId.toString(),
        input.effectId,
        candidate.drawingVersion,
      ],
      readonly: false,
    });
    if (drawingUpdated.rowCount !== 1) return yield* rejected("effect-conflict");
    return {
      ...candidate,
      effectId: input.effectId,
      nonce: reservedNonce,
      effectVersion: 2,
      ticket: input.ticket,
    } satisfies MegapotReservedPurchase;
  });
}

export function makeControlPlaneMegapotPurchaseRepository() {
  return {
    findProgress: (effectId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* findProgressIn(db, effectId);
      }).pipe(mapped),
    closePreBroadcast: (input: Parameters<MegapotPurchaseStore["closePreBroadcast"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const candidate = yield* loadCandidateIn(transaction, {
              poolLegId: input.candidate.poolLegId,
              drawingId: input.candidate.drawingId,
              lock: true,
            });
            if (!sameCandidate(candidate, input.candidate))
              return yield* rejected("effect-conflict");
            const context = yield* transaction.execute<Row>({
              label: "megapot-purchase.prebroadcast-close.read",
              text: `SELECT leg.funding_source, leg.funder_account_id,
                            drawing.reserved_ticket_cost_atomic,
                            drawing.fallback_beneficiary,
                            to_char(drawing.cutoff_frozen_at AT TIME ZONE 'UTC','YYYY-MM-DD')
                              AS sponsor_day
                       FROM megapot_pool_drawings drawing
                       JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
                      WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                        AND drawing.status='committed' AND drawing.version=$3
                      FOR UPDATE OF drawing,leg`,
              values: [
                candidate.poolLegId,
                candidate.drawingId.toString(),
                candidate.drawingVersion,
              ],
              readonly: false,
            });
            if (context.rows.length !== 1) return yield* rejected("effect-conflict");
            const row = context.rows[0] as Row;
            const amount = bigint(row, "reserved_ticket_cost_atomic");
            const fundingSource = text(row, "funding_source");
            const sponsorAccountId = text(row, "funder_account_id");
            if (fundingSource === "leg_budget") {
              const released = yield* transaction.execute({
                label: "megapot-purchase.prebroadcast-leg-budget.release",
                text: `UPDATE song_reward_offer_legs
                          SET reserved_atomic=reserved_atomic-$2,
                              updated_at=clock_timestamp()
                        WHERE leg_id=$1 AND reserved_atomic >= $2`,
                values: [candidate.poolLegId, amount.toString()],
                readonly: false,
              });
              if (released.rowCount !== 1) return yield* rejected("insufficient-budget");
            } else if (fundingSource === "shared_sponsor_budget") {
              const released = yield* transaction.execute<Row>({
                label: "megapot-purchase.prebroadcast-sponsorship-budget.release",
                text: `UPDATE platform_sponsorship_budgets
                          SET reserved_atomic=reserved_atomic-$2,
                              updated_at=clock_timestamp()
                        WHERE sponsor_account_id=$1 AND reserved_atomic >= $2
                    RETURNING funded_atomic, winnings_credited_atomic, reserved_atomic,
                              spent_atomic, withdrawn_atomic`,
                values: [sponsorAccountId, amount.toString()],
                readonly: false,
              });
              if (released.rows.length !== 1) return yield* rejected("insufficient-budget");
              const budget = released.rows[0] as Row;
              yield* transaction.execute({
                label: "megapot-purchase.prebroadcast-sponsorship-entry.create",
                text: `INSERT INTO platform_sponsorship_budget_entries (
                         budget_entry_id, sponsor_account_id, entry_kind,
                         amount_atomic, source_reference, balance_hash
                       ) VALUES ($1,$2,'purchase_released',$3,$4,$5)`,
                values: [
                  `sponsor_release_${hashDocument({
                    pool_leg_id: candidate.poolLegId,
                    drawing_id: candidate.drawingId.toString(),
                  })}`,
                  sponsorAccountId,
                  amount.toString(),
                  `${candidate.poolLegId}:${candidate.drawingId}`,
                  hashDocument({
                    funded: bigint(budget, "funded_atomic").toString(),
                    winnings: bigint(budget, "winnings_credited_atomic").toString(),
                    reserved: bigint(budget, "reserved_atomic").toString(),
                    spent: bigint(budget, "spent_atomic").toString(),
                    withdrawn: bigint(budget, "withdrawn_atomic").toString(),
                  }),
                ],
                readonly: false,
              });
            } else {
              return yield* rejected("effect-conflict");
            }
            const dailyKind =
              fundingSource === "shared_sponsor_budget"
                ? "shared_platform"
                : row.fallback_beneficiary === true
                  ? "external_fallback"
                  : null;
            if (dailyKind !== null) {
              const dailyReleased = yield* transaction.execute({
                label: "megapot-purchase.prebroadcast-daily-total.release",
                text: `UPDATE sponsor_daily_ticket_totals
                          SET released_ticket_count=released_ticket_count+1,
                              released_spend_atomic=released_spend_atomic+$4,
                              updated_at=clock_timestamp()
                        WHERE sponsor_account_id=$1 AND sponsor_day=$2::date
                          AND sponsor_kind=$3
                          AND reserved_ticket_count-released_ticket_count >= 1
                          AND reserved_spend_atomic-released_spend_atomic >= $4`,
                values: [sponsorAccountId, text(row, "sponsor_day"), dailyKind, amount.toString()],
                readonly: false,
              });
              if (dailyReleased.rowCount !== 1) return yield* rejected("effect-conflict");
            }
            const nextVersion = candidate.drawingVersion + 1;
            yield* transaction.execute({
              label: "megapot-purchase.prebroadcast-close-transition.create",
              text: `INSERT INTO megapot_pool_drawing_transitions (
                       pool_leg_id, drawing_id, target_version, event_type, event
                     ) VALUES ($1,$2,$3,'closed_purchase_unavailable',jsonb_build_object(
                       'reason',$4::text,'failed_at',$5::timestamptz
                     ))`,
              values: [
                candidate.poolLegId,
                candidate.drawingId.toString(),
                nextVersion,
                input.reason,
                input.failedAt,
              ],
              readonly: false,
            });
            const closed = yield* transaction.execute({
              label: "megapot-purchase.prebroadcast-close.record",
              text: `UPDATE megapot_pool_drawings
                        SET status='closed_purchase_unavailable', version=$3,
                            terminal_reason=$4, terminal_at=$5::timestamptz,
                            updated_at=clock_timestamp()
                      WHERE pool_leg_id=$1 AND drawing_id=$2
                        AND status='committed' AND version=$3-1`,
              values: [
                candidate.poolLegId,
                candidate.drawingId.toString(),
                nextVersion,
                input.reason,
                input.failedAt,
              ],
              readonly: false,
            });
            if (closed.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
    loadCandidate: (input: Parameters<MegapotPurchaseStore["loadCandidate"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* loadCandidateIn(db, { ...input, lock: false });
      }).pipe(mapped),
    reserveNonce: (input: Parameters<MegapotPurchaseStore["reserveNonce"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) => reserveNonceIn(transaction, input));
      }).pipe(mapped),
    prepare: (input: Parameters<MegapotPurchaseStore["prepare"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const effect = yield* transaction.execute<Row>({
              label: "megapot-purchase.effect.prepare.read",
              text: `SELECT state, version, nonce, reserved_amount_atomic
                       FROM reward_chain_effects WHERE effect_id=$1 FOR UPDATE`,
              values: [input.reservation.effectId],
              readonly: false,
            });
            if (effect.rows.length !== 1) return yield* rejected("not-found");
            const effectRow = effect.rows[0] as Row;
            if (
              text(effectRow, "state") !== "nonce_reserved" ||
              integer(effectRow, "version") !== input.reservation.effectVersion ||
              bigint(effectRow, "nonce") !== input.reservation.nonce ||
              bigint(effectRow, "reserved_amount_atomic") !== input.reservation.ticketPriceAtomic
            ) {
              return yield* rejected("effect-conflict");
            }
            const purchase = yield* transaction.execute<Row>({
              label: "megapot-purchase.detail.prepare.read",
              text: `SELECT drawing.status, drawing.version,
                            purchase.normal_one, purchase.normal_two,
                            purchase.normal_three, purchase.normal_four,
                            purchase.normal_five, purchase.bonusball
                       FROM megapot_ticket_purchase_effects purchase
                       JOIN megapot_pool_drawings drawing
                         ON drawing.pool_leg_id=purchase.pool_leg_id
                        AND drawing.drawing_id=purchase.drawing_id
                      WHERE purchase.purchase_effect_id=$1
                        AND purchase.pool_leg_id=$2 AND purchase.drawing_id=$3
                        AND drawing.purchase_effect_id=$1
                      FOR UPDATE OF drawing`,
              values: [
                input.reservation.effectId,
                input.reservation.poolLegId,
                input.reservation.drawingId.toString(),
              ],
              readonly: false,
            });
            if (purchase.rows.length !== 1) return yield* rejected("effect-conflict");
            const purchaseRow = purchase.rows[0] as Row;
            const persistedTicket = {
              normals: [
                integer(purchaseRow, "normal_one"),
                integer(purchaseRow, "normal_two"),
                integer(purchaseRow, "normal_three"),
                integer(purchaseRow, "normal_four"),
                integer(purchaseRow, "normal_five"),
              ],
              bonusball: integer(purchaseRow, "bonusball"),
            } as const;
            if (
              text(purchaseRow, "status") !== "purchase_pending" ||
              integer(purchaseRow, "version") !== input.reservation.drawingVersion + 1 ||
              !sameTicket(persistedTicket, input.reservation.ticket) ||
              !sameTicket(input.ticket, input.reservation.ticket)
            ) {
              return yield* rejected("effect-conflict");
            }
            yield* transaction.execute({
              label: "megapot-purchase.effect.prepared-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,3,'prepared',jsonb_build_object(
                       'calldata_hash',$2::text,'signed_transaction_hash',$3::text
                     ))`,
              values: [input.reservation.effectId, input.calldataHash, input.signedTransactionHash],
              readonly: false,
            });
            const prepared = yield* transaction.execute({
              label: "megapot-purchase.effect.prepare",
              text: `UPDATE reward_chain_effects
                        SET state='prepared', version=3, calldata=$2,
                            calldata_hash=$3, signed_transaction=$4,
                            signed_transaction_hash=$5, prepared_at=$6,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state='nonce_reserved' AND version=2`,
              values: [
                input.reservation.effectId,
                input.calldata,
                input.calldataHash,
                input.signedTransaction,
                input.signedTransactionHash,
                input.preparedAt,
              ],
              readonly: false,
            });
            if (prepared.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
    recordSubmission: (input: Parameters<MegapotPurchaseStore["recordSubmission"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const effect = yield* transaction.execute<Row>({
              label: "megapot-purchase.submission.read",
              text: `SELECT state, version, signed_transaction_hash
                       FROM reward_chain_effects WHERE effect_id=$1 FOR UPDATE`,
              values: [input.effectId],
              readonly: false,
            });
            if (effect.rows.length !== 1) return yield* rejected("not-found");
            const row = effect.rows[0] as Row;
            if (
              text(row, "state") !== "prepared" ||
              text(row, "signed_transaction_hash") !== input.transactionHash
            ) {
              return yield* rejected("effect-conflict");
            }
            const broadcastVersion = integer(row, "version") + 1;
            yield* transaction.execute({
              label: "megapot-purchase.submission-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'broadcast_submitted',jsonb_build_object(
                       'transaction_hash',$3::text
                     ))`,
              values: [input.effectId, broadcastVersion, input.transactionHash],
              readonly: false,
            });
            const submitted = yield* transaction.execute({
              label: "megapot-purchase.submission.record",
              text: `UPDATE reward_chain_effects
                        SET state='broadcast_pending', version=$2,
                            transaction_hash=$3, broadcast_at=$4,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state='prepared'`,
              values: [input.effectId, broadcastVersion, input.transactionHash, input.submittedAt],
              readonly: false,
            });
            if (submitted.rowCount !== 1) return yield* rejected("effect-conflict");
            if (input.outcome === "uncertain") {
              const failureReason = input.failureReason?.trim();
              if (failureReason === undefined || failureReason.length === 0) {
                return yield* rejected("effect-conflict");
              }
              yield* transaction.execute({
                label: "megapot-purchase.uncertain-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'submission_uncertain',jsonb_build_object(
                         'failure_reason',$3::text
                       ))`,
                values: [input.effectId, broadcastVersion + 1, failureReason],
                readonly: false,
              });
              const uncertain = yield* transaction.execute({
                label: "megapot-purchase.uncertain.record",
                text: `UPDATE reward_chain_effects
                          SET state='reconciliation_required', version=version+1,
                              failure_class='ambiguous_submission', failure_reason=$2,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1 AND state='broadcast_pending'`,
                values: [input.effectId, failureReason],
                readonly: false,
              });
              if (uncertain.rowCount !== 1) return yield* rejected("effect-conflict");
            }
          }),
        );
      }).pipe(mapped),
    requireReconciliation: (input: Parameters<MegapotPurchaseStore["requireReconciliation"]>[0]) =>
      Effect.gen(function* () {
        const reason = input.reason.trim();
        if (reason.length === 0) return yield* rejected("effect-conflict");
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const effect = yield* transaction.execute<Row>({
              label: "megapot-purchase.reconciliation.read",
              text: `SELECT state, version, transaction_hash
                       FROM reward_chain_effects WHERE effect_id=$1 FOR UPDATE`,
              values: [input.effectId],
              readonly: false,
            });
            if (effect.rows.length !== 1) return yield* rejected("not-found");
            const row = effect.rows[0] as Row;
            if (text(row, "transaction_hash") !== input.transactionHash) {
              return yield* rejected("effect-conflict");
            }
            const state = text(row, "state");
            if (state === "reconciliation_required") return;
            if (state !== "broadcast_pending" && state !== "confirming") {
              return yield* rejected("effect-conflict");
            }
            const version = integer(row, "version") + 1;
            yield* transaction.execute({
              label: "megapot-purchase.reconciliation-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'receipt_requires_reconciliation',jsonb_build_object(
                       'failure_reason',$3::text
                     ))`,
              values: [input.effectId, version, reason],
              readonly: false,
            });
            const updated = yield* transaction.execute({
              label: "megapot-purchase.reconciliation.record",
              text: `UPDATE reward_chain_effects
                        SET state='reconciliation_required', version=$2,
                            failure_class='receipt_evidence_invalid', failure_reason=$3,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1 AND state IN ('broadcast_pending','confirming')`,
              values: [input.effectId, version, reason],
              readonly: false,
            });
            if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
    confirm: (input: Parameters<MegapotPurchaseStore["confirm"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const detail = yield* transaction.execute<Row>({
              label: "megapot-purchase.confirm.read",
              text: `SELECT effect.state, effect.version, effect.transaction_hash,
                            effect.reserved_amount_atomic, purchase.pool_leg_id,
                            purchase.drawing_id, purchase.attestation_id,
                            attestation.custody_address,
                            drawing.reserved_ticket_cost_atomic,
                            observation.ticket_price_atomic,
                            drawing.fallback_beneficiary,
                            leg.funding_source, leg.fallback_beneficiary_account_id,
                            leg.referral_allocation_version,
                            fallback.sponsor_account_id, fallback.sponsor_day,
                            fallback.sponsor_kind
                       FROM reward_chain_effects effect
                       JOIN megapot_ticket_purchase_effects purchase
                         ON purchase.purchase_effect_id=effect.effect_id
                       JOIN megapot_pool_drawings drawing
                         ON drawing.pool_leg_id=purchase.pool_leg_id
                        AND drawing.drawing_id=purchase.drawing_id
                       JOIN song_reward_offer_legs leg ON leg.leg_id=purchase.pool_leg_id
                       JOIN megapot_drawing_observations observation
                         ON observation.observation_id=drawing.observation_id
                       JOIN megapot_deployment_attestations attestation
                         ON attestation.attestation_id=purchase.attestation_id
                       LEFT JOIN megapot_fallback_cutoff_evidence fallback
                         ON fallback.pool_leg_id=purchase.pool_leg_id
                        AND fallback.drawing_id=purchase.drawing_id
                      WHERE effect.effect_id=$1 FOR UPDATE OF effect, drawing, leg`,
              values: [input.effectId],
              readonly: false,
            });
            if (detail.rows.length !== 1) return yield* rejected("not-found");
            const row = detail.rows[0] as Row;
            if (
              !["broadcast_pending", "confirming", "reconciliation_required"].includes(
                text(row, "state"),
              ) ||
              text(row, "transaction_hash") !== input.transactionHash
            ) {
              return yield* rejected("effect-conflict");
            }
            if (bigint(row, "reserved_amount_atomic") !== bigint(row, "ticket_price_atomic")) {
              return yield* rejected("effect-conflict");
            }
            const effectVersion = integer(row, "version") + 1;
            yield* transaction.execute({
              label: "megapot-purchase.confirm-transition.create",
              text: `INSERT INTO reward_chain_effect_transitions (
                       effect_id, target_version, event_type, event
                     ) VALUES ($1,$2,'receipt_confirmed',jsonb_build_object(
                       'transaction_hash',$3::text,'ticket_id',$4::text
                     ))`,
              values: [
                input.effectId,
                effectVersion,
                input.transactionHash,
                input.ticketId.toString(),
              ],
              readonly: false,
            });
            const effectConfirmed = yield* transaction.execute({
              label: "megapot-purchase.effect.confirm",
              text: `UPDATE reward_chain_effects
                        SET state='confirmed', version=$2,
                            settled_amount_atomic=reserved_amount_atomic,
                            receipt_status='success', receipt_block_number=$3,
                            receipt_block_hash=$4, receipt_hash=$5,
                            confirmations=$6, confirmed_at=$7,
                            failure_class=NULL, failure_reason=NULL,
                            updated_at=clock_timestamp()
                      WHERE effect_id=$1`,
              values: [
                input.effectId,
                effectVersion,
                input.blockNumber.toString(),
                input.blockHash,
                input.receiptHash,
                input.confirmations,
                input.confirmedAt,
              ],
              readonly: false,
            });
            if (effectConfirmed.rowCount !== 1) return yield* rejected("effect-conflict");
            yield* transaction.execute({
              label: "megapot-purchase.ticket-inventory.create",
              text: `INSERT INTO megapot_ticket_inventory (
                       attestation_id, ticket_id, purchase_effect_id, pool_leg_id,
                       drawing_id, custody_address, owner_observation_block_number,
                       owner_observation_block_hash, minted_transaction_hash,
                       minted_log_index, status, acquired_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'custodied',$11)`,
              values: [
                text(row, "attestation_id"),
                input.ticketId.toString(),
                input.effectId,
                text(row, "pool_leg_id"),
                bigint(row, "drawing_id").toString(),
                text(row, "custody_address"),
                input.blockNumber.toString(),
                input.blockHash,
                input.transactionHash,
                input.mintLogIndex,
                input.confirmedAt,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "megapot-purchase.receipt-evidence.create",
              text: `INSERT INTO megapot_purchase_receipt_evidence (
                       purchase_effect_id, attestation_id, ticket_id,
                       transaction_hash, purchase_log_index, mint_log_index,
                       block_number, block_hash, receipt_hash, confirmations,
                       referral_fees_atomic, lp_earnings_atomic, confirmed_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              values: [
                input.effectId,
                text(row, "attestation_id"),
                input.ticketId.toString(),
                input.transactionHash,
                input.purchaseLogIndex,
                input.mintLogIndex,
                input.blockNumber.toString(),
                input.blockHash,
                input.receiptHash,
                input.confirmations,
                input.referralFeesAtomic.toString(),
                input.lpEarningsAtomic.toString(),
                input.confirmedAt,
              ],
              readonly: false,
            });
            if (input.referralFeesAtomic > 0n) {
              yield* transaction.execute({
                label: "megapot-purchase.referral-revenue.create",
                text: `INSERT INTO platform_referral_revenue_ledger (
                         revenue_entry_id, attestation_id, pool_leg_id, drawing_id,
                         ticket_id, revenue_kind, amount_atomic,
                         allocation_policy_version, observation_hash
                       ) VALUES ($1,$2,$3,$4,$5,'purchase_referral_fee',$6,$7,$8)`,
                values: [
                  `purchase-referral:${input.effectId}`,
                  text(row, "attestation_id"),
                  text(row, "pool_leg_id"),
                  bigint(row, "drawing_id").toString(),
                  input.ticketId.toString(),
                  input.referralFeesAtomic.toString(),
                  nullableText(row, "referral_allocation_version") ?? "platform_referral_v1",
                  input.receiptHash,
                ],
                readonly: false,
              });
            }
            const amount = bigint(row, "reserved_amount_atomic");
            const reservationAmount = bigint(row, "reserved_ticket_cost_atomic");
            const fundingSource = text(row, "funding_source");
            if (fundingSource === "leg_budget") {
              const budget = yield* transaction.execute({
                label: "megapot-purchase.leg-budget.confirm",
                text: `UPDATE song_reward_offer_legs
                          SET reserved_atomic=reserved_atomic-$2,
                              spent_atomic=spent_atomic+$3,
                              updated_at=clock_timestamp()
                        WHERE leg_id=$1 AND reserved_atomic >= $2`,
                values: [text(row, "pool_leg_id"), reservationAmount.toString(), amount.toString()],
                readonly: false,
              });
              if (budget.rowCount !== 1) return yield* rejected("insufficient-budget");
            } else if (fundingSource === "shared_sponsor_budget") {
              const sponsorAccountId = text(row, "fallback_beneficiary_account_id");
              const budget = yield* transaction.execute({
                label: "megapot-purchase.sponsorship-budget.confirm",
                text: `UPDATE platform_sponsorship_budgets
                          SET reserved_atomic=reserved_atomic-$2,
                              spent_atomic=spent_atomic+$3,
                              updated_at=clock_timestamp()
                        WHERE sponsor_account_id=$1 AND reserved_atomic >= $2`,
                values: [sponsorAccountId, reservationAmount.toString(), amount.toString()],
                readonly: false,
              });
              if (budget.rowCount !== 1) return yield* rejected("insufficient-budget");
            } else {
              return yield* rejected("effect-conflict");
            }
            const sponsorAccountId = nullableText(row, "sponsor_account_id");
            if (sponsorAccountId !== null) {
              const sponsorTotal = yield* transaction.execute({
                label: "megapot-purchase.sponsor-ceiling.confirm",
                text: `UPDATE sponsor_daily_ticket_totals
                          SET confirmed_ticket_count=confirmed_ticket_count+1,
                              released_ticket_count=released_ticket_count+1,
                              confirmed_spend_atomic=confirmed_spend_atomic+$4,
                              released_spend_atomic=released_spend_atomic+$5,
                              updated_at=clock_timestamp()
                        WHERE sponsor_account_id=$1 AND sponsor_day=$2
                          AND sponsor_kind=$3
                          AND reserved_ticket_count-released_ticket_count >= 1
                          AND reserved_spend_atomic-released_spend_atomic >= $5`,
                values: [
                  sponsorAccountId,
                  text(row, "sponsor_day"),
                  text(row, "sponsor_kind"),
                  amount.toString(),
                  reservationAmount.toString(),
                ],
                readonly: false,
              });
              if (sponsorTotal.rowCount !== 1) return yield* rejected("effect-conflict");
            }
            const drawing = yield* transaction.execute<Row>({
              label: "megapot-purchase.drawing-confirm.read",
              text: `SELECT version FROM megapot_pool_drawings
                      WHERE pool_leg_id=$1 AND drawing_id=$2
                        AND status='purchase_pending' AND purchase_effect_id=$3
                      FOR UPDATE`,
              values: [
                text(row, "pool_leg_id"),
                bigint(row, "drawing_id").toString(),
                input.effectId,
              ],
              readonly: false,
            });
            if (drawing.rows.length !== 1) return yield* rejected("effect-conflict");
            const drawingVersion = integer(drawing.rows[0] as Row, "version") + 1;
            yield* transaction.execute({
              label: "megapot-purchase.drawing-confirm-transition.create",
              text: `INSERT INTO megapot_pool_drawing_transitions (
                       pool_leg_id, drawing_id, target_version, event_type, event
                     ) VALUES ($1,$2,$3,'tickets_confirmed',jsonb_build_object(
                       'purchase_effect_id',$4::text,'ticket_id',$5::text
                     ))`,
              values: [
                text(row, "pool_leg_id"),
                bigint(row, "drawing_id").toString(),
                drawingVersion,
                input.effectId,
                input.ticketId.toString(),
              ],
              readonly: false,
            });
            const drawingConfirmed = yield* transaction.execute({
              label: "megapot-purchase.drawing.confirm",
              text: `UPDATE megapot_pool_drawings
                        SET status='tickets_confirmed', version=$3,
                            actual_ticket_cost_atomic=$4,
                            updated_at=clock_timestamp()
                      WHERE pool_leg_id=$1 AND drawing_id=$2`,
              values: [
                text(row, "pool_leg_id"),
                bigint(row, "drawing_id").toString(),
                drawingVersion,
                amount.toString(),
              ],
              readonly: false,
            });
            if (drawingConfirmed.rowCount !== 1) return yield* rejected("effect-conflict");
          }),
        );
      }).pipe(mapped),
  };
}

export const makeControlPlaneMegapotPurchaseStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotPurchaseStore => {
  const repository = makeControlPlaneMegapotPurchaseRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    findProgress: (effectId) => provide(repository.findProgress(effectId)),
    loadCandidate: (input) => provide(repository.loadCandidate(input)),
    closePreBroadcast: (input) => provide(repository.closePreBroadcast(input)),
    reserveNonce: (input) => provide(repository.reserveNonce(input)),
    prepare: (input) => provide(repository.prepare(input)),
    recordSubmission: (input) => provide(repository.recordSubmission(input)),
    requireReconciliation: (input) => provide(repository.requireReconciliation(input)),
    confirm: (input) => provide(repository.confirm(input)),
  };
};
