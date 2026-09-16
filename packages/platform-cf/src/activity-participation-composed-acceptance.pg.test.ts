/**
 * Composed never-joined acceptance regressions for the accepted happy-path
 * candidate (API 2133c423). Local integration proofs only: wallet attestations
 * and speech grades are deterministic fixtures, not live Privy, provider or
 * funding evidence. The suite composes explicit activity-persona preparation,
 * the ordinary wallet confirmation, Study v2 and Karaoke completion, and the
 * independent monetary admission guards on one fixture song with accepted
 * lyrics, exercises and a ready timed-lyrics alignment. The M1 instrumental
 * song cannot satisfy these checks.
 */
import { describe, expect, test } from "bun:test";
import {
  aggregateKaraokeSession,
  buildKaraokeScoringDiagnostics,
  confirmPersonaEvmWallet,
  type KaraokeLineScore,
  prepareActivityPersona,
} from "@pirate/application";
import {
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import {
  makeControlPlanePersonaStore,
  makeControlPlanePersonaWalletStore,
} from "./persona-repository.ts";
import type { ControlPlaneDb } from "./postgres.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const COMMUNITY_ID = "composed-community";
const POST_ID = "composed-post";
const AUTHOR_ID = "composed-author";
const AUTHOR_PERSONA_ID = "composed-author-persona";
const SUBMISSION_ID = "composed-submission";
const OPERATION_ID = "composed-operation";
const AUDIO_REVISION = 1;
const LYRICS_REVISION = 1;
const CANONICAL_AUDIO_SHA256 = "a".repeat(64);

/** Five lines: four Study say-it-back cards and a fifth qualifying Karaoke line. */
const LYRIC_LINES = [
  "Hold the line",
  "Sing it back",
  "Keep the rhythm",
  "Move with me",
  "Shine tonight",
] as const;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};
const digest = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );

type Runtime = ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
type StudyRepository = ReturnType<typeof makeControlPlaneStudyV2Repository>;
type KaraokeRepository = ReturnType<typeof makeControlPlaneKaraokeRepository>;

const run = <A, E>(runtime: Runtime, effect: Effect.Effect<A, E, ControlPlaneDb>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));

const addressFor = async (value: string): Promise<string> =>
  `0x${(await digest(value)).slice(0, 40)}`;

