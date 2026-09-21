import { confirmPersonaEvmWallet, prepareActivityPersona } from "@pirate/application";
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
import type { Client } from "pg";
import {
  AUDIO_REVISION,
  AUTHOR_ID,
  addressFor,
  COMMUNITY_ID,
  POST_ID,
} from "./activity-participation-composed.pg-fixture.ts";
import type { Runtime } from "./activity-participation-composed-drivers.pg-fixture.ts";
import {
  makeControlPlanePersonaStore,
  makeControlPlanePersonaWalletStore,
} from "./persona-repository.ts";

export async function seedVeryRewardEvidence(
  admin: Client,
  accountId: string,
  suffix: string,
  subjectDigest = "1".repeat(64),
): Promise<void> {
  const proofSessionId = `composed-proof-${suffix}`;
  const subjectId = `composed-subject-${suffix}`;
  const bindingEventId = `composed-binding-${suffix}`;
  const receiptId = `composed-receipt-${suffix}`;
  const bindingId = `composed-group-${suffix}`;
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
      subjectDigest,
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
      values: [subjectId, VERY_WEB_ISSUER, VERY_WEB_METHOD, VERY_WEB_RP_SCOPE, subjectDigest],
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
        subjectDigest,
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
      values: [proofSessionId, `composed-complete-${suffix}`, subjectDigest],
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

export async function seedFundedAssetBonus(
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

export const prepareIdentity = (runtime: Runtime) => {
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

export const confirmWallet = (runtime: Runtime) => {
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
