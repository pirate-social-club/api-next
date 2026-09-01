import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type DanceAttemptAction,
  type DanceAttemptActionReplay,
  type DanceAttemptSessionAuthority,
  type DanceAttemptStore,
  DanceAttemptStoreError,
} from "@pirate/application/use-cases/dance/attempt-services";
import {
  CreateDanceSession,
  FinalizeDanceSessionUpload,
  GetDanceSession,
  RecordDanceSessionConsent,
  ReserveDanceSessionUpload,
  SubmitDanceSessionForGrading,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Failure = DanceAttemptStoreError | ControlPlaneError;
type Executor = Pick<ControlPlaneTransaction, "execute">;

const fail = (
  operation: DanceAttemptStoreError["operation"],
  reason: DanceAttemptStoreError["reason"],
) => new DanceAttemptStoreError({ operation, reason });

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw fail("get", "invalid-row");
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
  if (!Number.isSafeInteger(parsed)) throw fail("get", "invalid-row");
  return parsed;
};

const nullableInteger = (row: Row, key: string): number | null =>
  row[key] === null ? null : integer(row, key);

const instant = (row: Row, key: string): string => {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw fail("get", "invalid-row");
  return date.toISOString();
};

const nullableInstant = (row: Row, key: string): string | null =>
  row[key] === null ? null : instant(row, key);

const json = (row: Row, key: string): unknown => {
  const value = row[key];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw fail("get", "invalid-row");
    }
  }
  return value;
};

const bytesText = (value: unknown): string | null =>
  value instanceof Uint8Array ? new TextDecoder().decode(value) : null;

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

const identifier = async (prefix: string, value: unknown): Promise<string> =>
  `${prefix}-${await sha256(value)}`;

function decodeResponse<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  operation: DanceAttemptStoreError["operation"],
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw fail(operation, "invalid-row");
  }
}

const projectionSql = `SELECT s.*,c.consented_at,u.reservation_id,u.private_object_key,
       u.expected_content_type,u.expected_size_bytes,u.expected_duration_ms,u.state AS upload_row_state,
       u.server_sha256,u.sealed_size_bytes,u.sealed_duration_ms,u.sealed_at,
       a.attempt_id,a.state AS attempt_state,e.grade_outcome,e.qualification_outcome,
       e.score_bps,e.rejection_code,e.scored_window_start_ms,e.scored_window_end_ms,
       e.scored_duration_ms,e.evidence_summary,e.completed_at,
       COALESCE(cleanup.cleanup_count,0)::bigint AS cleanup_count,
       COALESCE(cleanup.completed_count,0)::bigint AS cleanup_completed_count
  FROM dance_sessions s
  LEFT JOIN dance_session_consents c ON c.session_id=s.session_id
  LEFT JOIN dance_upload_reservations u ON u.session_id=s.session_id
  LEFT JOIN dance_attempts a ON a.session_id=s.session_id
  LEFT JOIN dance_attempt_evidence e ON e.attempt_id=a.attempt_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS cleanup_count,
           count(*) FILTER (WHERE state='completed') AS completed_count
      FROM dance_media_cleanup_operations operation
     WHERE operation.session_id=s.session_id
  ) cleanup ON true`;

