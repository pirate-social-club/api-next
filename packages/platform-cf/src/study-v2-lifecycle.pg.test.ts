import { describe, expect, test } from "bun:test";
import {
  emptyTelegramStudyState,
  TelegramStudyLeaseExpired,
} from "@pirate/application/telegram-study";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";
import { defaultStudySpokenEvidence } from "./study-v2-spoken-test-evidence.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";
import { telegramStudyAdmission } from "./telegram-study-admission.ts";
import { makeTelegramStudyStore } from "./telegram-study-store.ts";

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
  for (const practiceOnly of [false, true])
    test(`requeues a missed spoken card, keeps reload continuity and reward isolation (Telegram practice: ${practiceOnly})`, async () => {
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

        const runtime = makeDirectPostgresControlPlaneLayer(scoped);
        const grant = { accountId: "study-account", personaId: "study-persona", revision: 1 };
        const lease = {
          sender: {
            communityId: "study-community",
            botId: "123",
            epoch: "epoch",
            telegramUserId: "321",
          },
          token: "lease",
          state: emptyTelegramStudyState(),
        };
        if (practiceOnly) {
          await admin.query("SET session_replication_role=replica");
          try {
            await admin.query(
              `INSERT INTO study_language_profiles(community_id,post_id,lyrics_revision,language_profile_revision,source_hash,provider_id,provider_model,prompt_revision,validator_revision,request_hash,accepted_at) VALUES('study-community','study-post',1,1,$1,'fixture','fixture','fixture','fixture',$1,clock_timestamp())`,
              ["a".repeat(64)],
            );
            for (let ordinal = 1; ordinal <= 4; ordinal++)
              await admin.query(
                `INSERT INTO study_language_profile_units(community_id,post_id,lyrics_revision,language_profile_revision,study_unit_id,detected_languages,dominant_language,mixed,vocable_only,proper_name_only,confidence) VALUES('study-community','study-post',1,1,$1,'["en"]'::jsonb,'en',FALSE,FALSE,FALSE,0.99)`,
                [`unit-${ordinal}`],
              );
            for (const slot of ["instrumental_audio", "vocal_audio"])
              await admin.query(
                `INSERT INTO media_song_stems(submission_id,slot,community_id,actor_user_id,operation_id,reservation_id,immutable_ref,destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id) VALUES('study-submission',$1,'study-community','study-account','study-operation',$1,'sealed-ref-'||$1,'sealed-destination-'||$1,'etag','version',1024,'audio/mpeg',$2,'study-persona')`,
                [slot, "b".repeat(64)],
              );
          } finally {
            await admin.query("SET session_replication_role=origin");
          }
          const catalogue = makeTelegramStudyStore(
            makeTelegramDatabase(runtime),
            "study-community",
            ["study-post"],
          );
          expect(await catalogue.catalogue("another-community")).toEqual([]);
          expect(await catalogue.ready("study-community", "study-post")).toBe(true);
          // Remove fixture content with triggers suspended, then read through the real readiness query.
          await admin.query("SET session_replication_role=replica");
          try {
            await admin.query("DELETE FROM media_song_stems WHERE slot='vocal_audio'");
          } finally {
            await admin.query("SET session_replication_role=origin");
          }
          expect(await catalogue.ready("study-community", "study-post")).toBe(false);
          await admin.query("SET session_replication_role=replica");
          try {
            await admin.query(
              `INSERT INTO media_song_stems(submission_id,slot,community_id,actor_user_id,operation_id,reservation_id,immutable_ref,destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id) SELECT submission_id,'vocal_audio',community_id,actor_user_id,operation_id,'vocal_audio',immutable_ref||'-vocal',destination_ref||'-vocal',etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id FROM media_song_stems WHERE slot='instrumental_audio'`,
            );
          } finally {
            await admin.query("SET session_replication_role=origin");
          }
          const record = {
            ...emptyTelegramIntegration("study-community"),
            botEpoch: "epoch",
            botId: "123",
            botUsername: "fixture_bot",
            status: "ready",
          };
          await admin.query(
            `INSERT INTO community_telegram_integrations(community_id,record,revision,bot_epoch,webhook_id) VALUES('study-community',$1::jsonb,1,'epoch','hook')`,
            [JSON.stringify(record)],
          );
          await admin.query(
            `INSERT INTO community_telegram_private_chats(community_id,bot_epoch,telegram_user_id) VALUES('study-community','epoch','321')`,
          );
          await admin.query(
            `INSERT INTO telegram_account_associations(telegram_user_id,account_id) VALUES('321','study-account')`,
          );
          await admin.query(
            `INSERT INTO telegram_bot_grants(community_id,bot_id,telegram_user_id,account_id,persona_id,revision) VALUES('study-community','123','321','study-account','study-persona',1)`,
          );
          await admin.query(
            `INSERT INTO telegram_study_conversations(community_id,bot_id,telegram_user_id,bot_epoch,state,lease_token,lease_until) VALUES('study-community','123','321','epoch',$1::jsonb,'lease',clock_timestamp()+interval '120 seconds')`,
            [JSON.stringify(emptyTelegramStudyState())],
          );
        }
        const study = makeControlPlaneStudyV2Repository(
          practiceOnly ? telegramStudyAdmission(lease, grant, ["study-post"]) : undefined,
        );
        const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
          Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
        const session = await run(
          study.startSession({
            accountId: "study-account",
            communityId: "study-community",
            createdAt: practiceOnly ? new Date().toISOString() : "2026-09-12T12:00:00.000Z",
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
        expect(session.lesson.current?.session_item_id).toBe(
          session.items[0]?.session_item_id ?? "",
        );

        if (practiceOnly) {
          expect(
            (
              await admin.query(
                "SELECT telegram_practice_only FROM study_sessions_v2 WHERE session_id=$1",
                [session.session_id],
              )
            ).rows,
          ).toEqual([{ telegram_practice_only: true }]);
          await expect(
            admin.query(
              "UPDATE study_sessions_v2 SET telegram_practice_only=FALSE WHERE session_id=$1",
              [session.session_id],
            ),
          ).rejects.toMatchObject({ code: "23514" });
          await admin.query("UPDATE telegram_bot_grants SET active=FALSE,revision=2");
          await expect(
            run(
              study.getSession({
                accountId: "study-account",
                communityId: "study-community",
                sessionId: session.session_id,
              }),
            ),
          ).rejects.toMatchObject({ reason: "not-found" });
          await admin.query("UPDATE telegram_bot_grants SET active=TRUE,revision=3");
          await expect(
            run(
              study.getSession({
                accountId: "study-account",
                communityId: "study-community",
                sessionId: session.session_id,
              }),
            ),
          ).rejects.toMatchObject({ reason: "not-found" });
          // Fixture restoration only: the runtime never rolls consent revisions back.
          await admin.query("UPDATE telegram_bot_grants SET revision=1");
        }
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
          const writer =
            practiceOnly && attemptNumber === 2 ? makeControlPlaneStudyV2Repository() : study;
          const completion = writer.completeSpokenAnswer({
            ...defaultStudySpokenEvidence,
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
          });
          if (practiceOnly && commandCounterNow === 1) {
            await admin.query("UPDATE telegram_bot_grants SET active=FALSE,revision=2");
            await expect(run(completion)).rejects.toMatchObject({ reason: "not-found" });
            expect((await admin.query("SELECT * FROM study_attempts_v2")).rows).toHaveLength(0);
            // Fixture restores consent so the same reserved command can exercise completion.
            await admin.query("UPDATE telegram_bot_grants SET active=TRUE,revision=1");
          }
          const result = await run(completion);
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

        if (practiceOnly) {
          expect(
            (
              await admin.query("SELECT * FROM activity_qualifications WHERE study_session_id=$1", [
                session.session_id,
              ])
            ).rows,
          ).toHaveLength(0);
          expect((await admin.query("SELECT * FROM megapot_pool_shares")).rows).toHaveLength(0);
          // Browser continuation uses the persisted practice marker too.
          const browserRead = await run(
            makeControlPlaneStudyV2Repository().getSession({
              accountId: "study-account",
              communityId: "study-community",
              sessionId: session.session_id,
            }),
          );
          expect(browserRead?.status).toBe("completed");
          await expect(
            admin.query(
              `INSERT INTO activity_qualifications(qualification_id,account_id,persona_id,community_id,post_id,audio_revision,activity_key,study_session_id,score_bps,qualification_policy_version_id,qualified_at,streak_day,evidence_summary) VALUES('forged','study-account','study-persona','study-community','study-post',1,'study',$1,10000,'study-v2',clock_timestamp(),current_date,'{}'::jsonb)`,
              [session.session_id],
            ),
          ).rejects.toMatchObject({
            code: "23514",
            message: "Telegram practice cannot create reward qualification",
          });
        }
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
        if (practiceOnly) {
          const read = () =>
            run(
              study.getSession({
                accountId: grant.accountId,
                communityId: lease.sender.communityId,
                sessionId: session.session_id,
              }),
            );
          await admin.query(
            "UPDATE telegram_study_conversations SET lease_until=clock_timestamp()-interval '1 second'",
          );
          await expect(read()).rejects.toBeInstanceOf(TelegramStudyLeaseExpired);
          // Genuine revocation takes precedence over lease expiry and still refuses authority.
          await admin.query("UPDATE telegram_bot_grants SET active=FALSE");
          try {
            await read();
            throw Error("Revoked grant admitted");
          } catch (error) {
            expect(error).not.toBeInstanceOf(TelegramStudyLeaseExpired);
            expect(error).toMatchObject({ reason: "not-found" });
          }
          await admin.query("UPDATE telegram_bot_grants SET active=TRUE");
          await admin.query(
            "UPDATE telegram_study_conversations SET lease_until=clock_timestamp()+interval '120 seconds'",
          );
          expect((await read())?.session_id).toBe(session.session_id);
        }
        if (practiceOnly) {
          const chat = makeTelegramStudyStore(makeTelegramDatabase(runtime), "study-community", [
            "study-post",
          ]);
          await admin.query(
            "UPDATE telegram_study_conversations SET lease_token=NULL,lease_until=NULL",
          );
          const held = await chat.claim(lease.sender, "second-lease");
          expect(held).not.toBeNull();
          expect(await chat.claim(lease.sender, "concurrent-lease")).toBeNull();
          if (!held) throw Error("Missing held lease");
          await chat.save(held, {
            ...held.state,
            selectedPostId: "study-post",
            selectedUntil: Date.now() + 15 * 60 * 1000,
          });
          await chat.release(held);
          await admin.query(
            "UPDATE telegram_study_conversations SET updated_at=clock_timestamp()-interval '25 hours'",
          );
          await chat.cleanup();
          expect(
            (await admin.query("SELECT state FROM telegram_study_conversations")).rows,
          ).toEqual([{ state: emptyTelegramStudyState() }]);
        }
      } finally {
        await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
        await admin.end();
      }
    }, 60_000);
});
