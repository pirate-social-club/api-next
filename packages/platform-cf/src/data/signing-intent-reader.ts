import { ControlPlaneDb } from "@pirate/application";
import type { DataRegistrationSigningAttempt } from "@pirate/application/data/registration-persistence";
import type { DataRegistrationSigningIntentReader } from "@pirate/application/data/signing-coordinator";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;

const STATES = new Set([
  "signing_intent",
  "nonce_reserved",
  "prepared",
  "broadcast",
  "mined",
  "confirmed",
  "replaced",
  "reverted",
  "failed",
  "reconciliation_required",
]);
const FAILURE_CODES = new Set([
  "signing_failed",
  "broadcast_failed",
  "receipt_reverted",
  "confirmation_timeout",
  "chain_reorganization",
  "invalid_receipt",
]);

export class DataRegistrationSigningIntentReadFailed extends Data.TaggedError(
  "DataRegistrationSigningIntentReadFailed",
)<{
  readonly reason: "invalid-input" | "invalid-row" | "unavailable";
}> {}

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();

const text = (row: Row, field: string): string => {
  const value = row[field];
  if (!id(value)) throw new Error("invalid row");
  return value;
};

const bigint = (row: Row, field: string): bigint => {
  const value = String(row[field]);
  if (!/^[0-9]+$/u.test(value)) throw new Error("invalid row");
  return BigInt(value);
};

const integer = (row: Row, field: string): number => {
  const value = Number(bigint(row, field));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid row");
  return value;
};

const nullableBigint = (row: Row, field: string): bigint | null =>
  row[field] === null || row[field] === undefined ? null : bigint(row, field);

const nullableText = (row: Row, field: string): string | null =>
  row[field] === null || row[field] === undefined ? null : text(row, field);

const member = <Value extends string>(row: Row, field: string, values: Set<string>): Value => {
  const value = text(row, field);
  if (!values.has(value)) throw new Error("invalid row");
  return value as Value;
};

const nullableMember = <Value extends string>(
  row: Row,
  field: string,
  values: Set<string>,
): Value | null =>
  row[field] === null || row[field] === undefined ? null : member<Value>(row, field, values);

const instant = (row: Row, field: string): string => {
  const value = row[field];
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) throw new Error("invalid row");
  return new Date(milliseconds).toISOString();
};

const bytes = (row: Row, field: string): Uint8Array | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (!(value instanceof Uint8Array)) throw new Error("invalid row");
  return new Uint8Array(value);
};

const attemptFromRow = (row: Row): DataRegistrationSigningAttempt => ({
  submissionAttemptId: text(row, "submission_attempt_id"),
  registrationOperationId: text(row, "registration_operation_id"),
  chainId: bigint(row, "chain_id"),
  attemptNumber: integer(row, "attempt_number"),
  signerNamespace: text(row, "signer_namespace"),
  signerAddress: text(row, "signer_address"),
  signingIntentId: text(row, "signing_intent_id"),
  targetAddress: text(row, "target_address"),
  methodSelector: text(row, "method_selector"),
  calldataHash: text(row, "calldata_hash"),
  signingDeadline: instant(row, "signing_deadline"),
  valueWei: bigint(row, "value_wei"),
  gasLimit: bigint(row, "gas_limit"),
  maxFeePerGas: bigint(row, "max_fee_per_gas"),
  maxPriorityFeePerGas: bigint(row, "max_priority_fee_per_gas"),
  nonce: nullableBigint(row, "nonce"),
  signedTransaction: bytes(row, "signed_transaction"),
  signedTransactionHash: nullableText(row, "signed_transaction_hash"),
  transactionHash: nullableText(row, "transaction_hash"),
  supersedesSubmissionAttemptId: nullableText(row, "supersedes_submission_attempt_id"),
  state: member<DataRegistrationSigningAttempt["state"]>(row, "state", STATES),
  failureCode: nullableMember<NonNullable<DataRegistrationSigningAttempt["failureCode"]>>(
    row,
    "failure_code",
    FAILURE_CODES,
  ),
  failureEvidenceRef: nullableText(row, "failure_evidence_ref"),
});

export const makeDataRegistrationSigningIntentReader =
  (): DataRegistrationSigningIntentReader<ControlPlaneDb> => ({
    getSigningAttempt: (submissionAttemptId) => {
      if (!id(submissionAttemptId)) {
        return Effect.fail(
          new DataRegistrationSigningIntentReadFailed({ reason: "invalid-input" }),
        );
      }
      return Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db
          .execute<Row>({
            label: "data-registration.signing-intent.read",
            text: `SELECT submission_attempt_id,registration_operation_id,chain_id,
                        attempt_number,signer_namespace,signer_address,signing_intent_id,
                        target_address,method_selector,calldata_hash,signing_deadline,
                        value_wei,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,
                        nonce,signed_transaction,signed_transaction_hash,transaction_hash,
                        supersedes_submission_attempt_id,state,failure_code,failure_evidence_ref
                   FROM data_registration_signing_attempts
                  WHERE submission_attempt_id=$1`,
            values: [submissionAttemptId],
            readonly: true,
          })
          .pipe(
            Effect.mapError(
              () => new DataRegistrationSigningIntentReadFailed({ reason: "unavailable" }),
            ),
          );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1 || result.rows[0] === undefined) {
          return yield* Effect.fail(
            new DataRegistrationSigningIntentReadFailed({ reason: "invalid-row" }),
          );
        }
        return yield* Effect.try({
          try: () => attemptFromRow(result.rows[0] ?? {}),
          catch: () => new DataRegistrationSigningIntentReadFailed({ reason: "invalid-row" }),
        });
      });
    },
  });
