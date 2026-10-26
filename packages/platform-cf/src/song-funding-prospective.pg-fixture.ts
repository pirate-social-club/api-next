import type { Client } from "pg";
import { sharedSongParticipantFixture } from "../../testing/src/shared-song-participant-fixture.ts";

/** Fictional admitted SQL prerequisites only. Bootstrap suppresses unrelated
 * producer triggers; actual context/policy/pot/contribution writes keep every
 * trigger and constraint enabled. No provider or managed resource is used. */
export async function seedProspectiveSongFundingFixture(admin: Client) {
  const h = "a".repeat(64),
    start = Date.now(),
    iso = (n: number) => new Date(start + n).toISOString();
  const templates = [];
  const packet = await sharedSongParticipantFixture(new Date());
  await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
  try {
    await admin.query(
      "INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES('community','Purpose fixture','active','b',now(),now())",
    );
    await admin.query(
      "INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,content_rating,author_declared_rating,created_at,updated_at) VALUES('community','prospective-song','b','persona-b','song','published','public','general','general',now(),now())",
    );
    await admin.query(
      "INSERT INTO media_publication_projections(submission_id,community_id,actor_user_id,operation_id,post_id,creation_revision,audio_revision,analysis_revision,decision_revision,canonical_audio_sha256,title,audio_asset_ref,language_status,lyrics_explicitness,alignment,data_registration,locked_delivery,author_persona_id,lyrics_status,lyrics_revision,lyrics_text) VALUES('purpose-submission','community','b','purpose-operation','prospective-song',1,1,1,1,$1,'Purpose song','r2://purpose-audio','ready','not_explicit','ready','registered','not_required','persona-b','ready',1,'Fixture lyrics')",
      [h],
    );
    await admin.query(
      "INSERT INTO song_owner_policy_revisions(community_id,post_id,audio_revision,owner_account_id,policy_revision,third_party_reward_legs,pool_leg,derivative_video,policy_hash) SELECT 'community','prospective-song',1,'b',1,'allowed','allowed','allowed',song_owner_policy_hash_v1('community','prospective-song',1,'b',1,'allowed','allowed','allowed')",
    );
    await admin.query(
      "INSERT INTO song_owner_policies(community_id,post_id,audio_revision,owner_account_id,current_policy_revision,current_policy_hash) SELECT community_id,post_id,audio_revision,owner_account_id,policy_revision,policy_hash FROM song_owner_policy_revisions WHERE post_id='prospective-song'",
    );
    for (const activity of ["study", "karaoke", "dance"] as const) {
      const doc = packet.qualification_documents.find((d) => d.activity === activity);
      const binding = packet.projection.terms.qualification_bindings.find(
        (b) => b.activity === activity,
      );
      if (!doc || !binding) throw Error("Qualification fixture required");
      const id = doc.policy_id,
        kind = doc.kind,
        hash = doc.policy_hash;
      await admin.query(
        "INSERT INTO qualification_policy_versions(qualification_policy_version_id,activity_key,policy_kind,policy_document) VALUES($1,$2,$3,$4::jsonb)",
        [id, activity, kind, JSON.stringify(doc.document)],
      );
      await admin.query(
        "UPDATE activity_registry SET status='active',producer_version='purpose-fixture',current_policy_version_id=$2 WHERE activity_key=$1",
        [activity, id],
      );
      templates.push({
        template_key: `template-${activity}`,
        activity,
        grading_family: activity === "dance" ? "moderator_verdict" : "numeric",
        qualification_policy_id: id,
        qualification_policy_hash: hash,
        numeric_floor_bps: activity === "dance" ? null : 7000,
        choreography_scope: activity === "dance" ? "any_policy_accepted" : "not_applicable",
        admission_id: binding.admission_id,
        admission_hash: binding.admission_hash,
        disclosure_version: "fixture",
      });
      if (activity === "dance") {
        const review = {
          version: "moderator-review-policy-v1",
          hash: h,
          reviewWindowMs: 604800000,
          qualificationVersion: id,
          qualificationHash: hash,
          admission: "money_admitted",
          admissionVersion: binding.admission_id,
          admissionHash: binding.admission_hash,
          producerId: "purpose-fixture",
          rubricId: "purpose-rubric",
        };
        await admin.query(
          "INSERT INTO dance_review_policy_versions_v1(policy_id,policy_hash,review_policy,operational_profile,disposition_profile,qualification_policy_version_id,accepted_by,valid_from,valid_until) VALUES('purpose-review',$1,$2,'{}','{}',$3,'fixture-operator',$4,$5)",
          [h, JSON.stringify(review), id, iso(-60000), iso(86400000)],
        );
        await admin.query(
          "INSERT INTO dance_review_policy_admissions_v1(community_id,policy_id,accepted,accepted_by,effective_at,valid_until) VALUES('community','purpose-review',true,'fixture-operator',$1,$2)",
          [iso(-60000), iso(86400000)],
        );
      }
    }
    const operations = {
      disclosureVersion: "fixture",
      feePolicyId: "fixture-fees",
      scheduleRuleId: "fixture-initialized-rows",
      scheduleRuleHash: h,
      priceRuleHash: h,
      finalityPolicyId: "fixture-finality",
      cadenceSeconds: "3600",
      entryCutoffSeconds: 60,
      purchaseLeadSeconds: 30,
      maximumContextAttempts: 3,
      contextLeaseMs: 60000,
      maximumContextWorkPerAccount: 5,
      maximumContextWorkGlobal: 10,
      contextWorkPerAttempt: 1,
      inboundRequiredGasWei: "1",
      refundEnvelopeMinimumWei: "1",
      legalActivationGate: "test_only",
      initializedDrawingIds: ["101", "102", "103", "104", "105", "106"],
    };
    await admin.query(
      "INSERT INTO reward_shared_song_templates_v2(template_id,community_id,profile_id,template_hash,attestation_id,reward_policy,compiled_plan,qualification_templates,operational_profile,accepted_by,accepted_receipt_hash,valid_from,valid_until) VALUES('purpose-template','community','profile',$1,'attestation',$2,'{}',$3,$4,'fixture-operator',$1,$5,$6)",
      [
        h,
        JSON.stringify({
          version: "shared_song_megapot_v2",
          pool_entry: "qualifying_account",
          claim_verification: "megapot_claim_time_verification_v1",
        }),
        JSON.stringify(templates),
        JSON.stringify(operations),
        iso(-60000),
        iso(86400000),
      ],
    );
    await admin.query(
      "INSERT INTO reward_shared_song_template_admissions_v2(community_id,template_id,accepted,accepted_by,admission_hash,effective_at,valid_until) VALUES('community','purpose-template',true,'fixture-operator',$1,$2,$3)",
      [h, iso(-60000), iso(86400000)],
    );
    await admin.query(
      "INSERT INTO reward_song_slots_v2(slot_id,community_id,post_id,generation,target,terms,reward_policy_ready,status) VALUES('prospective-slot','community','prospective-song',0,NULL,NULL,FALSE,'open')",
    );
    await admin.query(
      "INSERT INTO reward_funding_work_envelopes_v2 VALUES('purpose-leg','leg','empty-slot:prospective-slot','profile',NULL,100,0,0,$1,NULL)",
      [iso(86400000)],
    );
    await admin.query(
      "INSERT INTO reward_asset_whitelist(chain_id,token_address,decimals,symbol,asset_kind,environment,status,policy_version,activated_at,plain_erc20_verified_at) VALUES(84532,$1,6,'USDC','settlement_usdc','test','active','purpose-fixture',now(),now())",
      [`0x${"22".repeat(20)}`],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  return { start, postId: "prospective-song" };
}
