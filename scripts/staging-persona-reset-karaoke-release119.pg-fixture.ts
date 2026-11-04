// TEST ONLY: exact frozen release119 Karaoke finalization/recording behavior.
// Never composed by a Worker or used to validate current captured producers.
import {
  ActivityQualificationStorageFailed,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type KaraokeAttemptStore,
  KaraokeStoreFailed,
} from "@pirate/application";
import { type KaraokeAttempt, KaraokeAttempt as KaraokeAttemptSchema } from "@pirate/contracts";
import { recomputeActivityStreak } from "@pirate/domain";
import { Effect, Schema } from "effect";

export const HISTORICAL_RESET_KARAOKE_SOURCE = "ba0fd44529d834f491879126cdb8c67c4ec9fcdc";

type Row = Readonly<Record<string, unknown>>;

const failed = (reason: KaraokeStoreFailed["reason"]) => new KaraokeStoreFailed({ reason });
const mapControlPlaneError = (error: ControlPlaneError): KaraokeStoreFailed =>
  error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null
    ? failed("constraint")
    : failed("unavailable");

const mapErrors = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapControlPlaneError(error as ControlPlaneError)
          : (error as E)
        : (error as E),
    ),
  );

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};
const integer = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${key}`);
  return value;
};
const nullableInteger = (row: Row, key: string): number | null =>
  row[key] === null ? null : integer(row, key);
const iso = (value: unknown): string => {
  const instant = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid instant");
  return instant.toISOString();
};
const date = (value: unknown): string => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new Error("invalid date");
};
const json = (value: unknown): unknown =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : value;
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const bps = (value: number): number => Math.max(0, Math.min(10_000, Math.round(value * 10_000)));

const attemptFromRow = (row: Row): KaraokeAttempt =>
  decode(KaraokeAttemptSchema, {
    id: text(row, "attempt_id"),
    object: "karaoke_attempt",
    session_id: text(row, "session_id"),
    attempt_id: text(row, "attempt_id"),
    persona_id: text(row, "persona_id"),
    post_id: text(row, "post_id"),
    community_id: text(row, "community_id"),
    karaoke_revision_id: text(row, "karaoke_revision_id"),
    scoring_version: integer(row, "scoring_version"),
    scoring_provider: text(row, "scoring_provider"),
    scoring_model: text(row, "scoring_model"),
    final_score: integer(row, "final_score_bps"),
    lyrics_score: integer(row, "lyrics_score_bps"),
    timing_score: nullableInteger(row, "timing_score_bps"),
    timing_trend: text(row, "timing_trend"),
    scored_line_count: integer(row, "scored_line_count"),
    line_count: integer(row, "line_count"),
    uncertain_line_count: integer(row, "uncertain_line_count"),
    no_recognition_line_count: integer(row, "no_recognition_line_count"),
    low_confidence_line_count: integer(row, "low_confidence_line_count"),
    completion_reason: text(row, "completion_reason"),
    rank_eligible: row.rank_eligible === true,
    activity_date: date(row.activity_date),
    completed_at: iso(row.completed_at),
    created_at: iso(row.created_at),
    recording_state: text(row, "recording_state"),
    scoring_diagnostics: json(row.scoring_diagnostics),
  });

const ATTEMPT_SELECT = `
  SELECT attempt.attempt_id, attempt.session_id, session.persona_id,
         session.post_id, session.community_id, session.karaoke_revision_id,
         attempt.scoring_version, attempt.scoring_provider, attempt.scoring_model,
         attempt.final_score_bps, attempt.lyrics_score_bps, attempt.timing_score_bps,
         attempt.timing_trend, attempt.scored_line_count, attempt.line_count,
         attempt.uncertain_line_count, attempt.no_recognition_line_count,
         attempt.low_confidence_line_count, attempt.completion_reason,
         EXISTS (
           SELECT 1 FROM activity_qualifications AS qualification
            WHERE qualification.karaoke_attempt_id=attempt.attempt_id
              AND qualification.activity_key='karaoke'
         ) AS rank_eligible,
         (attempt.completed_at AT TIME ZONE session.timezone)::date AS activity_date,
         attempt.completed_at, attempt.created_at, attempt.scoring_diagnostics,
         recording.state AS recording_state
    FROM karaoke_attempts AS attempt
    JOIN karaoke_sessions AS session
      ON session.session_id=attempt.session_id AND session.attempt_id=attempt.attempt_id
    JOIN karaoke_recordings AS recording
      ON recording.session_id=session.session_id AND recording.attempt_id=attempt.attempt_id`;

const storage = (
  reason: ConstructorParameters<typeof ActivityQualificationStorageFailed>[0]["reason"],
): ActivityQualificationStorageFailed => new ActivityQualificationStorageFailed({ reason });

const advisoryLock = (
  transaction: ControlPlaneTransaction,
  namespace: number,
  parts: readonly string[],
  label: string,
) =>
  transaction.execute({
    label,
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
    values: [JSON.stringify(parts), namespace],
    readonly: false,
  });

const recomputeProjection = (
  transaction: ControlPlaneTransaction,
  input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly postId: string | null;
    readonly recomputedAt: string;
    readonly timezone: string;
  },
) =>
  Effect.gen(function* () {
    const song = input.postId !== null;
    const daysResult = yield* transaction.execute<Row>({
      label: song
        ? "activity-qualification.song-streak-days.read"
        : "activity-qualification.community-streak-days.read",
      text: song
        ? `SELECT streak_day FROM song_streak_days
            WHERE account_id=$1 AND community_id=$2 AND post_id=$3 ORDER BY streak_day`
        : `SELECT streak_day FROM community_streak_days
            WHERE account_id=$1 AND community_id=$2 ORDER BY streak_day`,
      values: song
        ? [input.accountId, input.communityId, input.postId]
        : [input.accountId, input.communityId],
      readonly: false,
    });
    const projection = yield* Effect.try({
      try: () =>
        recomputeActivityStreak(
          daysResult.rows.map((row) => date(row.streak_day)),
          input.timezone,
        ),
      catch: () => storage("invalid-row"),
    });
    if (projection === null) return;
    yield* transaction.execute({
      label: song
        ? "activity-qualification.song-streak.upsert"
        : "activity-qualification.community-streak.upsert",
      text: song
        ? `INSERT INTO song_streaks (
             account_id, community_id, post_id, current_count, best_count,
             started_day, last_day, total_days, active_until_at, recomputed_at
           ) VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9::timestamptz,$10::timestamptz)
           ON CONFLICT (account_id, post_id) DO UPDATE SET
             community_id=EXCLUDED.community_id,
             current_count=EXCLUDED.current_count,
             best_count=EXCLUDED.best_count,
             started_day=EXCLUDED.started_day,
             last_day=EXCLUDED.last_day,
             total_days=EXCLUDED.total_days,
             active_until_at=EXCLUDED.active_until_at,
             recomputed_at=EXCLUDED.recomputed_at`
        : `INSERT INTO community_streaks (
             account_id, community_id, current_count, best_count,
             started_day, last_day, total_days, active_until_at, recomputed_at
           ) VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8::timestamptz,$9::timestamptz)
           ON CONFLICT (account_id, community_id) DO UPDATE SET
             current_count=EXCLUDED.current_count,
             best_count=EXCLUDED.best_count,
             started_day=EXCLUDED.started_day,
             last_day=EXCLUDED.last_day,
             total_days=EXCLUDED.total_days,
             active_until_at=EXCLUDED.active_until_at,
             recomputed_at=EXCLUDED.recomputed_at`,
      values: song
        ? [
            input.accountId,
            input.communityId,
            input.postId,
            projection.current,
            projection.best,
            projection.startedDay,
            projection.lastDay,
            projection.totalDays,
            projection.activeUntilAt,
            input.recomputedAt,
          ]
        : [
            input.accountId,
            input.communityId,
            projection.current,
            projection.best,
            projection.startedDay,
            projection.lastDay,
            projection.totalDays,
            projection.activeUntilAt,
            input.recomputedAt,
          ],
      readonly: false,
    });
  });

const recordQualificationProjections = (
  transaction: ControlPlaneTransaction,
  input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly personaId: string;
    readonly postId: string;
    readonly activity: "study" | "karaoke";
    readonly qualificationId: string;
    readonly qualifiedAt: string;
    readonly streakDay: string;
    readonly timezone: string;
  },
) =>
  Effect.gen(function* () {
    yield* transaction.execute({
      label: "activity-qualification.song-day.insert",
      text: `INSERT INTO song_streak_days (
               account_id, community_id, post_id, streak_day,
               first_qualification_id, earned_at
             ) VALUES ($1,$2,$3,$4::date,$5,$6::timestamptz)
             ON CONFLICT (account_id, post_id, streak_day) DO NOTHING`,
      values: [
        input.accountId,
        input.communityId,
        input.postId,
        input.streakDay,
        input.qualificationId,
        input.qualifiedAt,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "activity-qualification.song-day-activity.upsert",
      text: `INSERT INTO song_streak_day_activities (
               account_id, community_id, post_id, streak_day, activity_key,
               qualification_count, first_qualified_at, last_qualified_at,
               last_qualification_id
             ) VALUES ($1,$2,$3,$4::date,$5,1,$6::timestamptz,$6::timestamptz,$7)
             ON CONFLICT (account_id, post_id, streak_day, activity_key) DO UPDATE SET
               qualification_count=song_streak_day_activities.qualification_count + 1,
               last_qualified_at=greatest(
                 song_streak_day_activities.last_qualified_at,
                 EXCLUDED.last_qualified_at
               ),
               last_qualification_id=EXCLUDED.last_qualification_id`,
      values: [
        input.accountId,
        input.communityId,
        input.postId,
        input.streakDay,
        input.activity,
        input.qualifiedAt,
        input.qualificationId,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "activity-qualification.community-day.insert",
      text: `INSERT INTO community_streak_days (
               account_id, community_id, streak_day, first_qualification_id, earned_at
             ) VALUES ($1,$2,$3::date,$4,$5::timestamptz)
             ON CONFLICT (account_id, community_id, streak_day) DO NOTHING`,
      values: [
        input.accountId,
        input.communityId,
        input.streakDay,
        input.qualificationId,
        input.qualifiedAt,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "activity-qualification.presentation.default",
      text: `INSERT INTO persona_activity_presentations (
               community_id, account_id, persona_id, created_at, updated_at
             ) VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz)
             ON CONFLICT (community_id, account_id) DO NOTHING`,
      values: [input.communityId, input.accountId, input.personaId, input.qualifiedAt],
      readonly: false,
    });
    yield* recomputeProjection(transaction, {
      accountId: input.accountId,
      communityId: input.communityId,
      postId: input.postId,
      recomputedAt: input.qualifiedAt,
      timezone: input.timezone,
    });
    yield* recomputeProjection(transaction, {
      accountId: input.accountId,
      communityId: input.communityId,
      postId: null,
      recomputedAt: input.qualifiedAt,
      timezone: input.timezone,
    });
  });

export const makeHistoricalResetKaraokeRepository119 = (): Pick<
  KaraokeAttemptStore,
  "finalizeAttempt" | "reconcileRecording"
> => ({
  finalizeAttempt: (input: Parameters<KaraokeAttemptStore["finalizeAttempt"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const replay = yield* transaction.execute<Row>({
              label: "karaoke.attempt.replay",
              text: `${ATTEMPT_SELECT} WHERE attempt.attempt_id=$1 FOR UPDATE OF attempt`,
              values: [input.authority.attemptId],
              readonly: false,
            });
            if (replay.rows.length === 1) return attemptFromRow(replay.rows[0] as Row);
            const summary = input.summary;
            const finalScore = input.completionReason === "completed" ? bps(summary.finalScore) : 0;
            const scoredLineCount =
              input.completionReason === "completed" ? summary.scoredLineCount : 0;
            const evidence = {
              kind: "karaoke_qualification_v2",
              scored_line_count: scoredLineCount,
              line_count: summary.lineCount,
              coverage_bps: Math.floor((10_000 * scoredLineCount) / summary.lineCount),
              final_score_bps: finalScore,
              scoring_version: input.authority.scoringVersion,
              scoring_provider: input.authority.scoringProvider,
              karaoke_revision_id: input.authority.karaokeRevisionId,
              playback_kind: input.authority.playbackKind,
            };
            yield* transaction.execute({
              label: "karaoke.attempt.insert",
              text: `INSERT INTO karaoke_attempts (
                       attempt_id, session_id, completion_reason, scoring_version,
                       scoring_provider, scoring_model, final_score_bps, scored_line_count,
                       line_count, evidence_summary, completed_at, created_at,
                       lyrics_score_bps, timing_score_bps, timing_trend,
                       uncertain_line_count, no_recognition_line_count,
                       low_confidence_line_count, scoring_diagnostics, transport_facts
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz,
                       $12::timestamptz,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb)`,
              values: [
                input.authority.attemptId,
                input.authority.sessionId,
                input.completionReason,
                input.authority.scoringVersion,
                input.authority.scoringProvider,
                input.authority.scoringModel,
                finalScore,
                scoredLineCount,
                summary.lineCount,
                JSON.stringify(evidence),
                input.completedAt,
                input.authority.createdAt,
                input.completionReason === "completed" ? bps(summary.lyricsScore) : 0,
                input.completionReason === "completed" && summary.timingScore !== null
                  ? bps(summary.timingScore)
                  : null,
                summary.timingTrend,
                summary.uncertainLineCount,
                summary.noRecognitionLineCount,
                summary.lowConfidenceLineCount,
                JSON.stringify(input.diagnostics),
                JSON.stringify(input.transportFacts),
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "karaoke.session.complete",
              text: `UPDATE karaoke_sessions SET status='completed', completed_at=$2::timestamptz
                      WHERE session_id=$1 AND status='active'`,
              values: [input.authority.sessionId, input.completedAt],
              readonly: false,
            });
            const coverage = Math.floor((10_000 * scoredLineCount) / summary.lineCount);
            if (
              input.completionReason === "completed" &&
              scoredLineCount >= 5 &&
              coverage >= 8500 &&
              finalScore >= 7000
            ) {
              const day = yield* transaction.execute<Row>({
                label: "karaoke.qualification.streak-day",
                text: "SELECT ($1::timestamptz AT TIME ZONE $2)::date AS streak_day",
                values: [input.completedAt, input.authority.timezone],
                readonly: true,
              });
              const streakDay = date((day.rows[0] as Row).streak_day);
              yield* transaction.execute({
                label: "karaoke.qualification.insert",
                text: `INSERT INTO activity_qualifications (
                         qualification_id, account_id, persona_id, community_id, post_id,
                         audio_revision, activity_key, karaoke_session_id, karaoke_attempt_id,
                         score_bps, qualification_policy_version_id, qualified_at, streak_day,
                         evidence_summary, created_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,'karaoke',$7,$8,$9,$10,
                         $11::timestamptz,($11::timestamptz AT TIME ZONE $12)::date,
                         $13::jsonb,$11::timestamptz) ON CONFLICT DO NOTHING`,
                values: [
                  input.qualificationId,
                  input.authority.accountId,
                  input.authority.personaId,
                  input.authority.communityId,
                  input.authority.postId,
                  input.authority.audioRevision,
                  input.authority.sessionId,
                  input.authority.attemptId,
                  finalScore,
                  input.authority.qualificationPolicyVersionId,
                  input.completedAt,
                  input.authority.timezone,
                  JSON.stringify(evidence),
                ],
                readonly: false,
              });
              yield* recordQualificationProjections(transaction, {
                accountId: input.authority.accountId,
                communityId: input.authority.communityId,
                personaId: input.authority.personaId,
                postId: input.authority.postId,
                activity: "karaoke",
                qualificationId: input.qualificationId,
                qualifiedAt: input.completedAt,
                streakDay,
                timezone: input.authority.timezone,
              }).pipe(Effect.mapError(() => failed("constraint")));
            }
            const stored = yield* transaction.execute<Row>({
              label: "karaoke.attempt.finalized",
              text: `${ATTEMPT_SELECT} WHERE attempt.attempt_id=$1`,
              values: [input.authority.attemptId],
              readonly: true,
            });
            return attemptFromRow(stored.rows[0] as Row);
          }),
        );
      }),
    ),
  reconcileRecording: (input: Parameters<KaraokeAttemptStore["reconcileRecording"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            if (input.result.state === "stored") {
              yield* transaction.execute({
                label: "karaoke.recording.artifact.insert",
                text: `INSERT INTO learner_audio_artifacts (
                         learner_audio_artifact_id, account_id, source_kind, attempt_ref,
                         expected_object_ref, object_ref, content_digest, content_type,
                         byte_size, duration_ms, platform_retention, provider_retention,
                         recording_state, expires_at, created_at
                       ) VALUES ($1,$2,'karaoke',$3,$4,$5,$6,'audio/L16;rate=16000;channels=1',
                         $7,$8,'private_learning',$9,'stored',
                         $10::timestamptz + interval '24 months',$10::timestamptz)
                       ON CONFLICT (learner_audio_artifact_id) DO NOTHING`,
                values: [
                  input.artifactId,
                  input.accountId,
                  input.attemptId,
                  input.result.objectRef,
                  input.result.objectRef,
                  input.result.contentSha256,
                  input.result.byteSize,
                  input.result.durationMs,
                  input.providerRetention,
                  input.reconciledAt,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "karaoke.recording.stored",
                text: `UPDATE karaoke_recordings SET state='stored', object_ref=$4,
                         content_sha256=$5, byte_size=$6, duration_ms=$7,
                         reconciled_at=$8::timestamptz
                       WHERE session_id=$1 AND attempt_id=$2 AND artifact_id=$3
                         AND state='pending'`,
                values: [
                  input.sessionId,
                  input.attemptId,
                  input.artifactId,
                  input.result.objectRef,
                  input.result.contentSha256,
                  input.result.byteSize,
                  input.result.durationMs,
                  input.reconciledAt,
                ],
                readonly: false,
              });
            } else {
              yield* transaction.execute({
                label: "karaoke.recording.failed",
                text: `UPDATE karaoke_recordings SET state='failed', failure_kind=$4,
                         reconciled_at=$5::timestamptz
                       WHERE session_id=$1 AND attempt_id=$2 AND artifact_id=$3
                         AND state='pending'`,
                values: [
                  input.sessionId,
                  input.attemptId,
                  input.artifactId,
                  input.result.failureKind,
                  input.reconciledAt,
                ],
                readonly: false,
              });
            }
          }),
        );
      }),
    ),
});
