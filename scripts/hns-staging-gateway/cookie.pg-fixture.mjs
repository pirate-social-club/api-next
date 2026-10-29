import { createHash } from "node:crypto";
import {
  encodeHnsAuthorityInventory,
  hnsAuthorityCapabilitySetDigest,
} from "../../packages/application/src/namespace-ownership/hns-authority-inventory.ts";
import { seedContinuityFixture } from "../hns-continuity/promotion.pg-fixture.mjs";
import { cookieProfileFixture } from "./cookie.fixture.ts";
import { PREVIOUS_GATEWAY } from "./cookie-plan.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Historical authority is explicitly seeded with fixture-only replication
 * controls. The operation under test uses the real readers and atomic writers;
 * this seed is not proof that a creator ceremony occurred on staging. */
export async function seedCookieProfileFixture(client) {
  const manifests = await cookieProfileFixture();
  const next = JSON.parse(manifests.nextManifest);
  for (const root of ["8s28", "a18n"]) {
    const communityId =
      root === "8s28"
        ? "community_00000000-0000-4000-8000-000000000001"
        : "community_00000000-0000-4000-8000-000000000002";
    const result = await seedContinuityFixture(client, async (raw) => {
      const original = raw.state;
      const mappings = [
        [original.sale.actor_account_id, `actor-${root}`],
        [original.app.community_id, communityId],
        [original.app.route_binding_id, `route-${root}`],
        [original.sale.namespace_authority_reference, `evidence-${root}`],
        [original.sale.authority_grant_id, `sales-authority-${root}`],
        [original.sale.sale_namespace_activation_id, `sale-${root}`],
        [original.dns.dns_zone_activation_id, `dns-${root}`],
        [original.app.app_host_activation_id, `app-${root}`],
        [original.dns.canonical_root, root],
      ];
      let text = JSON.stringify(raw);
      for (const [from, to] of mappings) text = text.replaceAll(from, to);
      Object.assign(raw, JSON.parse(text));
      const state = raw.state;
      let inventoryText = Buffer.from(state.inventory.bytes_hex, "hex").toString();
      for (const [from, to] of mappings) inventoryText = inventoryText.replaceAll(from, to);
      const inventory = JSON.parse(inventoryText);
      inventory.environment = "staging";
      inventory.published_at = new Date(Date.now() - 60000).toISOString();
      inventory.expires_at = new Date(Date.now() + 86400000).toISOString();
      inventory.runtime_capability_set_digest = await hnsAuthorityCapabilitySetDigest(inventory);
      const encoded = await encodeHnsAuthorityInventory(inventory);
      state.inventory.bytes_hex = Buffer.from(encoded).toString("hex");
      state.dns.pirate_dns_authority_inventory_digest = sha(encoded);
      state.dns.gateway_deployment_reference = PREVIOUS_GATEWAY;
      state.dns.gateway_certificate_spki_sha256 = next.gateway_certificate_spki_sha256;
      state.dns.zone_hex = Buffer.from(
        Buffer.from(state.dns.zone_hex, "hex")
          .toString()
          .replaceAll(original.dns.canonical_root, root),
      ).toString("hex");
      state.dns.zone_bytes_digest = sha(Buffer.from(state.dns.zone_hex, "hex"));
      const activation = JSON.parse(
        Buffer.from(state.dns.activation_document_bytes.data).toString(),
      );
      activation.canonical_root = root;
      activation.dns_zone_activation_id = state.dns.dns_zone_activation_id;
      activation.pirate_dns_authority_inventory = [
        state.dns.pirate_dns_authority_inventory_reference,
        state.dns.pirate_dns_authority_inventory_version,
        state.dns.pirate_dns_authority_inventory_digest,
      ];
      activation.gateway = [PREVIOUS_GATEWAY, next.gateway_certificate_spki_sha256];
      activation.zone[1] = state.dns.zone_bytes_digest;
      state.dns.activation_document_bytes = Buffer.from(JSON.stringify(activation)).toJSON();
      state.app.gateway_deployment_reference = PREVIOUS_GATEWAY;
      state.app.route_authority_kind = "verified_namespace_v1";
      state.app.route_authority_reference = `evidence-${root}`;
      state.app.route_authority_generation = "1";
      state.sale.namespace_authority_reference = `evidence-${root}`;
      state.sale.namespace_authority_generation = "1";
      state.health.observed_gateway_deployment_reference = PREVIOUS_GATEWAY;
      state.health.observed_gateway_certificate_spki_sha256 = next.gateway_certificate_spki_sha256;
      state.health.observed_zone_bytes_digest = state.dns.zone_bytes_digest;
    });
    if (root === "8s28") await seedRecoveredLineage(client, result.state);
    else {
      await client.query("SET session_replication_role=replica");
      try {
        await client.query(
          "UPDATE hns_dns_zone_health_observations SET valid_until=clock_timestamp()-interval '1 hour',checked_at=clock_timestamp()-interval '2 hours' WHERE dns_zone_activation_id=$1",
          [result.state.dns.dns_zone_activation_id],
        );
      } finally {
        await client.query("SET session_replication_role=origin");
      }
    }
    await client.query("SET session_replication_role=replica");
    try {
      await client.query(
        "INSERT INTO personas(persona_id,account_id,status,is_first_persona) VALUES($1,$2,'active',true)",
        [`persona-${root}`, `actor-${root}`],
      );
      await client.query(
        `INSERT INTO handle_grants(grant_id,community_id,offering_id,offering_hash,claim_id,owner_account_id,owner_persona_id,sale_namespace_activation_id,sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,handle_label,display_identifier,status,issued_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'hosted_persona_v1','hns',$10,'participant',$11,'active',clock_timestamp(),clock_timestamp())`,
        [
          `grant-${root}`,
          communityId,
          `offering-${root}`,
          "a".repeat(64),
          `claim-${root}`,
          `actor-${root}`,
          `persona-${root}`,
          result.state.sale.sale_namespace_activation_id,
          result.state.sale.sale_namespace_activation_generation,
          root,
          `participant.${root}`,
        ],
      );
    } finally {
      await client.query("SET session_replication_role=origin");
    }
  }
  return {
    previousManifest: manifests.previousManifest,
    nextManifest: manifests.nextManifest,
    sourceCommit: "f".repeat(40),
  };
}

