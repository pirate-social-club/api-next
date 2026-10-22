import { Effect } from "effect";
import type { Client } from "pg";
import { prepareModeratedDanceTerms } from "../../application/src/use-cases/dance/moderated-intake.ts";
import { prepareModeratedDancePolicyPublication } from "../../application/src/use-cases/dance/moderated-policy.ts";
import { moderatedDanceContextFixture } from "../../testing/src/moderated-dance-context-fixture.ts";
import type { seedModeratedDanceIntake } from "./moderated-dance-intake.pg-fixture.ts";
import { seedMegapotAuthority } from "./rewards-composed-pool.pg-fixture.ts";

/** Synthetic retained graph for projection only. Bootstrap suppresses unrelated
 * command triggers, never the reads under test. No funding/recording acceptance,
 * provider call, runtime activation or financial operation is demonstrated. */
export async function seedCapturedSharedDanceObjective(
  f: Awaited<ReturnType<typeof seedModeratedDanceIntake>>,
  admin: Client,
) {
  const fixture = await moderatedDanceContextFixture(true),
    o = fixture.resolved;
  const policy = await Effect.runPromise(
    prepareModeratedDancePolicyPublication({
      ...f.publication,
      policy_id: "context-money-policy",
      policy: {
        ...f.publication.policy,
        admission: "money_admitted",
        qualificationVersion: o.binding.qualification_policy_id,
        admissionVersion: o.binding.admission_id,
        admissionHash: o.binding.admission_hash,
        producerId: "test-producer",
      },
    }),
  );
  if (policy.policy.qualificationHash !== o.binding.qualification_policy_hash)
    throw new Error("Inconsistent fictional qualification");
  await admin.query("SELECT publish_moderated_dance_policy_v1($1::jsonb)", [
    JSON.stringify(policy),
  ]);
  const terms = await Effect.runPromise(
    prepareModeratedDanceTerms(
      {
        ...f.facts,
        nowMs: Date.now(),
        policyId: policy.policy_id,
        policy: policy.policy,
        disposition: policy.disposition,
        objectives: [
          {
            id: o.binding.objective_id,
            version: o.binding.qualification_policy_id,
            termsHash: o.terms.terms_hash,
            fundingPolicyHash: o.terms.funding_policy_hash,
            gradingMode: "moderator_verdict",
          },
        ],
      },
      {
        sessionId: crypto.randomUUID(),
        reviewId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
      },
      "arms_t",
    ),
  );
  const target = {
    ...o.target,
    community_id: f.facts.communityId,
    post_id: f.facts.songPostId,
    canonical_song_id: f.facts.songPostId,
    audio_revision: f.facts.audioRevision,
  };
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await seedMegapotAuthority(admin);
    await admin.query(
      "INSERT INTO reward_uniqueness_authorities(campaign_id,issuer,method,scope_kind,issuer_rp_scope) VALUES('test-offer','https://verify.very.org','palm_web','issuer_rp_scope','pirate-social')",
    );
    await admin.query(
      "INSERT INTO policy_versions(policy_version_id,community_id,policy_key,revision,policy_hash,policy,compiled_plan,compiler_version,uniqueness_model,created_by_user_id,published_at,policy_purpose,uniqueness_authority_id) VALUES('context-reward-policy',$1,'context-key',1,$2,'{}','{}','test-version','{\"kind\":\"single_authority\",\"authority_id\":\"test-offer\"}','private-test-owner',statement_timestamp(),'reward','test-offer')",
      [f.facts.communityId, o.terms.reward_policy_hash],
    );
    await admin.query(
      "INSERT INTO song_reward_offers(offer_id,community_id,post_id,audio_revision,created_by_account_id,status,starts_at,ends_at,owner_policy_snapshot,terms_hash,reward_policy_version_id) VALUES('test-offer',$1,$2,$3,'private-test-owner','active',$4,$5,'{}',$6,'context-reward-policy')",
      [
        f.facts.communityId,
        f.facts.songPostId,
        f.facts.audioRevision,
        o.terms.starts_at,
        o.terms.ends_at,
        o.terms.terms_hash,
      ],
    );
    await admin.query(
      `INSERT INTO song_reward_offer_legs(leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,participation_starts_at,chain_id,token_address,token_decimals,tickets_per_drawing,max_ticket_price_atomic,entry_cutoff_seconds,beneficiary_algorithm_version,ticket_selection_version,attestation_id,participation_starts_drawing_id,eligible_activities,min_score_bps,empty_pool_policy,funding_source,funded_atomic,qualification_family_v2,shared_song_terms_v2,qualification_policies)
      VALUES('test-leg','test-offer','megapot_pool','active','private-test-owner','refund_to_funders_pro_rata',$1,$2,84532,$3,6,1,2000000,300,'equal_v1','keccak_packed_v1','megapot-base-sepolia-v2',200,ARRAY['study','karaoke','dance'],NULL,'no_purchase','leg_budget',10000000,'shared_song',$4::jsonb,$5::jsonb)`,
      [
        `0x${o.terms.terms_hash}`,
        o.terms.starts_at,
        o.token_address,
        JSON.stringify(o.terms),
        JSON.stringify(
          o.terms.qualification_bindings.map((binding) => ({
            activity: binding.activity,
            policy: { qualification_policy_version_id: binding.qualification_policy_id },
          })),
        ),
      ],
    );
    await admin.query(
      "INSERT INTO reward_song_slots_v2(slot_id,community_id,post_id,generation,target,terms,reward_policy_ready,status) VALUES('context-slot',$1,$2,0,$3::jsonb,$4::jsonb,true,'open')",
      [f.facts.communityId, f.facts.songPostId, JSON.stringify(target), JSON.stringify(o.terms)],
    );
    await admin.query(
      "INSERT INTO dance_moderated_sessions_v1(session_id,review_id,attempt_id,account_id,persona_id,community_id,song_post_id,choreography_id,choreography_revision,policy_id,capture_account_fence,terms,terms_hash,created_at,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11::jsonb,$12,to_timestamp($13::NUMERIC/1000),to_timestamp($14::NUMERIC/1000),'created')",
      [
        terms.capture.sessionId,
        terms.capture.reviewId,
        terms.capture.attemptId,
        f.facts.accountId,
        f.facts.personaId,
        f.facts.communityId,
        f.facts.songPostId,
        f.facts.choreographyId,
        f.facts.choreographyRevision,
        policy.policy_id,
        JSON.stringify(terms),
        terms.terms_hash,
        terms.created_at_ms,
        terms.capture.captureExpiresAtMs,
      ],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  return { terms, policy, resolved: o };
}

/** Deliberate corrupt-data injection, never a supported state transition. */
export async function injectContextLineageFault(
  admin: Client,
  sql: string,
  values: readonly unknown[] = [],
) {
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query(sql, [...values]);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
