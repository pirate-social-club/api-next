import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type KaraokeAttemptStore,
  KaraokeCommandRejected,
  type KaraokeFailure,
  type KaraokeRuntimeLine,
  type KaraokeSessionAuthority,
  KaraokeStoreFailed,
} from "@pirate/application";
import {
  type KaraokeAttempt,
  KaraokeAttempt as KaraokeAttemptSchema,
  KaraokeSongLeaderboard as KaraokeSongLeaderboardSchema,
} from "@pirate/contracts";
import { canonicalJson } from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";
import { recordQualificationProjections } from "./activity-qualification-repository.ts";
import { buildKaraokePayloadLines } from "./karaoke-readiness-repository.ts";

type Row = Readonly<Record<string, unknown>>;

const failed = (reason: KaraokeStoreFailed["reason"]) => new KaraokeStoreFailed({ reason });
const rejected = (reason: KaraokeCommandRejected["reason"]) =>
  new KaraokeCommandRejected({ reason });

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
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null ? null : text(row, key);
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

const authorityFromRow = (row: Row): KaraokeSessionAuthority => ({
  accountId: text(row, "account_id"),
  artifactId: text(row, "artifact_id"),
  attemptId: text(row, "attempt_id"),
  audioRevision: integer(row, "audio_revision"),
  communityId: text(row, "community_id"),
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
  karaokeRevisionId: text(row, "karaoke_revision_id"),
  lines: json(row.line_snapshot) as readonly KaraokeRuntimeLine[],
  lyricsRevision: integer(row, "lyrics_revision"),
  personaId: text(row, "persona_id"),
  playbackKind: "full_mix",
  postId: text(row, "post_id"),
  qualificationPolicyVersionId: text(row, "qualification_policy_version_id"),
  requestHash: text(row, "request_hash"),
  scoringModel: "scribe_v2_realtime",
  scoringProvider: "elevenlabs",
  scoringVersion: 5,
  sessionId: text(row, "session_id"),
  timezone: text(row, "timezone"),
});

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

const sessionSource = (communityId: string, postId: string) =>
  Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const source = yield* db.execute<Row>({
      label: "karaoke.session.source",
      text: `SELECT publication.audio_revision, publication.lyrics_revision,
                    publication.canonical_audio_sha256,
                    artifact.artifact_sha256, artifact.artifact,
                    registry.current_policy_version_id
               FROM posts AS post
               JOIN media_publication_projections AS publication
                 ON publication.community_id=post.community_id AND publication.post_id=post.post_id
               JOIN media_alignment_projections AS alignment
                 ON alignment.community_id=publication.community_id
                AND alignment.post_id=publication.post_id
                AND alignment.submission_id=publication.submission_id
                AND alignment.audio_revision=publication.audio_revision
                AND alignment.analysis_revision=publication.analysis_revision
                AND alignment.lyrics_revision=publication.lyrics_revision
               JOIN media_timed_lyrics_artifacts AS artifact
                 ON artifact.artifact_ref=alignment.current_artifact_ref
                AND artifact.artifact_revision=alignment.current_artifact_revision
               JOIN activity_registry AS registry ON registry.activity_key='karaoke'
              WHERE post.community_id=$1 AND post.post_id=$2 AND post.post_type='song'
                AND post.status='published' AND post.visibility='public'
                AND publication.lyrics_status='ready' AND alignment.status='ready'`,
      values: [communityId, postId],
      readonly: true,
    });
    if (source.rows.length === 0) return yield* rejected("not-found");
    if (source.rows.length !== 1) return yield* failed("invalid-row");
    const row = source.rows[0] as Row;
    const catalog = yield* db.execute<Row>({
      label: "karaoke.session.catalog",
      text: `SELECT membership.ordinal, membership.lyric_line_id, version.canonical_text
               FROM localization_lyrics_revision_lines AS membership
               JOIN localization_lyric_line_versions AS version
                 ON version.community_id=membership.community_id
                AND version.post_id=membership.post_id
                AND version.lyric_line_id=membership.lyric_line_id
                AND version.line_version=membership.line_version
                AND version.source_hash=membership.source_hash
              WHERE membership.community_id=$1 AND membership.post_id=$2
                AND membership.lyrics_revision=$3 ORDER BY membership.ordinal`,
      values: [communityId, postId, integer(row, "lyrics_revision")],
      readonly: true,
    });
    const lines = buildKaraokePayloadLines({
      artifact: row.artifact,
      catalogLines: catalog.rows.map((line) => ({
        id: text(line, "lyric_line_id"),
        index: integer(line, "ordinal") - 1,
        text: text(line, "canonical_text"),
      })),
    });
    if (lines === null || lines.length === 0) return yield* failed("invalid-row");
    const revisionHash = createHash("sha256")
      .update(
        canonicalJson({
          algorithm: "karaoke_revision_v1",
          audio_sha256: text(row, "canonical_audio_sha256"),
          lyrics_revision: integer(row, "lyrics_revision"),
          timed_artifact_sha256: text(row, "artifact_sha256"),
          playback_kind: "full_mix",
        }),
      )
      .digest("hex");
    return {
      audioRevision: integer(row, "audio_revision"),
      karaokeRevisionId: `karaoke-revision-${revisionHash}`,
      lines,
      lyricsRevision: integer(row, "lyrics_revision"),
      policyVersion: text(row, "current_policy_version_id"),
    };
  });

