import { afterAll, describe, expect, test } from "bun:test";
import {
  Clock,
  IdGen,
  makeActivityQualificationService,
  StudyItemSource,
  type StudyItemSourceSetV1,
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
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneAcceptedLyricsStudyItemSource } from "./accepted-lyrics-study-item-source.ts";
import { makeControlPlaneActivityQualificationStore } from "./activity-qualification-repository.ts";
import {
  activatePendingPersonaFixtures,
  createActivePersonaFixture,
} from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";
import { makeControlPlaneRewardProjectionStore } from "./reward-projection-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const migrations = await loadPostgresMigrations();

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const bytes32 = (byte: string): string => `0x${byte.repeat(64)}`;
const hash = (byte: string): string => byte.repeat(64);

const schemaIdentifier = (): string =>
  `api_next_rewards_repository_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(
  use: (input: { readonly admin: Client; readonly scopedConnection: string }) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnection = connectionForSchema(connectionString, schema);
  try {
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(migrations).pipe(
          Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnection)),
        ),
      ),
    );
    return await use({ admin, scopedConnection });
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedAccountSong(
  admin: Client,
  suffix: string,
): Promise<{
  readonly accountId: string;
  readonly communityId: string;
  readonly personaId: string;
  readonly postId: string;
}> {
  const accountId = `account-${suffix}`;
  const communityId = `community-${suffix}`;
  const postId = `post-${suffix}`;
  await admin.query(
    `INSERT INTO users (user_id, status, account, created_at)
     VALUES ($1, 'active', '{}'::jsonb, '2026-08-01T00:00:00.000Z')`,
    [accountId],
  );
  await activatePendingPersonaFixtures(admin);
  const firstPersona = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
    [accountId],
  );
  const personaId = firstPersona.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona was not provisioned");
  await admin.query(`UPDATE persona_profiles SET display_name=$2 WHERE persona_id=$1`, [
    personaId,
    `Persona ${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1,$2,'active',$3,'2026-08-02T00:00:00.000Z','2026-08-02T00:00:00.000Z')`,
    [communityId, `Community ${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO community_memberships (
       community_id, membership_id, user_id, status, joined_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'member','2026-08-03T00:00:00.000Z',
       '2026-08-03T00:00:00.000Z','2026-08-03T00:00:00.000Z')`,
    [communityId, `membership-${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'song','published','public',$5,
       '2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')`,
    [communityId, postId, accountId, personaId, `Song ${suffix}`],
  );
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         lyrics_explicitness, alignment, data_registration, locked_delivery,
         projected_at, author_persona_id, lyrics_status, lyrics_revision, lyrics_text
       ) VALUES (
         $1,$2,$3,$4,$5,1,3,1,1,$6,$7,$8,'ready','not_explicit','ready',
         'registered','not_required','2026-08-04T00:00:00.000Z',$9,'ready',2,$10
       )`,
      [
        `submission-${suffix}`,
        communityId,
        accountId,
        `operation-${suffix}`,
        postId,
        "a".repeat(64),
        `Song ${suffix}`,
        `r2://audio-${suffix}`,
        personaId,
        "Sail away",
      ],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  return { accountId, communityId, personaId, postId };
}

async function seedParticipant(
  admin: Client,
  identity: Readonly<{ readonly communityId: string; readonly postId: string }>,
  suffix: string,
): Promise<{
  readonly accountId: string;
  readonly communityId: string;
  readonly personaId: string;
  readonly postId: string;
}> {
  const accountId = `account-${suffix}`;
  await admin.query(
    `INSERT INTO users (user_id, status, account, created_at)
     VALUES ($1, 'active', '{}'::jsonb, '2026-08-01T00:00:00.000Z')`,
    [accountId],
  );
  await activatePendingPersonaFixtures(admin);
  const firstPersona = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
    [accountId],
  );
  const personaId = firstPersona.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona was not provisioned");
  await admin.query(
    `INSERT INTO community_memberships (
       community_id, membership_id, user_id, status, joined_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'member','2026-08-03T00:00:00.000Z',
       '2026-08-03T00:00:00.000Z','2026-08-03T00:00:00.000Z')`,
    [identity.communityId, `membership-${suffix}`, accountId],
  );
  return { ...identity, accountId, personaId };
}

