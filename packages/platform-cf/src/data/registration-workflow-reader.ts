import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { DataRegistrationPinVerification } from "@pirate/application/data/registration-persistence";
import type {
  DataRegistrationWorkflowPinReader,
  DataRegistrationWorkflowSigningReader,
} from "@pirate/application/data/registration-workflow";
import { Effect, type Layer } from "effect";
import { makeDataRegistrationSigningIntentReader } from "./signing-intent-reader";

type Row = Readonly<Record<string, unknown>>;

const id = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim()
  ) {
    throw new Error("invalid DATA pin row");
  }
  return value;
};

const integer = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid DATA pin row");
  return parsed;
};

const bigint = (value: unknown): bigint => {
  const text = String(value);
  if (!/^[0-9]+$/u.test(text)) throw new Error("invalid DATA pin row");
  return BigInt(text);
};

const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : id(value);

const pinFromRow = (row: Row): DataRegistrationPinVerification => {
  const artifactKind = id(row.artifact_kind);
  const role = id(row.role);
  const outcome = id(row.outcome);
  if (
    !["canonical_audio", "normalized_artwork", "ip_metadata", "nft_metadata"].includes(
      artifactKind,
    ) ||
    !["primary", "independent_gateway"].includes(role) ||
    !["verified", "failed"].includes(outcome)
  ) {
    throw new Error("invalid DATA pin row");
  }
  const verifiedAtValue = row.verified_at;
  const verifiedAt =
    verifiedAtValue === null || verifiedAtValue === undefined
      ? null
      : new Date(
          verifiedAtValue instanceof Date ? verifiedAtValue.getTime() : String(verifiedAtValue),
        ).toISOString();
  return {
    pinVerificationId: id(row.pin_verification_id),
    registrationOperationId: id(row.registration_operation_id),
    artifactId: id(row.artifact_id),
    artifactKind: artifactKind as DataRegistrationPinVerification["artifactKind"],
    role: role as DataRegistrationPinVerification["role"],
    providerId: id(row.provider_id),
    attemptNumber: integer(row.attempt_number),
    outcome: outcome as DataRegistrationPinVerification["outcome"],
    cid: nullable(row.cid),
    canonicalSha256: nullable(row.canonical_sha256),
    byteLength:
      row.byte_length === null || row.byte_length === undefined ? null : bigint(row.byte_length),
    evidenceRef: id(row.evidence_ref),
    verifiedAt,
  };
};

export function makeDataRegistrationWorkflowReaders(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Readonly<{
  pinReader: DataRegistrationWorkflowPinReader;
  signingReader: DataRegistrationWorkflowSigningReader;
}> {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));
  const signing = makeDataRegistrationSigningIntentReader();
  return {
    signingReader: {
      getSigningAttempt: (submissionAttemptId) =>
        run(signing.getSigningAttempt(submissionAttemptId)),
    },
    pinReader: {
      listPinVerifications: (registrationOperationId) => {
        if (id(registrationOperationId) !== registrationOperationId) {
          return Promise.reject(new Error("invalid DATA operation id"));
        }
        return run(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            const result = yield* db.execute<Row>({
              label: "data-registration.workflow.pins.read",
              text: `SELECT pin_verification_id,registration_operation_id,artifact_id,
                            artifact_kind,role,provider_id,attempt_number,outcome,cid,
                            canonical_sha256,byte_length,evidence_ref,verified_at
                       FROM data_registration_pin_verifications
                      WHERE registration_operation_id=$1
                      ORDER BY artifact_id,role,pin_verification_id`,
              values: [registrationOperationId],
              readonly: true,
            });
            return result.rows.map(pinFromRow);
          }),
        );
      },
    },
  };
}
