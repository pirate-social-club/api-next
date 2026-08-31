import { describe, expect, test } from "bun:test";
import {
  STUDY_LANGUAGE_PROFILE_PROMPT_V2,
  STUDY_LANGUAGE_PROFILE_VALIDATOR_V2,
  STUDY_TRANSLATION_GENERATOR_POLICY_V1,
  STUDY_TRANSLATION_PROMPT_V2,
  validateStudyTranslationProposal,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyLanguageProfileRepository } from "./study-language-profile-repository.ts";
import {
  makeControlPlaneStudyTranslationPolicyResolver,
  makeControlPlaneStudyTranslationRepository,
} from "./study-translation-repository.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";

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

suite("Study translation generation", () => {
  test("gates exact authority, materializes private choices, and delivers them through Study v2", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_study_translation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      const lines = [
        "City lights are rising",
        "We keep moving forward",
        "Hold the rhythm closer",
        "Sing the night together",
      ];
      const lyrics = lines.join("\n");
      const lyricsHash = await digest(lyrics);
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
        await admin.query(
          `INSERT INTO community_memberships (
               community_id, membership_id, user_id, status, joined_at, created_at, updated_at
             ) VALUES ('study-community','study-membership','study-account','member',
               clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO personas (persona_id, account_id, status, created_at)
             VALUES ('study-persona', 'study-account', 'active', clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO posts (
               community_id, post_id, post_type, status, visibility, created_at, updated_at
             ) VALUES ('study-community', 'study-post', 'song', 'published', 'public',
               clock_timestamp(), clock_timestamp())`,
        );
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
          `INSERT INTO media_song_lyrics_revisions (
               submission_id, community_id, actor_user_id, author_persona_id, operation_id,
               lyrics_revision, creation_revision, audio_revision, canonical_audio_sha256,
               lyrics_text, lyrics_sha256, provenance
             ) VALUES ('study-submission','study-community','study-account','study-persona',
               'study-operation',1,2,1,$1,$2,$3,'pasted')`,
          ["2".repeat(64), lyrics, lyricsHash],
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
        }
        await expect(
          admin.query(
            `INSERT INTO study_translation_quality_policies (
                 target_language, quality_policy_revision, release_state, corpus_sample_count,
                 source_binding_bps, meaning_preservation_bps, bilingual_rubric_bps,
                 critical_defect_count, accepted_at
               ) VALUES ('es','study-translation-quality-missing-evidence','active',100,
                 10000,10000,9500,0,clock_timestamp())`,
          ),
        ).rejects.toThrow();
        await admin.query(
          `INSERT INTO study_translation_quality_policies (
               target_language, quality_policy_revision, release_state, corpus_sample_count,
               source_binding_bps, meaning_preservation_bps, bilingual_rubric_bps,
               critical_defect_count, corpus_revision, reviewed_file_sha256,
               reviewer_role, evaluator_revision, accepted_at
             ) VALUES ('es','study-translation-quality-es-v1','active',100,10000,10000,9500,0,
               'study-translation-corpus-es-b1-v1',repeat('f',64),'bilingual_reviewer',
               'study_translation_corpus_evaluator_v1',clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO study_translation_quality_registry (
               target_language, quality_policy_revision, selected_at, selected_by
             ) VALUES ('es','study-translation-quality-es-v1',clock_timestamp(),
               'study-quality-review-v1')`,
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const policy = await Effect.runPromise(
        Effect.scoped(
          makeControlPlaneStudyTranslationPolicyResolver(runtime).resolve({
            targetLanguage: "es",
          }),
        ),
      );
      expect(policy).toEqual({
        generatorPolicyRevision: STUDY_TRANSLATION_GENERATOR_POLICY_V1,
        promptRevision: STUDY_TRANSLATION_PROMPT_V2,
        qualityPolicyRevision: "study-translation-quality-es-v1",
      });
      const profiles = makeControlPlaneStudyLanguageProfileRepository();
      const profileResolution = await Effect.runPromise(
        Effect.scoped(
          profiles
            .resolve({ communityId: "study-community", postId: "study-post" })
            .pipe(Effect.provide(runtime)),
        ),
      );
      if (profileResolution.state !== "generate") throw new Error("expected profile generation");
      expect(profileResolution.request.units.map(({ sourceText }) => sourceText)).toEqual(lines);
      expect(profileResolution.request.contextLines.map(({ sourceText }) => sourceText)).toEqual(
        lines,
      );
      const profileOutcome = await Effect.runPromise(
        Effect.scoped(
          profiles
            .accept({
              request: profileResolution.request,
              analysis: {
                providerId: "fake-language-profile",
                providerModel: "fake-model",
                promptRevision: STUDY_LANGUAGE_PROFILE_PROMPT_V2,
                validatorRevision: STUDY_LANGUAGE_PROFILE_VALIDATOR_V2,
                units: profileResolution.request.units.map((unit) => ({
                  studyUnitId: unit.studyUnitId,
                  detectedLanguages: ["en"],
                  dominantLanguage: "en",
                  mixed: false,
                  vocableOnly: false,
                  properNameOnly: false,
                  confidence: 0.99,
                })),
              },
              acceptedAt: "2026-08-29T11:59:00.000Z",
            })
            .pipe(Effect.provide(runtime)),
        ),
      );
      expect(profileOutcome.languageProfileRevision).toBe(1);
      const profileReplay = await Effect.runPromise(
        Effect.scoped(
          profiles
            .resolve({ communityId: "study-community", postId: "study-post" })
            .pipe(Effect.provide(runtime)),
        ),
      );
      expect(profileReplay).toEqual({ state: "ready", outcome: profileOutcome });

      const repository = makeControlPlaneStudyTranslationRepository();
      await expect(
        Effect.runPromise(
          Effect.scoped(
            repository
              .reserve({
                communityId: "study-community",
                postId: "study-post",
                targetLanguage: "es",
                learnerBand: "B1",
                generatorPolicyRevision: STUDY_TRANSLATION_GENERATOR_POLICY_V1,
                promptRevision: STUDY_TRANSLATION_PROMPT_V2,
                qualityPolicyRevision: "study-translation-quality-es-v2",
                generationRunId: "translation-run-policy-mismatch",
                leaseToken: "translation-lease-policy-mismatch",
                requestedAt: "2026-08-29T12:00:00.000Z",
                leaseExpiresAt: "2026-08-29T12:06:00.000Z",
              })
              .pipe(Effect.provide(runtime)),
          ),
        ),
      ).rejects.toMatchObject({ reason: "policy-blocked" });
      const reservation = await Effect.runPromise(
        Effect.scoped(
          repository
            .reserve({
              communityId: "study-community",
              postId: "study-post",
              targetLanguage: "es",
              learnerBand: "B1",
              generatorPolicyRevision: STUDY_TRANSLATION_GENERATOR_POLICY_V1,
              promptRevision: STUDY_TRANSLATION_PROMPT_V2,
              qualityPolicyRevision: "study-translation-quality-es-v1",
              generationRunId: "translation-run-1",
              leaseToken: "translation-lease-1",
              requestedAt: "2026-08-29T12:00:00.000Z",
              leaseExpiresAt: "2026-08-29T12:05:00.000Z",
            })
            .pipe(Effect.provide(runtime)),
        ),
      );
      if (reservation.state !== "leased") throw new Error("expected leased generation");
      expect(reservation.request.units.map(({ sourceText }) => sourceText)).toEqual(lines);
      expect(reservation.request.contextLines.map(({ sourceText }) => sourceText)).toEqual(lines);
      const rawProposal = {
        generation_run_id: "translation-run-1",
        provider_id: "fake-study-translator",
        provider_model: "fake-model-v1",
        prompt_revision: STUDY_TRANSLATION_PROMPT_V2,
        units: reservation.request.units.map((unit, index) => ({
          status: "ready" as const,
          study_unit_id: unit.studyUnitId,
          lyric_line_id: unit.lyricLineId,
          line_version: unit.lineVersion,
          source_hash: unit.sourceHash,
          source_text: unit.sourceText,
          target_language: "es",
          learner_band: "B1" as const,
          detected_languages: ["en"],
          dominant_language: "en",
          mixed: false,
          vocable_only: false,
          proper_name_only: false,
          question: "¿Qué significa esta línea?",
          translation: `Traducción correcta número ${index + 1}`,
          distractors: [
            `Distractor norte ${index + 1}`,
            `Distractor sur ${index + 1}`,
            `Distractor oeste ${index + 1}`,
          ] as const,
          explanation: `Explicación breve número ${index + 1}`,
          whole_line_translated: true,
          preserved_source_fragments: [],
        })),
      };
      const proposal = await Effect.runPromise(
        validateStudyTranslationProposal(reservation.request, rawProposal),
      );
      const completed = await Effect.runPromise(
        Effect.scoped(
          repository
            .complete({
              request: reservation.request,
              proposal,
              leaseToken: "translation-lease-1",
              acceptedAt: "2026-08-29T12:01:00.000Z",
            })
            .pipe(Effect.provide(runtime)),
        ),
      );
      expect(completed).toMatchObject({ status: "succeeded", readyCount: 4 });
      const persisted = await admin.query<{
        runs: string;
        items: string;
        translations: string;
        exercises: string;
      }>(
        `SELECT
             (SELECT count(*)::text FROM study_translation_generation_runs
               WHERE status='succeeded') AS runs,
             (SELECT count(*)::text FROM study_translation_generation_items
               WHERE status='ready') AS items,
             (SELECT count(*)::text FROM localization_translation_versions
               WHERE generation_run_id='translation-run-1') AS translations,
             (SELECT count(*)::text FROM study_exercise_versions
               WHERE generation_run_id='translation-run-1') AS exercises`,
      );
      expect(persisted.rows).toEqual([
        { runs: "1", items: "4", translations: "4", exercises: "4" },
      ]);

      const study = makeControlPlaneStudyV2Repository();
      const session = await Effect.runPromise(
        Effect.scoped(
          study
            .startSession({
              accountId: "study-account",
              communityId: "study-community",
              createdAt: "2026-08-29T12:02:00.000Z",
              targetLanguage: "es",
              idempotencyKey: "study-session-command",
              learnerBand: "B1",
              personaId: "study-persona",
              postId: "study-post",
              requestHash: "5".repeat(64),
              sessionId: "study-session-translation",
              timezone: "UTC",
            })
            .pipe(Effect.provide(runtime)),
        ),
      );
      expect(session.items).toHaveLength(4);
      for (const item of session.items) {
        expect(item.exercise_type).toBe("translation_choice");
        expect(JSON.stringify(item)).not.toContain("correct_choice_key");
      }
      const firstItemId = session.lesson.current?.session_item_id;
      if (firstItemId === undefined) throw new Error("expected a current lesson item");
      const firstItem = session.items.find(
        ({ session_item_id }) => session_item_id === firstItemId,
      );
      if (firstItem?.presentation.kind !== "translation_choice") {
        throw new Error("expected a translation presentation");
      }
      const firstGrader = await admin.query<{ correct_choice_key: string }>(
        `SELECT exercise.private_grader->>'correct_choice_key' AS correct_choice_key
             FROM study_session_items_v2 item
             JOIN study_exercise_versions exercise
               ON exercise.exercise_version_id=item.exercise_version_id
            WHERE item.session_item_id=$1`,
        [firstItemId],
      );
      const firstCorrectChoice = firstGrader.rows[0]?.correct_choice_key;
      const wrongChoice = firstItem.presentation.choices.find(
        ({ choice_key }) => choice_key !== firstCorrectChoice,
      )?.choice_key;
      if (wrongChoice === undefined) throw new Error("expected a wrong public choice");
      const firstMiss = await Effect.runPromise(
        Effect.scoped(
          study
            .submitAnswer({
              accountId: "study-account",
              acceptedAt: "2026-08-29T12:03:00.000Z",
              answer: { kind: "single_select", choice_key: wrongChoice },
              attemptId: "translation-attempt-1",
              attemptNumber: 1,
              communityId: "study-community",
              idempotencyKey: "translation-answer-1",
              qualificationId: "translation-qualification-1",
              requestHash: "6".repeat(64),
              sessionId: session.session_id,
              sessionItemId: firstItemId,
            })
            .pipe(Effect.provide(runtime)),
        ),
      );
      expect(firstMiss).toMatchObject({
        outcome: "incorrect",
        first_pass: true,
        attempt_state: "retryable",
        feedback: { kind: "none" },
      });
      expect(firstMiss.session.lesson.current?.session_item_id).not.toBe(firstItemId);

      let currentSession = firstMiss.session;
      const requestHashes = ["7", "8", "9", "a"];
      let answerIndex = 0;
      while (currentSession.status === "active") {
        const currentItemId = currentSession.lesson.current?.session_item_id;
        if (currentItemId === undefined) throw new Error("expected a current lesson item");
        const grader = await admin.query<{ correct_choice_key: string }>(
          `SELECT exercise.private_grader->>'correct_choice_key' AS correct_choice_key
               FROM study_session_items_v2 item
               JOIN study_exercise_versions exercise
                 ON exercise.exercise_version_id=item.exercise_version_id
              WHERE item.session_item_id=$1`,
          [currentItemId],
        );
        const correctChoiceKey = grader.rows[0]?.correct_choice_key;
        if (correctChoiceKey === undefined) throw new Error("expected a private answer key");
        const answer = await Effect.runPromise(
          Effect.scoped(
            study
              .submitAnswer({
                accountId: "study-account",
                acceptedAt: `2026-08-29T12:0${answerIndex + 4}:00.000Z`,
                answer: { kind: "single_select", choice_key: correctChoiceKey },
                attemptId: `translation-attempt-${answerIndex + 2}`,
                attemptNumber: currentSession.lesson.current?.presentation_number ?? 1,
                communityId: "study-community",
                idempotencyKey: `translation-answer-${answerIndex + 2}`,
                qualificationId: "translation-qualification-1",
                requestHash: (requestHashes[answerIndex] ?? "f").repeat(64),
                sessionId: session.session_id,
                sessionItemId: currentItemId,
              })
              .pipe(Effect.provide(runtime)),
          ),
        );
        expect(answer).toMatchObject({
          outcome: "correct",
          attempt_state: "spent",
        });
        currentSession = answer.session;
        answerIndex += 1;
        if (answerIndex > 4) throw new Error("lesson did not terminate within its expected queue");
      }
      expect(currentSession).toMatchObject({
        status: "completed",
        progress: {
          qualifying_exercise_count: 4,
          answered_exercise_count: 4,
          first_pass_correct: 3,
          score_bps: 7_500,
        },
        lesson: { resolved_card_count: 4, completion_reason: "all_resolved" },
      });
      const qualification = await admin.query<{
        qualifications: string;
        streak_days: string;
        persona_presentations: string;
      }>(
        `SELECT
             (SELECT count(*)::text FROM activity_qualifications
               WHERE account_id='study-account' AND post_id='study-post'
                 AND activity_key='study') AS qualifications,
             (SELECT count(*)::text FROM song_streak_days
               WHERE account_id='study-account' AND post_id='study-post') AS streak_days,
             (SELECT count(*)::text FROM persona_activity_presentations
               WHERE persona_id='study-persona') AS persona_presentations`,
      );
      expect(qualification.rows).toEqual([
        { qualifications: "1", streak_days: "1", persona_presentations: "1" },
      ]);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 60_000);
});
