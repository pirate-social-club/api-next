import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  DanceAttemptProcessingBinding,
  type DanceAttemptProcessingClaim,
  DanceAttemptProcessingInvalid,
  type DanceAttemptProcessingOutcome,
  type DanceAttemptProcessingStore,
  FrozenDanceAttemptInput,
} from "@pirate/application/dance/attempt-processing";
import type {
  DanceAttemptWakeupRecord,
  DanceAttemptWakeupStore,
} from "@pirate/application/dance/attempt-processing-wakeup";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Failure = DanceAttemptProcessingInvalid | ControlPlaneError;

const invalid = (phase: DanceAttemptProcessingInvalid["phase"]) =>
  new DanceAttemptProcessingInvalid({ phase });

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw invalid("claim");
  return value;
};

const nullableText = (row: Row, key: string): string | null =>
  row[key] === null ? null : text(row, key);

const integer = (row: Row, key: string): number => {
  const value = row[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw invalid("claim");
  return parsed;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

async function sha256(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

function decodeClaim(row: Row): DanceAttemptProcessingClaim {
  try {
    const scoredWindowStartMs = integer(row, "cue_observation_end_ms");
    const expectedScoredDurationMs = integer(row, "expected_scored_duration_ms");
    const frozenInput = Schema.decodeUnknownSync(FrozenDanceAttemptInput, {
      onExcessProperty: "error",
    })({
      version: "frozen-dance-attempt-input-v1",
      attemptId: text(row, "attempt_id"),
      sessionId: text(row, "session_id"),
      inputDigest: text(row, "input_digest"),
      privateMediaRef: text(row, "private_object_key"),
      sealedMediaSha256: text(row, "sealed_media_sha256"),
      segmentId: text(row, "segment_id"),
      choreographyId: text(row, "choreography_id"),
      choreographyRevision: integer(row, "choreography_revision"),
      referenceArtifactRef: text(row, "private_artifact_ref"),
      referenceArtifactSha256: text(row, "artifact_sha256"),
      scoredWindowStartMs,
      scoredWindowEndMs: scoredWindowStartMs + expectedScoredDurationMs,
      expectedScoredDurationMs,
      policy: {
        capturedAdmissionState: "shadow",
        poseModelVersion: text(row, "pose_model_version"),
        featureSchemaVersion: text(row, "feature_schema_version"),
        scorerContractVersion: text(row, "scorer_contract_version"),
        mirrorPolicyVersion: text(row, "mirror_policy_version"),
        fingerprintPolicyVersion: text(row, "fingerprint_policy_version"),
        fingerprintKeyVersion: text(row, "fingerprint_key_version"),
        integrityPolicyVersion: text(row, "integrity_policy_version"),
        graderAdapterVersion: text(row, "grader_adapter_version"),
      },
    });
    const binding = Schema.decodeUnknownSync(DanceAttemptProcessingBinding, {
      onExcessProperty: "error",
    })({
      version: "dance-attempt-processing-binding-v1",
      effectIdentity: text(row, "effect_identity"),
      attemptId: text(row, "attempt_id"),
      inputDigest: text(row, "input_digest"),
      attemptNumber: integer(row, "delivery_attempts"),
      claimOwner: text(row, "claim_owner"),
      claimFence: integer(row, "claim_fence"),
    });
    return { frozenInput, binding };
  } catch (error) {
    if (error instanceof DanceAttemptProcessingInvalid) throw error;
    throw invalid("claim");
  }
}

const attemptStates = new Set(["grading_pending", "completed", "rejected", "processing_failed"]);
const wakeupStates = new Set(["pending", "running", "delivered", "failed"]);

function decodeWakeupRow(row: Row): DanceAttemptWakeupRecord {
  const attemptState = text(row, "attempt_state");
  const state = text(row, "state");
  const inputDigest = text(row, "input_digest");
  const deliveryAttempts = integer(row, "delivery_attempts");
  const claimFence = integer(row, "claim_fence");
  if (
    !attemptStates.has(attemptState) ||
    !wakeupStates.has(state) ||
    !/^[0-9a-f]{64}$/u.test(inputDigest) ||
    deliveryAttempts > 3 ||
    typeof row.eligible !== "boolean"
  ) {
    throw invalid("claim");
  }
  return Object.freeze({
    attemptId: text(row, "attempt_id"),
    effectIdentity: text(row, "effect_identity"),
    inputDigest,
    attemptState: attemptState as DanceAttemptWakeupRecord["attemptState"],
    state: state as DanceAttemptWakeupRecord["state"],
    deliveryAttempts,
    claimFence,
    eligible: row.eligible,
  });
}

const frozenProjectionSql = `SELECT a.attempt_id,a.session_id,a.input_digest,a.sealed_media_sha256,
       o.effect_identity,o.delivery_attempts,o.claim_owner,o.claim_fence,
       s.segment_id,s.choreography_id,s.choreography_revision,s.expected_scored_duration_ms,
       s.cue_observation_end_ms,s.captured_admission_state,s.pose_model_version,
       s.feature_schema_version,s.scorer_contract_version,s.mirror_policy_version,
       s.fingerprint_policy_version,s.fingerprint_key_version,s.integrity_policy_version,
       s.grader_adapter_version,u.private_object_key,artifact.private_artifact_ref,
       artifact.artifact_sha256
  FROM dance_attempts a
  JOIN dance_attempt_outbox o ON o.attempt_id=a.attempt_id
  JOIN dance_sessions s ON s.session_id=a.session_id
  JOIN dance_upload_reservations u ON u.reservation_id=a.reservation_id
  JOIN dance_reference_artifacts artifact
    ON artifact.choreography_id=s.choreography_id
   AND artifact.revision=s.choreography_revision`;

function runWithRuntime<A>(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  effect: Effect.Effect<A, Failure, ControlPlaneDb>,
  phase: DanceAttemptProcessingInvalid["phase"],
): Promise<A> {
  return Effect.runPromise(Effect.provide(runtime)(effect)).catch((error: unknown) => {
    if (error instanceof DanceAttemptProcessingInvalid) throw error;
    throw invalid(phase);
  });
}

function existingTerminal(
  tx: ControlPlaneTransaction,
  attemptId: string,
): Effect.Effect<"completed" | "failed" | null, Failure> {
  return Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: "dance-attempt-processing.terminal",
      text: "SELECT state FROM dance_attempts WHERE attempt_id=$1 FOR UPDATE",
      values: [attemptId],
      readonly: false,
    });
    if (result.rows.length !== 1) return null;
    const state = text(result.rows[0] as Row, "state");
    if (state === "grading_pending") return null;
    return state === "processing_failed" ? "failed" : "completed";
  });
}

