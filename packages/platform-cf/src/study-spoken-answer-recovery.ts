import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

export const STUDY_SPOKEN_ANSWER_RECOVERY_BATCH_LIMIT = 25;
export const STUDY_SPOKEN_ANSWER_RECOVERY_LEASE_MS = 120_000;

export interface StudySpokenAnswerRecoveryClaim {
  readonly commandId: string;
  readonly accountId: string;
  readonly artifactId: string;
  readonly expectedObjectRef: string;
  readonly leaseToken: string;
}

export interface StudySpokenAnswerRecoveryStore {
  readonly claimExpired: (input: {
    readonly leaseToken: string;
    readonly leaseMs: number;
    readonly limit: number;
  }) => Effect.Effect<readonly StudySpokenAnswerRecoveryClaim[], ControlPlaneError>;
  readonly finalizeFailed: (input: {
    readonly claim: StudySpokenAnswerRecoveryClaim;
    readonly failedAt: string;
  }) => Effect.Effect<boolean, ControlPlaneError | StudySpokenAnswerRecoveryInvariantFailed>;
}

export interface StudySpokenAnswerRecoveryBucket {
  readonly delete: (key: string) => Promise<void>;
  readonly head: (key: string) => Promise<unknown | null>;
}

export interface StudySpokenAnswerRecoverySummary {
  readonly claimed: number;
  readonly recovered: number;
  readonly storageFailures: number;
  readonly fenced: number;
}

export class StudySpokenAnswerRecoveryInvariantFailed extends Data.TaggedError(
  "StudySpokenAnswerRecoveryInvariantFailed",
)<{ readonly commandId: string }> {}

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
};

export const makeControlPlaneStudySpokenAnswerRecoveryStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): StudySpokenAnswerRecoveryStore => ({
  claimExpired: ({ leaseToken, leaseMs, limit }) =>
    Effect.gen(function* () {
      positiveInteger(leaseMs, "leaseMs");
      positiveInteger(limit, "limit");
      if (leaseToken.length === 0 || leaseToken.length > 256) {
        throw new Error("leaseToken is invalid");
      }
      const db = yield* ControlPlaneDb;
      const claimed = yield* db.execute<Row>({
        label: "study-spoken-answer-recovery.claim",
        text: `WITH candidates AS (
                   SELECT command.command_id, command.lease_token
                     FROM study_spoken_answer_commands command
                     JOIN learner_audio_artifacts artifact
                       ON artifact.learner_audio_artifact_id=command.learner_audio_artifact_id
                      AND artifact.account_id=command.account_id
                    WHERE command.state='reserved'
                      AND (command.lease_expires_at <= clock_timestamp()
                        OR command.lease_token=$2)
                      AND artifact.recording_state='pending'
                      AND artifact.object_ref IS NULL
                    ORDER BY command.lease_expires_at, command.command_id
                    LIMIT $1 FOR UPDATE OF command SKIP LOCKED
                 )
                 UPDATE study_spoken_answer_commands command
                    SET lease_token=$2,
                        reserved_at=clock_timestamp(),
                        lease_expires_at=clock_timestamp() + $3 * interval '1 millisecond'
                   FROM candidates, learner_audio_artifacts artifact
                  WHERE command.command_id=candidates.command_id
                    AND command.lease_token=candidates.lease_token
                    AND command.state='reserved'
                    AND (command.lease_expires_at <= clock_timestamp()
                      OR command.lease_token=$2)
                    AND artifact.learner_audio_artifact_id=command.learner_audio_artifact_id
                    AND artifact.account_id=command.account_id
                    AND artifact.recording_state='pending'
                    AND artifact.object_ref IS NULL
              RETURNING command.command_id, command.account_id,
                        command.learner_audio_artifact_id,
                        artifact.expected_object_ref`,
        values: [limit, leaseToken, leaseMs],
        readonly: false,
      });
      return claimed.rows.map((row) => ({
        commandId: text(row, "command_id"),
        accountId: text(row, "account_id"),
        artifactId: text(row, "learner_audio_artifact_id"),
        expectedObjectRef: text(row, "expected_object_ref"),
        leaseToken,
      }));
    }).pipe(Effect.provide(runtime)),
  finalizeFailed: ({ claim, failedAt }) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const command = yield* transaction.execute<Row>({
            label: "study-spoken-answer-recovery.finalize-command",
            text: `UPDATE study_spoken_answer_commands
                        SET state='retryable_failed', provider_failure_kind='timeout',
                            completed_at=$4::timestamptz
                      WHERE command_id=$1 AND account_id=$2 AND lease_token=$3
                        AND state='reserved' AND lease_expires_at > clock_timestamp()
                  RETURNING learner_audio_artifact_id`,
            values: [claim.commandId, claim.accountId, claim.leaseToken, failedAt],
            readonly: false,
          });
          if (command.rows.length === 0) return false;
          const artifact = yield* transaction.execute<Row>({
            label: "study-spoken-answer-recovery.finalize-artifact",
            text: `UPDATE learner_audio_artifacts
                        SET recording_state='failed', object_ref=NULL
                      WHERE learner_audio_artifact_id=$1 AND account_id=$2
                        AND expected_object_ref=$3
                        AND recording_state='pending' AND object_ref IS NULL
                  RETURNING learner_audio_artifact_id`,
            values: [claim.artifactId, claim.accountId, claim.expectedObjectRef],
            readonly: false,
          });
          if (artifact.rows.length !== 1) {
            return yield* new StudySpokenAnswerRecoveryInvariantFailed({
              commandId: claim.commandId,
            });
          }
          return true;
        }),
      );
    }).pipe(Effect.provide(runtime)),
});

export const recoverExpiredStudySpokenAnswers = Effect.fn("recoverExpiredStudySpokenAnswers")(
  function* (input: {
    readonly store: StudySpokenAnswerRecoveryStore;
    readonly bucket: StudySpokenAnswerRecoveryBucket;
    readonly leaseToken: string;
    readonly failedAt: string;
    readonly leaseMs?: number;
    readonly limit?: number;
  }): Effect.fn.Return<
    StudySpokenAnswerRecoverySummary,
    ControlPlaneError | StudySpokenAnswerRecoveryInvariantFailed
  > {
    const claims = yield* input.store.claimExpired({
      leaseToken: input.leaseToken,
      leaseMs: input.leaseMs ?? STUDY_SPOKEN_ANSWER_RECOVERY_LEASE_MS,
      limit: input.limit ?? STUDY_SPOKEN_ANSWER_RECOVERY_BATCH_LIMIT,
    });
    let recovered = 0;
    let storageFailures = 0;
    let fenced = 0;

    for (const claim of claims) {
      const objectAbsent = yield* Effect.tryPromise({
        try: async () => {
          await input.bucket.delete(claim.expectedObjectRef);
          return (await input.bucket.head(claim.expectedObjectRef)) === null;
        },
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!objectAbsent) {
        storageFailures += 1;
        continue;
      }
      if (yield* input.store.finalizeFailed({ claim, failedAt: input.failedAt })) {
        recovered += 1;
      } else {
        fenced += 1;
      }
    }

    return { claimed: claims.length, recovered, storageFailures, fenced };
  },
);
