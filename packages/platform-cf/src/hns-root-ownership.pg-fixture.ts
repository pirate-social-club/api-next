import { createHash } from "node:crypto";
import { hnsControlIdentityDigest } from "@pirate/application/namespace-ownership";
import { Sha256Hex } from "@pirate/domain/verification";
import { Schema } from "effect";
import type { Client } from "pg";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const expiresAt = "2099-01-01T00:00:00.000Z";

export async function seedOwnership(client: Client, ownerTxt = false): Promise<void> {
  const providerId = ownerTxt ? "hns.owner.v1" : "namespace-provider";
  const environment = ownerTxt ? "staging" : "test";
  await client.query("INSERT INTO users (user_id) VALUES ('actor-root-import')");
  await client.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash, revision, status,
       draft, canonical_policy_revision, canonical_policy_hash, verification_requirement_hash,
       verification_provider_id, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, expires_at
     ) VALUES (
       'intent-root-import', 'actor-root-import', 'create-root-import', $1, 1,
       'verification_required', '{}'::jsonb, 1, $1, $2, '${providerId}',
       'managed', 'namespace-config', 'v1', $3::timestamptz
     )`,
    [SHA_A, SHA_B, expiresAt],
  );
  await client.query(
    `INSERT INTO community_creation_requirement_states (
       intent_id, actor_id, requirement_kind, status, requirement_hash, provider_id,
       provider_binding_hash, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, route_family, route_root_label,
       route_root_label_display, route_path_segment
     ) VALUES (
       'intent-root-import', 'actor-root-import', 'namespace_ownership', 'unmet', $1,
       '${providerId}', $2, 'managed', 'namespace-config', 'v1', 'hns',
       'newroot', 'newroot', 'app.newroot'
     )`,
    [SHA_B, SHA_C],
  );
  await client.query(
    `INSERT INTO community_creation_ceremony_attempts (
       ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
       requirement_hash, provider_id, provider_binding_hash, provider_configuration_kind,
       provider_configuration_ref, provider_configuration_version, route_family,
       route_root_label, route_root_label_display, route_path_segment,
       reservation_request_hash, reservation_request, expires_at
     ) VALUES (
       'ceremony-root-import', 'actor-root-import', 'intent-root-import',
       'namespace_ownership', 1, $1, '${providerId}', $2, 'managed',
       'namespace-config', 'v1', 'hns', 'newroot', 'newroot', 'app.newroot',
       $3, '{}'::jsonb, $4::timestamptz
     )`,
    [SHA_B, SHA_C, SHA_A, expiresAt],
  );
  await client.query(
    `UPDATE community_creation_requirement_states
        SET status = 'pending', generation = 1,
            current_ceremony_intent_id = 'ceremony-root-import',
            updated_at = clock_timestamp()
      WHERE intent_id = 'intent-root-import'
        AND requirement_kind = 'namespace_ownership'`,
  );
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO namespace_ownership_start_reservations (
       reservation_id, namespace_session_id, actor_id, creation_intent_id,
       ceremony_intent_id, generation, requirement_hash, expected_revision,
       client_idempotency_key, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
       protocol_version, environment, route_family, route_root_label,
       route_root_label_display, route_path_segment, route_href, route_app_host,
       state, fence_token, lease_expires_at
     ) VALUES (
       'reservation-root-import', 'namespace-root-import', 'actor-root-import',
       'intent-root-import', 'ceremony-root-import', 1, $1, 1, 'start-root-import',
       $2, '${providerId}', $3, 'managed', 'namespace-config', 'v1',
       'hns-txt-v1', '${environment}', 'hns', 'newroot', 'newroot', 'app.newroot',
       '/c/app.newroot', NULL, 'acquired', 1, clock_timestamp() + interval '30 minutes'
     )`,
    [SHA_B, SHA_A, SHA_C],
  );
  await client.query(
    `INSERT INTO namespace_ownership_sessions (
       namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
       start_reservation_id, start_fence_token, expected_revision, generation,
       requirement_hash, request_hash, provider_id, provider_binding_hash,
       provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, protocol_version, environment, route_family,
       route_root_label, route_root_label_display, route_path_segment, route_href,
       route_app_host, upstream_session_ref, presentation_kind, presentation_payload,
       status, started_at, expires_at
     ) VALUES (
       'namespace-root-import', 'actor-root-import', 'intent-root-import',
       'ceremony-root-import', 'reservation-root-import', 1, 1, 1, $1, $2,
       '${providerId}', $3, 'managed', 'namespace-config', 'v1', 'hns-txt-v1',
       '${environment}', 'hns', 'newroot', 'newroot', 'app.newroot', '/c/app.newroot', NULL,
       'upstream-root-import', 'poll', '{"session_id":"upstream-root-import"}'::jsonb,
       'pending', clock_timestamp() - interval '1 minute', $4::timestamptz
     )`,
    [SHA_B, SHA_A, SHA_C, expiresAt],
  );
  await client.query(
    `UPDATE namespace_ownership_start_reservations
        SET state = 'finalized', updated_at = clock_timestamp()
      WHERE reservation_id = 'reservation-root-import'`,
  );
  await client.query("COMMIT");
}

