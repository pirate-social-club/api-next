import { describe, expect, test } from "bun:test";
import {
  assessStudySpokenRerecord,
  gradeTranscriptV2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V2,
  type StudyTranscriptGradeV2,
} from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";
import { defaultStudySpokenEvidence } from "./study-v2-spoken-test-evidence.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};
const digest = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );

/**
 * Shared fixture for the spoken retry review: one community, one bound
 * persona, one published song and four say-it-back exercises. Copied from the
 * lifecycle suite so both review the same database shape.
 */
async function seedRetryFixture(admin: Client): Promise<void> {
  const lines = [
    "I can love you",
    "We keep moving forward",
    "Hold the rhythm closer",
    "Sing the night together",
  ];
  const lyrics = lines.join("\n");
  const lineHashes = await Promise.all(lines.map(digest));
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query("INSERT INTO users (user_id) VALUES ('study-account')");
    await admin.query(
      `INSERT INTO communities (
               community_id, display_name, status, created_by_user_id, created_at, updated_at
             ) VALUES ('study-community','Study community','active','study-account',
             clock_timestamp(),clock_timestamp())`,
    );
    await insertActiveCommunityMembershipFixture(admin, {
      communityId: "study-community",
      membershipId: "study-membership",
      userId: "study-account",
    });
    await admin.query(
      `INSERT INTO personas (
             persona_id, account_id, status, created_at
           ) VALUES ('study-persona', 'study-account', 'active', clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO persona_community_bindings (
               persona_id, account_id, community_id, binding_source
             ) VALUES ('study-persona', 'study-account', 'study-community', 'first_membership')`,
    );
    await admin.query(
      `INSERT INTO posts (
               community_id, post_id, post_type, status, visibility, created_at, updated_at
             ) VALUES ('study-community', 'study-post', 'song', 'published', 'public',
               clock_timestamp(), clock_timestamp())`,
    );
    await admin.query("UPDATE posts SET content_rating='general' WHERE post_id='study-post'");
    await admin.query(
      `INSERT INTO media_post_submissions (
             submission_id, community_id, actor_user_id, operation_id, idempotency_key,
             request_hash, title, song_type, start_input, audio_reservation_id,
             creation_revision, audio_revision, analysis_revision, current_analysis_revision,
             current_immutable_ref, status, phase, post_id,
             response_snapshot_bytes, response_snapshot_sha256,
             author_persona_id, lyrics_revision, current_lyrics_revision
           ) VALUES ('study-submission','study-community','study-account','study-operation',
             'study-idempotency',$1,'Study song','original','{}'::jsonb,'study-reservation',
             1,1,1,1,'audio-ref','published',NULL,'study-post',convert_to('snapshot','UTF8'),$2,
             'study-persona',1,1)`,
      ["1".repeat(64), await digest("snapshot")],
    );
    await admin.query(
      `INSERT INTO media_analysis_evidence (
              submission_id,community_id,actor_user_id,operation_id,analysis_version,
              audio_revision,analysis_revision,canonical_audio_sha256,finalized_audio_ref,
              probe_evidence_ref,embedded_metadata_evidence_ref,embedded_metadata_adapter_revision,
              embedded_title,embedded_title_provenance,cover_status,cover_facts,speech_status,
              transcript_artifact_ref,transcript_sha256,explicitness,primary_language_bcp47,
              speech_evidence_ref,speech_policy_revision,speech_adapter_revision,acr_decision,
              acr_evidence_ref,acr_policy_revision,acr_adapter_revision,media_safety,lyrics_safety,
              cover_moderation_decision,cover_moderation_reason,
              cover_moderation_matched_categories,analysis_snapshot,author_persona_id,
              lyrics_revision
            ) VALUES (
              'study-submission','study-community','study-account','study-operation',
              'song-trusted-analysis-v1',1,1,$1,'audio-ref','probe-ref','metadata-ref',
              'metadata-v1',NULL,'absent','absent','{"reasonCode":"not_embedded"}'::jsonb,
              'ready',NULL,NULL,'not_explicit','en','speech-ref','speech-policy-v1',
              'speech-adapter-v1','allow','acr-no-match-1001','acr-policy-v1','acr-adapter-v1',
              'allow','allow','not_applicable','not_embedded','[]'::jsonb,
              '{}'::jsonb,'study-persona',1
            )`,
      ["2".repeat(64)],
    );
    await admin.query(
      `INSERT INTO media_publication_projections (
             submission_id, community_id, actor_user_id, operation_id, post_id,
             creation_revision, audio_revision, analysis_revision, decision_revision,
             canonical_audio_sha256, title, audio_asset_ref, language_status,
             primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
             locked_delivery, projected_at, author_persona_id, lyrics_status,
             lyrics_revision, lyrics_text
           ) VALUES ('study-submission','study-community','study-account','study-operation',
             'study-post',1,1,1,1,$1,'Study song','audio-ref','ready','en','not_explicit',
             'ready','registered','not_required',clock_timestamp(),'study-persona','ready',1,$2)`,
      ["2".repeat(64), lyrics],
    );
    for (const [index, line] of lines.entries()) {
      const ordinal = index + 1;
      await admin.query(
        `INSERT INTO localization_lyric_line_occurrences (
                 community_id, post_id, lyric_line_id
               ) VALUES ('study-community','study-post',$1)`,
        [`line-${ordinal}`],
      );
      await admin.query(
        `INSERT INTO localization_lyric_line_versions (
                 community_id, post_id, lyric_line_id, line_version, canonical_text,
                 source_language, source_hash
               ) VALUES ('study-community','study-post',$1,1,$2,'en',$3)`,
        [`line-${ordinal}`, line, lineHashes[index]],
      );
      await admin.query(
        `INSERT INTO localization_study_units (
                 community_id, post_id, study_unit_id, identity_normalization_revision,
                 normalized_source_hash
               ) VALUES ('study-community','study-post',$1,
                 'lyric_line_identity_normalization_v1',$2)`,
        [`unit-${ordinal}`, lineHashes[index]],
      );
      await admin.query(
        `INSERT INTO localization_lyric_line_study_units (
                 community_id, post_id, lyric_line_id, line_version, study_unit_id
               ) VALUES ('study-community','study-post',$1,1,$2)`,
        [`line-${ordinal}`, `unit-${ordinal}`],
      );
      await admin.query(
        `INSERT INTO localization_lyrics_revision_lines (
                 community_id, actor_user_id, post_id, submission_id, lyrics_revision,
                 ordinal, lyric_line_id, line_version, source_hash
               ) VALUES ('study-community','study-account','study-post','study-submission',1,
                 $1,$2,1,$3)`,
        [ordinal, `line-${ordinal}`, lineHashes[index]],
      );
      await admin.query(
        `INSERT INTO study_exercise_versions (
               exercise_version_id, community_id, post_id, audio_revision, lyrics_revision,
               lyric_line_id, line_version, line_source_hash, exercise_review_key,
               exercise_type, exercise_variant, learning_language, target_language,
               learner_band, content_revision, presentation, private_grader, study_unit_id,
               answer_visibility, feedback_release, grader_policy_revision,
               feedback_policy_revision, generation_kind, generation_run_id, producer_id,
               provider_model, prompt_revision, request_hash, raw_result_digest,
               structural_validator_revision, semantic_validator_revision,
               safety_validator_revision, quality_validator_revision,
               quality_policy_revision, generated_at, validated_at, accepted_at
             ) VALUES ($1,'study-community','study-post',1,1,$2,1,$3,$4,
               'say_it_back','spoken-recall-v2','en',NULL,NULL,1,$5::jsonb,$6::jsonb,$7,
               'always_visible','every_graded_attempt','script_aware_token_phonetic_v2',
               'spoken-feedback-v1','deterministic',$8,'accepted-lyrics-say-it-back-v2',NULL,
               'accepted-say-it-back-v2',$9,$3,'study-source-structure-v1',
               'study-source-semantic-v1','study-source-safety-v1','study-source-quality-v1',
               'accepted-source-v1',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        [
          `exercise-${ordinal}`,
          `line-${ordinal}`,
          lineHashes[index],
          `study-say-it-back:study-post:unit-${ordinal}`,
          JSON.stringify({
            kind: "say_it_back",
            reference_text: line,
            capture: "microphone_audio",
          }),
          JSON.stringify({
            kind: "source_token_phonetic_v2",
            reference_text: line,
            tokenizer_policy_revision: "script_aware_token_phonetic_v2",
          }),
          `unit-${ordinal}`,
          `study-run-${ordinal}`,
          await digest(`exercise-${ordinal}`),
        ],
      );
    }
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

type Runtime = ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
type StudyRepository = ReturnType<typeof makeControlPlaneStudyV2Repository>;

const hex = (seed: string): string =>
  Buffer.from(seed, "utf8").toString("hex").padEnd(64, "0").slice(0, 64);

const payload = (
  seed: string,
  overrides: Partial<{
    audioByteSize: number;
    audioContentType: string;
    audioDigest: string;
    audioDurationMs: number;
    requestHash: string;
  }> = {},
) => ({
  audioByteSize: 100,
  audioContentType: "audio/webm",
  audioDigest: hex(seed),
  audioDurationMs: 1000,
  requestHash: hex(`${seed}-request`),
  ...overrides,
});

suite("Study v2 ungraded spoken receipt", () => {
  test("one receipt preserves the presentation and its next graded first attempt", async () => {
    await withSchema("rerecord", async ({ admin, driver }) => {
      const session = await driver.start("study-session-rerecord");
      const sessionItemId = session.items[0]?.session_item_id ?? "";
      expect(await driver.loadContext(session.session_id, sessionItemId)).toMatchObject({
        dominantLanguage: null,
        languageProvenance: { kind: "no_authoritative_evidence" },
      });
      const grade = gradeTranscriptV2(
        "I can love you",
        "I can let love you",
        null,
        STUDY_TRANSCRIPT_GRADER_POLICY_V2,
      );
      expect(grade).toMatchObject({ correct: false, extra: ["let"], missing: [] });
      const firstPayload = payload("rerecord-first");
      const first = reservedOnly(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "rerecord-first",
          leaseToken: "rerecord-first-lease",
          sessionId: session.session_id,
          sessionItemId,
          ...firstPayload,
        }),
      );
      const initialReview = await admin.query(
        `SELECT difficulty, lapses, repetitions, stability FROM study_review_items
          WHERE review_item_id=(SELECT review_item_id FROM study_session_items_v2
                                WHERE session_item_id=$1)`,
        [sessionItemId],
      );
      const receipt = await driver.complete(first, {
        acceptedAt: "2026-09-12T12:01:00.000Z",
        attemptNumber: 1,
        audioDigest: firstPayload.audioDigest,
        correct: false,
        grade,
        rerecordEnabled: true,
        requestHash: firstPayload.requestHash,
        sessionId: session.session_id,
        sessionItemId,
      });
      expect(receipt).toMatchObject({
        outcome: "ungraded_rerecord",
        attempt_number: 1,
        attempt_state: "retryable",
        first_pass: true,
        spoken: {
          language_provenance: { kind: "no_authoritative_evidence" },
          rerecord_decision: { kind: "ungraded_rerecord", reason: "single_insertion" },
        },
        session: { lesson: { presentation_count: 0 } },
      });
      expect(receipt.session.lesson.current?.session_item_id).toBe(sessionItemId);
      expect(await attemptRows(admin, sessionItemId)).toHaveLength(0);
      const presentationsBefore = await admin.query(
        "SELECT count(*)::int AS n FROM study_presentations_v2 WHERE session_item_id=$1",
        [sessionItemId],
      );
      expect(presentationsBefore.rows[0]?.n).toBe(0);
      const reviewAfterReceipt = await admin.query(
        `SELECT difficulty, lapses, repetitions, stability FROM study_review_items
          WHERE review_item_id=(SELECT review_item_id FROM study_session_items_v2
                                WHERE session_item_id=$1)`,
        [sessionItemId],
      );
      expect(reviewAfterReceipt.rows).toEqual(initialReview.rows);
      expect(
        await driver.complete(first, {
          acceptedAt: "2026-09-12T12:01:00.000Z",
          attemptNumber: 1,
          audioDigest: firstPayload.audioDigest,
          correct: false,
          grade,
          rerecordEnabled: true,
          requestHash: firstPayload.requestHash,
          sessionId: session.session_id,
          sessionItemId,
        }),
      ).toEqual(receipt);
      expect(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "rerecord-first",
          leaseToken: "rerecord-replay-lease",
          sessionId: session.session_id,
          sessionItemId,
          ...firstPayload,
        }),
      ).toMatchObject({ state: "completed", result: receipt });

      const secondPayload = payload("rerecord-second");
      const second = reservedOnly(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "rerecord-second",
          leaseToken: "rerecord-second-lease",
          sessionId: session.session_id,
          sessionItemId,
          ...secondPayload,
        }),
      );
      const graded = await driver.complete(second, {
        acceptedAt: "2026-09-12T12:02:00.000Z",
        attemptNumber: 1,
        audioDigest: secondPayload.audioDigest,
        correct: false,
        grade,
        rerecordEnabled: true,
        requestHash: secondPayload.requestHash,
        sessionId: session.session_id,
        sessionItemId,
      });
      expect(graded).toMatchObject({
        outcome: "incorrect",
        attempt_number: 1,
        attempt_state: "spent",
        first_pass: true,
        spoken: { rerecord_decision: { kind: "graded", reason: null } },
        session: { lesson: { presentation_count: 1 } },
      });
      expect(await attemptRows(admin, sessionItemId)).toHaveLength(1);
      const commands = await admin.query(
        `SELECT result_kind, count(*)::int AS n FROM study_spoken_answer_commands
          WHERE session_item_id=$1 GROUP BY result_kind ORDER BY result_kind`,
        [sessionItemId],
      );
      expect(commands.rows).toEqual([
        { result_kind: "graded", n: 1 },
        { result_kind: "rerecord", n: 1 },
      ]);
      expect(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "rerecord-first",
          leaseToken: "rerecord-late-replay-lease",
          sessionId: session.session_id,
          sessionItemId,
          ...firstPayload,
        }),
      ).toMatchObject({ state: "completed", result: receipt });
    });
  }, 60_000);

  test("records the joined profile composite key when it authorizes English", async () => {
    await withSchema("profile-provenance", async ({ admin, driver }) => {
      await admin.query(
        `INSERT INTO study_language_profiles (
           community_id, post_id, lyrics_revision, language_profile_revision,
           source_hash, provider_id, provider_model, prompt_revision,
           validator_revision, request_hash, accepted_at
         ) VALUES ('study-community','study-post',1,1,$1,
                   'profile-provider','profile-model','profile-prompt-v1',
                   'profile-validator-v1',$2,clock_timestamp())`,
        [hex("profile-source"), hex("profile-request")],
      );
      for (const ordinal of [1, 2, 3, 4]) {
        await admin.query(
          `INSERT INTO study_language_profile_units (
             community_id, post_id, lyrics_revision, language_profile_revision,
             study_unit_id, detected_languages, dominant_language, mixed,
             vocable_only, confidence
           ) VALUES ('study-community','study-post',1,1,$1,
                     '["en"]'::jsonb,'en',false,false,0.95)`,
          [`unit-${ordinal}`],
        );
      }
      const session = await driver.start("study-session-profile");
      const current = session.lesson.current?.session_item_id ?? "";
      const context = await driver.loadContext(session.session_id, current);
      const item = session.items.find(({ session_item_id }) => session_item_id === current);
      expect(context).toMatchObject({
        dominantLanguage: "en",
        languageProvenance: {
          kind: "unit_profile",
          community_id: "study-community",
          post_id: "study-post",
          lyrics_revision: 1,
          language_profile_revision: 1,
          study_unit_id: item?.line.study_unit_id,
          confidence: 0.95,
          dominant_language: "en",
        },
      });
    });
  }, 60_000);

  test("a rerecord after a graded miss does not restore first-pass eligibility", async () => {
    await withSchema("rerecord-after-miss", async ({ admin, driver }) => {
      const session = await driver.start("study-session-after-miss");
      const sessionItemId = session.lesson.current?.session_item_id ?? "";
      let current = session;
      for (let ordinal = 0; ordinal < 8; ordinal += 1) {
        const currentItemId = current.lesson.current?.session_item_id;
        if (currentItemId === undefined) throw new Error("expected a current lesson item");
        if (ordinal > 0 && currentItemId === sessionItemId) break;
        const answerPayload = payload(`after-miss-grade-${ordinal}`);
        const reservation = reservedOnly(
          await driver.reserve({
            attemptNumber: 1,
            idempotencyKey: `after-miss-grade-${ordinal}`,
            leaseToken: `after-miss-grade-${ordinal}-lease`,
            sessionId: session.session_id,
            sessionItemId: currentItemId,
            ...answerPayload,
          }),
        );
        const graded = await driver.complete(reservation, {
          acceptedAt: "2026-09-12T12:01:00.000Z",
          attemptNumber: 1,
          audioDigest: answerPayload.audioDigest,
          correct: ordinal !== 0,
          requestHash: answerPayload.requestHash,
          sessionId: session.session_id,
          sessionItemId: currentItemId,
        });
        current = graded.session;
      }
      expect(current.lesson.current?.session_item_id).toBe(sessionItemId);
      expect(await attemptRows(admin, sessionItemId)).toHaveLength(1);

      const grade = gradeTranscriptV2(
        "I can love you",
        "I can let love you",
        null,
        STUDY_TRANSCRIPT_GRADER_POLICY_V2,
      );
      const rerecordPayload = payload("after-miss-rerecord");
      const rerecordReservation = reservedOnly(
        await driver.reserve({
          attemptNumber: 2,
          idempotencyKey: "after-miss-rerecord",
          leaseToken: "after-miss-rerecord-lease",
          sessionId: session.session_id,
          sessionItemId,
          ...rerecordPayload,
        }),
      );
      const receipt = await driver.complete(rerecordReservation, {
        acceptedAt: "2026-09-12T12:02:00.000Z",
        attemptNumber: 2,
        audioDigest: rerecordPayload.audioDigest,
        correct: false,
        grade,
        rerecordEnabled: true,
        requestHash: rerecordPayload.requestHash,
        sessionId: session.session_id,
        sessionItemId,
      });
      expect(receipt).toMatchObject({
        outcome: "ungraded_rerecord",
        attempt_number: 2,
        first_pass: false,
      });
      expect(await attemptRows(admin, sessionItemId)).toHaveLength(1);

      const gradedPayload = payload("after-miss-second-grade");
      const gradedReservation = reservedOnly(
        await driver.reserve({
          attemptNumber: 2,
          idempotencyKey: "after-miss-second-grade",
          leaseToken: "after-miss-second-grade-lease",
          sessionId: session.session_id,
          sessionItemId,
          ...gradedPayload,
        }),
      );
      const graded = await driver.complete(gradedReservation, {
        acceptedAt: "2026-09-12T12:03:00.000Z",
        attemptNumber: 2,
        audioDigest: gradedPayload.audioDigest,
        correct: true,
        requestHash: gradedPayload.requestHash,
        sessionId: session.session_id,
        sessionItemId,
      });
      expect(graded).toMatchObject({
        outcome: "correct",
        attempt_number: 2,
        first_pass: false,
      });
      expect(await attemptRows(admin, sessionItemId)).toHaveLength(2);
    });
  }, 60_000);
});

type SpokenReservation = Effect.Success<ReturnType<StudyRepository["reserveSpokenAnswer"]>>;

const reservedOnly = (
  reservation: SpokenReservation,
): Extract<SpokenReservation, { readonly state: "reserved" }> => {
  if (reservation.state !== "reserved") throw new Error("expected a reserved spoken answer");
  return reservation;
};

function makeDriver(runtime: Runtime, study: StudyRepository) {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${counter}`;
  };

  return {
    run,
    next,
    start: (sessionId: string) =>
      run(
        study.startSession({
          accountId: "study-account",
          communityId: "study-community",
          createdAt: "2026-09-12T12:00:00.000Z",
          idempotencyKey: `session-command-${sessionId}`,
          learnerBand: null,
          personaId: "study-persona",
          postId: "study-post",
          requestHash: hex(`session-${sessionId}`),
          sessionId,
          targetLanguage: null,
          timezone: "UTC",
        }),
      ),
    startRaw: (input: {
      readonly sessionId: string;
      readonly idempotencyKey: string;
      readonly requestHash: string;
    }) =>
      run(
        study.startSession({
          accountId: "study-account",
          communityId: "study-community",
          createdAt: "2026-09-12T12:00:00.000Z",
          idempotencyKey: input.idempotencyKey,
          learnerBand: null,
          personaId: "study-persona",
          postId: "study-post",
          requestHash: input.requestHash,
          sessionId: input.sessionId,
          targetLanguage: null,
          timezone: "UTC",
        }),
      ),
    getSession: (sessionId: string) =>
      run(
        study.getSession({
          accountId: "study-account",
          communityId: "study-community",
          sessionId,
        }),
      ),
    loadContext: (sessionId: string, sessionItemId: string) =>
      run(
        study.loadSpokenAnswerContext({
          accountId: "study-account",
          communityId: "study-community",
          idempotencyKey: "profile-context",
          sessionId,
          sessionItemId,
        }),
      ),
    reserve: (input: {
      readonly attemptNumber: number;
      readonly audioByteSize?: number;
      readonly audioContentType?: string;
      readonly audioDigest: string;
      readonly audioDurationMs?: number;
      readonly idempotencyKey: string;
      readonly leaseToken: string;
      readonly requestHash: string;
      readonly sessionId: string;
      readonly sessionItemId: string;
    }) =>
      run(
        study.reserveSpokenAnswer({
          accountId: "study-account",
          attemptNumber: input.attemptNumber,
          audioByteSize: input.audioByteSize ?? 100,
          audioContentType: input.audioContentType ?? "audio/webm",
          audioDigest: input.audioDigest,
          audioDurationMs: input.audioDurationMs ?? 1000,
          attemptId: next("study-attempt"),
          artifactId: next("study-artifact"),
          commandId: next("study-command"),
          idempotencyKey: input.idempotencyKey,
          leaseToken: input.leaseToken,
          providerRetention: "stored",
          requestHash: input.requestHash,
          sessionId: input.sessionId,
          sessionItemId: input.sessionItemId,
        }),
      ),
    fail: (reservation: SpokenReservation) => {
      const owned = reservedOnly(reservation);
      return run(
        study.failSpokenAnswer({
          accountId: "study-account",
          commandId: owned.commandId,
          failedAt: "2026-09-12T12:01:00.000Z",
          leaseToken: owned.leaseToken,
          providerFailureKind: "unavailable",
        }),
      );
    },
    complete: (
      reservation: SpokenReservation,
      input: {
        readonly acceptedAt: string;
        readonly archiveObjectRef?: string;
        readonly attemptNumber: number;
        readonly audioDigest: string;
        readonly correct: boolean;
        readonly grade?: StudyTranscriptGradeV2;
        readonly rerecordEnabled?: boolean;
        readonly requestHash: string;
        readonly sessionId: string;
        readonly sessionItemId: string;
      },
    ) => {
      const owned = reservedOnly(reservation);
      const grade = input.grade ?? {
        correct: input.correct,
        matchKind: input.correct ? ("exact" as const) : ("none" as const),
        heardTranscript: input.correct ? "I can love you" : "unrecognized murmur",
        matched: [],
        missing: [],
        extra: [],
        substituted: [],
        policyRevision: "script_aware_token_phonetic_v2" as const,
      };
      return run(
        study.completeSpokenAnswer({
          ...defaultStudySpokenEvidence,
          accountId: "study-account",
          acceptedAt: input.acceptedAt,
          archive: {
            state: "stored",
            objectRef:
              input.archiveObjectRef ??
              `learner-audio/study/${owned.attemptId}/${input.audioDigest}`,
          },
          artifactId: owned.artifactId,
          attemptId: owned.attemptId,
          attemptNumber: input.attemptNumber,
          audioByteSize: 100,
          audioContentType: "audio/webm",
          audioDigest: input.audioDigest,
          audioDurationMs: 1000,
          commandId: owned.commandId,
          communityId: "study-community",
          grade,
          rerecordEnabled: input.rerecordEnabled === true,
          rerecordAssessment: assessStudySpokenRerecord({
            grade,
            expectedLanguage: null,
            detectedLanguage: "en",
            detectedLanguageConfidence: 0.99,
          }),
          leaseToken: owned.leaseToken,
          providerDetectedLanguage: "en",
          providerDetectedLanguageConfidence: 0.99,
          qualificationId: next("study-qualification"),
          requestHash: input.requestHash,
          sessionId: input.sessionId,
          sessionItemId: input.sessionItemId,
        }),
      );
    },
  };
}

type Driver = ReturnType<typeof makeDriver>;

const commandRow = async (admin: Client, commandId: string) =>
  (
    await admin.query(
      `SELECT idempotency_key, request_hash, audio_digest, state, lease_token
         FROM study_spoken_answer_commands WHERE command_id=$1`,
      [commandId],
    )
  ).rows[0] as Record<string, unknown>;

const artifactRow = async (admin: Client, artifactId: string) =>
  (
    await admin.query(
      `SELECT recording_state, expected_object_ref, content_digest
         FROM learner_audio_artifacts WHERE learner_audio_artifact_id=$1`,
      [artifactId],
    )
  ).rows[0] as Record<string, unknown>;

const attemptRows = async (admin: Client, sessionItemId: string) =>
  (
    await admin.query(
      `SELECT attempt_id, attempt_number, outcome, submission_evidence
         FROM study_attempts_v2 WHERE session_item_id=$1 ORDER BY attempt_number`,
      [sessionItemId],
    )
  ).rows as ReadonlyArray<Record<string, unknown>>;

const lessonCounts = async (admin: Client, sessionId: string) =>
  (
    await admin.query(
      `SELECT
         (SELECT count(*)::int FROM study_attempts_v2 attempt
            JOIN study_session_items_v2 item USING (session_item_id)
           WHERE item.session_id=$1) AS attempts,
         (SELECT count(*)::int FROM activity_qualifications
           WHERE account_id='study-account' AND activity_key='study') AS qualifications,
         (SELECT status FROM study_sessions_v2 WHERE session_id=$1) AS session_status`,
      [sessionId],
    )
  ).rows[0] as Record<string, unknown>;

async function withSchema(
  name: string,
  body: (context: {
    readonly admin: Client;
    readonly driver: Driver;
    readonly scoped: string;
  }) => Promise<void>,
): Promise<void> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `api_next_study_${name}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const scoped = connectionForSchema(connectionString, schema);
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await seedRetryFixture(admin);
    const runtime = makeDirectPostgresControlPlaneLayer(scoped);
    const study = makeControlPlaneStudyV2Repository();
    await body({ admin, driver: makeDriver(runtime, study), scoped });
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

suite("Study v2 spoken reservation reclaim", () => {
  test("reclaims failed and expired reservations and rejects stale writers", async () => {
    await withSchema("retry", async ({ admin, driver }) => {
      const session = await driver.start("study-session-retry");
      const item = (index: number) => session.items[index]?.session_item_id ?? "";

      // 1. A provider failure leaves the reservation reclaimable.
      const failed = payload("failed-recording");
      const first = reservedOnly(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-failed",
          leaseToken: "study-lease-failed",
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...failed,
        }),
      );
      await driver.fail(first);
      expect((await commandRow(admin, first.commandId)).state).toBe("retryable_failed");
      expect((await artifactRow(admin, first.artifactId)).recording_state).toBe("failed");

      // 2. Newly recorded audio reclaims the same command under a new identity.
      const replacement = payload("replacement-recording");
      const second = reservedOnly(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-replacement",
          leaseToken: "study-lease-replacement",
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...replacement,
        }),
      );
      expect(second.commandId).toBe(first.commandId);
      expect(await commandRow(admin, second.commandId)).toMatchObject({
        audio_digest: replacement.audioDigest,
        idempotency_key: "study-spoken-replacement",
        request_hash: replacement.requestHash,
        state: "reserved",
      });
      expect(await artifactRow(admin, first.artifactId)).toMatchObject({
        content_digest: replacement.audioDigest,
        expected_object_ref: `learner-audio/study/${first.attemptId}/${replacement.audioDigest}`,
        recording_state: "pending",
      });

      // 3. The replaced request cannot complete against its successor.
      await expect(
        driver.complete(first, {
          acceptedAt: "2026-09-12T12:02:00.000Z",
          attemptNumber: 1,
          correct: true,
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...failed,
        }),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });

      // 4. A stale archive reference cannot complete the new attempt either.
      await expect(
        driver.complete(second, {
          acceptedAt: "2026-09-12T12:02:00.000Z",
          archiveObjectRef: `learner-audio/study/${first.attemptId}/${failed.audioDigest}`,
          attemptNumber: 1,
          correct: true,
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...replacement,
        }),
      ).rejects.toMatchObject({ reason: "command-in-flight" });
      expect(await attemptRows(admin, item(0))).toHaveLength(0);

      // 5. The replacement completes exactly once with its own audio.
      const completed = await driver.complete(second, {
        acceptedAt: "2026-09-12T12:03:00.000Z",
        attemptNumber: 1,
        correct: true,
        sessionId: session.session_id,
        sessionItemId: item(0),
        ...replacement,
      });
      expect(completed).toMatchObject({ outcome: "correct", attempt_state: "spent" });
      const attempts = await attemptRows(admin, item(0));
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.submission_evidence).toMatchObject({
        audio_digest: replacement.audioDigest,
      });

      // 6. A completed answer keeps its strict replay and digest checks.
      const replay = await driver.reserve({
        attemptNumber: 1,
        idempotencyKey: "study-spoken-replacement",
        leaseToken: "study-lease-replay",
        sessionId: session.session_id,
        sessionItemId: item(0),
        ...replacement,
      });
      expect(replay.state).toBe("completed");
      await expect(
        driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-conflict",
          leaseToken: "study-lease-conflict",
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...payload("different-audio"),
        }),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });
      expect(await attemptRows(admin, item(0))).toHaveLength(1);

      // 7. A live lease is never replaceable; an expired lease is.
      const live = payload("live-lease");
      const third = reservedOnly(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-live",
          leaseToken: "study-lease-live",
          sessionId: session.session_id,
          sessionItemId: item(1),
          ...live,
        }),
      );
      await expect(
        driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-live",
          leaseToken: "study-lease-live-again",
          sessionId: session.session_id,
          sessionItemId: item(1),
          ...live,
        }),
      ).rejects.toMatchObject({ reason: "command-in-flight" });
      await expect(
        driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-live",
          leaseToken: "study-lease-usurper",
          sessionId: session.session_id,
          sessionItemId: item(1),
          ...payload("usurping-audio"),
        }),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });

      await admin.query(
        `UPDATE study_spoken_answer_commands
              SET reserved_at=clock_timestamp() - interval '2 minutes',
                  lease_expires_at=clock_timestamp() - interval '1 second'
            WHERE command_id=$1`,
        [third.commandId],
      );
      const expiredPayload = payload("expired-replacement");
      const fourth = reservedOnly(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-expired",
          leaseToken: "study-lease-expired",
          sessionId: session.session_id,
          sessionItemId: item(1),
          ...expiredPayload,
        }),
      );
      await expect(
        driver.complete(third, {
          acceptedAt: "2026-09-12T12:04:00.000Z",
          attemptNumber: 1,
          correct: true,
          sessionId: session.session_id,
          sessionItemId: item(1),
          ...live,
        }),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });
      expect(await attemptRows(admin, item(1))).toHaveLength(0);
      await driver.complete(fourth, {
        acceptedAt: "2026-09-12T12:05:00.000Z",
        attemptNumber: 1,
        correct: true,
        sessionId: session.session_id,
        sessionItemId: item(1),
        ...expiredPayload,
      });
      expect(await attemptRows(admin, item(1))).toHaveLength(1);

      // 8. The lesson completes with exactly one attempt per card and one
      // qualification.
      for (const index of [2, 3]) {
        const answer = payload(`normal-${index}`);
        const reservation = reservedOnly(
          await driver.reserve({
            attemptNumber: 1,
            idempotencyKey: `study-spoken-${index}`,
            leaseToken: `study-lease-${index}`,
            sessionId: session.session_id,
            sessionItemId: item(index),
            ...answer,
          }),
        );
        await driver.complete(reservation, {
          acceptedAt: `2026-09-12T12:0${index + 5}:00.000Z`,
          attemptNumber: 1,
          correct: true,
          sessionId: session.session_id,
          sessionItemId: item(index),
          ...answer,
        });
      }
      expect(await lessonCounts(admin, session.session_id)).toEqual({
        attempts: 4,
        qualifications: 1,
        session_status: "completed",
      });
      const replayAfterCompletion = await driver.reserve({
        attemptNumber: 1,
        idempotencyKey: "study-spoken-replacement",
        leaseToken: "study-lease-final-replay",
        sessionId: session.session_id,
        sessionItemId: item(0),
        ...replacement,
      });
      expect(replayAfterCompletion.state).toBe("completed");
      expect(await lessonCounts(admin, session.session_id)).toEqual({
        attempts: 4,
        qualifications: 1,
        session_status: "completed",
      });
    });
  }, 60_000);

  test("serializes concurrent retries so exactly one owner completes", async () => {
    await withSchema("concurrent", async ({ admin, driver }) => {
      const session = await driver.start("study-session-concurrent");
      const item = (index: number) => session.items[index]?.session_item_id ?? "";

      // A failed reservation is the retry trigger for the race.
      const failed = payload("race-failed");
      const first = reservedOnly(
        await driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-race-failed",
          leaseToken: "study-lease-race-failed",
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...failed,
        }),
      );
      await driver.fail(first);

      // Two simultaneous retries with different audio: the account lock
      // serializes them and only one may acquire ownership.
      const differentAudio = await Promise.allSettled([
        driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-race-a",
          leaseToken: "study-lease-race-a",
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...payload("race-audio-a"),
        }),
        driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-race-b",
          leaseToken: "study-lease-race-b",
          sessionId: session.session_id,
          sessionItemId: item(0),
          ...payload("race-audio-b"),
        }),
      ]);
      const owned = differentAudio.filter((result) => result.status === "fulfilled");
      const refused = differentAudio.filter((result) => result.status === "rejected");
      expect(owned).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toMatchObject({ reason: "idempotency-conflict" });
      const winner = reservedOnly(owned[0]?.value as SpokenReservation);
      const winnerRow = await commandRow(admin, winner.commandId);
      await driver.complete(winner, {
        acceptedAt: "2026-09-12T12:06:00.000Z",
        attemptNumber: 1,
        audioDigest: String(winnerRow.audio_digest),
        correct: true,
        requestHash: String(winnerRow.request_hash),
        sessionId: session.session_id,
        sessionItemId: item(0),
      });
      expect(await attemptRows(admin, item(0))).toHaveLength(1);

      // Two simultaneous identical submissions: one owns, the other observes
      // the live lease instead of double-claiming.
      const identicalPayload = payload("race-identical");
      const identical = await Promise.allSettled([
        driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-identical",
          leaseToken: "study-lease-identical-a",
          sessionId: session.session_id,
          sessionItemId: item(1),
          ...identicalPayload,
        }),
        driver.reserve({
          attemptNumber: 1,
          idempotencyKey: "study-spoken-identical",
          leaseToken: "study-lease-identical-b",
          sessionId: session.session_id,
          sessionItemId: item(1),
          ...identicalPayload,
        }),
      ]);
      const ownedIdentical = identical.filter((result) => result.status === "fulfilled");
      const refusedIdentical = identical.filter((result) => result.status === "rejected");
      expect(ownedIdentical).toHaveLength(1);
      expect(refusedIdentical).toHaveLength(1);
      expect(refusedIdentical[0]?.reason).toMatchObject({ reason: "command-in-flight" });
      const identicalWinner = reservedOnly(ownedIdentical[0]?.value as SpokenReservation);
      await driver.complete(identicalWinner, {
        acceptedAt: "2026-09-12T12:07:00.000Z",
        attemptNumber: 1,
        correct: true,
        sessionId: session.session_id,
        sessionItemId: item(1),
        ...identicalPayload,
      });
      expect(await attemptRows(admin, item(1))).toHaveLength(1);
    });
  }, 60_000);
});

suite("Study v2 session start concurrency", () => {
  test("identical concurrent starts return one committed session", async () => {
    await withSchema("start-race", async ({ admin, driver }) => {
      const identical = {
        idempotencyKey: "session-race-identical",
        requestHash: hex("session-race-identical"),
      };
      const [first, second] = await Promise.all([
        driver.startRaw({ ...identical, sessionId: "study-session-race-a" }),
        driver.startRaw({ ...identical, sessionId: "study-session-race-b" }),
      ]);
      expect(first.session_id).toBe(second.session_id);
      const stored = await admin.query(
        `SELECT count(*)::int AS n, min(session_id) AS session_id FROM study_sessions_v2
          WHERE account_id='study-account' AND post_id='study-post' AND idempotency_key=$1`,
        [identical.idempotencyKey],
      );
      const row = stored.rows[0] as { n: number; session_id: string };
      expect(row.n).toBe(1);
      expect(row.session_id).toBe(first.session_id);
      const replay = await driver.startRaw({ ...identical, sessionId: "study-session-race-c" });
      expect(replay.session_id).toBe(first.session_id);
    });
  }, 60_000);

  test("a distinct key while the schedule is not due is refused without a session", async () => {
    await withSchema("start-not-due", async ({ admin, driver }) => {
      const first = await driver.startRaw({
        idempotencyKey: "session-not-due-1",
        requestHash: hex("session-not-due-1"),
        sessionId: "study-session-not-due-1",
      });
      expect(first.session_id).toBe("study-session-not-due-1");
      // A start creates the account's card schedule; while those items are not
      // due, a different key cannot start another lesson and must not persist
      // a second session. This is the server-side state behind the start
      // conflicts the browser suite saw when a concurrent consumer had already
      // started the account.
      await expect(
        driver.startRaw({
          idempotencyKey: "session-not-due-2",
          requestHash: hex("session-not-due-2"),
          sessionId: "study-session-not-due-2",
        }),
      ).rejects.toMatchObject({ reason: "insufficient-exercises" });
      const stored = await admin.query(
        `SELECT count(*)::int AS n FROM study_sessions_v2 WHERE account_id='study-account'`,
      );
      expect((stored.rows[0] as { n: number }).n).toBe(1);
    });
  }, 60_000);

  test("a distinct key creates a later session once the schedule is due again", async () => {
    await withSchema("start-later", async ({ admin, driver }) => {
      const first = await driver.startRaw({
        idempotencyKey: "session-later-1",
        requestHash: hex("session-later-1"),
        sessionId: "study-session-later-1",
      });
      expect(first.session_id).toBe("study-session-later-1");
      // A later lesson is legitimate only after the first session is terminal
      // and the review schedule is due again; both are authoritative server
      // state, not a client key-rotation heuristic.
      await admin.query(
        `UPDATE study_sessions_v2
            SET status='completed', completed_at=clock_timestamp(),
                completion_reason='all_resolved', current_session_item_id=NULL,
                current_presented_at=NULL
          WHERE session_id=$1`,
        [first.session_id],
      );
      await admin.query(
        `UPDATE study_review_items SET due_at=clock_timestamp() - interval '1 hour'
          WHERE account_id='study-account'`,
      );
      const second = await driver.startRaw({
        idempotencyKey: "session-later-2",
        requestHash: hex("session-later-2"),
        sessionId: "study-session-later-2",
      });
      expect(second.session_id).toBe("study-session-later-2");
      const stored = await admin.query(
        `SELECT count(*)::int AS n FROM study_sessions_v2 WHERE account_id='study-account'`,
      );
      expect((stored.rows[0] as { n: number }).n).toBe(2);
    });
  }, 60_000);

  test("the same key with different inputs stays an idempotency conflict", async () => {
    await withSchema("start-conflict", async ({ driver }) => {
      await driver.startRaw({
        idempotencyKey: "session-conflict",
        requestHash: hex("session-conflict-a"),
        sessionId: "study-session-conflict-a",
      });
      const conflict = await driver
        .startRaw({
          idempotencyKey: "session-conflict",
          requestHash: hex("session-conflict-b"),
          sessionId: "study-session-conflict-b",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(conflict).toMatchObject({ reason: "idempotency-conflict" });
    });
  }, 60_000);
});