export const makeControlPlaneKaraokeRepository = () => ({
  reserveSession: (input: Parameters<KaraokeAttemptStore["reserveSession"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const source = yield* sessionSource(input.communityId, input.postId);
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const identity = yield* transaction.execute<Row>({
              label: "karaoke.session.identity",
              text: `SELECT persona.persona_id,
                            coalesce($3, clock.timezone) AS timezone
                       FROM personas AS persona
                       LEFT JOIN account_streak_clocks AS clock ON clock.account_id=persona.account_id
                      WHERE persona.account_id=$1 AND persona.status='active'
                        AND persona.persona_id=coalesce($2, (
                          SELECT candidate.persona_id FROM personas AS candidate
                           WHERE candidate.account_id=$1 AND candidate.status='active'
                           ORDER BY candidate.is_first_persona DESC, candidate.created_at,
                                    candidate.persona_id LIMIT 1
                        ))`,
              values: [input.accountId, input.personaId, input.timezone],
              readonly: true,
            });
            if (identity.rows.length !== 1) return yield* rejected("invalid-input");
            const identityRow = identity.rows[0] as Row;
            const timezone = nullableText(identityRow, "timezone");
            if (timezone === null) return yield* rejected("invalid-input");
            const personaId = text(identityRow, "persona_id");
            const replay = yield* transaction.execute<Row>({
              label: "karaoke.session.replay",
              text: `SELECT session.*, recording.artifact_id
                       FROM karaoke_sessions AS session
                       JOIN karaoke_recordings AS recording USING (session_id, attempt_id)
                      WHERE session.account_id=$1 AND session.persona_id=$2
                        AND session.idempotency_key=$3 FOR UPDATE OF session`,
              values: [input.accountId, personaId, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (text(row, "request_hash") !== input.requestHash) {
                return yield* rejected("idempotency-conflict");
              }
              return authorityFromRow(row);
            }
            yield* transaction.execute({
              label: "karaoke.session.insert",
              text: `INSERT INTO karaoke_sessions (
                       session_id, attempt_id, account_id, persona_id, community_id, post_id,
                       audio_revision, lyrics_revision, karaoke_revision_id,
                       qualification_policy_version_id, idempotency_key, request_hash, timezone,
                       created_at, expires_at, playback_kind, scoring_version, scoring_provider,
                       scoring_model, line_snapshot, client_context
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                       $14::timestamptz,$15::timestamptz,'full_mix',5,'elevenlabs',
                       'scribe_v2_realtime',$16::jsonb,$17::jsonb)`,
              values: [
                input.sessionId,
                input.attemptId,
                input.accountId,
                personaId,
                input.communityId,
                input.postId,
                source.audioRevision,
                source.lyricsRevision,
                source.karaokeRevisionId,
                source.policyVersion,
                input.idempotencyKey,
                input.requestHash,
                timezone,
                input.createdAt,
                input.expiresAt,
                JSON.stringify(source.lines),
                input.clientContext === undefined ? null : JSON.stringify(input.clientContext),
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "karaoke.recording.reserve",
              text: `INSERT INTO karaoke_recordings (
                       session_id, attempt_id, account_id, artifact_id, created_at
                     ) VALUES ($1,$2,$3,$4,$5::timestamptz)`,
              values: [
                input.sessionId,
                input.attemptId,
                input.accountId,
                input.artifactId,
                input.createdAt,
              ],
              readonly: false,
            });
            const inserted = yield* transaction.execute<Row>({
              label: "karaoke.session.inserted",
              text: `SELECT session.*, recording.artifact_id
                       FROM karaoke_sessions AS session
                       JOIN karaoke_recordings AS recording USING (session_id, attempt_id)
                      WHERE session.session_id=$1`,
              values: [input.sessionId],
              readonly: true,
            });
            return authorityFromRow(inserted.rows[0] as Row);
          }),
        );
      }),
    ),
  getAttempt: (input: Parameters<KaraokeAttemptStore["getAttempt"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "karaoke.attempt.read",
          text: `${ATTEMPT_SELECT}
                  WHERE attempt.attempt_id=$1 AND session.account_id=$2
                    AND session.community_id=$3`,
          values: [input.attemptId, input.accountId, input.communityId],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return yield* failed("invalid-row");
        return yield* Effect.try({
          try: () => attemptFromRow(result.rows[0] as Row),
          catch: () => failed("invalid-row"),
        });
      }),
    ),
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
                         $7,$8,'private_learning','not_stored','stored',
                         $9::timestamptz + interval '24 months',$9::timestamptz)
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
  getLeaderboard: (input: Parameters<KaraokeAttemptStore["getLeaderboard"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const rows = yield* db.execute<Row>({
          label: "karaoke.leaderboard.read",
          text: `WITH revision AS (
                   SELECT karaoke_revision_id, scoring_version, scoring_provider, scoring_model
                     FROM karaoke_sessions
                    WHERE community_id=$1 AND post_id=$2
                    ORDER BY created_at DESC, session_id DESC LIMIT 1
                 ), eligible AS (
                   SELECT session.account_id, session.persona_id, attempt.final_score_bps,
                          attempt.completed_at,
                          row_number() OVER (
                            PARTITION BY session.account_id
                            ORDER BY attempt.final_score_bps DESC, attempt.completed_at, attempt.attempt_id
                          ) AS account_best,
                          count(*) OVER (PARTITION BY session.account_id) AS eligible_attempt_count
                     FROM revision
                     JOIN karaoke_sessions AS session
                       ON session.community_id=$1 AND session.post_id=$2
                      AND session.karaoke_revision_id=revision.karaoke_revision_id
                     JOIN karaoke_attempts AS attempt
                       ON attempt.session_id=session.session_id
                     JOIN activity_qualifications AS qualification
                       ON qualification.karaoke_attempt_id=attempt.attempt_id
                      AND qualification.activity_key='karaoke'
                 ), ranked AS (
                   SELECT eligible.*,
                          rank() OVER (ORDER BY final_score_bps DESC) AS rank,
                          count(*) OVER () AS total_ranked
                     FROM eligible WHERE account_best=1
                 )
                 SELECT revision.*, ranked.*, profile.display_name, profile.avatar_ref,
                        handle.label_display AS public_handle
                   FROM revision
                   LEFT JOIN ranked ON ranked.rank <= $3 OR ranked.account_id=$4
                   LEFT JOIN persona_profiles AS profile ON profile.persona_id=ranked.persona_id
                   LEFT JOIN LATERAL (
                     SELECT candidate.label_display FROM public_handle_index AS candidate
                      WHERE candidate.owner_persona_id=ranked.persona_id AND candidate.status='active'
                      ORDER BY candidate.updated_at DESC, candidate.handle_id LIMIT 1
                   ) AS handle ON true
                  ORDER BY ranked.rank, ranked.completed_at, ranked.persona_id`,
          values: [input.communityId, input.postId, input.limit, input.accountId],
          readonly: true,
        });
        if (rows.rows.length === 0) return yield* rejected("not-found");
        return yield* Effect.try({
          try: () => {
            const metadata = rows.rows[0] as Row;
            const ranked = rows.rows.filter((row) => row.account_id !== null);
            const total = ranked.length === 0 ? 0 : integer(ranked[0] as Row, "total_ranked");
            const entries = ranked
              .filter((row) => integer(row, "rank") <= input.limit)
              .map((row) => ({
                rank: integer(row, "rank"),
                top_percent: Math.max(1, Math.ceil((100 * integer(row, "rank")) / total)),
                score: integer(row, "final_score_bps"),
                reached_at: iso(row.completed_at),
                identity: {
                  visibility: "visible" as const,
                  display_name: nullableText(row, "display_name"),
                  handle: nullableText(row, "public_handle"),
                  avatar_ref: nullableText(row, "avatar_ref"),
                },
                is_viewer: row.account_id === input.accountId,
              }));
            const viewer = ranked.find((row) => row.account_id === input.accountId);
            return decode(KaraokeSongLeaderboardSchema, {
              object: "karaoke_song_leaderboard",
              post_id: input.postId,
              community_id: input.communityId,
              scope: "all_time",
              period_start: null,
              period_end: null,
              karaoke_revision_id: text(metadata, "karaoke_revision_id"),
              scoring_version: integer(metadata, "scoring_version"),
              scoring_provider: text(metadata, "scoring_provider"),
              scoring_model: text(metadata, "scoring_model"),
              total_ranked: total,
              entries,
              viewer_rank: viewer === undefined ? null : integer(viewer, "rank"),
              viewer_top_percent:
                viewer === undefined
                  ? null
                  : Math.max(1, Math.ceil((100 * integer(viewer, "rank")) / total)),
              viewer_best_score: viewer === undefined ? null : integer(viewer, "final_score_bps"),
              viewer_best_reached_at: viewer === undefined ? null : iso(viewer.completed_at),
              viewer_eligible_attempt_count:
                viewer === undefined ? 0 : integer(viewer, "eligible_attempt_count"),
            });
          },
          catch: () => failed("invalid-row"),
        });
      }),
    ),
});

export const makeControlPlaneKaraokeStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): KaraokeAttemptStore => {
  const repository = makeControlPlaneKaraokeRepository();
  const provide = <A>(
    effect: Effect.Effect<A, KaraokeFailure | ControlPlaneError, ControlPlaneDb>,
  ) => mapErrors(Effect.provide(runtime)(effect));
  return {
    reserveSession: (input) => provide(repository.reserveSession(input)),
    getAttempt: (input) => provide(repository.getAttempt(input)),
    getLeaderboard: (input) => provide(repository.getLeaderboard(input)),
    finalizeAttempt: (input) => provide(repository.finalizeAttempt(input)),
    reconcileRecording: (input) => provide(repository.reconcileRecording(input)),
  };
};