async function seedVeryRewardEvidence(
  admin: Client,
  accountId: string,
  suffix: string,
  digestByte = "1",
): Promise<void> {
  const proofSessionId = `proof-${suffix}`;
  const subjectId = `subject-${suffix}`;
  const bindingEventId = `binding-event-${suffix}`;
  const receiptId = `receipt-${suffix}`;
  const bindingId = `binding-${suffix}`;
  await admin.query({
    text: `INSERT INTO proof_sessions (
             proof_session_id, actor_id, intent_id, request_hash, provider_id,
             provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, method, issuer, scope_kind, issuer_rp_scope,
             issuer_rp_action_scope, request_mode, protocol_version, environment, status,
             requested_requirements, requested_claim_ids, subject_binding_intent,
             started_at, expires_at, upstream_session_ref
           ) VALUES ($1,$2,$3,$4,$5,'dynamic',$6,$7,$8,$9,'issuer_rp_scope',$10,
             NULL,'dynamic',$11,'test','pending',$12::jsonb,$13::jsonb,'establish',
             clock_timestamp(),clock_timestamp() + interval '5 minutes',$14)`,
    values: [
      proofSessionId,
      accountId,
      `intent-${suffix}`,
      hash("a"),
      VERY_WEB_PROVIDER_ID,
      VERY_WEB_CONFIGURATION_REFERENCE,
      VERY_WEB_CONFIGURATION_VERSION,
      VERY_WEB_METHOD,
      VERY_WEB_ISSUER,
      VERY_WEB_RP_SCOPE,
      VERY_WEB_PROTOCOL_VERSION,
      JSON.stringify([{ claim_id: "credential.subject_unique" }, { claim_id: "human.personhood" }]),
      JSON.stringify(["credential.subject_unique", "human.personhood"]),
      `upstream-${suffix}`,
    ],
  });
  await admin.query("BEGIN");
  try {
    await admin.query({
      text: `INSERT INTO subject_keys (
               subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
               issuer_rp_action_scope, subject_digest
             ) VALUES ($1,$2,$3,'issuer_rp_scope',$4,NULL,$5)`,
      values: [subjectId, VERY_WEB_ISSUER, VERY_WEB_METHOD, VERY_WEB_RP_SCOPE, hash(digestByte)],
    });
    await admin.query({
      text: `INSERT INTO subject_key_binding_events (
               binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
               binding_kind, idempotency_key, bound_at
             ) VALUES ($1,$2,1,$3,$4,'initial',$5,clock_timestamp())`,
      values: [bindingEventId, subjectId, accountId, proofSessionId, `bind-${suffix}`],
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
        hash(digestByte),
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
        `assertion-person-${suffix}`,
        bindingId,
        receiptId,
        subjectId,
        accountId,
        `assertion-unique-${suffix}`,
      ],
    });
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status='completed',completed_at=terminal.value,
                    completion_idempotency_key=$2,completion_result_hash=$3,
                    terminal_at=terminal.value
               FROM terminal WHERE proof_session_id=$1`,
      values: [proofSessionId, `complete-${suffix}`, hash("b")],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
               completion_event_id, proof_session_id, actor_id, idempotency_key,
               terminal_status, result_hash, terminal_at
             ) SELECT $2,proof_session_id,actor_id,completion_idempotency_key,
                      status,completion_result_hash,terminal_at
                 FROM proof_sessions WHERE proof_session_id=$1`,
      values: [proofSessionId, `completion-${suffix}`],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function seedOpenMegapotPool(
  admin: Client,
  identity: Readonly<{
    readonly accountId: string;
    readonly communityId: string;
    readonly personaId: string;
    readonly postId: string;
  }>,
  suffix: string,
): Promise<Readonly<{ readonly legId: string; readonly offerId: string }>> {
  const offerId = `offer-${suffix}`;
  const legId = `leg-${suffix}`;
  const policyVersionId = `reward-policy-${suffix}`;
  const observationId = `drawing-observation-${suffix}`;
  await admin.query(
    `INSERT INTO reward_asset_whitelist (
       chain_id,token_address,decimals,symbol,asset_kind,environment,status,
       policy_version,activated_at,plain_erc20_verified_at
     ) VALUES (84532,$1,6,'USDC','settlement_usdc','staging','active',
       'base-sepolia-usdc-v1',statement_timestamp(),statement_timestamp())`,
    [address("1")],
  );
  await admin.query(
    `INSERT INTO megapot_deployment_attestations (
       attestation_id,environment,chain_id,jackpot_address,usdc_address,
       ticket_nft_address,custody_address,referrer_address,source_tag,
       jackpot_code_hash,usdc_code_hash,ticket_nft_code_hash,
       attestation_block_number,attestation_block_hash,abi_version,status,verified_at
     ) VALUES ('megapot-base-sepolia-v2','staging',84532,$1,$2,$3,$4,$5,$6,
       $7,$8,$9,100,$10,'megapot_v2','active',clock_timestamp())`,
    [
      address("2"),
      address("1"),
      address("3"),
      address("4"),
      address("5"),
      bytes32("6"),
      bytes32("7"),
      bytes32("8"),
      bytes32("9"),
      bytes32("a"),
    ],
  );
  await admin.query(
    `INSERT INTO reward_activity_availability_observations (
       availability_observation_id,community_id,post_id,audio_revision,activity_key,
       producer_id,producer_revision,state,study_item_count,evidence,evidence_hash,
       observed_at,expires_at
     ) VALUES ($1,$2,$3,3,'study','study-item-source','v1','available',1,
       '{"kind":"typed_study_items","item_count":1}'::jsonb,$4,
       clock_timestamp(),clock_timestamp() + interval '2 hours')`,
    [`availability-${suffix}`, identity.communityId, identity.postId, hash("d")],
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
      identity.communityId,
      `song_reward_offer:${offerId}`,
      hash("e"),
      JSON.stringify({ kind: "single_authority", authority_id: offerId }),
      identity.accountId,
      offerId,
    ],
  );
  await admin.query(
    `INSERT INTO song_reward_offers (
       offer_id,community_id,post_id,audio_revision,created_by_account_id,status,
       starts_at,ends_at,owner_policy_snapshot,terms_hash,reward_policy_version_id
     ) VALUES ($1,$2,$3,3,$4,'draft','2026-08-01T00:00:00.000Z',
       clock_timestamp() + interval '10 days','{"third_party_legs":"allowed"}'::jsonb,
       $5,$6)`,
    [
      offerId,
      identity.communityId,
      identity.postId,
      identity.accountId,
      hash("f"),
      policyVersionId,
    ],
  );
  await admin.query(
    `UPDATE song_reward_offers SET status='active',activated_at=clock_timestamp(),
       updated_at=clock_timestamp() WHERE offer_id=$1`,
    [offerId],
  );
  await admin.query(
    `INSERT INTO song_reward_offer_legs (
       leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,
       participation_starts_at,chain_id,token_address,token_decimals,tickets_per_drawing,
       max_ticket_price_atomic,entry_cutoff_seconds,beneficiary_algorithm_version,
       ticket_selection_version,attestation_id,participation_starts_drawing_id,
       eligible_activities,min_score_bps,empty_pool_policy,funding_source,funded_atomic
     ) VALUES ($1,$2,'megapot_pool','draft',$3,'refund_to_funders_pro_rata',$4,
       '2026-08-01T00:00:00.000Z',84532,$5,6,1,10000,300,'equal_v1',
       'keccak_packed_v1','megapot-base-sepolia-v2',100,ARRAY['study'],7000,
       'no_purchase','leg_budget',100000)`,
    [legId, offerId, identity.accountId, bytes32("b"), address("1")],
  );
  await admin.query(
    `UPDATE song_reward_offer_legs SET status='active',activated_at=clock_timestamp(),
       updated_at=clock_timestamp() WHERE leg_id=$1`,
    [legId],
  );
  await admin.query(
    `INSERT INTO megapot_drawing_observations (
       observation_id,attestation_id,chain_id,drawing_id,ticket_price_atomic,drawing_time,
       ball_max,bonusball_max,drawing_locked,referral_fee_wei,referral_win_share_wei,
       block_number,block_hash,block_timestamp,confirmations,observed_at,expires_at,
       raw_state_hash
     ) VALUES ($1,'megapot-base-sepolia-v2',84532,100,10000,
       clock_timestamp() + interval '1 hour',25,13,false,100000000000000000,
       100000000000000000,101,$2,clock_timestamp() - interval '1 minute',3,
       clock_timestamp(),clock_timestamp() + interval '30 minutes',$3)`,
    [observationId, bytes32("c"), hash("c")],
  );
  await admin.query(
    `INSERT INTO megapot_pool_drawings (
       pool_leg_id,drawing_id,observation_id,status,entry_cutoff_at,
       ticket_price_ceiling_atomic
     ) SELECT $1,100,$2,'entry_open',drawing_time - interval '300 seconds',10000
         FROM megapot_drawing_observations WHERE observation_id=$2`,
    [legId, observationId],
  );
  return { legId, offerId };
}

