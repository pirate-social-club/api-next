import {
  type ActivityCompletionStore,
  ActivityQualificationRejected,
  ActivityQualificationStorageFailed,
  ControlPlaneDb,
  type ControlPlaneError,
} from "@pirate/application";
import {
  ActivityCompletionV1,
  ActivityPresentationStateV1,
  ActivityProgressV1,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;
const storage = () => new ActivityQualificationStorageFailed({ reason: "invalid-row" });
const missing = () => new ActivityQualificationRejected({ reason: "not-found" });
const mapDbError = (error: ControlPlaneError) =>
  new ActivityQualificationStorageFailed({
    reason:
      error._tag === "ControlPlaneTransactionOutcomeUnknown" ? "outcome-unknown" : "unavailable",
  });
const text = (row: Row, key: string): string =>
  Schema.decodeUnknownSync(Schema.NonEmptyString)(row[key]);
const count = (row: Row, key: string): number => {
  const value = row[key];
  return Schema.decodeUnknownSync(Schema.Int)(typeof value === "string" ? Number(value) : value);
};
const iso = (value: unknown): string =>
  new Date(value instanceof Date ? value : String(value)).toISOString();
const day = (value: unknown): string =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : Schema.decodeUnknownSync(Schema.String)(value);
const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

export const makeControlPlaneActivityCompletionRepository = () => ({
  getCompletion: Effect.fn("ActivityCompletionRepository.getCompletion")(function* (
    input: Parameters<ActivityCompletionStore["getCompletion"]>[0],
  ) {
    const db = yield* ControlPlaneDb;
    const study = input.activity === "study";
    const result = yield* db
      .execute<Row>({
        label: "activity-completion.read",
        text: `WITH source AS (
        ${
          study
            ? `SELECT session_id,NULL::text AS attempt_id,account_id,persona_id,
          community_id,post_id,audio_revision,timezone,status,completed_at,
          qualification_policy_revision AS policy,NULL::text AS completion_reason
          FROM study_sessions_v2 WHERE session_id=$3`
            : `SELECT s.session_id,s.attempt_id,
          s.account_id,s.persona_id,s.community_id,s.post_id,s.audio_revision,s.timezone,
          s.status,a.completed_at,s.qualification_policy_version_id AS policy,a.completion_reason
          FROM karaoke_sessions s LEFT JOIN karaoke_attempts a
            ON a.session_id=s.session_id AND a.attempt_id=s.attempt_id
          WHERE s.session_id=$3 AND s.attempt_id=$4`
        }
      ) SELECT s.*,q.qualification_id,q.qualification_policy_version_id,q.qualified_at,q.streak_day,
        d.outcome AS decision_outcome,d.decided_at,
        song.first_qualification_id AS song_first,community.first_qualification_id AS community_first
      FROM source s LEFT JOIN activity_qualifications q
        ON q.activity_key='${study ? "study" : "karaoke"}' AND q.account_id=s.account_id
        AND q.persona_id=s.persona_id AND q.community_id=s.community_id
        AND q.post_id=s.post_id AND q.audio_revision=s.audio_revision
        AND q.qualification_policy_version_id=s.policy AND q.qualified_at=s.completed_at
        AND ${study ? "q.study_session_id=s.session_id" : "q.karaoke_session_id=s.session_id AND q.karaoke_attempt_id=s.attempt_id"}
      LEFT JOIN activity_completion_decisions d ON d.activity_key='${study ? "study" : "karaoke"}'
        AND d.session_id=s.session_id AND d.attempt_id IS NOT DISTINCT FROM s.attempt_id
        AND d.account_id=s.account_id AND d.persona_id=s.persona_id
        AND d.community_id=s.community_id AND d.post_id=s.post_id AND d.audio_revision=s.audio_revision
        AND d.decided_at=s.completed_at AND d.qualification_id IS NOT DISTINCT FROM q.qualification_id
      LEFT JOIN song_streak_days song ON song.account_id=s.account_id AND song.community_id=s.community_id
        AND song.post_id=s.post_id AND song.streak_day=q.streak_day
      LEFT JOIN community_streak_days community ON community.account_id=s.account_id
        AND community.community_id=s.community_id AND community.streak_day=q.streak_day
      WHERE s.account_id=$1 AND s.community_id=$2
        AND active_activity_persona(s.account_id,s.persona_id,s.community_id)
        AND can_account_access_activity_song(s.account_id,s.community_id,s.post_id)`,
        values: study
          ? [input.accountId, input.communityId, input.sessionId]
          : [input.accountId, input.communityId, input.sessionId, input.attemptId],
        readonly: true,
      })
      .pipe(Effect.mapError(mapDbError));
    if (result.rows.length === 0) return yield* missing();
    if (result.rows.length !== 1) return yield* storage();
    return yield* Effect.try({
      try: () => {
        const row = result.rows[0] as Row;
        const qualification = row.qualification_id;
        const decision =
          qualification !== null
            ? {
                status: "qualified",
                qualification_id: qualification,
                qualification_policy_version_id: text(row, "qualification_policy_version_id"),
                qualified_at: iso(row.qualified_at),
                streak_day: day(row.streak_day),
                earned_day:
                  row.song_first === null || row.community_first === null
                    ? { status: "unavailable" }
                    : {
                        status: "recorded",
                        signal_id: qualification,
                        song_day_newly_earned: row.song_first === qualification,
                        community_day_newly_earned: row.community_first === qualification,
                      },
              }
            : row.status === "cancelled" ||
                (row.completion_reason !== null && row.completion_reason !== "completed")
              ? { status: "refused", reason: "activity_incomplete" }
              : row.status === "active"
                ? { status: "pending" }
                : row.decision_outcome === "not_qualified"
                  ? {
                      status: "not_qualified",
                      reason: "producer_not_qualified",
                      decided_at: iso(row.decided_at),
                    }
                  : { status: "unknown", reason: "historical_decision_unavailable" };
        return decode(ActivityCompletionV1, {
          object: "activity_completion",
          community_id: text(row, "community_id"),
          post_id: text(row, "post_id"),
          persona_id: text(row, "persona_id"),
          audio_revision: count(row, "audio_revision"),
          timezone: text(row, "timezone"),
          attempt: study
            ? { kind: "study", session_id: text(row, "session_id") }
            : {
                kind: "karaoke",
                session_id: text(row, "session_id"),
                attempt_id: text(row, "attempt_id"),
              },
          day_semantics: "account_pinned_iana_timezone_v1",
          observed_at: input.readAt,
          decision,
        });
      },
      catch: storage,
    });
  }),

  getProgress: Effect.fn("ActivityCompletionRepository.getProgress")(function* (
    input: Parameters<ActivityCompletionStore["getProgress"]>[0],
  ) {
    const db = yield* ControlPlaneDb;
    const song = input.postId !== null;
    // A single statement fixes observation, bounds, counts and ranking to one snapshot.
    // Day keys are read verbatim; timezone changes never rewrite historical ledgers.
    const result = yield* db
      .execute<Row>({
        label: "activity-progress.read",
        text: `WITH authority AS (
        SELECT coalesce(clock.timezone,'UTC') AS timezone,clock.account_id IS NOT NULL AS timezone_pinned,
          ($4::timestamptz AT TIME ZONE coalesce(clock.timezone,'UTC'))::date AS today
        FROM users u JOIN communities c ON c.community_id=$2 AND c.status='active'
        LEFT JOIN account_streak_clocks clock ON clock.account_id=u.user_id
        WHERE u.user_id=$1 AND u.status='active'
          ${song ? "AND can_account_access_activity_song($1,$2,$3)" : "AND $3::text IS NULL"}
      ), bounds AS (SELECT *,today-(extract(isodow FROM today)::int-1) AS start_day FROM authority),
      ranked AS (
        SELECT s.account_id,p.persona_id,rank() OVER(ORDER BY s.current_count DESC,s.best_count DESC) AS rank
        FROM ${song ? "song_streaks" : "community_streaks"} s
        JOIN persona_activity_presentations p ON p.account_id=s.account_id AND p.community_id=s.community_id
        JOIN persona_profiles profile ON profile.persona_id=p.persona_id
        WHERE s.community_id=$2 ${song ? "AND s.post_id=$3" : ""} AND s.active_until_at>$4::timestamptz
          AND active_activity_persona(s.account_id,p.persona_id,s.community_id)
      ) SELECT b.*,b.start_day+6 AS end_day,s.current_count,s.best_count,s.total_days,s.started_day,s.last_day,
        s.active_until_at>$4::timestamptz AS alive,r.rank,r.persona_id AS standing_persona_id,
        (SELECT jsonb_agg(jsonb_build_object('day',to_char(b.start_day+n,'YYYY-MM-DD'),'earned',EXISTS(
          SELECT 1 FROM ${song ? "song_streak_days" : "community_streak_days"} d
          WHERE d.account_id=$1 AND d.community_id=$2 ${song ? "AND d.post_id=$3" : ""}
            AND d.streak_day=b.start_day+n)) ORDER BY n) FROM generate_series(0,6) n) AS days,
        (SELECT count(*) FROM activity_qualifications q WHERE q.account_id=$1 AND q.community_id=$2
          ${song ? "AND q.post_id=$3" : ""} AND q.activity_key='study') AS study_count,
        (SELECT count(*) FROM activity_qualifications q WHERE q.account_id=$1 AND q.community_id=$2
          ${song ? "AND q.post_id=$3" : ""} AND q.activity_key='karaoke') AS karaoke_count
      FROM bounds b LEFT JOIN ${song ? "song_streaks" : "community_streaks"} s
        ON s.account_id=$1 AND s.community_id=$2 ${song ? "AND s.post_id=$3" : ""}
      LEFT JOIN ranked r ON r.account_id=$1`,
        values: [input.accountId, input.communityId, input.postId, input.readAt],
        readonly: true,
      })
      .pipe(Effect.mapError(mapDbError));
    if (result.rows.length === 0) return yield* missing();
    if (result.rows.length !== 1) return yield* storage();
    return yield* Effect.try({
      try: () => {
        const row = result.rows[0] as Row;
        return decode(ActivityProgressV1, {
          object: "activity_progress",
          scope: song
            ? { kind: "song", community_id: input.communityId, post_id: input.postId }
            : { kind: "community", community_id: input.communityId },
          observed_at: input.readAt,
          day_semantics: "account_pinned_iana_timezone_v1",
          timezone: text(row, "timezone"),
          timezone_pinned: row.timezone_pinned,
          today: day(row.today),
          week: { start_day: day(row.start_day), end_day: day(row.end_day), days: json(row.days) },
          counting_period: "all_recorded_qualifications",
          activity_counts: [
            { activity: "study", qualification_count: count(row, "study_count") },
            { activity: "karaoke", qualification_count: count(row, "karaoke_count") },
          ],
          streak: {
            current: row.alive === true ? count(row, "current_count") : 0,
            best: row.best_count === null ? 0 : count(row, "best_count"),
            total_days: row.total_days === null ? 0 : count(row, "total_days"),
            started_day: row.started_day === null ? null : day(row.started_day),
            last_day: row.last_day === null ? null : day(row.last_day),
          },
          standing:
            row.rank === null
              ? null
              : { rank: count(row, "rank"), persona_id: text(row, "standing_persona_id") },
        });
      },
      catch: storage,
    });
  }),

  getPresentation: Effect.fn("ActivityCompletionRepository.getPresentation")(function* (
    input: Parameters<ActivityCompletionStore["getPresentation"]>[0],
  ) {
    const db = yield* ControlPlaneDb;
    const result = yield* db
      .execute<Row>({
        label: "activity-presentation.read",
        text: `SELECT p.persona_id,p.updated_at,
        active_activity_persona(u.user_id,p.persona_id,c.community_id) AS eligible
        FROM users u JOIN communities c ON c.community_id=$2 AND c.status='active'
        LEFT JOIN persona_activity_presentations p ON p.account_id=u.user_id AND p.community_id=c.community_id
        WHERE u.user_id=$1 AND u.status='active'`,
        values: [input.accountId, input.communityId],
        readonly: true,
      })
      .pipe(Effect.mapError(mapDbError));
    if (result.rows.length === 0) return yield* missing();
    if (result.rows.length !== 1) return yield* storage();
    return yield* Effect.try({
      try: () => {
        const row = result.rows[0] as Row;
        return decode(ActivityPresentationStateV1, {
          object: "activity_presentation_state",
          community_id: input.communityId,
          observed_at: input.readAt,
          selection:
            row.persona_id === null
              ? { status: "unset" }
              : row.eligible !== true
                ? { status: "unavailable" }
                : {
                    status: "selected",
                    presentation: {
                      object: "activity_presentation",
                      community_id: input.communityId,
                      persona_id: text(row, "persona_id"),
                      updated_at: iso(row.updated_at),
                    },
                  },
        });
      },
      catch: storage,
    });
  }),
});

export const makeControlPlaneActivityCompletionStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): ActivityCompletionStore => {
  const repository = makeControlPlaneActivityCompletionRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    effect.pipe(
      Effect.provide(runtime),
      Effect.mapError((error) =>
        error !== null &&
        typeof error === "object" &&
        "_tag" in error &&
        String(error._tag).startsWith("ControlPlane")
          ? mapDbError(error as ControlPlaneError)
          : (error as E),
      ),
    );
  return {
    getCompletion: (input) => provide(repository.getCompletion(input)),
    getProgress: (input) => provide(repository.getProgress(input)),
    getPresentation: (input) => provide(repository.getPresentation(input)),
  };
};