async function seedActivitySong(admin: Client): Promise<void> {
  const lyrics = LYRIC_LINES.join("\n");
  const lineHashes = await Promise.all(LYRIC_LINES.map((line) => digest(line)));
  await admin.query("INSERT INTO users (user_id) VALUES ($1)", [AUTHOR_ID]);
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1,'Composed practice','active',$2,clock_timestamp(),clock_timestamp())`,
    [COMMUNITY_ID, AUTHOR_ID],
  );
  await admin.query(
    `INSERT INTO personas (
       persona_id, account_id, status, is_first_persona, created_at, retired_at
     ) VALUES ($1,$2,'active',true,clock_timestamp(),NULL)`,
    [AUTHOR_PERSONA_ID, AUTHOR_ID],
  );
  await admin.query(
    `INSERT INTO persona_community_bindings (
       persona_id, account_id, community_id, binding_source
     ) VALUES ($1,$2,$3,'community_creation')`,
    [AUTHOR_PERSONA_ID, AUTHOR_ID, COMMUNITY_ID],
  );
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'song','published','public','Composed song',
       clock_timestamp(),clock_timestamp())`,
    [COMMUNITY_ID, POST_ID, AUTHOR_ID, AUTHOR_PERSONA_ID],
  );
  await admin.query("UPDATE posts SET content_rating='general' WHERE post_id=$1", [POST_ID]);
  await admin.query(
    `INSERT INTO media_post_submissions (
       submission_id, community_id, actor_user_id, operation_id, idempotency_key,
       request_hash, title, song_type, start_input, audio_reservation_id,
       creation_revision, audio_revision, analysis_revision, current_analysis_revision,
       current_immutable_ref, status, phase, post_id,
       response_snapshot_bytes, response_snapshot_sha256,
       author_persona_id, lyrics_revision, current_lyrics_revision
     ) VALUES ($1,$2,$3,$4,$5,$6,'Composed song','original','{}'::jsonb,
       'composed-reservation',1,$7,$7,$7,'audio-ref','published',NULL,$8,
       convert_to('snapshot','UTF8'),$9,$10,$11,$11)`,
    [
      SUBMISSION_ID,
      COMMUNITY_ID,
      AUTHOR_ID,
      OPERATION_ID,
      "composed-idempotency",
      CANONICAL_AUDIO_SHA256,
      AUDIO_REVISION,
      POST_ID,
      await digest("snapshot"),
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
    ],
  );
  await admin.query(
    `INSERT INTO media_publication_projections (
       submission_id, community_id, actor_user_id, operation_id, post_id,
       creation_revision, audio_revision, analysis_revision, decision_revision,
       canonical_audio_sha256, title, audio_asset_ref, language_status,
       primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
       locked_delivery, projected_at, author_persona_id, lyrics_status,
       lyrics_revision, lyrics_text
     ) VALUES ($1,$2,$3,$4,$5,1,$6,$6,1,$7,'Composed song','audio-ref',
       'ready','en','not_explicit','ready','registered','not_required',
       clock_timestamp(),$8,'ready',$9,$10)`,
    [
      SUBMISSION_ID,
      COMMUNITY_ID,
      AUTHOR_ID,
      OPERATION_ID,
      POST_ID,
      AUDIO_REVISION,
      CANONICAL_AUDIO_SHA256,
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
      lyrics,
    ],
  );
  for (const [index, line] of LYRIC_LINES.entries()) {
    const ordinal = index + 1;
    const lineId = `composed-line-${ordinal}`;
    const unitId = `composed-unit-${ordinal}`;
    const lineHash = lineHashes[index] ?? "";
    await admin.query(
      `INSERT INTO localization_lyric_line_occurrences (
         community_id, post_id, lyric_line_id
       ) VALUES ($1,$2,$3)`,
      [COMMUNITY_ID, POST_ID, lineId],
    );
    await admin.query(
      `INSERT INTO localization_lyric_line_versions (
         community_id, post_id, lyric_line_id, line_version, canonical_text,
         source_language, source_hash
       ) VALUES ($1,$2,$3,1,$4,'en',$5)`,
      [COMMUNITY_ID, POST_ID, lineId, line, lineHash],
    );
    await admin.query(
      `INSERT INTO localization_study_units (
         community_id, post_id, study_unit_id, identity_normalization_revision,
         normalized_source_hash
       ) VALUES ($1,$2,$3,'lyric_line_identity_normalization_v1',$4)`,
      [COMMUNITY_ID, POST_ID, unitId, lineHash],
    );
    await admin.query(
      `INSERT INTO localization_lyric_line_study_units (
         community_id, post_id, lyric_line_id, line_version, study_unit_id
       ) VALUES ($1,$2,$3,1,$4)`,
      [COMMUNITY_ID, POST_ID, lineId, unitId],
    );
    await admin.query(
      `INSERT INTO localization_lyrics_revision_lines (
         community_id, actor_user_id, post_id, submission_id, lyrics_revision,
         ordinal, lyric_line_id, line_version, source_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)`,
      [COMMUNITY_ID, AUTHOR_ID, POST_ID, SUBMISSION_ID, LYRICS_REVISION, ordinal, lineId, lineHash],
    );
  }
  for (const [index, line] of LYRIC_LINES.slice(0, 4).entries()) {
    const ordinal = index + 1;
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
       ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,
         'say_it_back','spoken-recall-v2','en',NULL,NULL,1,$9::jsonb,$10::jsonb,$11,
         'always_visible','every_graded_attempt','script_aware_token_phonetic_v2',
         'spoken-feedback-v1','deterministic',$12,'accepted-lyrics-say-it-back-v2',NULL,
         'accepted-say-it-back-v2',$13,$7,'study-source-structure-v1',
         'study-source-semantic-v1','study-source-safety-v1','study-source-quality-v1',
         'accepted-source-v1',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [
        `composed-exercise-${ordinal}`,
        COMMUNITY_ID,
        POST_ID,
        AUDIO_REVISION,
        LYRICS_REVISION,
        `composed-line-${ordinal}`,
        lineHashes[index] ?? "",
        `study-say-it-back:${POST_ID}:composed-unit-${ordinal}`,
        JSON.stringify({ kind: "say_it_back", reference_text: line, capture: "microphone_audio" }),
        JSON.stringify({
          kind: "source_token_phonetic_v2",
          reference_text: line,
          tokenizer_policy_revision: "script_aware_token_phonetic_v2",
        }),
        `composed-unit-${ordinal}`,
        `composed-run-${ordinal}`,
        await digest(`composed-exercise-${ordinal}`),
      ],
    );
  }
  let cursor = 0;
  const segments = LYRIC_LINES.flatMap((line) =>
    line.split(" ").map((word) => {
      const segment = { text: word, start_ms: cursor, end_ms: cursor + 300 };
      cursor += 350;
      return segment;
    }),
  );
  const artifact = {
    version: "media-timed-lyrics-artifact-v1",
    mode: "word",
    segments,
  };
  await admin.query(
    `INSERT INTO media_alignment_projections (
       submission_id, community_id, actor_user_id, operation_id, post_id,
       audio_revision, analysis_revision, canonical_audio_sha256, alignment_revision,
       status, current_artifact_ref, current_artifact_revision, author_persona_id,
       lyrics_revision
     ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,1,'ready','composed-artifact',1,$8,$9)`,
    [
      SUBMISSION_ID,
      COMMUNITY_ID,
      AUTHOR_ID,
      OPERATION_ID,
      POST_ID,
      AUDIO_REVISION,
      CANONICAL_AUDIO_SHA256,
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
    ],
  );
  await admin.query(
    `INSERT INTO media_timed_lyrics_artifacts (
       artifact_ref, community_id, actor_user_id, submission_id, operation_id,
       post_id, audio_revision, analysis_revision, artifact_revision,
       canonical_audio_sha256, artifact_sha256, artifact, author_persona_id,
       lyrics_revision
     ) VALUES ('composed-artifact',$1,$2,$3,$4,$5,$6,$6,1,$7,
       encode(sha256(convert_to($8::jsonb::text,'UTF8')),'hex'),$8::jsonb,$9,$10)`,
    [
      COMMUNITY_ID,
      AUTHOR_ID,
      SUBMISSION_ID,
      OPERATION_ID,
      POST_ID,
      AUDIO_REVISION,
      CANONICAL_AUDIO_SHA256,
      JSON.stringify(artifact),
      AUTHOR_PERSONA_ID,
      LYRICS_REVISION,
    ],
  );
}