async function seedOpenAssetBonus(
  admin: Client,
  identity: Readonly<{
    readonly accountId: string;
    readonly communityId: string;
    readonly personaId: string;
    readonly postId: string;
  }>,
  suffix: string,
  input: Readonly<{
    readonly fundedAtomic?: number;
    readonly maxClaims?: number;
  }> = {},
): Promise<Readonly<{ readonly legId: string; readonly offerId: string; readonly token: string }>> {
  const offerId = `offer-${suffix}`;
  const legId = `leg-${suffix}`;
  const policyVersionId = `reward-policy-${suffix}`;
  const token = address("d");
  const fundedAtomic = input.fundedAtomic ?? 200;
  const maxClaims = input.maxClaims ?? 2;
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
     ) VALUES ($1,$2,$3,3,'study','study-item-source','v1','available',1,
       '{"kind":"typed_study_items","item_count":1}'::jsonb,$4,
       clock_timestamp(),clock_timestamp() + interval '2 hours')`,
    [`availability-${suffix}`, identity.communityId, identity.postId, hash("d")],
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
      identity.communityId,
      `song_reward_offer:${offerId}`,
      hash("e"),
      JSON.stringify({ kind: "single_authority", authority_id: offerId }),
      identity.accountId,
      offerId,
    ],
  );
  await admin.query(
    `INSERT INTO song_reward_offers (
       offer_id,community_id,post_id,audio_revision,created_by_account_id,status,
       starts_at,ends_at,owner_policy_snapshot,terms_hash,reward_policy_version_id
     ) VALUES ($1,$2,$3,3,$4,'draft','2026-08-01T00:00:00.000Z',
       clock_timestamp() + interval '10 days','{"third_party_legs":"allowed"}'::jsonb,
       $5,$6)`,
    [
      offerId,
      identity.communityId,
      identity.postId,
      identity.accountId,
      hash("f"),
      policyVersionId,
    ],
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
       '2026-08-01T00:00:00.000Z',84532,$5,6,'BONUS','bonus-v1',100,$6,$7)`,
    [legId, offerId, identity.accountId, bytes32("b"), token, maxClaims, fundedAtomic],
  );
  await admin.query(
    `UPDATE song_reward_offer_legs SET status='active',activated_at=clock_timestamp(),
       updated_at=clock_timestamp() WHERE leg_id=$1`,
    [legId],
  );
  return { legId, offerId, token };
}

const sourceFor = (identity: {
  readonly communityId: string;
  readonly postId: string;
}): StudyItemSourceSetV1 => ({
  version: "study_item_source_v1",
  song_revision: {
    community_id: identity.communityId,
    post_id: identity.postId,
    audio_revision: 3,
    lyrics_revision: 2,
  },
  source_revision: 1,
  provenance: {
    kind: "accepted_song_lyrics",
    producer_id: "study-producer",
    producer_revision: "prompt-policy-v1",
  },
  items: [
    {
      source_item_key: "line-1",
      prompt: { kind: "text_response", text: "Repeat the line" },
      answer_key: {
        kind: "text_response",
        comparison: "unicode_casefold_whitespace_v1",
        accepted_answers: ["Sail away"],
      },
    },
  ],
});

const provideServices =
  (ids: string[], source: StudyItemSourceSetV1, now: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Clock, { now: Effect.succeed(Date.parse(now)) }),
      Effect.provideService(IdGen, {
        next: Effect.sync(() => {
          const id = ids.shift();
          if (id === undefined) throw new Error("test identifier sequence exhausted");
          return id;
        }),
      }),
      Effect.provideService(StudyItemSource, {
        getForAcceptedSongRevision: () => Effect.succeed(source),
      }),
    );

