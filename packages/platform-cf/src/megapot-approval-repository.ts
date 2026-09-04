import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotApprovalCandidate,
  type MegapotApprovalFailure,
  type MegapotApprovalProgress,
  MegapotApprovalRejected,
  MegapotApprovalStorageFailed,
  type MegapotApprovalStore,
  type MegapotReservedApproval,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import { mapMegapotStorageFailure } from "./control-plane-error-classification.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: MegapotApprovalStorageFailed["reason"]): MegapotApprovalStorageFailed =>
  new MegapotApprovalStorageFailed({ reason });
const rejected = (reason: MegapotApprovalRejected["reason"]): MegapotApprovalRejected =>
  new MegapotApprovalRejected({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapMegapotStorageFailure<E, MegapotApprovalStorageFailed>(error, storage),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function nullableText(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
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

const CANDIDATE_SELECT = `
  SELECT attestation.attestation_id, attestation.environment,
         attestation.chain_id, attestation.jackpot_address,
         attestation.usdc_address, attestation.ticket_nft_address,
         attestation.custody_address, attestation.referrer_address,
         attestation.jackpot_code_hash, attestation.usdc_code_hash,
         attestation.ticket_nft_code_hash
    FROM megapot_deployment_attestations attestation`;

function candidateFromRow(row: Row): MegapotApprovalCandidate {
  const environment = text(row, "environment");
  if (environment !== "test" && environment !== "staging" && environment !== "production") {
    throw new Error("invalid environment");
  }
  return {
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

function sameCandidate(left: MegapotApprovalCandidate, right: MegapotApprovalCandidate): boolean {
  return (
    left.attestationId === right.attestationId &&
    left.environment === right.environment &&
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

function loadCandidateIn(
  transaction: ControlPlaneTransaction,
  attestationId: string,
  lock: boolean,
): Effect.Effect<MegapotApprovalCandidate, MegapotApprovalFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "megapot-approval.candidate.read",
      text: `${CANDIDATE_SELECT}
              WHERE attestation.attestation_id=$1 AND attestation.status='active'
              ${lock ? "FOR SHARE OF attestation" : ""}`,
      values: [attestationId],
      readonly: !lock,
    });
    if (result.rows.length === 0) return yield* rejected("not-found");
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => candidateFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

function progressFromRow(row: Row): MegapotApprovalProgress {
  const state = text(row, "state");
  const effectId = text(row, "effect_id");
  const candidate = candidateFromRow(row);
  if (state === "confirmed") {
    return {
      state,
      effectId,
      attestationId: candidate.attestationId,
      transactionHash: text(row, "transaction_hash"),
      approvedAmountAtomic: bigint(row, "approved_amount_atomic"),
      allowanceAfterAtomic: bigint(row, "allowance_after_atomic"),
      blockNumber: bigint(row, "receipt_block_number"),
      blockHash: text(row, "receipt_block_hash"),
      confirmations: integer(row, "receipt_confirmations"),
    };
  }
  const reservation: MegapotReservedApproval = {
    ...candidate,
    effectId,
    nonce: bigint(row, "nonce"),
    effectVersion: integer(row, "effect_version"),
    allowanceBeforeAtomic: bigint(row, "allowance_before_atomic"),
    minimumAllowanceAtomic: bigint(row, "minimum_allowance_atomic"),
    approvedAmountAtomic: bigint(row, "approved_amount_atomic"),
  };
  if (state === "nonce_reserved") return { state, reservation };
  if (
    state !== "prepared" &&
    state !== "broadcast_pending" &&
    state !== "confirming" &&
    state !== "reconciliation_required"
  ) {
    throw new Error("invalid approval state");
  }
  const transactionHash = nullableText(row, "transaction_hash");
  if (state === "prepared" ? transactionHash !== null : transactionHash === null) {
    throw new Error("invalid approval transaction identity");
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

const PROGRESS_SELECT = `
  SELECT effect.effect_id, effect.state, effect.version AS effect_version,
         effect.nonce, effect.calldata, effect.calldata_hash,
         effect.signed_transaction, effect.signed_transaction_hash,
         effect.transaction_hash,
         approval.allowance_before_atomic, approval.minimum_allowance_atomic,
         approval.approved_amount_atomic,
         attestation.attestation_id, attestation.environment,
         attestation.chain_id, attestation.jackpot_address,
         attestation.usdc_address, attestation.ticket_nft_address,
         attestation.custody_address, attestation.referrer_address,
         attestation.jackpot_code_hash, attestation.usdc_code_hash,
         attestation.ticket_nft_code_hash,
         evidence.allowance_after_atomic,
         evidence.block_number AS receipt_block_number,
         evidence.block_hash AS receipt_block_hash,
         evidence.confirmations AS receipt_confirmations
    FROM reward_chain_effects effect
    JOIN megapot_usdc_approval_effects approval
      ON approval.approval_effect_id=effect.effect_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=approval.attestation_id
    LEFT JOIN megapot_usdc_approval_receipt_evidence evidence
      ON evidence.approval_effect_id=effect.effect_id`;

function reserveNonceIn(
  transaction: ControlPlaneTransaction,
  input: Parameters<MegapotApprovalStore["reserveNonce"]>[0],
) {
  return Effect.gen(function* () {
    const candidate = yield* loadCandidateIn(transaction, input.candidate.attestationId, true);
    if (!sameCandidate(candidate, input.candidate)) return yield* rejected("effect-conflict");
    if (
      input.minimumAllowanceAtomic < 1n ||
      input.approvedAmountAtomic < input.minimumAllowanceAtomic ||
      input.allowanceBeforeAtomic >= input.minimumAllowanceAtomic
    ) {
      return yield* rejected("effect-conflict");
    }
    const current = yield* transaction.execute<Row>({
      label: "megapot-approval.nonce.read",
      text: `SELECT next_nonce, observed_block_number, observed_at
               FROM reward_signer_nonces
              WHERE chain_id=$1 AND signer_address=$2 FOR UPDATE`,
      values: [candidate.chainId, candidate.custodyAddress],
      readonly: false,
    });
    let nonce: bigint;
    if (current.rows.length === 0) {
      nonce = input.observedPendingNonce;
      const created = yield* transaction.execute({
        label: "megapot-approval.nonce.create",
        text: `INSERT INTO reward_signer_nonces (
                 chain_id, signer_address, next_nonce, observed_pending_nonce,
                 observed_block_number, observed_block_hash, observed_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [
          candidate.chainId,
          candidate.custodyAddress,
          (nonce + 1n).toString(),
          input.observedPendingNonce.toString(),
          input.observedBlockNumber.toString(),
          input.observedBlockHash,
          input.observedAt,
        ],
        readonly: false,
      });
      if (created.rowCount !== 1) return yield* rejected("effect-conflict");
    } else {
      if (current.rows.length !== 1) return yield* storage("invalid-row");
      const row = current.rows[0] as Row;
      if (
        input.observedBlockNumber < bigint(row, "observed_block_number") ||
        Date.parse(input.observedAt) < instantMillis(row, "observed_at")
      ) {
        return yield* rejected("nonce-observation-stale");
      }
      nonce = bigint(row, "next_nonce");
      if (input.observedPendingNonce > nonce) nonce = input.observedPendingNonce;
      const updated = yield* transaction.execute({
        label: "megapot-approval.nonce.reserve",
        text: `UPDATE reward_signer_nonces
                  SET next_nonce=$3, observed_pending_nonce=$4,
                      observed_block_number=$5, observed_block_hash=$6,
                      observed_at=$7, fence_version=fence_version+1,
                      updated_at=clock_timestamp()
                WHERE chain_id=$1 AND signer_address=$2`,
        values: [
          candidate.chainId,
          candidate.custodyAddress,
          (nonce + 1n).toString(),
          input.observedPendingNonce.toString(),
          input.observedBlockNumber.toString(),
          input.observedBlockHash,
          input.observedAt,
        ],
        readonly: false,
      });
      if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
    }
    yield* transaction.execute({
      label: "megapot-approval.effect.create",
      text: `INSERT INTO reward_chain_effects (
               effect_id, effect_kind, state, chain_id, signer_address, target_address
             ) VALUES ($1,'usdc_approval','planned',$2,$3,$4)`,
      values: [input.effectId, candidate.chainId, candidate.custodyAddress, candidate.usdcAddress],
      readonly: false,
    });
    yield* transaction.execute({
      label: "megapot-approval.effect.nonce-transition.create",
      text: `INSERT INTO reward_chain_effect_transitions (
               effect_id, target_version, event_type, event
             ) VALUES ($1,2,'nonce_reserved',jsonb_build_object('nonce',$2::text))`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    const effect = yield* transaction.execute({
      label: "megapot-approval.effect.nonce-reserve",
      text: `UPDATE reward_chain_effects
                SET state='nonce_reserved', version=2, nonce=$2,
                    updated_at=clock_timestamp()
              WHERE effect_id=$1 AND state='planned' AND version=1`,
      values: [input.effectId, nonce.toString()],
      readonly: false,
    });
    if (effect.rowCount !== 1) return yield* rejected("effect-conflict");
    yield* transaction.execute({
      label: "megapot-approval.detail.create",
      text: `INSERT INTO megapot_usdc_approval_effects (
               approval_effect_id, attestation_id, spender_address,
               allowance_before_atomic, minimum_allowance_atomic, approved_amount_atomic
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
      values: [
        input.effectId,
        candidate.attestationId,
        candidate.jackpotAddress,
        input.allowanceBeforeAtomic.toString(),
        input.minimumAllowanceAtomic.toString(),
        input.approvedAmountAtomic.toString(),
      ],
      readonly: false,
    });
    return {
      ...candidate,
      effectId: input.effectId,
      nonce,
      effectVersion: 2,
      allowanceBeforeAtomic: input.allowanceBeforeAtomic,
      minimumAllowanceAtomic: input.minimumAllowanceAtomic,
      approvedAmountAtomic: input.approvedAmountAtomic,
    } satisfies MegapotReservedApproval;
  });
}

export function makeControlPlaneMegapotApprovalRepository() {
  return {
    findProgress: (effectId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "megapot-approval.progress.read",
            text: `${PROGRESS_SELECT} WHERE effect.effect_id=$1`,
            values: [effectId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length !== 1) return yield* storage("invalid-row");
          return yield* Effect.try({
            try: () => progressFromRow(result.rows[0] as Row),
            catch: () => storage("invalid-row"),
          });
        }),
      ),
    loadCandidate: (attestationId: string) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* loadCandidateIn(db, attestationId, false);
        }),
      ),
    reserveNonce: (input: Parameters<MegapotApprovalStore["reserveNonce"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) => reserveNonceIn(transaction, input));
        }),
      ),
    prepare: (input: Parameters<MegapotApprovalStore["prepare"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const current = yield* transaction.execute<Row>({
                label: "megapot-approval.prepare.read",
                text: `SELECT effect.state, effect.version, effect.nonce,
                              approval.allowance_before_atomic,
                              approval.minimum_allowance_atomic,
                              approval.approved_amount_atomic
                         FROM reward_chain_effects effect
                         JOIN megapot_usdc_approval_effects approval
                           ON approval.approval_effect_id=effect.effect_id
                        WHERE effect.effect_id=$1 FOR UPDATE OF effect`,
                values: [input.reservation.effectId],
                readonly: false,
              });
              if (current.rows.length !== 1) return yield* rejected("not-found");
              const row = current.rows[0] as Row;
              if (
                text(row, "state") !== "nonce_reserved" ||
                integer(row, "version") !== input.reservation.effectVersion ||
                bigint(row, "nonce") !== input.reservation.nonce ||
                bigint(row, "allowance_before_atomic") !==
                  input.reservation.allowanceBeforeAtomic ||
                bigint(row, "minimum_allowance_atomic") !==
                  input.reservation.minimumAllowanceAtomic ||
                bigint(row, "approved_amount_atomic") !== input.reservation.approvedAmountAtomic
              ) {
                return yield* rejected("effect-conflict");
              }
              yield* transaction.execute({
                label: "megapot-approval.prepared-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,3,'prepared',jsonb_build_object(
                         'calldata_hash',$2::text,'signed_transaction_hash',$3::text
                       ))`,
                values: [
                  input.reservation.effectId,
                  input.calldataHash,
                  input.signedTransactionHash,
                ],
                readonly: false,
              });
              const updated = yield* transaction.execute({
                label: "megapot-approval.prepare",
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
              if (updated.rowCount !== 1) return yield* rejected("effect-conflict");
            }),
          );
        }),
      ),
    recordSubmission: (input: Parameters<MegapotApprovalStore["recordSubmission"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const current = yield* transaction.execute<Row>({
                label: "megapot-approval.submission.read",
                text: `SELECT state, version, signed_transaction_hash
                         FROM reward_chain_effects WHERE effect_id=$1 FOR UPDATE`,
                values: [input.effectId],
                readonly: false,
              });
              if (current.rows.length !== 1) return yield* rejected("not-found");
              const row = current.rows[0] as Row;
              if (
                text(row, "state") !== "prepared" ||
                text(row, "signed_transaction_hash") !== input.transactionHash
              ) {
                return yield* rejected("effect-conflict");
              }
              const version = integer(row, "version") + 1;
              yield* transaction.execute({
                label: "megapot-approval.submission-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'broadcast_submitted',jsonb_build_object(
                         'transaction_hash',$3::text
                       ))`,
                values: [input.effectId, version, input.transactionHash],
                readonly: false,
              });
              const submitted = yield* transaction.execute({
                label: "megapot-approval.submission.record",
                text: `UPDATE reward_chain_effects
                          SET state='broadcast_pending', version=$2,
                              transaction_hash=$3, broadcast_at=$4,
                              updated_at=clock_timestamp()
                        WHERE effect_id=$1 AND state='prepared'`,
                values: [input.effectId, version, input.transactionHash, input.submittedAt],
                readonly: false,
              });
              if (submitted.rowCount !== 1) return yield* rejected("effect-conflict");
              if (input.outcome === "uncertain") {
                const reason = input.failureReason?.trim();
                if (reason === undefined || reason.length === 0) {
                  return yield* rejected("effect-conflict");
                }
                yield* transaction.execute({
                  label: "megapot-approval.uncertain-transition.create",
                  text: `INSERT INTO reward_chain_effect_transitions (
                           effect_id, target_version, event_type, event
                         ) VALUES ($1,$2,'submission_uncertain',jsonb_build_object(
                           'failure_reason',$3::text
                         ))`,
                  values: [input.effectId, version + 1, reason],
                  readonly: false,
                });
                const uncertain = yield* transaction.execute({
                  label: "megapot-approval.uncertain.record",
                  text: `UPDATE reward_chain_effects
                            SET state='reconciliation_required', version=version+1,
                                failure_class='ambiguous_submission', failure_reason=$2,
                                updated_at=clock_timestamp()
                          WHERE effect_id=$1 AND state='broadcast_pending'`,
                  values: [input.effectId, reason],
                  readonly: false,
                });
                if (uncertain.rowCount !== 1) return yield* rejected("effect-conflict");
              }
            }),
          );
        }),
      ),
    requireReconciliation: (input: Parameters<MegapotApprovalStore["requireReconciliation"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const reason = input.reason.trim();
          if (reason.length === 0) return yield* rejected("effect-conflict");
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const current = yield* transaction.execute<Row>({
                label: "megapot-approval.reconciliation.read",
                text: `SELECT state, version, transaction_hash
                         FROM reward_chain_effects WHERE effect_id=$1 FOR UPDATE`,
                values: [input.effectId],
                readonly: false,
              });
              if (current.rows.length !== 1) return yield* rejected("not-found");
              const row = current.rows[0] as Row;
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
                label: "megapot-approval.reconciliation-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'receipt_requires_reconciliation',jsonb_build_object(
                         'failure_reason',$3::text
                       ))`,
                values: [input.effectId, version, reason],
                readonly: false,
              });
              const updated = yield* transaction.execute({
                label: "megapot-approval.reconciliation.record",
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
        }),
      ),
    confirm: (input: Parameters<MegapotApprovalStore["confirm"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const current = yield* transaction.execute<Row>({
                label: "megapot-approval.confirm.read",
                text: `SELECT effect.state, effect.version, effect.transaction_hash,
                              approval.attestation_id,
                              approval.minimum_allowance_atomic,
                              approval.approved_amount_atomic
                         FROM reward_chain_effects effect
                         JOIN megapot_usdc_approval_effects approval
                           ON approval.approval_effect_id=effect.effect_id
                        WHERE effect.effect_id=$1 FOR UPDATE OF effect`,
                values: [input.effectId],
                readonly: false,
              });
              if (current.rows.length !== 1) return yield* rejected("not-found");
              const row = current.rows[0] as Row;
              if (
                !["broadcast_pending", "confirming", "reconciliation_required"].includes(
                  text(row, "state"),
                ) ||
                text(row, "transaction_hash") !== input.transactionHash ||
                bigint(row, "approved_amount_atomic") !== input.approvedAmountAtomic ||
                input.allowanceAfterAtomic < bigint(row, "minimum_allowance_atomic")
              ) {
                return yield* rejected("effect-conflict");
              }
              const version = integer(row, "version") + 1;
              yield* transaction.execute({
                label: "megapot-approval.confirm-transition.create",
                text: `INSERT INTO reward_chain_effect_transitions (
                         effect_id, target_version, event_type, event
                       ) VALUES ($1,$2,'receipt_confirmed',jsonb_build_object(
                         'transaction_hash',$3::text,'approved_amount_atomic',$4::text
                       ))`,
                values: [
                  input.effectId,
                  version,
                  input.transactionHash,
                  input.approvedAmountAtomic.toString(),
                ],
                readonly: false,
              });
              const confirmed = yield* transaction.execute({
                label: "megapot-approval.effect.confirm",
                text: `UPDATE reward_chain_effects
                          SET state='confirmed', version=$2, settled_amount_atomic=0,
                              receipt_status='success', receipt_block_number=$3,
                              receipt_block_hash=$4, receipt_hash=$5,
                              confirmations=$6, confirmed_at=$7,
                              failure_class=NULL, failure_reason=NULL,
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
              if (confirmed.rowCount !== 1) return yield* rejected("effect-conflict");
              yield* transaction.execute({
                label: "megapot-approval.receipt-evidence.create",
                text: `INSERT INTO megapot_usdc_approval_receipt_evidence (
                         approval_effect_id, attestation_id, transaction_hash,
                         approval_log_index, approved_amount_atomic,
                         allowance_after_atomic, block_number, block_hash,
                         receipt_hash, confirmations, confirmed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                values: [
                  input.effectId,
                  text(row, "attestation_id"),
                  input.transactionHash,
                  input.approvalLogIndex,
                  input.approvedAmountAtomic.toString(),
                  input.allowanceAfterAtomic.toString(),
                  input.blockNumber.toString(),
                  input.blockHash,
                  input.receiptHash,
                  input.confirmations,
                  input.confirmedAt,
                ],
                readonly: false,
              });
            }),
          );
        }),
      ),
  };
}

export function makeControlPlaneMegapotApprovalStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotApprovalStore {
  const repository = makeControlPlaneMegapotApprovalRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    findProgress: (effectId) => provide(repository.findProgress(effectId)),
    loadCandidate: (attestationId) => provide(repository.loadCandidate(attestationId)),
    reserveNonce: (input) => provide(repository.reserveNonce(input)),
    prepare: (input) => provide(repository.prepare(input)),
    recordSubmission: (input) => provide(repository.recordSubmission(input)),
    requireReconciliation: (input) => provide(repository.requireReconciliation(input)),
    confirm: (input) => provide(repository.confirm(input)),
  };
}