async function seedVeryRewardEvidence(
  admin: Client,
  accountId: string,
  suffix: string,
): Promise<void> {
  const proofSessionId = `composed-proof-${suffix}`;
  const subjectId = `composed-subject-${suffix}`;
  const bindingEventId = `composed-binding-${suffix}`;
  const receiptId = `composed-receipt-${suffix}`;
  const bindingId = `composed-group-${suffix}`;
  const hashCharacter = "1";
  await admin.query({
    text: `INSERT INTO proof_sessions (
             proof_session_id, actor_id, intent_id, request_hash, provider_id,
             provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, method, issuer, scope_kind, issuer_rp_scope,
             issuer_rp_action_scope, request_mode, protocol_version, environment, status,
             requested_requirements, requested_claim_ids, subject_binding_intent,
             started_at, expires_at, upstream_session_ref
           ) VALUES ($1,$2,$3,$4,$5,'dynamic',$6,$7,$8,$9,'issuer_rp_scope',$10,
             NULL,'dynamic',$11,'test','pending',$12::jsonb,$13::jsonb,$15,
             clock_timestamp(),clock_timestamp() + interval '5 minutes',$14)`,
    values: [
      proofSessionId,
      accountId,
      `composed-intent-${suffix}`,
      hashCharacter.repeat(64),
      VERY_WEB_PROVIDER_ID,
      VERY_WEB_CONFIGURATION_REFERENCE,
      VERY_WEB_CONFIGURATION_VERSION,
      VERY_WEB_METHOD,
      VERY_WEB_ISSUER,
      VERY_WEB_RP_SCOPE,
      VERY_WEB_PROTOCOL_VERSION,
      JSON.stringify([{ claim_id: "credential.subject_unique" }, { claim_id: "human.personhood" }]),
      JSON.stringify(["credential.subject_unique", "human.personhood"]),
      `composed-upstream-${suffix}`,
      "establish",
    ],
  });
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO subject_keys (
               subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
               issuer_rp_action_scope, subject_digest
             ) VALUES ($1,$2,$3,'issuer_rp_scope',$4,NULL,$5)`,
      values: [
        subjectId,
        VERY_WEB_ISSUER,
        VERY_WEB_METHOD,
        VERY_WEB_RP_SCOPE,
        hashCharacter.repeat(64),
      ],
    });
    await admin.query({
      text: `INSERT INTO subject_key_binding_events (
               binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
               binding_kind, idempotency_key, bound_at, previous_binding_event_id
             ) VALUES ($1,$2,1,$3,$4,'initial',$5,clock_timestamp(),NULL)`,
      values: [bindingEventId, subjectId, accountId, proofSessionId, `composed-bind-${suffix}`],
    });
    await admin.query({
      text: `INSERT INTO evidence_receipts (
               evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
               scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
               evidence_kind, evidence_hash, receipt_metadata, observed_at, expires_at,
               provenance_kind, subject_key_id, subject_binding_event_id, subject_binding_epoch,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version
             ) VALUES ($1,$2,$3,$4,$5,$6,'issuer_rp_scope',$7,NULL,$8,'test',
               'very.web.server-verified.v1',$9,'{}'::jsonb,clock_timestamp(),
               clock_timestamp() + interval '1 day','proof_session',$10,$11,1,
               'dynamic',$12,$13)`,
      values: [
        receiptId,
        proofSessionId,
        accountId,
        VERY_WEB_PROVIDER_ID,
        VERY_WEB_ISSUER,
        VERY_WEB_METHOD,
        VERY_WEB_RP_SCOPE,
        VERY_WEB_PROTOCOL_VERSION,
        hashCharacter.repeat(64),
        subjectId,
        bindingEventId,
        VERY_WEB_CONFIGURATION_REFERENCE,
        VERY_WEB_CONFIGURATION_VERSION,
      ],
    });
    await admin.query({
      text: `INSERT INTO assertion_bindings (
               binding_group_id, user_id, binding_mode, subject_key_id,
               subject_binding_event_id, subject_binding_epoch
             ) VALUES ($1,$2,'same_subject',$3,$4,1)`,
      values: [bindingId, accountId, subjectId, bindingEventId],
    });
    await admin.query({
      text: `INSERT INTO assertions (
               assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
               claim_id, assertion_value, assurance, observed_at, expires_at
             ) VALUES
               ($1,$2,$3,$4,$5,'human.personhood','{"personhood":true}'::jsonb,
                'provider_attested',clock_timestamp(),clock_timestamp() + interval '1 day'),
               ($6,$2,$3,$4,$5,'credential.subject_unique','{"subject_unique":true}'::jsonb,
                'provider_attested',clock_timestamp(),clock_timestamp() + interval '1 day')`,
      values: [
        `composed-assertion-person-${suffix}`,
        bindingId,
        receiptId,
        subjectId,
        accountId,
        `composed-assertion-unique-${suffix}`,
      ],
    });
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status='completed',completed_at=terminal.value,
                    completion_idempotency_key=$2,completion_result_hash=$3,
                    terminal_at=terminal.value
               FROM terminal WHERE proof_session_id=$1`,
      values: [proofSessionId, `composed-complete-${suffix}`, hashCharacter.repeat(64)],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
               completion_event_id, proof_session_id, actor_id, idempotency_key,
               terminal_status, result_hash, terminal_at
             ) SELECT $2,proof_session_id,actor_id,completion_idempotency_key,
                      status,completion_result_hash,terminal_at
                 FROM proof_sessions WHERE proof_session_id=$1`,
      values: [proofSessionId, `composed-completion-${suffix}`],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function seedFundedAssetBonus(
  admin: Client,
): Promise<Readonly<{ readonly legId: string; readonly offerId: string; readonly token: string }>> {
  const suffix = "composed-bonus";
  const offerId = `offer-${suffix}`;
  const legId = `leg-${suffix}`;
  const policyVersionId = `reward-policy-${suffix}`;
  const token = `0x${"d".repeat(40)}`;
  await admin.query(
    `INSERT INTO reward_asset_whitelist (
       chain_id,token_address,decimals,symbol,asset_kind,environment,status,
       policy_version,activated_at,plain_erc20_verified_at
     ) VALUES (84532,$1,6,'BONUS','bonus_asset','staging','active',
       'bonus-v1',statement_timestamp(),statement_timestamp())`,
    [token],
  );
  await admin.query(
    `INSERT INTO reward_activity_availability_observations (
       availability_observation_id,community_id,post_id,audio_revision,activity_key,
       producer_id,producer_revision,state,study_item_count,evidence,evidence_hash,
       observed_at,expires_at
     ) VALUES ($1,$2,$3,$4,'study','study-item-source','v1','available',4,
       '{"kind":"typed_study_items","item_count":4}'::jsonb,$5,
       clock_timestamp(),clock_timestamp() + interval '2 hours')`,
    [`availability-${suffix}`, COMMUNITY_ID, POST_ID, AUDIO_REVISION, "d".repeat(64)],
  );
  await admin.query(
    `INSERT INTO reward_uniqueness_authorities (
       campaign_id,issuer,method,scope_kind,issuer_rp_scope
     ) VALUES ($1,$2,$3,'issuer_rp_scope',$4)`,
    [offerId, VERY_WEB_ISSUER, VERY_WEB_METHOD, VERY_WEB_RP_SCOPE],
  );
  await admin.query(
    `INSERT INTO policy_versions (
       policy_version_id,community_id,policy_key,revision,policy_hash,policy,
       compiled_plan,compiler_version,uniqueness_model,created_by_user_id,
       published_at,policy_purpose,uniqueness_authority_id
     ) VALUES ($1,$2,$3,1,$4,'{"version":"scarce_reward_v1"}'::jsonb,
       '{"evaluator":"scarce_reward_eligibility_v1"}'::jsonb,
       'scarce_reward_policy_v1',$5::jsonb,$6,clock_timestamp(),'reward',$7)`,
    [
      policyVersionId,
      COMMUNITY_ID,
      `song_reward_offer:${offerId}`,
      "e".repeat(64),
      JSON.stringify({ kind: "single_authority", authority_id: offerId }),
      AUTHOR_ID,
      offerId,
    ],
  );
  await admin.query(
    `INSERT INTO song_reward_offers (
       offer_id,community_id,post_id,audio_revision,created_by_account_id,status,
       starts_at,ends_at,owner_policy_snapshot,terms_hash,reward_policy_version_id
     ) VALUES ($1,$2,$3,$4,$5,'draft','2026-08-01T00:00:00.000Z',
       clock_timestamp() + interval '10 days','{"third_party_legs":"allowed"}'::jsonb,
       $6,$7)`,
    [offerId, COMMUNITY_ID, POST_ID, AUDIO_REVISION, AUTHOR_ID, "f".repeat(64), policyVersionId],
  );
  await admin.query(
    `UPDATE song_reward_offers SET status='active',activated_at=clock_timestamp(),
       updated_at=clock_timestamp() WHERE offer_id=$1`,
    [offerId],
  );
  await admin.query(
    `INSERT INTO song_reward_offer_legs (
       leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,
       participation_starts_at,chain_id,token_address,token_decimals,token_symbol,
       asset_policy_version,amount_per_claim_atomic,max_claims,funded_atomic
     ) VALUES ($1,$2,'asset_bonus','draft',$3,'refund_to_funders_pro_rata',$4,
       '2026-08-01T00:00:00.000Z',84532,$5,6,'BONUS','bonus-v1',100,2,200)`,
    [legId, offerId, AUTHOR_ID, `0x${"b".repeat(64)}`, token],
  );
  await admin.query(
    `UPDATE song_reward_offer_legs SET status='active',activated_at=clock_timestamp(),
       updated_at=clock_timestamp() WHERE leg_id=$1`,
    [legId],
  );
  return { legId, offerId, token };
}

const prepareIdentity = (runtime: Runtime) => {
  const services = {
    store: makeControlPlanePersonaStore(runtime),
    nextPersonaId: () => Effect.sync(() => `persona_${crypto.randomUUID().replaceAll("-", "")}`),
    nowIso: () => Effect.sync(() => new Date().toISOString()),
  };
  return (accountId: string, idempotencyKey: string) =>
    Effect.runPromise(
      prepareActivityPersona(
        {
          accountId,
          communityId: COMMUNITY_ID,
          body: { idempotency_key: idempotencyKey, choice: { kind: "create_new" } },
        },
        services,
      ),
    );
};

const confirmWallet = (runtime: Runtime) => {
  const store = makeControlPlanePersonaWalletStore(runtime);
  return async (accountId: string, personaId: string) =>
    Effect.runPromise(
      confirmPersonaEvmWallet(
        {
          accountId,
          personaId,
          body: {
            proof: { type: "privy_access_token", privy_access_token: "composed-fixture-token" },
          },
        },
        {
          store,
          verifier: {
            verifyPrivyEmbeddedEvmWallet: ({ hdWalletIndex }) =>
              Effect.promise(async () => ({
                address: await addressFor(`${accountId}:${personaId}`),
                hdWalletIndex,
                privyWalletId: `composed-wallet-${personaId}`,
                sourceUserId: accountId,
              })),
          },
          accounts: { canonicalAccountId: (sourceUserId) => Effect.succeed(sourceUserId) },
        },
      ),
    );
};

type SpokenCommand = Parameters<StudyRepository["completeSpokenAnswer"]>[0];

const makeStudyDriver = (runtime: Runtime, study: StudyRepository) => {
  const answerSpoken = async (input: {
    readonly accountId: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
    readonly attemptNumber: number;
    readonly correct: boolean;
    readonly commandId: string;
  }) => {
    const audioDigest = await digest(input.commandId);
    const idempotencyKey = `composed-spoken-${input.commandId}`;
    const requestHash = await digest(`composed-request-${input.commandId}`);
    await run(
      runtime,
      study.loadSpokenAnswerContext({
        accountId: input.accountId,
        communityId: COMMUNITY_ID,
        idempotencyKey,
        sessionId: input.sessionId,
        sessionItemId: input.sessionItemId,
      }),
    );
    const reservation = await run(
      runtime,
      study.reserveSpokenAnswer({
        accountId: input.accountId,
        attemptNumber: input.attemptNumber,
        audioByteSize: 100,
        audioContentType: "audio/webm",
        audioDigest,
        audioDurationMs: 1000,
        attemptId: `composed-attempt-${input.commandId}`,
        artifactId: `composed-artifact-${input.commandId}`,
        commandId: `composed-command-${input.commandId}`,
        idempotencyKey,
        leaseToken: `composed-lease-${input.commandId}`,
        providerRetention: "stored",
        requestHash,
        sessionId: input.sessionId,
        sessionItemId: input.sessionItemId,
      }),
    );
    if (reservation.state === "completed") {
      throw new Error("fixture reservation unexpectedly completed");
    }
    const command = {
      accountId: input.accountId,
      acceptedAt: "2026-09-01T12:05:00.000Z",
      archive: {
        state: "stored" as const,
        objectRef: `learner-audio/study/${reservation.attemptId}/${audioDigest}`,
      },
      artifactId: reservation.artifactId,
      attemptId: reservation.attemptId,
      attemptNumber: input.attemptNumber,
      audioByteSize: 100,
      audioContentType: "audio/webm",
      audioDigest,
      audioDurationMs: 1000,
      commandId: reservation.commandId,
      leaseToken: reservation.leaseToken,
      communityId: COMMUNITY_ID,
      grade: {
        correct: input.correct,
        matchKind: input.correct ? ("exact" as const) : ("none" as const),
        heardTranscript: input.correct ? LYRIC_LINES[0] : "unrecognized murmur",
        matched: [],
        missing: [],
        extra: [],
        substituted: [],
        policyRevision: "script_aware_token_phonetic_v2",
      },
      providerDetectedLanguage: "en",
      providerDetectedLanguageConfidence: 0.99,
      qualificationId: `composed-qualification-${input.commandId}`,
      requestHash,
      sessionId: input.sessionId,
      sessionItemId: input.sessionItemId,
    } satisfies SpokenCommand;
    const result = await run(runtime, study.completeSpokenAnswer(command));
    return { command, result };
  };

  const startSession = (accountId: string, personaId: string, suffix: string) =>
    run(
      runtime,
      study.startSession({
        accountId,
        communityId: COMMUNITY_ID,
        createdAt: "2026-09-01T12:00:00.000Z",
        idempotencyKey: `composed-study-${suffix}`,
        learnerBand: null,
        personaId,
        postId: POST_ID,
        requestHash: "5".repeat(64),
        sessionId: `composed-session-${suffix}`,
        targetLanguage: null,
        timezone: "UTC",
      }),
    );

  const completeSession = async (accountId: string, personaId: string, suffix: string) => {
    const session = await startSession(accountId, personaId, suffix);
    expect(session.items).toHaveLength(4);
    const itemId = (index: number) => session.items[index]?.session_item_id ?? "";
    await answerSpoken({
      accountId,
      sessionId: session.session_id,
      sessionItemId: itemId(0),
      attemptNumber: 1,
      correct: false,
      commandId: `${suffix}-miss`,
    });
    for (const index of [1, 2, 3]) {
      await answerSpoken({
        accountId,
        sessionId: session.session_id,
        sessionItemId: itemId(index),
        attemptNumber: 1,
        correct: true,
        commandId: `${suffix}-card-${index}`,
      });
    }
    const final = await answerSpoken({
      accountId,
      sessionId: session.session_id,
      sessionItemId: itemId(0),
      attemptNumber: 2,
      correct: true,
      commandId: `${suffix}-retry`,
    });
    return { session, final };
  };

  return {
    answerSpoken,
    completeSession,
    replaySpokenCommand: (command: SpokenCommand) =>
      run(runtime, study.completeSpokenAnswer(command)),
    startSession,
  };
};

const makeKaraokeDriver = (runtime: Runtime, repository: KaraokeRepository) => {
  const qualifyingLineScores = (
    authority: Effect.Success<ReturnType<KaraokeRepository["reserveSession"]>>,
  ) =>
    authority.lines.map(
      (line, index): KaraokeLineScore => ({
        confidenceScore: 0.9,
        finalizedReason: "asr_final",
        lineId: line.id,
        lineIndex: index,
        recognizedWords: line.words.map((word) => ({
          confidence: 0.9,
          endMs: word.end_ms,
          final: true,
          startMs: word.start_ms,
          text: word.text,
        })),
        score: 0,
        scoredLineIndex: index,
        textScore: {
          confidenceMean: 0.9,
          keywordCoverage: 0.95,
          missedWords: [],
          phoneticAvailable: true,
          phoneticCoverage: 0.95,
          phoneticQuality: 0.95,
          score: 0.95,
          wer: 0.05,
        },
        timingScore: {
          matchedWordCount: line.words.length,
          meanAbsDeltaMs: 0,
          medianAbsDeltaMs: 0,
          medianSignedDeltaMs: 0,
          score: 0,
          signedMeanDeltaMs: 0,
          timingTrend: "on_time" as const,
        },
        transcript: line.text,
        uncertain: false,
      }),
    );

  const reserve = (accountId: string, personaId: string, suffix: string) =>
    run(
      runtime,
      repository.reserveSession({
        accountId,
        artifactId: `composed-karaoke-artifact-${suffix}`,
        attemptId: `composed-karaoke-attempt-${suffix}`,
        clientContext: undefined,
        communityId: COMMUNITY_ID,
        createdAt: "2026-09-01T13:00:00.000Z",
        expiresAt: "2026-09-01T13:30:00.000Z",
        idempotencyKey: `composed-karaoke-${suffix}`,
        personaId,
        postId: POST_ID,
        requestHash: "6".repeat(64),
        sessionId: `composed-karaoke-session-${suffix}`,
        timezone: "UTC",
      }),
    );

  const finish = async (
    authority: Effect.Success<ReturnType<KaraokeRepository["reserveSession"]>>,
    qualificationId: string,
  ) => {
    const summary = aggregateKaraokeSession({ lineScores: qualifyingLineScores(authority) });
    return await run(
      runtime,
      repository.finalizeAttempt({
        authority,
        completedAt: "2026-09-01T13:10:00.000Z",
        completionReason: "completed",
        qualificationId,
        diagnostics: buildKaraokeScoringDiagnostics(authority, summary),
        summary,
        transportFacts: {
          schema_version: 1,
          reconnect_count: 0,
          pause_count: 0,
          seek_count: 0,
          epoch_count: 1,
          dropped_frame_count: 0,
          late_frame_count: 0,
          mic_sample_rate: 16000,
          provider_commit_latency_p50_ms: null,
          provider_commit_latency_p95_ms: null,
        },
      }),
    );
  };

  return { finish, reserve };
};

const sideEffectCounts = async (admin: Client, accountId: string) => {
  const result = await admin.query(
    `SELECT
       (SELECT count(*)::integer FROM community_memberships WHERE user_id=$1) AS memberships,
       (SELECT count(*)::integer FROM community_follows WHERE user_id=$1) AS follows,
       (SELECT count(*)::integer FROM posts WHERE author_user_id=$1) AS posts,
       (SELECT count(*)::integer FROM data_registration_operations
         WHERE actor_user_id=$1) AS data_operations,
       (SELECT count(*)::integer FROM persona_activity_preparation_actions
         WHERE account_id=$1) AS preparation_actions,
       active_community_effect($1,$2) AS posting_authority`,
    [accountId, COMMUNITY_ID],
  );
  return result.rows[0] as Readonly<{
    memberships: number;
    follows: number;
    posts: number;
    data_operations: number;
    preparation_actions: number;
    posting_authority: boolean;
  }>;
};

suite("Composed never-joined activity and reward acceptance", () => {
  test("prepares, activates and completes Study with independent monetary admission and no replay duplication", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_composed_study_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query(
        "INSERT INTO users (user_id) VALUES ('composed-unverified'),('composed-eligible')",
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await seedActivitySong(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const { offerId } = await seedFundedAssetBonus(admin);
      await seedVeryRewardEvidence(admin, "composed-eligible", "eligible");

      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const study = makeControlPlaneStudyV2Repository();
      const prepare = prepareIdentity(runtime);
      const confirm = confirmWallet(runtime);
      const driver = makeStudyDriver(runtime, study);

      const unverified = await prepare("composed-unverified", "unverified-prepare");
      expect(unverified).toMatchObject({ persona_status: "pending_wallet" });
      const pendingState = await admin.query(
        `SELECT persona.status, assignment.status AS wallet_status,
                binding.binding_source,
                (SELECT count(*)::integer FROM persona_pending_profiles draft
                  WHERE draft.persona_id=persona.persona_id) AS profile_drafts
           FROM personas AS persona
           JOIN persona_wallet_assignments AS assignment
             ON assignment.persona_id=persona.persona_id
           JOIN persona_community_bindings AS binding
             ON binding.persona_id=persona.persona_id
          WHERE persona.persona_id=$1`,
        [unverified.persona_id],
      );
      expect(pendingState.rows).toEqual([
        {
          status: "pending_wallet",
          wallet_status: "pending",
          binding_source: "activity_participation",
          profile_drafts: 1,
        },
      ]);
      // A pending persona cannot start before the ordinary confirmation.
      await expect(
        driver.startSession("composed-unverified", unverified.persona_id, "pending-attempt"),
      ).rejects.toMatchObject({ _tag: "StudyV2CommandRejected", reason: "not-found" });

      const reservedIndex = await admin.query<{ readonly hd_wallet_index: string }>(
        "SELECT hd_wallet_index::text FROM persona_wallet_assignments WHERE persona_id=$1 AND status='pending'",
        [unverified.persona_id],
      );
      const confirmed = await confirm("composed-unverified", unverified.persona_id);
      expect(confirmed.hd_wallet_index).toBe(Number(reservedIndex.rows[0]?.hd_wallet_index));
      expect(confirmed.address).toMatch(/^0x[0-9a-f]{40}$/u);
      expect(
        (
          await admin.query(
            `SELECT persona.status,
                    (SELECT count(*)::integer FROM persona_profiles profile
                      WHERE profile.persona_id=persona.persona_id) AS profiles,
                    (SELECT count(*)::integer FROM persona_pending_profiles draft
                      WHERE draft.persona_id=persona.persona_id) AS profile_drafts
               FROM personas AS persona WHERE persona.persona_id=$1`,
            [unverified.persona_id],
          )
        ).rows,
      ).toEqual([{ status: "active", profiles: 1, profile_drafts: 0 }]);

      const eligible = await prepare("composed-eligible", "eligible-prepare");
      expect(eligible.persona_status).toBe("pending_wallet");
      await confirm("composed-eligible", eligible.persona_id);

      const unverifiedRun = await driver.completeSession(
        "composed-unverified",
        unverified.persona_id,
        "unverified",
      );
      expect(unverifiedRun.final.result.session).toMatchObject({
        status: "completed",
        lesson: { completion_reason: "all_resolved" },
      });

      const unverifiedMoney = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id=$1) AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id=$1) AS credits,
           (SELECT count(*)::integer FROM megapot_pool_shares
             WHERE account_id=$1) AS shares,
           (SELECT outcome FROM reward_eligibility_decisions
             WHERE leg_id=(SELECT leg_id FROM song_reward_offer_legs
                            WHERE offer_id=$2)
               AND account_id=$1) AS outcome,
           (SELECT reason FROM reward_eligibility_decisions
             WHERE leg_id=(SELECT leg_id FROM song_reward_offer_legs
                            WHERE offer_id=$2)
               AND account_id=$1) AS reason`,
        ["composed-unverified", offerId],
      );
      expect(unverifiedMoney.rows).toEqual([
        {
          qualifications: 1,
          credits: 0,
          shares: 0,
          outcome: "ineligible",
          reason: "verification_missing",
        },
      ]);

      const eligibleRun = await driver.completeSession(
        "composed-eligible",
        eligible.persona_id,
        "eligible",
      );
      expect(eligibleRun.final.result.session).toMatchObject({
        status: "completed",
        lesson: { completion_reason: "all_resolved" },
      });
      const allocated = await admin.query(
        `SELECT account_id, amount_atomic::text AS amount, state
           FROM reward_ledger_credits ORDER BY account_id`,
      );
      expect(allocated.rows).toEqual([
        { account_id: "composed-eligible", amount: "100", state: "credited" },
      ]);

      // An exact replay of the final completion command keeps one qualification
      // and one allocation.
      const replayed = await driver.replaySpokenCommand(eligibleRun.final.command);
      expect(replayed.session.status).toBe("completed");
      const afterReplay = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-eligible') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-eligible') AS credits`,
      );
      expect(afterReplay.rows).toEqual([{ qualifications: 1, credits: 1 }]);

      // A second qualifying completion by the same account inserts a second
      // qualification but cannot allocate the funded leg twice.
      const second = await driver.completeSession(
        "composed-eligible",
        eligible.persona_id,
        "eligible-second",
      );
      expect(second.final.result.session).toMatchObject({ status: "completed" });
      const afterSecond = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-eligible') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-eligible') AS credits,
           (SELECT count(*)::integer FROM song_reward_bundle_claims
             WHERE account_id='composed-eligible') AS claims`,
      );
      expect(afterSecond.rows).toEqual([{ qualifications: 2, credits: 1, claims: 1 }]);

      for (const accountId of ["composed-unverified", "composed-eligible"]) {
        expect(await sideEffectCounts(admin, accountId)).toEqual({
          memberships: 0,
          follows: 0,
          posts: 0,
          data_operations: 0,
          preparation_actions: 1,
          posting_authority: false,
        });
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 120_000);

  test("completes Karaoke with a qualifying score and allocates one funded credit across a finalization replay", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_composed_karaoke_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query(
        "INSERT INTO users (user_id) VALUES ('composed-karaoke-unverified'),('composed-karaoke-eligible')",
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await seedActivitySong(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await seedFundedAssetBonus(admin);
      await seedVeryRewardEvidence(admin, "composed-karaoke-eligible", "karaoke-eligible");

      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const repository = makeControlPlaneKaraokeRepository();
      const prepare = prepareIdentity(runtime);
      const confirm = confirmWallet(runtime);
      const driver = makeKaraokeDriver(runtime, repository);

      const unverified = await prepare("composed-karaoke-unverified", "karaoke-unverified-prepare");
      const eligible = await prepare("composed-karaoke-eligible", "karaoke-eligible-prepare");
      expect(unverified.persona_status).toBe("pending_wallet");
      expect(eligible.persona_status).toBe("pending_wallet");

      // A pending persona cannot reserve a scored take.
      await expect(
        driver.reserve("composed-karaoke-unverified", unverified.persona_id, "pending-reserve"),
      ).rejects.toMatchObject({ _tag: "KaraokeCommandRejected", reason: "invalid-input" });

      await confirm("composed-karaoke-unverified", unverified.persona_id);
      await confirm("composed-karaoke-eligible", eligible.persona_id);

      const eligibleAuthority = await driver.reserve(
        "composed-karaoke-eligible",
        eligible.persona_id,
        "eligible",
      );
      const eligibleAttempt = await driver.finish(
        eligibleAuthority,
        "composed-karaoke-qualification",
      );
      expect(eligibleAttempt).toMatchObject({
        completion_reason: "completed",
        rank_eligible: true,
        scored_line_count: 5,
      });
      expect(eligibleAttempt.final_score).toBeGreaterThanOrEqual(7000);
      const eligibleReplay = await driver.finish(
        eligibleAuthority,
        "composed-karaoke-qualification",
      );
      expect(eligibleReplay).toEqual(eligibleAttempt);

      const karaokeAllocation = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-karaoke-eligible'
               AND activity_key='karaoke') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-karaoke-eligible') AS credits,
           (SELECT count(*)::integer FROM reward_ledger_credits) AS credits_total`,
      );
      expect(karaokeAllocation.rows).toEqual([{ qualifications: 1, credits: 1, credits_total: 1 }]);

      const unverifiedAuthority = await driver.reserve(
        "composed-karaoke-unverified",
        unverified.persona_id,
        "unverified",
      );
      const unverifiedAttempt = await driver.finish(
        unverifiedAuthority,
        "composed-karaoke-unverified-qualification",
      );
      expect(unverifiedAttempt).toMatchObject({ completion_reason: "completed" });
      const unverifiedKaraoke = await admin.query(
        `SELECT
           (SELECT count(*)::integer FROM activity_qualifications
             WHERE account_id='composed-karaoke-unverified') AS qualifications,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE account_id='composed-karaoke-unverified') AS credits,
           (SELECT count(*)::integer FROM reward_ledger_credits) AS credits_total,
           (SELECT outcome FROM reward_eligibility_decisions
             WHERE account_id='composed-karaoke-unverified') AS outcome,
           (SELECT reason FROM reward_eligibility_decisions
             WHERE account_id='composed-karaoke-unverified') AS reason`,
      );
      expect(unverifiedKaraoke.rows).toEqual([
        {
          qualifications: 1,
          credits: 0,
          credits_total: 1,
          outcome: "ineligible",
          reason: "verification_missing",
        },
      ]);

      for (const accountId of ["composed-karaoke-unverified", "composed-karaoke-eligible"]) {
        expect(await sideEffectCounts(admin, accountId)).toEqual({
          memberships: 0,
          follows: 0,
          posts: 0,
          data_operations: 0,
          preparation_actions: 1,
          posting_authority: false,
        });
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 120_000);
});