function sessionDocument(row: Row) {
  const attemptId = nullableText(row, "attempt_id");
  const gradeOutcome = nullableText(row, "grade_outcome");
  const uploadRowState = nullableText(row, "upload_row_state");
  const cleanupCount = integer(row, "cleanup_count");
  const cleanupCompletedCount = integer(row, "cleanup_completed_count");
  const uploadState =
    uploadRowState === null
      ? "none"
      : cleanupCount > 0 && cleanupCount === cleanupCompletedCount
        ? "deleted"
        : cleanupCount > 0
          ? "cleanup_pending"
          : uploadRowState;
  const result =
    gradeOutcome === null
      ? null
      : {
          object: "dance_attempt_result" as const,
          attempt_id: attemptId,
          grade_outcome: gradeOutcome,
          qualification_outcome: text(row, "qualification_outcome"),
          score_bps: nullableInteger(row, "score_bps"),
          rejection_code: nullableText(row, "rejection_code"),
          scored_window_start_ms: integer(row, "scored_window_start_ms"),
          scored_window_end_ms: integer(row, "scored_window_end_ms"),
          scored_duration_ms: integer(row, "scored_duration_ms"),
          evidence_summary: json(row, "evidence_summary"),
          completed_at: instant(row, "completed_at"),
        };
  return {
    object: "dance_session" as const,
    session_id: text(row, "session_id"),
    persona_id: text(row, "persona_id"),
    community_id: text(row, "community_id"),
    song_post_id: text(row, "song_post_id"),
    audio_revision: integer(row, "audio_revision"),
    segment_id: text(row, "segment_id"),
    choreography_id: text(row, "choreography_id"),
    choreography_revision: integer(row, "choreography_revision"),
    reward_mode: "practice" as const,
    objective_snapshot: [] as const,
    expected_scored_duration_ms: integer(row, "expected_scored_duration_ms"),
    cue: {
      kind: text(row, "cue_kind"),
      hold_ms: integer(row, "cue_hold_ms"),
      observation_start_ms: integer(row, "cue_observation_start_ms"),
      observation_end_ms: integer(row, "cue_observation_end_ms"),
    },
    policy: {
      qualification_policy_version_id: text(row, "qualification_policy_version_id"),
      calibration_version_id: text(row, "calibration_version_id"),
      calibration_checksum: text(row, "calibration_checksum"),
      captured_admission_state: "shadow" as const,
      platform_floor_bps: integer(row, "platform_floor_bps"),
      pose_model_version: text(row, "pose_model_version"),
      feature_schema_version: text(row, "feature_schema_version"),
      scorer_contract_version: text(row, "scorer_contract_version"),
      mirror_policy_version: text(row, "mirror_policy_version"),
      cue_policy_version: text(row, "cue_policy_version"),
      fingerprint_policy_version: text(row, "fingerprint_policy_version"),
      integrity_policy_version: text(row, "integrity_policy_version"),
      grader_adapter_version: text(row, "grader_adapter_version"),
    },
    session_terms_hash: text(row, "session_terms_hash"),
    state: text(row, "state"),
    consented_at: nullableInstant(row, "consented_at"),
    upload_state: uploadState,
    attempt_id: attemptId,
    result,
    created_at: instant(row, "created_at"),
    expires_at: instant(row, "expires_at"),
  };
}

function actionLock(tx: ControlPlaneTransaction, action: DanceAttemptAction) {
  return tx.execute({
    label: "dance-attempt.action.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [
      `dance-attempt-action:${action.actorAccountId}:${action.endpointTemplate}:${action.idempotencyKey}`,
    ],
    readonly: false,
  });
}

function lookupActionEffect(
  executor: Executor,
  action: DanceAttemptAction,
): Effect.Effect<DanceAttemptActionReplay, Failure> {
  return Effect.gen(function* () {
    const result = yield* executor.execute<Row>({
      label: "dance-attempt.action.lookup",
      text: "SELECT request_hash,response_snapshot FROM dance_attempt_actions WHERE actor_account_id=$1 AND http_method=$2 AND endpoint_template=$3 AND idempotency_key=$4",
      values: [
        action.actorAccountId,
        action.httpMethod,
        action.endpointTemplate,
        action.idempotencyKey,
      ],
      readonly: true,
    });
    if (result.rows.length === 0) return { kind: "miss" };
    if (result.rows.length !== 1) return yield* Effect.fail(fail("action", "invalid-row"));
    const row = result.rows[0] as Row;
    if (text(row, "request_hash") !== action.requestHash) return { kind: "conflict" };
    const snapshot = bytesText(row.response_snapshot);
    if (snapshot === null) return yield* Effect.fail(fail("action", "invalid-row"));
    return yield* Effect.try({
      try: () => ({ kind: "replay" as const, response: JSON.parse(snapshot) as unknown }),
      catch: () => fail("action", "invalid-row"),
    });
  });
}

