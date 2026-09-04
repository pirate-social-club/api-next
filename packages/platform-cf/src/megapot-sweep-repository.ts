import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotSweepCandidate,
  type MegapotSweepFailure,
  MegapotSweepRejected,
  type MegapotSweepResult,
  MegapotSweepStorageFailed,
  type MegapotSweepStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import { mapMegapotStorageFailure } from "./control-plane-error-classification.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: MegapotSweepStorageFailed["reason"]) =>
  new MegapotSweepStorageFailed({ reason });
const rejected = (reason: MegapotSweepRejected["reason"]) => new MegapotSweepRejected({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapMegapotStorageFailure<E, MegapotSweepStorageFailed>(error, storage),
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

function candidateFromRow(row: Row): MegapotSweepCandidate {
  const environment = text(row, "environment");
  const drawingStatus = text(row, "drawing_status");
  if (
    (environment !== "test" && environment !== "staging" && environment !== "production") ||
    (drawingStatus !== "tickets_confirmed" && drawingStatus !== "drawing_pending")
  ) {
    throw new Error("invalid sweep candidate");
  }
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    drawingVersion: integer(row, "drawing_version"),
    drawingStatus,
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
    ticketId: bigint(row, "ticket_id"),
  };
}

const CANDIDATE_SELECT = `
  SELECT drawing.pool_leg_id, drawing.drawing_id,
         drawing.version AS drawing_version, drawing.status AS drawing_status,
         ticket.ticket_id, attestation.attestation_id, attestation.environment,
         attestation.chain_id, attestation.jackpot_address,
         attestation.usdc_address, attestation.ticket_nft_address,
         attestation.custody_address, attestation.referrer_address,
         attestation.jackpot_code_hash, attestation.usdc_code_hash,
         attestation.ticket_nft_code_hash
    FROM megapot_pool_drawings drawing
    JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
    JOIN megapot_ticket_inventory ticket
      ON ticket.pool_leg_id=drawing.pool_leg_id AND ticket.drawing_id=drawing.drawing_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=ticket.attestation_id`;

function loadCandidateIn(
  transaction: ControlPlaneTransaction,
  input: { readonly poolLegId: string; readonly drawingId: bigint; readonly lock: boolean },
): Effect.Effect<MegapotSweepCandidate, MegapotSweepFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "megapot-sweep.candidate.read",
      text: `${CANDIDATE_SELECT}
              WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                AND drawing.status IN ('tickets_confirmed','drawing_pending')
                AND ticket.status='custodied' AND attestation.status='active'
              ${input.lock ? "FOR UPDATE OF drawing, ticket" : ""}`,
      values: [input.poolLegId, input.drawingId.toString()],
      readonly: !input.lock,
    });
    if (result.rows.length === 0) return yield* rejected("not-found");
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => candidateFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

function resultFromRow(row: Row): MegapotSweepResult {
  const tierId = integer(row, "tier_id");
  return {
    sweepId: text(row, "sweep_id"),
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    ticketId: bigint(row, "ticket_id"),
    outcome: tierId === 0 || tierId === 2 ? "no_win" : "winnings_detected",
    tierId,
    grossWinningsAtomic: bigint(row, "gross_winnings_atomic"),
    referralAccrualAtomic: bigint(row, "referral_accrual_atomic"),
    netWinningsAtomic: bigint(row, "net_winnings_atomic"),
    observationBlockNumber: bigint(row, "observation_block_number"),
    observationBlockHash: text(row, "observation_block_hash"),
  };
}

function sameCandidate(left: MegapotSweepCandidate, right: MegapotSweepCandidate): boolean {
  return (
    left.poolLegId === right.poolLegId &&
    left.drawingId === right.drawingId &&
    left.drawingVersion === right.drawingVersion &&
    left.drawingStatus === right.drawingStatus &&
    left.attestationId === right.attestationId &&
    left.chainId === right.chainId &&
    left.ticketId === right.ticketId &&
    left.custodyAddress === right.custodyAddress
  );
}

function moveDrawingPending(
  transaction: ControlPlaneTransaction,
  candidate: MegapotSweepCandidate,
) {
  return Effect.gen(function* () {
    if (candidate.drawingStatus === "drawing_pending") return candidate;
    const nextVersion = candidate.drawingVersion + 1;
    yield* transaction.execute({
      label: "megapot-sweep.pending-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'drawing_pending','{}'::jsonb)`,
      values: [candidate.poolLegId, candidate.drawingId.toString(), nextVersion],
      readonly: false,
    });
    const updated = yield* transaction.execute({
      label: "megapot-sweep.pending.record",
      text: `UPDATE megapot_pool_drawings
                SET status='drawing_pending', version=$3, updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2
                AND status='tickets_confirmed' AND version=$4`,
      values: [
        candidate.poolLegId,
        candidate.drawingId.toString(),
        nextVersion,
        candidate.drawingVersion,
      ],
      readonly: false,
    });
    if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
    return { ...candidate, drawingStatus: "drawing_pending" as const, drawingVersion: nextVersion };
  });
}

function requireReviewIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<MegapotSweepStore["requireReview"]>[0],
): Effect.Effect<void, MegapotSweepFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const candidate = yield* loadCandidateIn(transaction, {
      poolLegId: input.candidate.poolLegId,
      drawingId: input.candidate.drawingId,
      lock: true,
    });
    if (!sameCandidate(candidate, input.candidate)) return yield* rejected("effect-conflict");
    const ticket = yield* transaction.execute({
      label: "megapot-sweep.ticket-review.record",
      text: `UPDATE megapot_ticket_inventory
                SET status='needs_review', terminal_at=$4, updated_at=clock_timestamp()
              WHERE attestation_id=$1 AND ticket_id=$2
                AND pool_leg_id=$3 AND status='custodied'`,
      values: [
        candidate.attestationId,
        candidate.ticketId.toString(),
        candidate.poolLegId,
        input.observedAt,
      ],
      readonly: false,
    });
    if (ticket.rowCount !== 1) return yield* rejected("ticket-not-custodied");
    const nextVersion = candidate.drawingVersion + 1;
    yield* transaction.execute({
      label: "megapot-sweep.review-transition.create",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'operational_hold',jsonb_build_object(
               'reason',$4::text,'sweep_id',$5::text,'ticket_id',$6::text,
               'observation_block_number',$7::text,
               'observation_block_hash',$8::text,'observed_owner_address',$9::text
             ))`,
      values: [
        candidate.poolLegId,
        candidate.drawingId.toString(),
        nextVersion,
        input.reason,
        input.sweepId,
        candidate.ticketId.toString(),
        input.observationBlockNumber.toString(),
        input.observationBlockHash,
        input.observedOwnerAddress,
      ],
      readonly: false,
    });
    const drawing = yield* transaction.execute({
      label: "megapot-sweep.review-hold.record",
      text: `UPDATE megapot_pool_drawings
                SET status='operational_hold', version=$3, terminal_reason=$4,
                    terminal_at=$5, updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2
                AND status=$6 AND version=$7`,
      values: [
        candidate.poolLegId,
        candidate.drawingId.toString(),
        nextVersion,
        input.reason,
        input.observedAt,
        candidate.drawingStatus,
        candidate.drawingVersion,
      ],
      readonly: false,
    });
    if (drawing.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* transaction.execute({
      label: "megapot-sweep.review-evidence.create",
      text: `INSERT INTO megapot_ticket_review_evidence (
               review_id, attestation_id, ticket_id, pool_leg_id, drawing_id,
               source_kind, source_operation_id, reason,
               observation_block_number, observation_block_hash,
               observed_owner_address, observed_at
             ) VALUES ($1,$2,$3,$4,$5,'sweep',$1,$6,$7,$8,$9,$10)`,
      values: [
        input.sweepId,
        candidate.attestationId,
        candidate.ticketId.toString(),
        candidate.poolLegId,
        candidate.drawingId.toString(),
        input.reason,
        input.observationBlockNumber.toString(),
        input.observationBlockHash,
        input.observedOwnerAddress,
        input.observedAt,
      ],
      readonly: false,
    });
  });
}

export function makeControlPlaneMegapotSweepRepository() {
  return {
    loadCandidate: (input: Parameters<MegapotSweepStore["loadCandidate"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* loadCandidateIn(db, { ...input, lock: false });
      }).pipe(mapped),
    findResult: (sweepId: string) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "megapot-sweep.result.read",
          text: `SELECT sweep.sweep_id, sweep.pool_leg_id, sweep.drawing_id,
                        sweep.observation_block_number, sweep.observation_block_hash,
                        evidence.ticket_id, evidence.tier_id,
                        evidence.gross_winnings_atomic,
                        evidence.referral_accrual_atomic,
                        evidence.net_winnings_atomic
                   FROM megapot_drawing_sweeps sweep
                   JOIN megapot_sweep_ticket_evidence evidence
                     ON evidence.sweep_id=sweep.sweep_id
                  WHERE sweep.sweep_id=$1 AND sweep.state='complete'`,
          values: [sweepId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* storage("invalid-row");
        return yield* Effect.try({
          try: () => resultFromRow(result.rows[0] as Row),
          catch: () => storage("invalid-row"),
        });
      }).pipe(mapped),
    markDrawingPending: (candidate: MegapotSweepCandidate) =>
      Effect.gen(function* () {
        if (candidate.drawingStatus === "drawing_pending") return;
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const current = yield* loadCandidateIn(transaction, {
              poolLegId: candidate.poolLegId,
              drawingId: candidate.drawingId,
              lock: true,
            });
            if (!sameCandidate(current, candidate)) return yield* rejected("effect-conflict");
            yield* moveDrawingPending(transaction, current);
          }),
        );
      }).pipe(mapped),
    requireReview: (input: Parameters<MegapotSweepStore["requireReview"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) => requireReviewIn(transaction, input));
      }).pipe(mapped),
    complete: (input: Parameters<MegapotSweepStore["complete"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const loaded = yield* loadCandidateIn(transaction, {
              poolLegId: input.candidate.poolLegId,
              drawingId: input.candidate.drawingId,
              lock: true,
            });
            if (!sameCandidate(loaded, input.candidate)) return yield* rejected("effect-conflict");
            const candidate = yield* moveDrawingPending(transaction, loaded);
            const winning = input.tierId !== 0 && input.tierId !== 2;
            yield* transaction.execute({
              label: "megapot-sweep.record.create",
              text: `INSERT INTO megapot_drawing_sweeps (
                       sweep_id, pool_leg_id, attestation_id, drawing_id,
                       observation_block_number, observation_block_hash,
                       drawing_state_hash, ticket_count, winning_ticket_count,
                       state, observed_at, completed_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,'complete',$9,$9)`,
              values: [
                input.sweepId,
                candidate.poolLegId,
                candidate.attestationId,
                candidate.drawingId.toString(),
                input.observationBlockNumber.toString(),
                input.observationBlockHash,
                input.drawingStateHash,
                winning ? 1 : 0,
                input.observedAt,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "megapot-sweep.ticket-evidence.create",
              text: `INSERT INTO megapot_sweep_ticket_evidence (
                       sweep_id, attestation_id, ticket_id, tier_id,
                       custody_owner_address, gross_winnings_atomic,
                       referral_win_share_atomic, referral_accrual_atomic,
                       net_winnings_atomic
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              values: [
                input.sweepId,
                candidate.attestationId,
                candidate.ticketId.toString(),
                input.tierId,
                input.custodyOwnerAddress,
                input.grossWinningsAtomic.toString(),
                input.referralWinShareAtomic.toString(),
                input.referralAccrualAtomic.toString(),
                input.netWinningsAtomic.toString(),
              ],
              readonly: false,
            });
            if (!winning) {
              const ticket = yield* transaction.execute({
                label: "megapot-sweep.ticket.no-win",
                text: `UPDATE megapot_ticket_inventory
                          SET status='no_win', terminal_at=$4, updated_at=clock_timestamp()
                        WHERE attestation_id=$1 AND ticket_id=$2
                          AND pool_leg_id=$3 AND status='custodied'`,
                values: [
                  candidate.attestationId,
                  candidate.ticketId.toString(),
                  candidate.poolLegId,
                  input.observedAt,
                ],
                readonly: false,
              });
              if (ticket.rowCount !== 1) return yield* rejected("ticket-not-custodied");
            }
            const nextVersion = candidate.drawingVersion + 1;
            const outcome = winning ? "winnings_detected" : "no_win";
            yield* transaction.execute({
              label: "megapot-sweep.outcome-transition.create",
              text: `INSERT INTO megapot_pool_drawing_transitions (
                       pool_leg_id, drawing_id, target_version, event_type, event
                     ) VALUES ($1,$2,$3,$4,jsonb_build_object(
                       'sweep_id',$5::text,'ticket_id',$6::text,'tier_id',$7::integer
                     ))`,
              values: [
                candidate.poolLegId,
                candidate.drawingId.toString(),
                nextVersion,
                outcome,
                input.sweepId,
                candidate.ticketId.toString(),
                input.tierId,
              ],
              readonly: false,
            });
            const drawing = yield* transaction.execute({
              label: "megapot-sweep.outcome.record",
              text: `UPDATE megapot_pool_drawings
                        SET status=$3, version=$4, gross_winnings_atomic=$5,
                            net_winnings_atomic=$6,
                            terminal_reason=CASE WHEN $3='no_win' THEN 'no_paying_tier' END,
                            terminal_at=CASE WHEN $3='no_win' THEN $7::timestamptz END,
                            updated_at=clock_timestamp()
                      WHERE pool_leg_id=$1 AND drawing_id=$2
                        AND status='drawing_pending' AND version=$8`,
              values: [
                candidate.poolLegId,
                candidate.drawingId.toString(),
                outcome,
                nextVersion,
                input.grossWinningsAtomic.toString(),
                input.netWinningsAtomic.toString(),
                input.observedAt,
                candidate.drawingVersion,
              ],
              readonly: false,
            });
            if (drawing.rowCount !== 1) return yield* rejected("effect-conflict");
            return {
              sweepId: input.sweepId,
              poolLegId: candidate.poolLegId,
              drawingId: candidate.drawingId,
              ticketId: candidate.ticketId,
              outcome,
              tierId: input.tierId,
              grossWinningsAtomic: input.grossWinningsAtomic,
              referralAccrualAtomic: input.referralAccrualAtomic,
              netWinningsAtomic: input.netWinningsAtomic,
              observationBlockNumber: input.observationBlockNumber,
              observationBlockHash: input.observationBlockHash,
            } satisfies MegapotSweepResult;
          }),
        );
      }).pipe(mapped),
  };
}

export const makeControlPlaneMegapotSweepStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotSweepStore => {
  const repository = makeControlPlaneMegapotSweepRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadCandidate: (input) => provide(repository.loadCandidate(input)),
    findResult: (sweepId) => provide(repository.findResult(sweepId)),
    markDrawingPending: (candidate) => provide(repository.markDrawingPending(candidate)),
    requireReview: (input) => provide(repository.requireReview(input)),
    complete: (input) => provide(repository.complete(input)),
  };
};