function insertEvidence(
  tx: ControlPlaneTransaction,
  input: {
    readonly claim: DanceAttemptProcessingClaim;
    readonly outcome: Readonly<{
      readonly gradeOutcome: "scored" | "rejected" | "failed";
      readonly qualificationOutcome: "suppressed_shadow";
      readonly scoreBps: number | null;
      readonly rejectionCode: string | null;
      readonly scoredWindowStartMs: number;
      readonly scoredWindowEndMs: number;
      readonly scoredDurationMs: number;
      readonly evidenceSummary: DanceAttemptProcessingOutcome["evidenceSummary"] | null;
      readonly evidenceDigest: string;
    }>;
    readonly fingerprintClaimId: string | null;
    readonly matchedFingerprintClaimId: string | null;
  },
) {
  return tx.execute({
    label: "dance-attempt-processing.evidence.insert",
    text: `INSERT INTO dance_attempt_evidence (
             attempt_id,session_id,fingerprint_claim_id,matched_fingerprint_claim_id,
             claim_owner,claim_fence,grade_outcome,qualification_outcome,score_bps,
             rejection_code,scored_window_start_ms,scored_window_end_ms,scored_duration_ms,
             evidence_summary,evidence_digest
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'suppressed_shadow',$8,$9,$10,$11,$12,$13::jsonb,$14)`,
    values: [
      input.claim.binding.attemptId,
      input.claim.frozenInput.sessionId,
      input.fingerprintClaimId,
      input.matchedFingerprintClaimId,
      input.claim.binding.claimOwner,
      input.claim.binding.claimFence,
      input.outcome.gradeOutcome,
      input.outcome.scoreBps,
      input.outcome.rejectionCode,
      input.outcome.scoredWindowStartMs,
      input.outcome.scoredWindowEndMs,
      input.outcome.scoredDurationMs,
      input.outcome.evidenceSummary === null ? null : JSON.stringify(input.outcome.evidenceSummary),
      input.outcome.evidenceDigest,
    ],
    readonly: false,
  });
}

export function makeDanceAttemptProcessingStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): DanceAttemptProcessingStore & DanceAttemptWakeupStore {
  const claim: DanceAttemptProcessingStore["claim"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runWithRuntime(
          runtime,
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((tx) =>
              Effect.gen(function* () {
                const terminal = yield* existingTerminal(tx, input.attemptId);
                if (terminal !== null) return { kind: "terminal", status: terminal } as const;
                const claimed = yield* tx.execute<Row>({
                  label: "dance-attempt-processing.claim",
                  text: `UPDATE dance_attempt_outbox SET state='running',
                           delivery_attempts=delivery_attempts+1,claim_owner=$2,
                           claim_fence=claim_fence+1,
                           lease_expires_at=clock_timestamp()+make_interval(secs=>$3),
                           next_eligible_at=NULL,failure_code=NULL,updated_at=clock_timestamp()
                          WHERE attempt_id=$1 AND delivery_attempts<3 AND (
                            state='pending'
                            OR (state='failed' AND next_eligible_at<=clock_timestamp())
                            OR (state='running' AND lease_expires_at<=clock_timestamp())
                          ) RETURNING attempt_id`,
                  values: [input.attemptId, input.workerId, input.leaseSeconds],
                  readonly: false,
                });
                if (claimed.rows.length === 0) return { kind: "busy" } as const;
                const projection = yield* tx.execute<Row>({
                  label: "dance-attempt-processing.claim.projection",
                  text: `${frozenProjectionSql} WHERE a.attempt_id=$1`,
                  values: [input.attemptId],
                  readonly: true,
                });
                if (projection.rows.length !== 1) return yield* Effect.fail(invalid("claim"));
                return {
                  kind: "claimed",
                  claim: decodeClaim(projection.rows[0] as Row),
                } as const;
              }),
            );
          }),
          "claim",
        ),
      catch: () => invalid("claim"),
    });

  const complete: DanceAttemptProcessingStore["complete"] = (processingClaim, outcome) =>
    Effect.tryPromise({
      try: () =>
        runWithRuntime(
          runtime,
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((tx) =>
              Effect.gen(function* () {
                const terminal = yield* existingTerminal(tx, processingClaim.binding.attemptId);
                if (terminal !== null) return "replayed" as const;
                const fingerprint = outcome.fingerprint;
                if (fingerprint === null) {
                  if (outcome.gradeOutcome !== "rejected") {
                    return yield* Effect.fail(invalid("complete"));
                  }
                  yield* insertEvidence(tx, {
                    claim: processingClaim,
                    outcome,
                    fingerprintClaimId: null,
                    matchedFingerprintClaimId: null,
                  });
                  return "committed" as const;
                }
                if (outcome.evidenceSummary === null) {
                  return yield* Effect.fail(invalid("complete"));
                }
                const insertedClaim = yield* tx.execute<Row>({
                  label: "dance-attempt-processing.fingerprint.claim",
                  text: `INSERT INTO dance_replay_fingerprint_claims (
                           fingerprint_claim_id,attempt_id,fingerprint_policy_version,
                           fingerprint_key_version,match_scope,account_scope_id,
                           whole_sequence_fingerprint,segment_fingerprints,terminal_evidence_digest
                         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                         ON CONFLICT DO NOTHING RETURNING fingerprint_claim_id`,
                  values: [
                    fingerprint.claimId,
                    processingClaim.binding.attemptId,
                    fingerprint.policyVersion,
                    fingerprint.keyVersion,
                    fingerprint.matchScope,
                    fingerprint.accountScopeId,
                    fingerprint.wholeSequenceFingerprint,
                    [...fingerprint.segmentFingerprints],
                    outcome.evidenceDigest,
                  ],
                  readonly: false,
                });
                if (insertedClaim.rows.length === 1) {
                  yield* insertEvidence(tx, {
                    claim: processingClaim,
                    outcome,
                    fingerprintClaimId: fingerprint.claimId,
                    matchedFingerprintClaimId: null,
                  });
                  return "committed" as const;
                }
                const matched = yield* tx.execute<Row>({
                  label: "dance-attempt-processing.fingerprint.match",
                  text: `SELECT fingerprint_claim_id FROM dance_replay_fingerprint_claims
                          WHERE fingerprint_policy_version=$1 AND fingerprint_key_version=$2
                            AND match_scope=$3 AND account_scope_id IS NOT DISTINCT FROM $4
                            AND whole_sequence_fingerprint=$5 FOR SHARE`,
                  values: [
                    fingerprint.policyVersion,
                    fingerprint.keyVersion,
                    fingerprint.matchScope,
                    fingerprint.accountScopeId,
                    fingerprint.wholeSequenceFingerprint,
                  ],
                  readonly: false,
                });
                if (matched.rows.length !== 1) return yield* Effect.fail(invalid("complete"));
                const duplicateDigest = yield* Effect.tryPromise({
                  try: () =>
                    sha256({
                      version: "dance-attempt-duplicate-evidence-v1",
                      attemptId: processingClaim.binding.attemptId,
                      matchedFingerprintClaimId: text(
                        matched.rows[0] as Row,
                        "fingerprint_claim_id",
                      ),
                      inputDigest: processingClaim.binding.inputDigest,
                    }),
                  catch: () => invalid("complete"),
                });
                yield* insertEvidence(tx, {
                  claim: processingClaim,
                  outcome: {
                    ...outcome,
                    gradeOutcome: "rejected",
                    scoreBps: null,
                    rejectionCode: "duplicate_attempt",
                    evidenceSummary: {
                      ...outcome.evidenceSummary,
                      replay_outcome: "duplicate",
                    },
                    evidenceDigest: duplicateDigest,
                  },
                  fingerprintClaimId: null,
                  matchedFingerprintClaimId: text(matched.rows[0] as Row, "fingerprint_claim_id"),
                });
                return "committed" as const;
              }),
            );
          }),
          "complete",
        ),
      catch: () => invalid("complete"),
    });

  const fail: DanceAttemptProcessingStore["fail"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runWithRuntime(
          runtime,
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((tx) =>
              Effect.gen(function* () {
                const authority = yield* tx.execute<Row>({
                  label: "dance-attempt-processing.fail.authority",
                  text: `SELECT state,delivery_attempts,claim_owner,claim_fence
                           FROM dance_attempt_outbox WHERE attempt_id=$1 FOR UPDATE`,
                  values: [input.claim.binding.attemptId],
                  readonly: false,
                });
                if (authority.rows.length !== 1) return "stale" as const;
                const row = authority.rows[0] as Row;
                if (
                  text(row, "state") !== "running" ||
                  nullableText(row, "claim_owner") !== input.claim.binding.claimOwner ||
                  integer(row, "claim_fence") !== input.claim.binding.claimFence
                ) {
                  const terminal = yield* existingTerminal(tx, input.claim.binding.attemptId);
                  return terminal === "failed" ? ("exhausted" as const) : ("stale" as const);
                }
                if (integer(row, "delivery_attempts") < 3) {
                  const failed = yield* tx.execute({
                    label: "dance-attempt-processing.fail.retry",
                    text: `UPDATE dance_attempt_outbox SET state='failed',claim_owner=NULL,
                             lease_expires_at=NULL,
                             next_eligible_at=clock_timestamp()+make_interval(secs=>$4),
                             failure_code=$5,updated_at=clock_timestamp()
                            WHERE attempt_id=$1 AND state='running' AND claim_owner=$2
                              AND claim_fence=$3 AND lease_expires_at>clock_timestamp()`,
                    values: [
                      input.claim.binding.attemptId,
                      input.claim.binding.claimOwner,
                      input.claim.binding.claimFence,
                      input.retryAfterSeconds,
                      input.failureCode,
                    ],
                    readonly: false,
                  });
                  return failed.rowCount === 1 ? ("retryable" as const) : ("stale" as const);
                }
                const failureDigest = yield* Effect.tryPromise({
                  try: () =>
                    sha256({
                      version: "dance-attempt-exhausted-evidence-v1",
                      attemptId: input.claim.binding.attemptId,
                      inputDigest: input.claim.binding.inputDigest,
                      failureCode: input.failureCode,
                    }),
                  catch: () => invalid("fail"),
                });
                yield* insertEvidence(tx, {
                  claim: input.claim,
                  outcome: {
                    gradeOutcome: "failed",
                    qualificationOutcome: "suppressed_shadow",
                    scoreBps: null,
                    rejectionCode: "grader_adapter_exhausted",
                    scoredWindowStartMs: input.claim.frozenInput.scoredWindowStartMs,
                    scoredWindowEndMs: input.claim.frozenInput.scoredWindowEndMs,
                    scoredDurationMs: input.claim.frozenInput.expectedScoredDurationMs,
                    evidenceSummary: null,
                    evidenceDigest: failureDigest,
                  },
                  fingerprintClaimId: null,
                  matchedFingerprintClaimId: null,
                });
                return "exhausted" as const;
              }),
            );
          }),
          "fail",
        ),
      catch: () => invalid("fail"),
    });

  const getWakeup: DanceAttemptWakeupStore["getWakeup"] = async (attemptId) =>
    runWithRuntime(
      runtime,
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "dance-attempt-processing.wakeup.get",
          text: `SELECT a.attempt_id,a.input_digest,a.state AS attempt_state,
                        o.effect_identity,o.state,o.delivery_attempts,o.claim_fence,
                        (a.state='grading_pending' AND o.delivery_attempts<3 AND (
                          o.state='pending'
                          OR (o.state='failed' AND o.next_eligible_at<=clock_timestamp())
                          OR (o.state='running' AND o.lease_expires_at<=clock_timestamp())
                        )) AS eligible
                   FROM dance_attempt_outbox o
                   JOIN dance_attempts a ON a.attempt_id=o.attempt_id
                  WHERE a.attempt_id=$1`,
          values: [attemptId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* Effect.fail(invalid("claim"));
        return decodeWakeupRow(result.rows[0] as Row);
      }),
      "claim",
    );

  const listEligibleWakeups: DanceAttemptWakeupStore["listEligibleWakeups"] = async (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid("claim");
    return runWithRuntime(
      runtime,
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "dance-attempt-processing.wakeup.list",
          text: `SELECT a.attempt_id,a.input_digest,a.state AS attempt_state,
                        o.effect_identity,o.state,o.delivery_attempts,o.claim_fence,
                        TRUE AS eligible
                   FROM dance_attempt_outbox o
                   JOIN dance_attempts a ON a.attempt_id=o.attempt_id
                  WHERE a.state='grading_pending' AND o.delivery_attempts<3
                    AND (o.state='pending'
                      OR (o.state='failed' AND o.next_eligible_at<=clock_timestamp())
                      OR (o.state='running' AND o.lease_expires_at<=clock_timestamp()))
                  ORDER BY o.created_at,o.outbox_event_id
                  LIMIT $1`,
          values: [limit],
          readonly: true,
        });
        return result.rows.map(decodeWakeupRow);
      }),
      "claim",
    );
  };

  return { claim, complete, fail, getWakeup, listEligibleWakeups };
}
