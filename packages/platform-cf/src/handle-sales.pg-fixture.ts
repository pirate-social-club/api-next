import { createHash } from "node:crypto";
import { handleSaleNamespaceActivationHash } from "@pirate/domain";
import type { Client } from "pg";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";

export async function seedAccount(
  admin: Client,
  accountId: string,
  options: Readonly<{ humanEvidence?: boolean }> = {},
): Promise<string> {
  await admin.query(`INSERT INTO users (user_id,status) VALUES ($1,'active')`, [accountId]);
  await activatePendingPersonaFixtures(admin);
  const result = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
    [accountId],
  );
  const personaId = result.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona missing");
  if (options.humanEvidence !== false) {
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query(
        `INSERT INTO evidence_receipts (
       evidence_receipt_id,proof_session_id,user_id,provider_id,issuer,method,scope_kind,
       issuer_rp_scope,issuer_rp_action_scope,protocol_version,environment,evidence_kind,
       evidence_hash,receipt_metadata,observed_at,expires_at,provenance_kind,
       provider_configuration_kind,provider_configuration_ref,provider_configuration_version
     ) VALUES ($1,$2,$3,'very.web','very','web','none',NULL,NULL,'v1','test',
               'very.web.server-verified.v1',$4,'{}'::jsonb,clock_timestamp(),
               clock_timestamp()+interval '1 hour','proof_session','managed','very:test','1')`,
        [
          `evidence-${accountId}`,
          `proof-${accountId}`,
          accountId,
          createHash("sha256").update(accountId).digest("hex"),
        ],
      );
    } finally {
      await admin.query("SET session_replication_role = origin");
    }
  }
  return personaId;
}

export async function bindPersonaToCommunity(
  admin: Client,
  input: Readonly<{
    readonly accountId: string;
    readonly communityId: string;
    readonly personaId: string;
  }>,
): Promise<void> {
  await admin.query(
    `INSERT INTO persona_community_bindings (
       persona_id, account_id, community_id, binding_source
     ) VALUES ($1,$2,$3,'first_membership')`,
    [input.personaId, input.accountId, input.communityId],
  );
}

export async function seedSaleNamespace(admin: Client, sellerId: string, communityId: string) {
  await admin.query(
    `INSERT INTO communities (
       community_id,display_name,status,created_by_user_id,created_at,updated_at,
       route_slug,route_authority_version
     ) VALUES ($1,'Handle Test','active',$2,clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')`,
    [communityId, sellerId],
  );
  await admin.query(
    `INSERT INTO community_handle_sales_authority_grants (
       grant_id,community_id,principal_account_id,authority,source_kind,status,
       granted_at,granted_by_account_id
     ) VALUES (community_handle_sales_creator_grant_id_v1($1,$2),$1,$2,
               'manage_handle_sales','creator_owner','active',clock_timestamp(),$2)`,
    [communityId, sellerId],
  );
  const activationId = "sale-activation-test";
  const activationHash = handleSaleNamespaceActivationHash({
    sale_namespace_activation_id: activationId,
    sale_namespace_activation_generation: 1,
    community_id: communityId,
    family: "hns",
    canonical_root: "charizard",
    namespace_authority_reference: "namespace-evidence-test",
    namespace_authority_generation: 1,
    dns_zone_activation_id: "dns-zone-test",
    dns_zone_activation_generation: 1,
  }).sha256;
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO community_handle_sale_namespace_activation_revisions (
         sale_namespace_activation_id,sale_namespace_activation_generation,
         sale_namespace_activation_hash,community_id,family,canonical_root,display_root,
         namespace_authority_kind,namespace_authority_reference,namespace_authority_generation,
         serving_kind,dns_zone_activation_id,dns_zone_activation_generation,root_replacement_kind,
         dedicated_root_replacement_confirmed,status,reason_code,actor_account_id,
         authority_grant_id,created_at,activated_at,suspended_at,revoked_at,recorded_at
       ) VALUES ($1,1,$2,$3,'hns','charizard','charizard','verified_namespace_v1',
                 'namespace-evidence-test',1,'hns_dns_zone_activation_v1','dns-zone-test',1,
                 'dedicated_root_replace_v1',TRUE,'active',NULL,$4,
                 community_handle_sales_creator_grant_id_v1($3,$4),clock_timestamp(),
                 clock_timestamp(),NULL,NULL,clock_timestamp())`,
      [activationId, activationHash, communityId, sellerId],
    );
    await admin.query(
      `INSERT INTO community_handle_sale_namespace_activation_current (
         sale_namespace_activation_id,family,canonical_root,community_id,current_generation,updated_at
       ) VALUES ($1,'hns','charizard',$2,1,clock_timestamp())`,
      [activationId, communityId],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  await admin.query(
    `CREATE OR REPLACE FUNCTION effective_community_handle_sale_namespace_v1(
       input_sale_namespace_activation_id TEXT,
       database_now TIMESTAMPTZ
     ) RETURNS SETOF community_handle_sale_namespace_activation_revisions
       LANGUAGE sql STABLE AS $$
         SELECT revision.*
           FROM community_handle_sale_namespace_activation_current AS current_activation
           JOIN community_handle_sale_namespace_activation_revisions AS revision
             ON revision.sale_namespace_activation_id=current_activation.sale_namespace_activation_id
            AND revision.sale_namespace_activation_generation=current_activation.current_generation
          WHERE current_activation.sale_namespace_activation_id=input_sale_namespace_activation_id
            AND revision.status='active' AND database_now IS NOT NULL
       $$`,
  );
  return activationId;
}

export const terms = (activationId: string) =>
  ({
    sale_namespace_activation_id: activationId,
    expected_sale_namespace_activation_generation: 1,
    label_scope: {
      kind: "label_rule_v2",
      label_grammar_id: "hns_ascii_ldh_1_63_v1",
      reserved_labels_id: "reserved_labels_01",
      expected_reserved_labels_revision: 1,
      availability: { kind: "length_band_v1", min_label_length: 8, max_label_length: 32 },
    },
    allocation_kind: "first_come_v1",
    fulfillment_kind: "hosted_persona_v1",
    qualification_policy_id: "none_v1",
    expected_qualification_policy_revision: 1,
    pricing_id: "platform_free_handles_v1",
    expected_pricing_revision: 1,
    issuance_driver_id: "hosted_persona-local",
    expected_issuance_driver_version: "1",
    quote_ttl_seconds: 120,
    reservation_ttl_seconds: 300,
  }) as const;