export async function seedSatisfiedOwnership(admin: Client): Promise<string> {
  const row = (
    await admin.query<{ provider_id: string }>(
      "SELECT provider_id FROM namespace_ownership_sessions WHERE namespace_session_id='namespace-root-import'",
    )
  ).rows[0];
  const ownerTxt = row?.provider_id === "hns.owner.v1";
  const providerId = ownerTxt ? "hns.owner.v1" : "namespace-provider";
  const environment = ownerTxt ? "staging" : "test";
  const expiry = ownerTxt ? new Date(Date.now() + 15_000).toISOString() : expiresAt;
  const challengeHash = createHash("sha256").update("pirate-verification=challenge").digest("hex");
  const controlIdentity = await hnsControlIdentityDigest({
    ownership_source: "hns_parent_chain_txt",
    txt_name: "newroot",
    root_label: "newroot",
    expected_txt_value: "pirate-verification=challenge",
    chain_authority_digest: Schema.decodeUnknownSync(Sha256Hex)(SHA_A),
  });
  const observation = JSON.stringify(
    ownerTxt
      ? {
          status: "verified",
          control_identity_digest: controlIdentity,
          chain_authority_digest: SHA_A,
        }
      : { status: "verified" },
  );
  const resultHash = "d".repeat(64);
  await admin.query("BEGIN");
  try {
    await admin.query(
      `INSERT INTO namespace_ownership_completion_attempts (
         completion_attempt_id,namespace_session_id,actor_id,idempotency_key,
         completion_request_hash,evidence_ref,submission_channel,state,fence_token,
         lease_expires_at
       ) VALUES ('completion-root-import','namespace-root-import','actor-root-import',
         'complete-root-import',$1,'evidence-root-import','poll_result','leased',1,
         clock_timestamp()+interval '30 minutes')`,
      [SHA_A],
    );
    await admin.query(
      `UPDATE namespace_ownership_completion_attempts
          SET state='consumed',consumption_kind='verified',updated_at=clock_timestamp()
        WHERE completion_attempt_id='completion-root-import'`,
    );
    await admin.query(
      `INSERT INTO namespace_ownership_evidence_snapshots (
         evidence_ref,completion_attempt_id,namespace_session_id,actor_id,creation_intent_id,
         ceremony_intent_id,generation,requirement_hash,request_hash,provider_id,
         provider_binding_hash,provider_configuration_kind,provider_configuration_ref,
         provider_configuration_version,protocol_version,environment,family,root_label,
         root_label_display,path_segment,href,app_host,upstream_session_ref,fence_token,
         abi_version,ownership_source,challenge_name,challenge_value_sha256,root_exists,
         root_control_verified,expiry_horizon_sufficient,chain_network,chain_anchor_height,
         chain_anchor_block_hash,chain_anchor_median_time,expiry_height,observed_at,expires_at,
         provider_evidence_ref,observation_sha256,provider_identity_digest,evidence_digest,
         observation,raw_response_bytes
       ) VALUES (
         'evidence-root-import','completion-root-import','namespace-root-import',
         'actor-root-import','intent-root-import','ceremony-root-import',1,$1,$2,
         '${providerId}',$3,'managed','namespace-config','v1','hns-txt-v1','${environment}',
         'hns','newroot','newroot','app.newroot','/c/app.newroot',NULL,
         'upstream-root-import',1,'pirate-hns-ownership-evidence-v1',
         'hns_parent_chain_txt','newroot',$5,TRUE,TRUE,TRUE,'hns-main',100,$2,1000,200,
         clock_timestamp()-interval '1 minute',$4::timestamptz,
         'provider-evidence-root-import',$2,$2,$2,
         $6::jsonb,$7::bytea
       )`,
      [
        SHA_B,
        SHA_A,
        SHA_C,
        expiry,
        ownerTxt ? challengeHash : SHA_A,
        observation,
        Buffer.from(observation),
      ],
    );
    await admin.query(
      `INSERT INTO community_creation_ceremony_results (
         ceremony_intent_id,actor_id,intent_id,requirement_kind,generation,
         requirement_hash,provider_id,provider_binding_hash,provider_configuration_version,
         callback_idempotency_key,callback_request_hash,outcome_status,result_hash,
         evidence_ref,evidence_digest,provider_identity_digest,terminal_at,satisfied_at,
         namespace_session_id,completion_attempt_id,submission_channel
       ) VALUES (
         'ceremony-root-import','actor-root-import','intent-root-import','namespace_ownership',1,
         $1,'${providerId}',$2,'v1','complete-root-import',$3,'satisfied',$4,
         'evidence-root-import',$3,$3,transaction_timestamp()-interval '1 minute',
         transaction_timestamp()-interval '1 minute','namespace-root-import',
         'completion-root-import','poll_result'
       )`,
      [SHA_B, SHA_C, SHA_A, resultHash],
    );
    await admin.query(
      `UPDATE community_creation_requirement_states
          SET status='satisfied',satisfied_at=transaction_timestamp()-interval '1 minute',
              updated_at=clock_timestamp()
        WHERE intent_id='intent-root-import' AND requirement_kind='namespace_ownership'`,
    );
    await admin.query(
      `INSERT INTO community_route_ownership_evidence (
         evidence_ref,creation_ceremony_intent_id,verified_by_actor_id,family,root_label,
         root_label_display,path_segment,requirement_hash,provider_id,provider_binding_hash,
         provider_configuration_version,provider_identity_digest,evidence_digest,
         binding_generation,verified_at,expires_at
       ) VALUES ('evidence-root-import','ceremony-root-import','actor-root-import','hns',
         'newroot','newroot','app.newroot',$1,'${providerId}',$2,'v1',$3,$3,1,
         transaction_timestamp()-interval '1 minute',$4::timestamptz)`,
      [SHA_B, SHA_C, SHA_A, expiry],
    );
    await admin.query(
      `UPDATE namespace_ownership_sessions
          SET status='completed',terminal_at=transaction_timestamp()-interval '1 minute',
              completed_at=transaction_timestamp()-interval '1 minute',updated_at=clock_timestamp()
        WHERE namespace_session_id='namespace-root-import'`,
    );
    if (ownerTxt) {
      const config = Buffer.from('{"kind":"test"}');
      await admin.query(
        `INSERT INTO hns_control_observer_configurations
        (provider_configuration_reference, provider_configuration_version, provider_configuration_digest, configuration_bytes)
        VALUES ('namespace-config','v1',$1,$2)`,
        [createHash("sha256").update(config).digest("hex"), config],
      );
      await admin.query(
        `INSERT INTO community_route_hns_control_identities
        (evidence_ref,ownership_source,root_label,txt_name,expected_txt_value_sha256,control_identity_digest,chain_authority_digest,provider_evidence_ref)
        VALUES ('evidence-root-import','hns_parent_chain_txt','newroot','newroot',$1,$2,$3,'provider-evidence-root-import')`,
        [challengeHash, controlIdentity, SHA_A],
      );
    }
    await admin.query("COMMIT");
    return resultHash;
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