function storeAction(
  tx: ControlPlaneTransaction,
  action: DanceAttemptAction,
  sessionId: string,
  response: unknown,
) {
  const snapshot = JSON.stringify(response);
  return tx.execute({
    label: "dance-attempt.action.insert",
    text: `INSERT INTO dance_attempt_actions (
             actor_account_id,http_method,endpoint_template,idempotency_key,request_hash,
             result_kind,response_snapshot,response_snapshot_sha256,session_id
           ) VALUES ($1,$2,$3,$4,$5,'accepted',convert_to($6,'UTF8'),
             encode(sha256(convert_to($6,'UTF8')),'hex'),$7)`,
    values: [
      action.actorAccountId,
      action.httpMethod,
      action.endpointTemplate,
      action.idempotencyKey,
      action.requestHash,
      snapshot,
      sessionId,
    ],
    readonly: false,
  });
}

function replayed<S extends { readonly replayed: boolean }>(response: S): S {
  return { ...response, replayed: true };
}

function authorityValid(authority: DanceAttemptSessionAuthority): boolean {
  return (
    authority.policy.capturedAdmissionState === "shadow" &&
    authority.expiresAt > authority.createdAt &&
    authority.cue.observationEndMs > authority.cue.observationStartMs &&
    authority.cue.holdMs <= authority.cue.observationEndMs - authority.cue.observationStartMs &&
    authority.expectedScoredDurationMs >= 6_000 &&
    authority.expectedScoredDurationMs <= 30_000
  );
}

function runWithRuntime<A>(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  effect: Effect.Effect<A, Failure, ControlPlaneDb>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(runtime)(effect)).catch((error: unknown) => {
    if (error instanceof DanceAttemptStoreError) throw error;
    throw fail("action", "unavailable");
  });
}

