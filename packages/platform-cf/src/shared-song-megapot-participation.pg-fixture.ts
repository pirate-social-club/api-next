import type { Client } from "pg";
import { sharedSongParticipantFixture } from "../../testing/src/shared-song-participant-fixture.ts";
import { seedMegapotAuthority } from "./rewards-composed-pool.pg-fixture.ts";

export const participantAccount = "test-reader";
export const otherParticipantAccount = "test-other-reader";
const hash = "a".repeat(64);

/** Synthetic retained history for a read-only projection test. Bootstrap alone
 * suppresses unrelated producer triggers and foreign keys. All CHECK constraints
 * remain enabled. This is not Funding, qualification or settlement acceptance. */
export async function seedSharedSongParticipant(admin: Client) {
  const packet = await sharedSongParticipantFixture(new Date());
  const { projection: p } = packet;
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query("INSERT INTO users(user_id) VALUES($1),($2),('test-owner')", [
      participantAccount,
      otherParticipantAccount,
    ]);
    await admin.query(
      "INSERT INTO personas(persona_id,account_id) VALUES('test-owner-persona','test-owner')",
    );
    await admin.query(`INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at)
      VALUES('test-community','Projection fixture','active','test-owner',statement_timestamp(),statement_timestamp())`);
    await admin.query(`INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,
      post_type,status,visibility,content_rating,author_declared_rating,created_at,updated_at)
      VALUES('test-community','test-song','test-owner','test-owner-persona','song','published','public','general','general',statement_timestamp(),statement_timestamp())`);
    await seedMegapotAuthority(admin);
    for (const document of packet.qualification_documents) {
      await admin.query(
        `INSERT INTO qualification_policy_versions(
        qualification_policy_version_id,activity_key,policy_kind,policy_document) VALUES($1,$2,$3,$4::jsonb)`,
        [document.policy_id, document.activity, document.kind, JSON.stringify(document.document)],
      );
      await admin.query(
        `UPDATE activity_registry SET status='active',producer_version='test-producer',
        current_policy_version_id=$2 WHERE activity_key=$1`,
        [document.activity, document.policy_id],
      );
    }
    const dance = p.terms.qualification_bindings.find((binding) => binding.activity === "dance");
    if (dance === undefined) throw new Error("Dance binding required");
    for (const [id, rubric] of [
      ["test-review-a", "routine-a"],
      ["test-review-b", "routine-b"],
    ]) {
      const policyHash = id === "test-review-a" ? "b".repeat(64) : "c".repeat(64);
      await admin.query(
        `INSERT INTO dance_review_policy_versions_v1(policy_id,policy_hash,review_policy,
        operational_profile,disposition_profile,qualification_policy_version_id,accepted_by,valid_from,valid_until)
        VALUES($1,$2,$3::jsonb,'{}','{}',$4,'test-operator',$5,$6)`,
        [
          id,
          policyHash,
          JSON.stringify({
            version: "moderator-review-policy-v1",
            hash: policyHash,
            reviewWindowMs: 604800000,
            qualificationVersion: dance.qualification_policy_id,
            qualificationHash: dance.qualification_policy_hash,
            admission: "money_admitted",
            admissionVersion: dance.admission_id,
            admissionHash: dance.admission_hash,
            producerId: "test-producer",
            rubricId: rubric,
          }),
          dance.qualification_policy_id,
          p.terms.starts_at,
          p.terms.ends_at,
        ],
      );
    }
    await admin.query(
      `INSERT INTO dance_review_policy_admissions_v1(community_id,policy_id,accepted,
      accepted_by,effective_at,valid_until) VALUES('test-community','test-review-a',true,'test-operator',$1,$2)`,
      [p.terms.starts_at, p.terms.ends_at],
    );
    await admin.query(`INSERT INTO reward_uniqueness_authorities(campaign_id,issuer,method,scope_kind,issuer_rp_scope)
      VALUES('test-offer','https://verify.very.org','palm_web','issuer_rp_scope','pirate-social')`);
    await admin.query(
      `INSERT INTO policy_versions(policy_version_id,community_id,policy_key,revision,policy_hash,
      policy,compiled_plan,compiler_version,uniqueness_model,created_by_user_id,published_at,policy_purpose,uniqueness_authority_id)
      VALUES('test-reward-policy','test-community','test-key',1,$1,'{}','{}','test-version',
      '{"kind":"single_authority","authority_id":"test-offer"}','test-owner',statement_timestamp(),'reward','test-offer')`,
      [p.terms.reward_policy_hash],
    );
    await admin.query(
      `INSERT INTO song_reward_offers(offer_id,community_id,post_id,audio_revision,
      created_by_account_id,status,starts_at,ends_at,owner_policy_snapshot,terms_hash,reward_policy_version_id)
      VALUES('test-offer','test-community','test-song',1,'test-owner','active',$1,$2,'{}',$3,'test-reward-policy')`,
      [p.terms.starts_at, p.terms.ends_at, p.terms.terms_hash],
    );
    await admin.query(
      `INSERT INTO song_reward_offer_legs(leg_id,offer_id,kind,status,funder_account_id,
      refund_policy,leg_terms_hash,participation_starts_at,chain_id,token_address,token_decimals,
      tickets_per_drawing,max_ticket_price_atomic,entry_cutoff_seconds,beneficiary_algorithm_version,
      ticket_selection_version,attestation_id,participation_starts_drawing_id,eligible_activities,
      min_score_bps,empty_pool_policy,funding_source,funded_atomic,spent_atomic,
      qualification_family_v2,shared_song_terms_v2,qualification_policies)
      VALUES('test-leg','test-offer','megapot_pool','active','test-owner','refund_to_funders_pro_rata',
      $1,$2,84532,$3,6,1,2000000,300,'equal_v1','keccak_packed_v1','megapot-base-sepolia-v2',200,
      ARRAY['study','karaoke','dance'],NULL,'no_purchase','leg_budget',10000000,2000000,'shared_song',$4::jsonb,$5::jsonb)`,
      [
        `0x${p.terms.terms_hash}`,
        p.terms.starts_at,
        p.token_address,
        JSON.stringify(p.terms),
        JSON.stringify(
          p.terms.qualification_bindings.map((binding) => ({
            activity: binding.activity,
            policy: { qualification_policy_version_id: binding.qualification_policy_id },
          })),
        ),
      ],
    );
    await admin.query(
      `INSERT INTO reward_song_slots_v2(slot_id,community_id,post_id,generation,
      target,terms,reward_policy_ready,status) VALUES('test-slot','test-community','test-song',0,$1::jsonb,$2::jsonb,true,'open')`,
      [JSON.stringify(p.target), JSON.stringify(p.terms)],
    );
    await admin.query(
      `INSERT INTO song_megapot_contributions_v2(contribution_id,account_id,community_id,post_id,
      pool_leg_id,funding_effect_id,nonce_lease_id,profile_id,snapshot_id,state)
      VALUES('test-contribution','test-owner','test-community','test-song','test-leg','test-funding-effect',
      'test-lease','test-profile','test-context-snapshot',$1::jsonb)`,
      [
        JSON.stringify({
          owner: { account_id: "test-owner" },
          receipt: {
            contribution_id: "test-contribution",
            funding_effect_id: "test-funding-effect",
            target: p.target,
          },
          revision: 1,
          fundingState: "pool_credited",
        }),
      ],
    );
    await admin.query(
      `INSERT INTO reward_incoming_receipts_v2(receipt_id,contribution_id,chain_id,transaction_hash,
      transfer_log_index,sender_address,sender_nonce,amount_atomic,category,evidence)
      VALUES('test-principal','test-contribution',84532,$1,0,$2,0,10000000,'pool_principal','{}')`,
      [`0x${hash}`, `0x${"6".repeat(40)}`],
    );
    const drawing = p.drawings.find((row) => row.kind === "materialized");
    if (drawing?.drawing_at === undefined || drawing.drawing === undefined)
      throw new Error("Drawing required");
    await admin.query(
      `INSERT INTO megapot_drawing_observations(observation_id,attestation_id,chain_id,drawing_id,
      ticket_price_atomic,drawing_time,ball_max,bonusball_max,drawing_locked,referral_fee_wei,referral_win_share_wei,
      block_number,block_hash,block_timestamp,confirmations,observed_at,expires_at,raw_state_hash)
      VALUES('test-observation','megapot-base-sepolia-v2',84532,200,1000000,$1,30,10,false,0,100000000000000000,
      100,$2,statement_timestamp()-interval '1 minute',3,statement_timestamp(),statement_timestamp()+interval '1 hour',$3)`,
      [drawing.drawing_at, `0x${hash}`, hash],
    );
    await admin.query(
      `INSERT INTO megapot_pool_drawings(pool_leg_id,drawing_id,observation_id,status,
      entry_cutoff_at,ticket_price_ceiling_atomic) VALUES('test-leg',200,'test-observation','entry_open',$1,2000000)`,
      [drawing.drawing.entry_cutoff_at],
    );
    await admin.query("UPDATE reward_operations_control SET paused=false WHERE singleton");
    await admin.query("COMMIT");
    return packet;
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