async function seedRecoveredLineage(client, state) {
  const now = new Date(Date.now() - 10000).toISOString();
  const until = new Date(Date.now() + 86400000).toISOString();
  const expired = new Date(Date.now() - 3600000).toISOString();
  const hex = "a".repeat(64),
    root = "8s28",
    evidence = "recovered-evidence-8s28";
  const route = {
    family: "hns",
    root_label: root,
    root_label_display: root,
    path_segment: `app.${root}`,
  };
  const provider = {
    provider_id: "hns.owner.v1",
    provider_binding_hash: hex,
    provider_configuration_kind: "managed",
    provider_configuration_reference: "cookie-fixture-configuration",
    provider_configuration_version: "1",
    provider_configuration_digest: hex,
  };
  const recovery = {
    operation_mode: "same_root_recovery",
    principal_kind: "user",
    principal_id: "actor-8s28",
    recovery_authority_kind: "database_time_expiry_transition",
    recovery_authority_reference: "expiry-8s28",
    public_start_hash: hex,
    provider_start_hash: hex,
    challenge_expires_at: until,
  };
  const common = {
    ...route,
    ...provider,
    community_id: state.app.community_id,
    route_binding_id: "route-8s28",
    expected_binding_generation: 2,
    requirement_hash: hex,
    revalidation_session_id: "recovery-session-8s28",
    route_revalidation_id: "recovery-8s28",
    protocol_version: "hns-owner-recovery-v1",
    environment: "staging",
  };
  const insert = async (table, row) => {
    const keys = Object.keys(row);
    await client.query(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
      Object.values(row),
    );
  };
  await client.query("SET session_replication_role=replica");
  try {
    await client.query(
      "UPDATE community_route_ownership_evidence SET provider_id='hns.owner.v1',provider_binding_hash=$1,provider_configuration_version='1',expires_at=$2 WHERE evidence_ref='evidence-8s28'",
      [hex, expired],
    );
    await insert("community_route_lifecycle_transitions", {
      ...route,
      route_lifecycle_transition_id: "expiry-8s28",
      version: "pirate-community-route-lifecycle-transition-v1",
      transition_kind: "database_time_expired",
      community_id: state.app.community_id,
      route_binding_id: "route-8s28",
      principal_kind: "system",
      principal_id: "fixture",
      expected_binding_generation: 1,
      resulting_binding_generation: 2,
      expected_verified_evidence_ref: "evidence-8s28",
      observed_evidence_expires_at: expired,
      transitioned_at: now,
      ownership_status: "expired",
      route_lifecycle_status: "suspended",
    });
    await insert("community_route_revalidation_sessions", {
      ...common,
      ...recovery,
      start_fence_token: 1,
      start_idempotency_key: "cookie-recovery",
      start_request_hash: hex,
      upstream_session_ref: "cookie-recovery-upstream",
      start_presentation: {},
      status: "completed",
      started_at: now,
      expires_at: until,
      terminal_at: now,
    });
    await insert("community_route_revalidation_completion_attempts", {
      route_revalidation_attempt_id: "recovery-attempt-8s28",
      route_revalidation_id: common.route_revalidation_id,
      revalidation_session_id: common.revalidation_session_id,
      route_binding_id: common.route_binding_id,
      expected_binding_generation: 2,
      attempt_number: 1,
      idempotency_key: "cookie-recovery-poll",
      completion_request_hash: hex,
      evidence_ref: evidence,
      state: "consumed",
      fence_token: 1,
      lease_expires_at: until,
      consumption_kind: "verified",
      result_hash: hex,
      terminal_at: now,
      created_at: now,
      updated_at: now,
      terminal_result_document: "{}",
      terminal_result_version: "pirate-hns-owner-recovery-result-v2",
      operation_mode: "same_root_recovery",
      observation_id: "cookie-observation",
    });
    await insert("community_route_ownership_evidence", {
      ...route,
      evidence_ref: evidence,
      route_revalidation_attempt_id: "recovery-attempt-8s28",
      verified_by_actor_id: "actor-8s28",
      requirement_hash: hex,
      provider_id: provider.provider_id,
      provider_binding_hash: hex,
      provider_configuration_version: "1",
      provider_identity_digest: hex,
      evidence_digest: hex,
      binding_generation: 3,
      verified_at: now,
      expires_at: until,
      origin: "route_revalidation",
    });
    const snapshot = {
      ...common,
      ...recovery,
      evidence_ref: evidence,
      route_revalidation_attempt_id: "recovery-attempt-8s28",
      binding_generation: 3,
      start_request_hash: hex,
      upstream_session_ref: "cookie-recovery-upstream",
      fence_token: 1,
      abi_version: "pirate-hns-owner-recovery-evidence-v1",
      ownership_source: "hns_parent_chain_txt",
      challenge_name: root,
      challenge_value_sha256: "b".repeat(64),
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "hns-main",
      chain_anchor_height: 1,
      chain_anchor_block_hash: hex,
      chain_anchor_median_time: 1,
      expiry_height: 200000,
      observed_at: now,
      expires_at: until,
      provider_evidence_ref: "cookie-fixture-evidence",
      observation_sha256: hex,
      provider_identity_digest: hex,
      evidence_digest: hex,
      observation: { status: "verified" },
      raw_response_bytes: Buffer.from("{}"),
      poll_hash: hex,
      observation_contract_version: "pirate-hns-target-observation-v2",
    };
    await insert("community_route_revalidation_evidence_snapshots", snapshot);
    for (const [ref, txt] of [
      ["evidence-8s28", hex],
      [evidence, "b".repeat(64)],
    ])
      await insert("community_route_hns_control_identities", {
        evidence_ref: ref,
        root_label: root,
        txt_name: root,
        ownership_source: "hns_parent_chain_txt",
        expected_txt_value_sha256: txt,
        control_identity_digest: hex,
        chain_authority_digest: hex,
        provider_evidence_ref: "cookie-fixture-evidence",
      });
    await client.query(
      "UPDATE community_canonical_route_bindings SET binding_generation=3,verified_evidence_ref=$1 WHERE route_binding_id='route-8s28'",
      [evidence],
    );
    await client.query(
      "UPDATE hns_community_app_host_activation_revisions SET route_authority_reference=$1,route_authority_generation=3 WHERE canonical_root='8s28'",
      [evidence],
    );
    await client.query(
      "UPDATE community_handle_sale_namespace_activation_revisions SET namespace_authority_reference=$1,namespace_authority_generation=3 WHERE canonical_root='8s28'",
      [evidence],
    );
    await insert("hns_root_import_activation_operations", {
      operation_id: "cookie-import",
      root_import_session_id: "cookie-import-session",
      actor_id: "actor-8s28",
      creation_intent_id: "cookie-creation",
      idempotency_key: "cookie-import",
      request_sha256: hex,
      expected_session_revision: 1,
      community_id: state.app.community_id,
      dns_zone_activation_id: state.dns.dns_zone_activation_id,
      app_host_activation_id: state.app.app_host_activation_id,
      sale_namespace_activation_id: state.sale.sale_namespace_activation_id,
      sale_namespace_activation_sha256: hex,
      result_session_revision: 2,
      committed_at: now,
    });
  } finally {
    await client.query("SET session_replication_role=origin");
  }
}
