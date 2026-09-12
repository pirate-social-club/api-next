import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
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

suite("Study v2 spoken lifecycle", () => {
  test("requeues a missed spoken card, keeps reload presentation continuity, and replays completed commands", {
    timeout: 60_000,
  }, async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_study_lifecycle_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
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

      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const study = makeControlPlaneStudyV2Repository();
      const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
        Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
      const session = await run(
        study.startSession({
          accountId: "study-account",
          communityId: "study-community",
          createdAt: "2026-09-12T12:00:00.000Z",
          targetLanguage: null,
          idempotencyKey: "study-session-command",
          learnerBand: null,
          personaId: "study-persona",
          postId: "study-post",
          requestHash: "5".repeat(64),
          sessionId: "study-session-lifecycle",
          timezone: "UTC",
        }),
      );
      expect(session.items).toHaveLength(4);
      expect(session.lesson.current?.session_item_id).toBe(session.items[0]?.session_item_id ?? "");

      let commandCounter = 0;
      const answerSpoken = async (
        sessionItemId: string,
        attemptNumber: number,
        correct: boolean,
      ) => {
        commandCounter += 1;
        const commandCounterNow = commandCounter;
        const keys = {
          audioDigest: `${commandCounterNow}`.repeat(64),
          idempotencyKey: `study-spoken-command-${commandCounterNow}`,
          requestHash: `${commandCounterNow}`.repeat(64),
        };
        const context = await run(
          study.loadSpokenAnswerContext({
            accountId: "study-account",
            communityId: "study-community",
            idempotencyKey: keys.idempotencyKey,
            sessionId: session.session_id,
            sessionItemId,
          }),
        );
        expect(context.item.exercise_type).toBe("say_it_back");
        const reservation = await run(
          study.reserveSpokenAnswer({
            accountId: "study-account",
            attemptNumber,
            audioByteSize: 100,
            audioContentType: "audio/webm",
            audioDigest: keys.audioDigest,
            audioDurationMs: 1000,
            attemptId: `study-attempt-${commandCounterNow}`,
            artifactId: `study-artifact-${commandCounterNow}`,
            commandId: `study-command-${commandCounterNow}`,
            idempotencyKey: keys.idempotencyKey,
            leaseToken: `study-lease-${commandCounterNow}`,
            providerRetention: "stored",
            requestHash: keys.requestHash,
            sessionId: session.session_id,
            sessionItemId,
          }),
        );
        if (reservation.state === "completed") {
          return { keys, reservation, result: reservation.result };
        }
        const result = await run(
          study.completeSpokenAnswer({
            accountId: "study-account",
            acceptedAt: `2026-09-12T12:0${commandCounterNow}:00.000Z`,
            archive: {
              state: "stored",
              objectRef: `learner-audio/study/study-attempt-${commandCounterNow}/${keys.audioDigest}`,
            },
            artifactId: reservation.artifactId,
            attemptId: reservation.attemptId,
            attemptNumber,
            audioByteSize: 100,
            audioContentType: "audio/webm",
            audioDigest: keys.audioDigest,
            audioDurationMs: 1000,
            commandId: reservation.commandId,
            leaseToken: reservation.leaseToken,
            communityId: "study-community",
            grade: {
              correct,
              matchKind: correct ? "exact" : "none",
              heardTranscript: correct ? (lines[0] ?? "") : "unrecognized murmur",
              matched: [],
              missing: [],
              extra: [],
              substituted: [],
              policyRevision: "script_aware_token_phonetic_v2",
            },
            providerDetectedLanguage: "en",
            providerDetectedLanguageConfidence: 0.99,
            qualificationId: `study-qualification-${commandCounterNow}`,
            requestHash: keys.requestHash,
            sessionId: session.session_id,
            sessionItemId,
          }),
        );
        return { keys, reservation, result };
      };

      const itemId = (index: number) => session.items[index]?.session_item_id ?? "";

      const miss = await answerSpoken(itemId(0), 1, false);
      expect(miss.reservation.state).toBe("reserved");
      expect(miss.result).toMatchObject({
        attempt_number: 1,
        attempt_state: "spent",
        outcome: "incorrect",
      });
      expect(miss.result.session.lesson.current?.session_item_id).toBe(itemId(1));
      expect(miss.result.session.lesson.resolved_card_count).toBe(0);

      const reloaded = await run(
        study.getSession({
          accountId: "study-account",
          communityId: "study-community",
          sessionId: session.session_id,
        }),
      );
      expect(reloaded?.lesson.current).toMatchObject({
        session_item_id: itemId(1),
        presentation_number: 1,
        is_reappearance: false,
      });

      for (const index of [1, 2, 3]) {
        const answered = await answerSpoken(itemId(index), 1, true);
        expect(answered.result).toMatchObject({ outcome: "correct", attempt_state: "spent" });
        expect(answered.result.session.lesson.resolved_card_count).toBe(index);
      }
      const afterUnseen = await run(
        study.getSession({
          accountId: "study-account",
          communityId: "study-community",
          sessionId: session.session_id,
        }),
      );
      expect(afterUnseen?.lesson.current).toMatchObject({
        session_item_id: itemId(0),
        presentation_number: 2,
        is_reappearance: true,
      });

      const replayReserve = () =>
        run(
          study.reserveSpokenAnswer({
            accountId: "study-account",
            attemptNumber: 1,
            audioByteSize: 100,
            audioContentType: "audio/webm",
            audioDigest: miss.keys.audioDigest,
            audioDurationMs: 1000,
            attemptId: "study-attempt-replay",
            artifactId: "study-artifact-replay",
            commandId: "study-command-replay",
            idempotencyKey: miss.keys.idempotencyKey,
            leaseToken: "study-lease-replay",
            providerRetention: "stored",
            requestHash: miss.keys.requestHash,
            sessionId: session.session_id,
            sessionItemId: itemId(0),
          }),
        );

      await run(
        study.loadSpokenAnswerContext({
          accountId: "study-account",
          communityId: "study-community",
          idempotencyKey: miss.keys.idempotencyKey,
          sessionId: session.session_id,
          sessionItemId: itemId(0),
        }),
      );
      const replayAfterAdvancement = await replayReserve();
      expect(replayAfterAdvancement).toMatchObject({
        state: "completed",
        result: {
          attempt_number: 1,
          attempt_state: "spent",
          outcome: "incorrect",
        },
      });

      await expect(
        run(
          study.loadSpokenAnswerContext({
            accountId: "study-account",
            communityId: "study-community",
            idempotencyKey: "study-spoken-command-unknown",
            sessionId: session.session_id,
            sessionItemId: itemId(1),
          }),
        ),
      ).rejects.toMatchObject({ reason: "not-found" });

      const final = await answerSpoken(itemId(0), 2, true);
      expect(final.reservation.state).toBe("reserved");
      expect(final.result).toMatchObject({ outcome: "correct", attempt_state: "spent" });
      expect(final.result.session).toMatchObject({
        status: "completed",
        lesson: { resolved_card_count: 4, completion_reason: "all_resolved" },
      });

      const replayAfterCompletion = await replayReserve();
      expect(replayAfterCompletion).toMatchObject({
        state: "completed",
        result: {
          attempt_number: 1,
          outcome: "incorrect",
        },
      });

      await expect(
        run(
          study.reserveSpokenAnswer({
            accountId: "study-account",
            attemptNumber: 1,
            audioByteSize: 100,
            audioContentType: "audio/webm",
            audioDigest: "f".repeat(64),
            audioDurationMs: 1000,
            attemptId: "study-attempt-conflict",
            artifactId: "study-artifact-conflict",
            commandId: "study-command-conflict",
            idempotencyKey: miss.keys.idempotencyKey,
            leaseToken: "study-lease-conflict",
            providerRetention: "stored",
            requestHash: miss.keys.requestHash,
            sessionId: session.session_id,
            sessionItemId: itemId(0),
          }),
        ),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