export function makeDanceAttemptStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): DanceAttemptStore {
  const run = <A>(effect: Effect.Effect<A, Failure, ControlPlaneDb>) =>
    runWithRuntime(runtime, effect);

  const lookupAction: DanceAttemptStore["lookupAction"] = (action) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* lookupActionEffect(db, action);
      }),
    );

  const create: DanceAttemptStore["create"] = (input) =>
    run(
      Effect.gen(function* () {
        if (!authorityValid(input.authority)) {
          return yield* Effect.fail(fail("create", "invalid-input"));
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* actionLock(tx, input.action);
            const prior = yield* lookupActionEffect(tx, input.action);
            if (prior.kind === "conflict") {
              return yield* Effect.fail(fail("create", "idempotency-conflict"));
            }
            if (prior.kind === "replay") {
              return replayed(
                decodeResponse(CreateDanceSession.response, prior.response, "create"),
              );
            }
            const reference = yield* tx.execute<Row>({
              label: "dance-attempt.create.reference",
              text: `SELECT r.audio_revision,r.segment_id
                       FROM dance_choreography_revisions r
                       JOIN dance_choreographies c ON c.choreography_id=r.choreography_id
                      WHERE r.community_id=$1 AND r.song_post_id=$2 AND r.choreography_id=$3
                        AND r.revision=$4 AND r.status='ready' AND c.status='ready'
                        AND c.disabled_at IS NULL AND c.retired_at IS NULL
                      FOR SHARE OF r,c`,
              values: [
                input.communityId,
                input.songPostId,
                input.choreographyId,
                input.choreographyRevision,
              ],
              readonly: false,
            });
            if (reference.rows.length !== 1) {
              return yield* Effect.fail(fail("create", "not-found"));
            }
            const referenceRow = reference.rows[0] as Row;
            if (
              integer(referenceRow, "audio_revision") !== input.authority.audioRevision ||
              text(referenceRow, "segment_id") !== input.authority.segmentId
            ) {
              return yield* Effect.fail(fail("create", "authority-conflict"));
            }
            const inserted = yield* tx.execute<Row>({
              label: "dance-attempt.create.insert",
              text: `INSERT INTO dance_sessions (
                       session_id,account_id,persona_id,community_id,song_post_id,audio_revision,
                       segment_id,choreography_id,choreography_revision,reward_mode,
                       expected_scored_duration_ms,cue_kind,cue_hold_ms,cue_observation_start_ms,
                       cue_observation_end_ms,qualification_policy_version_id,
                       calibration_version_id,calibration_checksum,captured_admission_state,
                       platform_floor_bps,pose_model_version,feature_schema_version,
                       scorer_contract_version,mirror_policy_version,cue_policy_version,
                       fingerprint_policy_version,fingerprint_key_version,
                       integrity_policy_version,grader_adapter_version,session_terms_hash,
                       created_at,expires_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'practice',$10,$11,$12,$13,$14,
                       $15,$16,$17,'shadow',$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
                     RETURNING session_id`,
              values: [
                input.authority.sessionId,
                input.action.actorAccountId,
                input.personaId,
                input.communityId,
                input.songPostId,
                input.authority.audioRevision,
                input.authority.segmentId,
                input.choreographyId,
                input.choreographyRevision,
                input.authority.expectedScoredDurationMs,
                input.authority.cue.kind,
                input.authority.cue.holdMs,
                input.authority.cue.observationStartMs,
                input.authority.cue.observationEndMs,
                input.authority.policy.qualificationPolicyVersionId,
                input.authority.policy.calibrationVersionId,
                input.authority.policy.calibrationChecksum,
                input.authority.policy.platformFloorBps,
                input.authority.policy.poseModelVersion,
                input.authority.policy.featureSchemaVersion,
                input.authority.policy.scorerContractVersion,
                input.authority.policy.mirrorPolicyVersion,
                input.authority.policy.cuePolicyVersion,
                input.authority.policy.fingerprintPolicyVersion,
                input.authority.policy.fingerprintKeyVersion,
                input.authority.policy.integrityPolicyVersion,
                input.authority.policy.graderAdapterVersion,
                input.authority.sessionTermsHash,
                input.authority.createdAt,
                input.authority.expiresAt,
              ],
              readonly: false,
            });
            if (inserted.rows.length !== 1) {
              return yield* Effect.fail(fail("create", "invalid-row"));
            }
            const view = yield* tx.execute<Row>({
              label: "dance-attempt.create.view",
              text: `${projectionSql} WHERE s.session_id=$1`,
              values: [input.authority.sessionId],
              readonly: true,
            });
            if (view.rows.length !== 1) {
              return yield* Effect.fail(fail("create", "invalid-row"));
            }
            const response = decodeResponse(
              CreateDanceSession.response,
              { session: sessionDocument(view.rows[0] as Row), replayed: false },
              "create",
            );
            yield* storeAction(tx, input.action, input.authority.sessionId, response);
            return response;
          }),
        );
      }),
    );

  const command = <S extends Schema.ConstraintDecoder<unknown>>(
    operation: "consent" | "finalize" | "submit",
    responseSchema: S,
    input: Parameters<
      DanceAttemptStore["consent"] | DanceAttemptStore["finalize"] | DanceAttemptStore["submit"]
    >[0],
    mutate: (tx: ControlPlaneTransaction) => Effect.Effect<void, Failure>,
  ): Promise<S["Type"]> =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* actionLock(tx, input.action);
            const prior = yield* lookupActionEffect(tx, input.action);
            if (prior.kind === "conflict") {
              return yield* Effect.fail(fail(operation, "idempotency-conflict"));
            }
            if (prior.kind === "replay") {
              const decoded = decodeResponse(
                responseSchema,
                prior.response,
                operation,
              ) as S["Type"] & {
                readonly replayed: boolean;
              };
              return replayed(decoded);
            }
            yield* mutate(tx);
            const view = yield* tx.execute<Row>({
              label: `dance-attempt.${operation}.view`,
              text: `${projectionSql} WHERE s.session_id=$1 AND s.account_id=$2 AND s.community_id=$3`,
              values: [input.sessionId, input.action.actorAccountId, input.communityId],
              readonly: true,
            });
            if (view.rows.length !== 1) {
              return yield* Effect.fail(fail(operation, "not-found"));
            }
            const response = decodeResponse(
              responseSchema,
              { session: sessionDocument(view.rows[0] as Row), replayed: false },
              operation,
            );
            yield* storeAction(tx, input.action, input.sessionId, response);
            return response;
          }),
        );
      }),
    );

  const consent: DanceAttemptStore["consent"] = (input) =>
    command("consent", RecordDanceSessionConsent.response, input, (tx) =>
      Effect.gen(function* () {
        const result = yield* tx.execute({
          label: "dance-attempt.consent.insert",
          text: `INSERT INTO dance_session_consents (
                   session_id,account_id,persona_id,session_terms_hash,
                   consent_policy_version_id,retention_disclosure_version,source
                 ) SELECT session_id,account_id,$4,$5,$6,$7,$8 FROM dance_sessions
                  WHERE session_id=$1 AND account_id=$2 AND community_id=$3
                    AND persona_id=$4 AND session_terms_hash=$5 AND state='created'`,
          values: [
            input.sessionId,
            input.action.actorAccountId,
            input.communityId,
            input.personaId,
            input.sessionTermsHash,
            input.consentPolicyVersionId,
            input.retentionDisclosureVersion,
            input.source,
          ],
          readonly: false,
        });
        if (result.rowCount !== 1) return yield* Effect.fail(fail("consent", "state-conflict"));
      }),
    );

  const reserve: DanceAttemptStore["reserve"] = (input) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* actionLock(tx, input.action);
            const prior = yield* lookupActionEffect(tx, input.action);
            if (prior.kind === "conflict") {
              return yield* Effect.fail(fail("reserve", "idempotency-conflict"));
            }
            if (prior.kind === "replay") {
              return replayed(
                decodeResponse(ReserveDanceSessionUpload.response, prior.response, "reserve"),
              );
            }
            const inserted = yield* tx.execute({
              label: "dance-attempt.reserve.insert",
              text: `INSERT INTO dance_upload_reservations (
                       reservation_id,session_id,private_object_key,expected_content_type,
                       expected_size_bytes,expected_duration_ms,expected_sha256,created_at,expires_at
                     ) SELECT $4,session_id,$5,$6,$7,$8,$9,$10,$11 FROM dance_sessions
                      WHERE session_id=$1 AND account_id=$2 AND community_id=$3 AND state='consented'`,
              values: [
                input.sessionId,
                input.action.actorAccountId,
                input.communityId,
                input.authority.reservationId,
                input.authority.privateObjectKey,
                input.authority.expectedContentType,
                input.authority.expectedSizeBytes,
                input.authority.expectedDurationMs,
                input.authority.expectedSha256,
                input.authority.createdAt,
                input.authority.expiresAt,
              ],
              readonly: false,
            });
            if (inserted.rowCount !== 1) {
              return yield* Effect.fail(fail("reserve", "state-conflict"));
            }
            const view = yield* tx.execute<Row>({
              label: "dance-attempt.reserve.view",
              text: `${projectionSql} WHERE s.session_id=$1`,
              values: [input.sessionId],
              readonly: true,
            });
            if (view.rows.length !== 1) {
              return yield* Effect.fail(fail("reserve", "invalid-row"));
            }
            const response = decodeResponse(
              ReserveDanceSessionUpload.response,
              {
                session: sessionDocument(view.rows[0] as Row),
                reservation: {
                  object: "dance_upload_reservation",
                  reservation_id: input.authority.reservationId,
                  session_id: input.sessionId,
                  upload_url: input.authority.uploadUrl,
                  expected_content_type: input.authority.expectedContentType,
                  expected_size_bytes: input.authority.expectedSizeBytes,
                  expected_duration_ms: input.authority.expectedDurationMs,
                  expires_at: input.authority.expiresAt,
                },
                replayed: false,
              },
              "reserve",
            );
            yield* storeAction(tx, input.action, input.sessionId, response);
            return response;
          }),
        );
      }),
    );

  const finalize: DanceAttemptStore["finalize"] = (input) =>
    command("finalize", FinalizeDanceSessionUpload.response, input, (tx) =>
      Effect.gen(function* () {
        const result = yield* tx.execute({
          label: "dance-attempt.finalize.update",
          text: `UPDATE dance_upload_reservations u SET state='sealed',server_sha256=$5,
                   sealed_size_bytes=$6,sealed_duration_ms=$7,sealed_at=$8
                   FROM dance_sessions s
                  WHERE u.session_id=s.session_id AND u.session_id=$1 AND s.account_id=$2
                    AND s.community_id=$3 AND u.reservation_id=$4
                    AND u.private_object_key=$9 AND u.expected_content_type=$10
                    AND u.state='reserved'`,
          values: [
            input.sessionId,
            input.action.actorAccountId,
            input.communityId,
            input.authority.reservationId,
            input.authority.serverSha256,
            input.authority.sizeBytes,
            input.authority.durationMs,
            input.authority.sealedAt,
            input.authority.privateObjectKey,
            input.authority.contentType,
          ],
          readonly: false,
        });
        if (result.rowCount !== 1) return yield* Effect.fail(fail("finalize", "state-conflict"));
      }),
    );

  const submit: DanceAttemptStore["submit"] = (input) =>
    command("submit", SubmitDanceSessionForGrading.response, input, (tx) =>
      Effect.gen(function* () {
        const target = yield* tx.execute<Row>({
          label: "dance-attempt.submit.target",
          text: `SELECT s.session_id,u.reservation_id,u.server_sha256,s.segment_id,
                        s.choreography_id,s.choreography_revision,s.session_terms_hash
                   FROM dance_sessions s
                   JOIN dance_upload_reservations u ON u.session_id=s.session_id
                  WHERE s.session_id=$1 AND s.account_id=$2 AND s.community_id=$3
                    AND s.state='uploaded' AND u.state='sealed' FOR UPDATE OF s,u`,
          values: [input.sessionId, input.action.actorAccountId, input.communityId],
          readonly: false,
        });
        if (target.rows.length !== 1) {
          return yield* Effect.fail(fail("submit", "state-conflict"));
        }
        const row = target.rows[0] as Row;
        const frozen = {
          version: "frozen-dance-attempt-input-v1",
          sessionId: input.sessionId,
          reservationId: text(row, "reservation_id"),
          sealedMediaSha256: text(row, "server_sha256"),
          segmentId: text(row, "segment_id"),
          choreographyId: text(row, "choreography_id"),
          choreographyRevision: integer(row, "choreography_revision"),
          sessionTermsHash: text(row, "session_terms_hash"),
        } as const;
        const attemptId = yield* Effect.tryPromise({
          try: () => identifier("dance-attempt", frozen),
          catch: () => fail("submit", "unavailable"),
        });
        const inputDigest = yield* Effect.tryPromise({
          try: () => sha256(frozen),
          catch: () => fail("submit", "unavailable"),
        });
        const inserted = yield* tx.execute({
          label: "dance-attempt.submit.attempt",
          text: `INSERT INTO dance_attempts (
                   attempt_id,session_id,reservation_id,sealed_media_sha256,input_digest
                 ) VALUES ($1,$2,$3,$4,$5)`,
          values: [
            attemptId,
            input.sessionId,
            frozen.reservationId,
            frozen.sealedMediaSha256,
            inputDigest,
          ],
          readonly: false,
        });
        if (inserted.rowCount !== 1) {
          return yield* Effect.fail(fail("submit", "state-conflict"));
        }
        const outboxEventId = yield* Effect.tryPromise({
          try: () => identifier("dance-attempt-outbox", attemptId),
          catch: () => fail("submit", "unavailable"),
        });
        const effectIdentity = `dance-attempt:${attemptId}`;
        const payload = JSON.stringify({
          version: "dance-attempt-shadow-outbox-v1",
          effect_identity: effectIdentity,
          attempt_id: attemptId,
          input_digest: inputDigest,
        });
        yield* tx.execute({
          label: "dance-attempt.submit.outbox",
          text: `INSERT INTO dance_attempt_outbox (
                   outbox_event_id,attempt_id,effect_identity,payload,payload_sha256
                 ) VALUES ($1,$2,$3,$4::jsonb,
                   encode(sha256(convert_to(($4::jsonb)::text,'UTF8')),'hex'))`,
          values: [outboxEventId, attemptId, effectIdentity, payload],
          readonly: false,
        });
      }),
    );

  const get: DanceAttemptStore["get"] = (input) =>
    run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const view = yield* db.execute<Row>({
          label: "dance-attempt.get",
          text: `${projectionSql} WHERE s.session_id=$1 AND s.account_id=$2 AND s.community_id=$3`,
          values: [input.sessionId, input.actorAccountId, input.communityId],
          readonly: true,
        });
        if (view.rows.length !== 1) return yield* Effect.fail(fail("get", "not-found"));
        return decodeResponse(
          GetDanceSession.response,
          sessionDocument(view.rows[0] as Row),
          "get",
        );
      }),
    );

  return { lookupAction, create, consent, reserve, finalize, submit, get };
}