suite("Postgres 17 activity qualification repository", () => {
  test("derives Study items only from the exact public accepted lyrics revision", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "accepted-lyrics-source");
      const source = makeControlPlaneAcceptedLyricsStudyItemSource(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const exact = await Effect.runPromise(
        source.getForAcceptedSongRevision({
          communityId: identity.communityId,
          postId: identity.postId,
          audioRevision: 3,
          lyricsRevision: 2,
        }),
      );
      expect(exact).toMatchObject({
        song_revision: {
          community_id: identity.communityId,
          post_id: identity.postId,
          audio_revision: 3,
          lyrics_revision: 2,
        },
        items: [
          {
            prompt: { text: "Complete the accepted lyric: Sail ____" },
            answer_key: { accepted_answers: ["away"] },
          },
        ],
      });

      await expect(
        Effect.runPromise(
          source.getForAcceptedSongRevision({
            communityId: identity.communityId,
            postId: identity.postId,
            audioRevision: 3,
            lyricsRevision: 3,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "StudyItemSourceError", reason: "unavailable" });

      await admin.query(
        `UPDATE posts SET visibility='members_only'
          WHERE community_id=$1 AND post_id=$2`,
        [identity.communityId, identity.postId],
      );
      await expect(
        Effect.runPromise(
          source.getForAcceptedSongRevision({
            communityId: identity.communityId,
            postId: identity.postId,
            audioRevision: 3,
            lyricsRevision: 2,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "StudyItemSourceError", reason: "unavailable" });
    });
  });

  test("freezes Study evidence, replays commands, and emits one account day", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "repository");
      const source = sourceFor(identity);
      const store = makeControlPlaneActivityQualificationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const service = makeActivityQualificationService(store);
      const startInput = {
        accountId: identity.accountId,
        communityId: identity.communityId,
        idempotencyKey: "start-1",
        personaId: identity.personaId,
        postId: identity.postId,
        requestedTimezone: "UTC",
      } as const;
      const start = () =>
        Effect.runPromise(
          provideServices(
            ["session-1", "item-1"],
            source,
            "2026-08-25T12:00:00.000Z",
          )(service.startStudySession(startInput)),
        );
      const session = await start();
      expect(session).toMatchObject({
        status: "active",
        streak_day: null,
        items: [{ session_item_id: "study_item_item-1", answer_count: 0 }],
      });
      expect(JSON.stringify(session)).not.toContain("answer_key");
      await expect(start()).resolves.toEqual(session);

      const submission = {
        accountId: identity.accountId,
        answer: { kind: "text_response" as const, text: "  SAIL   AWAY " },
        attemptNumber: 1,
        communityId: identity.communityId,
        idempotencyKey: "answer-1",
        sessionId: session.session_id,
        sessionItemId: session.items[0]?.session_item_id ?? "missing",
      };
      const result = await Effect.runPromise(
        provideServices(
          ["answer-1", "qualification-1"],
          source,
          "2026-08-25T12:05:00.000Z",
        )(service.submitStudyAnswer(submission)),
      );
      expect(result).toMatchObject({
        outcome: "correct",
        first_pass: true,
        session: {
          status: "completed",
          streak_day: "2026-08-25",
          progress: { score_bps: 10_000 },
          qualification: { activity: "study", persona_id: identity.personaId },
        },
      });
      const replay = await Effect.runPromise(
        provideServices(
          ["discarded-answer", "discarded-qualification"],
          source,
          "2026-08-25T12:06:00.000Z",
        )(service.submitStudyAnswer(submission)),
      );
      expect(replay).toEqual(result);

      const secondPersonaId = `persona-${crypto.randomUUID()}`;
      await createActivePersonaFixture(admin, {
        accountId: identity.accountId,
        personaId: secondPersonaId,
        profile: { displayName: "Second Persona" },
      });
      const secondSession = await Effect.runPromise(
        provideServices(
          ["session-2", "item-2"],
          source,
          "2026-08-25T12:10:00.000Z",
        )(
          service.startStudySession({
            ...startInput,
            idempotencyKey: "start-2",
            personaId: secondPersonaId,
            requestedTimezone: null,
          }),
        ),
      );
      await Effect.runPromise(
        provideServices(
          ["answer-2", "qualification-2"],
          source,
          "2026-08-25T12:15:00.000Z",
        )(
          service.submitStudyAnswer({
            ...submission,
            idempotencyKey: "answer-2",
            sessionId: secondSession.session_id,
            sessionItemId: secondSession.items[0]?.session_item_id ?? "missing",
          }),
        ),
      );
      const presentation = await Effect.runPromise(
        provideServices(
          [],
          source,
          "2026-08-25T12:16:00.000Z",
        )(
          service.setPresentationPersona({
            accountId: identity.accountId,
            communityId: identity.communityId,
            idempotencyKey: "presentation-2",
            personaId: secondPersonaId,
          }),
        ),
      );
      expect(presentation.persona_id).toBe(secondPersonaId);

      const counts = await admin.query<{
        readonly answers: string;
        readonly activity_count: string;
        readonly qualifications: string;
        readonly song_days: string;
        readonly community_days: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM study_session_answers) AS answers,
           (SELECT count(*)::text FROM activity_qualifications) AS qualifications,
           (SELECT count(*)::text FROM song_streak_days) AS song_days,
           (SELECT count(*)::text FROM community_streak_days) AS community_days,
           (SELECT qualification_count::text FROM song_streak_day_activities) AS activity_count`,
      );
      expect(counts.rows[0]).toEqual({
        answers: "2",
        qualifications: "2",
        song_days: "1",
        community_days: "1",
        activity_count: "2",
      });

      const leaderboard = await Effect.runPromise(
        provideServices(
          [],
          source,
          "2026-08-25T12:06:00.000Z",
        )(
          service.getSongLeaderboard({
            accountId: identity.accountId,
            communityId: identity.communityId,
            postId: identity.postId,
          }),
        ),
      );
      expect(leaderboard.entries).toHaveLength(1);
      expect(leaderboard.entries[0]).toMatchObject({
        rank: 1,
        current: 1,
        persona: { persona_id: secondPersonaId, display_name: "Second Persona" },
        is_viewer: true,
      });
      expect(JSON.stringify(leaderboard)).not.toContain(identity.accountId);
    });
  });

  test("uses competition rank and keeps every tie at the requested boundary", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const song = await seedAccountSong(admin, "rank-ties");
      const second = await seedParticipant(admin, song, "rank-ties-second");
      const third = await seedParticipant(admin, song, "rank-ties-third");
      const fourth = await seedParticipant(admin, song, "rank-ties-fourth");
      const ranked = [song, second, third, fourth];
      for (const [index, identity] of ranked.entries()) {
        await admin.query(
          `INSERT INTO persona_activity_presentations (
             community_id, account_id, persona_id
           ) VALUES ($1,$2,$3)`,
          [song.communityId, identity.accountId, identity.personaId],
        );
        const isLower = index === 3;
        await admin.query(
          `INSERT INTO song_streaks (
             account_id, community_id, post_id, current_count, best_count,
             started_day, last_day, total_days, active_until_at
           ) VALUES ($1,$2,$3,$4,$4,$5,'2026-08-29',$4,'2026-09-01T00:00:00.000Z')`,
          [
            identity.accountId,
            song.communityId,
            song.postId,
            isLower ? 2 : 3,
            `2026-08-${String(25 - index).padStart(2, "0")}`,
          ],
        );
      }
      const leaderboard = await Effect.runPromise(
        makeControlPlaneActivityQualificationStore(
          makeDirectPostgresControlPlaneLayer(scopedConnection),
        ).getSongLeaderboard({
          accountId: null,
          communityId: song.communityId,
          limit: 1,
          postId: song.postId,
          readAt: "2026-08-29T12:00:00.000Z",
        }),
      );
      expect(leaderboard.entries.map(({ rank }) => rank)).toEqual([1, 1, 1]);
      expect(leaderboard.entries.map(({ persona }) => persona.persona_id)).toEqual([
        third.personaId,
        second.personaId,
        song.personaId,
      ]);
      const allRanks = await admin.query<{ readonly rank: string }>(
        `SELECT rank::text FROM (
           SELECT rank() OVER (ORDER BY current_count DESC, best_count DESC) AS rank
             FROM song_streaks WHERE community_id=$1 AND post_id=$2
         ) AS ranked ORDER BY rank`,
        [song.communityId, song.postId],
      );
      expect(allRanks.rows.map(({ rank }) => Number(rank))).toEqual([1, 1, 1, 4]);
    });
  });

  test("projects Study qualification into one Very-gated Megapot share per account", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "pool-share");
      const participant = await seedParticipant(admin, identity, "pool-share-missing");
      const lateParticipant = await seedParticipant(admin, identity, "pool-share-late");
      const source = sourceFor(identity);
      await seedVeryRewardEvidence(admin, identity.accountId, "pool-share");
      await seedVeryRewardEvidence(admin, lateParticipant.accountId, "pool-share-late", "2");
      const { legId, offerId } = await seedOpenMegapotPool(admin, identity, "pool-share");
      const store = makeControlPlaneActivityQualificationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const service = makeActivityQualificationService(store);

      const qualify = async (
        actor: Readonly<{ readonly accountId: string; readonly personaId: string }>,
        suffix: string,
        now: string,
      ): Promise<void> => {
        const session = await Effect.runPromise(
          provideServices(
            [`session-${suffix}`, `item-${suffix}`],
            source,
            now,
          )(
            service.startStudySession({
              accountId: actor.accountId,
              communityId: identity.communityId,
              idempotencyKey: `start-${suffix}`,
              personaId: actor.personaId,
              postId: identity.postId,
              requestedTimezone: "UTC",
            }),
          ),
        );
        const result = await Effect.runPromise(
          provideServices(
            [`answer-${suffix}`, `qualification-${suffix}`],
            source,
            new Date(Date.parse(now) + 60_000).toISOString(),
          )(
            service.submitStudyAnswer({
              accountId: actor.accountId,
              answer: { kind: "text_response", text: "Sail away" },
              attemptNumber: 1,
              communityId: identity.communityId,
              idempotencyKey: `answer-${suffix}`,
              sessionId: session.session_id,
              sessionItemId: session.items[0]?.session_item_id ?? "missing",
            }),
          ),
        );
        expect(result.session.qualification).not.toBeNull();
      };

      await qualify(identity, "pool-share-eligible", "2026-08-25T15:00:00.000Z");

      const secondPersonaId = `persona-${crypto.randomUUID()}`;
      await createActivePersonaFixture(admin, {
        accountId: identity.accountId,
        personaId: secondPersonaId,
        profile: { displayName: "Second Pool Persona" },
      });
      await qualify(
        { accountId: identity.accountId, personaId: secondPersonaId },
        "pool-share-second-persona",
        "2026-08-25T15:05:00.000Z",
      );
      await qualify(participant, "pool-share-missing", "2026-08-25T15:10:00.000Z");

      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `UPDATE megapot_pool_drawings
              SET entry_cutoff_at=clock_timestamp() - interval '1 minute'
            WHERE pool_leg_id=$1 AND drawing_id=100`,
          [legId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await qualify(lateParticipant, "pool-share-late", new Date().toISOString());

      const counts = await admin.query<{
        readonly consumptions: string;
        readonly decisions: string;
        readonly eligibility: string;
        readonly qualifications: string;
        readonly shares: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM activity_qualifications
             WHERE community_id=$1 AND post_id=$2) AS qualifications,
           (SELECT count(*)::text FROM decision_records
             WHERE request_id LIKE 'pool-share:%') AS decisions,
           (SELECT count(*)::text FROM reward_eligibility_decisions
             WHERE leg_id=$3 AND drawing_id=100) AS eligibility,
           (SELECT count(*)::text FROM reward_subject_consumptions
             WHERE campaign_id=$4) AS consumptions,
           (SELECT count(*)::text FROM megapot_pool_shares
             WHERE pool_leg_id=$3 AND drawing_id=100) AS shares`,
        [identity.communityId, identity.postId, legId, offerId],
      );
      expect(counts.rows[0]).toEqual({
        consumptions: "1",
        decisions: "2",
        eligibility: "2",
        qualifications: "4",
        shares: "1",
      });

      const shares = await admin.query<{
        readonly account_id: string;
        readonly persona_id: string;
        readonly qualification_id: string;
      }>(
        `SELECT account_id,persona_id,qualification_id
           FROM megapot_pool_shares WHERE pool_leg_id=$1 AND drawing_id=100`,
        [legId],
      );
      expect(shares.rows).toEqual([
        {
          account_id: identity.accountId,
          persona_id: identity.personaId,
          qualification_id: "qualification_qualification-pool-share-eligible",
        },
      ]);

      const decisions = await admin.query<{
        readonly account_id: string;
        readonly decision_outcome: string;
        readonly outcome: string;
        readonly reason: string | null;
      }>(
        `SELECT eligibility.account_id,eligibility.outcome,eligibility.reason,
                decision.outcome AS decision_outcome
           FROM reward_eligibility_decisions eligibility
           JOIN decision_records decision
             ON decision.decision_record_id=eligibility.decision_record_id
          WHERE eligibility.leg_id=$1 AND eligibility.drawing_id=100
          ORDER BY eligibility.account_id`,
        [legId],
      );
      expect(decisions.rows).toEqual([
        {
          account_id: identity.accountId,
          decision_outcome: "pass",
          outcome: "eligible",
          reason: null,
        },
        {
          account_id: participant.accountId,
          decision_outcome: "needs_evidence",
          outcome: "ineligible",
          reason: "verification_missing",
        },
      ]);
      const consumptions = await admin.query<{
        readonly campaign_id: string;
        readonly user_id: string;
      }>(`SELECT campaign_id,user_id FROM reward_subject_consumptions WHERE campaign_id=$1`, [
        offerId,
      ]);
      expect(consumptions.rows).toEqual([{ campaign_id: offerId, user_id: identity.accountId }]);
    });
  });

  test("credits every available asset-bonus leg once per verified account", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "asset-claim");
      const missing = await seedParticipant(admin, identity, "asset-claim-missing");
      const second = await seedParticipant(admin, identity, "asset-claim-second");
      const stale = await seedParticipant(admin, identity, "asset-claim-stale");
      await seedVeryRewardEvidence(admin, identity.accountId, "asset-claim");
      await seedVeryRewardEvidence(admin, second.accountId, "asset-claim-second", "2");
      await seedVeryRewardEvidence(admin, stale.accountId, "asset-claim-stale", "3");
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `UPDATE evidence_receipts SET expires_at=clock_timestamp() - interval '1 minute'
            WHERE evidence_receipt_id='receipt-asset-claim-stale'`,
        );
        await admin.query(
          `UPDATE assertions SET expires_at=clock_timestamp() - interval '1 minute'
            WHERE user_id=$1`,
          [stale.accountId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const { legId, offerId, token } = await seedOpenAssetBonus(admin, identity, "asset-claim");
      const unfundedLegId = "leg-asset-claim-unfunded";
      await admin.query(
        `INSERT INTO song_reward_offer_legs (
           leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,
           participation_starts_at,chain_id,token_address,token_decimals,token_symbol,
           asset_policy_version,amount_per_claim_atomic,max_claims,funded_atomic
         ) VALUES ($1,$2,'asset_bonus','draft',$3,'refund_to_funders_pro_rata',$4,
           '2026-08-01T00:00:00.000Z',84532,$5,6,'BONUS','bonus-v1',50,2,0)`,
        [unfundedLegId, offerId, identity.accountId, bytes32("c"), token],
      );
      await admin.query(
        `UPDATE song_reward_offer_legs SET status='funding',updated_at=clock_timestamp()
          WHERE leg_id=$1`,
        [unfundedLegId],
      );
      const source = sourceFor(identity);
      const service = makeActivityQualificationService(
        makeControlPlaneActivityQualificationStore(
          makeDirectPostgresControlPlaneLayer(scopedConnection),
        ),
      );

      const qualify = async (
        actor: Readonly<{ readonly accountId: string; readonly personaId: string }>,
        suffix: string,
        now: string,
      ): Promise<void> => {
        const session = await Effect.runPromise(
          provideServices(
            [`session-${suffix}`, `item-${suffix}`],
            source,
            now,
          )(
            service.startStudySession({
              accountId: actor.accountId,
              communityId: identity.communityId,
              idempotencyKey: `start-${suffix}`,
              personaId: actor.personaId,
              postId: identity.postId,
              requestedTimezone: "UTC",
            }),
          ),
        );
        const result = await Effect.runPromise(
          provideServices(
            [`answer-${suffix}`, `qualification-${suffix}`],
            source,
            new Date(Date.parse(now) + 60_000).toISOString(),
          )(
            service.submitStudyAnswer({
              accountId: actor.accountId,
              answer: { kind: "text_response", text: "Sail away" },
              attemptNumber: 1,
              communityId: identity.communityId,
              idempotencyKey: `answer-${suffix}`,
              sessionId: session.session_id,
              sessionItemId: session.items[0]?.session_item_id ?? "missing",
            }),
          ),
        );
        expect(result.session.qualification).not.toBeNull();
      };

      await qualify(identity, "asset-claim-eligible", "2026-08-25T15:00:00.000Z");

      const secondPersonaId = `persona-${crypto.randomUUID()}`;
      await createActivePersonaFixture(admin, {
        accountId: identity.accountId,
        personaId: secondPersonaId,
        profile: { displayName: "Second Asset Persona" },
      });
      await qualify(
        { accountId: identity.accountId, personaId: secondPersonaId },
        "asset-claim-second-persona",
        "2026-08-25T15:05:00.000Z",
      );
      await qualify(missing, "asset-claim-missing", "2026-08-25T15:10:00.000Z");
      await qualify(stale, "asset-claim-stale", "2026-08-25T15:12:00.000Z");
      await qualify(second, "asset-claim-second", "2026-08-25T15:15:00.000Z");

      const claims = await admin.query<{
        readonly account_id: string;
        readonly state: string;
        readonly terminal_reason: string | null;
      }>(
        `SELECT account_id,state,terminal_reason
           FROM song_reward_bundle_claims WHERE offer_id=$1 ORDER BY account_id`,
        [offerId],
      );
      expect(claims.rows).toEqual([
        { account_id: identity.accountId, state: "credited", terminal_reason: null },
        {
          account_id: missing.accountId,
          state: "ineligible",
          terminal_reason: "verification_missing",
        },
        { account_id: second.accountId, state: "credited", terminal_reason: null },
        {
          account_id: stale.accountId,
          state: "ineligible",
          terminal_reason: "verification_stale",
        },
      ]);

      const credits = await admin.query<{
        readonly account_id: string;
        readonly amount_atomic: string;
        readonly token_address: string;
      }>(
        `SELECT account_id,amount_atomic::text,token_address
           FROM reward_ledger_credits WHERE source_kind='asset_bonus'
          ORDER BY account_id`,
      );
      expect(credits.rows).toEqual([
        { account_id: identity.accountId, amount_atomic: "100", token_address: token },
        { account_id: second.accountId, amount_atomic: "100", token_address: token },
      ]);

      const leg = await admin.query<{
        readonly fulfilled_atomic: string;
        readonly status: string;
      }>(`SELECT fulfilled_atomic::text,status FROM song_reward_offer_legs WHERE leg_id=$1`, [
        legId,
      ]);
      expect(leg.rows[0]).toEqual({ fulfilled_atomic: "200", status: "exhausted" });

      const claimLegs = await admin.query<{
        readonly state: string;
        readonly terminal_reason: string | null;
      }>(
        `SELECT state,terminal_reason FROM song_reward_bundle_claim_legs
          WHERE offer_id=$1 ORDER BY account_id`,
        [offerId],
      );
      expect(claimLegs.rows).toEqual([
        { state: "credited", terminal_reason: null },
        { state: "unavailable", terminal_reason: "verification_missing" },
        { state: "credited", terminal_reason: null },
        { state: "unavailable", terminal_reason: "verification_stale" },
      ]);

      const projections = makeControlPlaneRewardProjectionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const participantProjection = await Effect.runPromise(
        projections.listPublicSongAssetBonuses({
          accountId: identity.accountId,
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(
        participantProjection.find(({ legId: candidate }) => candidate === legId),
      ).toMatchObject({
        offerId,
        legStatus: "exhausted",
        tokenAddress: token,
        claimedCount: 2,
        availableInventoryAtomic: 0n,
        viewerState: "already_claimed",
        viewerCreditState: "credited",
      });
      expect(
        participantProjection.find(({ legId: candidate }) => candidate === unfundedLegId),
      ).toMatchObject({
        legStatus: "funding",
        claimedCount: 0,
        viewerState: "already_claimed",
        viewerCreditId: null,
      });
      const publicProjection = await Effect.runPromise(
        projections.listPublicSongAssetBonuses({
          accountId: null,
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(publicProjection).toHaveLength(2);
      expect(
        publicProjection.every(
          ({ viewerState, viewerCreditId }) => viewerState === null && viewerCreditId === null,
        ),
      ).toBe(true);

      const laterLegId = "leg-asset-claim-later";
      await admin.query(
        `INSERT INTO song_reward_offer_legs (
           leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,
           participation_starts_at,chain_id,token_address,token_decimals,token_symbol,
           asset_policy_version,amount_per_claim_atomic,max_claims,funded_atomic
         ) VALUES ($1,$2,'asset_bonus','draft',$3,'refund_to_funders_pro_rata',$4,
           '2026-08-01T00:00:00.000Z',84532,$5,6,'BONUS','bonus-v1',100,1,100)`,
        [laterLegId, offerId, identity.accountId, bytes32("e"), token],
      );
      await admin.query(
        `UPDATE song_reward_offer_legs SET status='active',activated_at=clock_timestamp(),
           updated_at=clock_timestamp() WHERE leg_id=$1`,
        [laterLegId],
      );
      const afterLaterLeg = await Effect.runPromise(
        projections.listPublicSongAssetBonuses({
          accountId: identity.accountId,
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(afterLaterLeg.find(({ legId: candidate }) => candidate === laterLegId)).toMatchObject({
        viewerState: "already_claimed",
        viewerCreditId: null,
        viewerCreditState: null,
      });
      const creditCount = await admin.query<{ readonly value: number }>(
        `SELECT count(*)::integer AS value FROM reward_ledger_credits
          WHERE source_kind='asset_bonus'`,
      );
      expect(creditCount.rows).toEqual([{ value: 2 }]);
      await expect(
        admin.query(
          `UPDATE song_reward_bundle_claims SET updated_at=clock_timestamp()
            WHERE account_id=$1 AND offer_id=$2`,
          [identity.accountId, offerId],
        ),
      ).rejects.toThrow("song reward bundle claims are append-only");
      await expect(
        admin.query(
          `UPDATE song_reward_offer_legs
              SET fulfilled_atomic=100,updated_at=clock_timestamp()
            WHERE leg_id=$1`,
          [laterLegId],
        ),
      ).rejects.toThrow("asset bonus leg accounting is not exact");
      await expect(
        admin.query(
          `INSERT INTO reward_ledger_credits (
             credit_id,account_id,payout_persona_id,chain_id,token_address,
             amount_atomic,source_kind,source_reference,state
           ) VALUES ('hostile-asset-credit',$1,$2,84532,$3,100,
             'asset_bonus','hostile-source','credited')`,
          [identity.accountId, identity.personaId, token],
        ),
      ).rejects.toThrow("reward ledger credit lacks exact asset claim");
    });
  });

  test("serializes concurrent asset claims at the funded inventory boundary", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "asset-capacity");
      const second = await seedParticipant(admin, identity, "asset-capacity-second");
      await seedVeryRewardEvidence(admin, identity.accountId, "asset-capacity");
      await seedVeryRewardEvidence(admin, second.accountId, "asset-capacity-second", "2");
      const { legId, offerId } = await seedOpenAssetBonus(admin, identity, "asset-capacity", {
        fundedAtomic: 100,
        maxClaims: 1,
      });
      const source = sourceFor(identity);
      const service = makeActivityQualificationService(
        makeControlPlaneActivityQualificationStore(
          makeDirectPostgresControlPlaneLayer(scopedConnection),
        ),
      );
      const start = (
        actor: Readonly<{ readonly accountId: string; readonly personaId: string }>,
        suffix: string,
      ) =>
        Effect.runPromise(
          provideServices(
            [`session-${suffix}`, `item-${suffix}`],
            source,
            "2026-08-25T16:00:00.000Z",
          )(
            service.startStudySession({
              accountId: actor.accountId,
              communityId: identity.communityId,
              idempotencyKey: `start-${suffix}`,
              personaId: actor.personaId,
              postId: identity.postId,
              requestedTimezone: "UTC",
            }),
          ),
        );
      const [firstSession, secondSession] = await Promise.all([
        start(identity, "asset-capacity-first"),
        start(second, "asset-capacity-second"),
      ]);
      const submit = (
        actor: Readonly<{ readonly accountId: string }>,
        suffix: string,
        session: Readonly<{
          readonly session_id: string;
          readonly items: readonly Readonly<{ readonly session_item_id: string }>[];
        }>,
      ) =>
        Effect.runPromise(
          provideServices(
            [`answer-${suffix}`, `qualification-${suffix}`],
            source,
            "2026-08-25T16:01:00.000Z",
          )(
            service.submitStudyAnswer({
              accountId: actor.accountId,
              answer: { kind: "text_response", text: "Sail away" },
              attemptNumber: 1,
              communityId: identity.communityId,
              idempotencyKey: `answer-${suffix}`,
              sessionId: session.session_id,
              sessionItemId: session.items[0]?.session_item_id ?? "missing",
            }),
          ),
        );
      const results = await Promise.all([
        submit(identity, "asset-capacity-first", firstSession),
        submit(second, "asset-capacity-second", secondSession),
      ]);
      expect(results.every(({ session }) => session.qualification !== null)).toBe(true);

      const counts = await admin.query<{
        readonly claims: number;
        readonly credits: number;
        readonly fulfilled_atomic: string;
        readonly status: string;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM song_reward_bundle_claims
             WHERE offer_id=$1) AS claims,
           (SELECT count(*)::integer FROM reward_ledger_credits
             WHERE source_kind='asset_bonus') AS credits,
           fulfilled_atomic::text,status
          FROM song_reward_offer_legs WHERE leg_id=$2`,
        [offerId, legId],
      );
      expect(counts.rows).toEqual([
        { claims: 1, credits: 1, fulfilled_atomic: "100", status: "exhausted" },
      ]);
    });
  });

  test("serializes concurrent finalization and keeps timezone updates prospective", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "concurrent");
      const source = sourceFor(identity);
      const store = makeControlPlaneActivityQualificationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const service = makeActivityQualificationService(store);
      const session = await Effect.runPromise(
        provideServices(
          ["session-concurrent", "item-concurrent"],
          source,
          "2026-08-25T13:00:00.000Z",
        )(
          service.startStudySession({
            accountId: identity.accountId,
            communityId: identity.communityId,
            idempotencyKey: "start-concurrent",
            personaId: identity.personaId,
            postId: identity.postId,
            requestedTimezone: "UTC",
          }),
        ),
      );
      const answerInput = {
        accountId: identity.accountId,
        answer: { kind: "text_response" as const, text: "Sail away" },
        attemptNumber: 1,
        communityId: identity.communityId,
        idempotencyKey: "answer-concurrent",
        sessionId: session.session_id,
        sessionItemId: session.items[0]?.session_item_id ?? "missing",
      };
      const ids = ["answer-left", "qualification-left", "answer-right", "qualification-right"];
      const submit = () =>
        Effect.runPromise(
          provideServices(
            ids,
            source,
            "2026-08-25T13:05:00.000Z",
          )(service.submitStudyAnswer(answerInput)),
        );
      const [left, right] = await Promise.all([submit(), submit()]);
      expect(left).toEqual(right);
      const counts = await admin.query<{
        readonly answers: string;
        readonly qualifications: string;
      }>(
        `SELECT (SELECT count(*)::text FROM study_session_answers) AS answers,
                (SELECT count(*)::text FROM activity_qualifications) AS qualifications`,
      );
      expect(counts.rows[0]).toEqual({ answers: "1", qualifications: "1" });

      const unchanged = await Effect.runPromise(
        provideServices(
          [],
          source,
          "2026-08-25T14:00:00.000Z",
        )(
          service.setStreakTimezone({
            accountId: identity.accountId,
            idempotencyKey: "timezone-same",
            timezone: "UTC",
          }),
        ),
      );
      expect(unchanged.timezone).toBe("UTC");
      await expect(
        Effect.runPromise(
          provideServices(
            [],
            source,
            "2026-08-26T14:00:00.000Z",
          )(
            service.setStreakTimezone({
              accountId: identity.accountId,
              idempotencyKey: "timezone-too-soon",
              timezone: "Asia/Tbilisi",
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "ActivityQualificationRejected",
        reason: "timezone-change-too-soon",
      });
    });
  });
});

afterAll(() => undefined);
