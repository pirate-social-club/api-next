import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  buildHnsRootImportPublishPlanV1,
  decodeHnsAuthorityInventoryBytes,
  encodeHnsAuthorityInventory,
  encodeHnsRootImportNameProofResultV1,
  encodeHnsRootImportReadinessResultV1,
  HNS_AUTHORITY_INVENTORY_VERSION,
  HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION,
  HNS_ROOT_IMPORT_READINESS_RESULT_VERSION,
  type HnsRootImportActivationRecord,
  type HnsRootImportStartRecord,
  hnsAuthorityCapabilitySetDigest,
  hnsRootImportLifecycleDeadlinePatchV1,
  hnsRootImportLifecycleStateFromRowV1,
} from "@pirate/application/namespace-ownership";
import {
  canonicalJson,
  decideHnsRootImportLifecycleV1,
  HNS_ROOT_IMPORT_POLICY_V1,
  type HnsRootImportLifecycleEventV1,
} from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneHnsCommunityRootImportRepository } from "./hns-community-root-import-repository.ts";
import { verifyHnsImportedInventoryRenewal } from "./hns-imported-inventory-renewal.pg-cases.ts";
import { verifyHnsRenewalRecovery } from "./hns-root-health-renewal.pg-cases.ts";
import { makeControlPlaneHnsRootImportStore } from "./hns-root-import-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const expiresAt = "2099-01-01T00:00:00.000Z";

function schemaIdentifier(): string {
  return `api_next_hns_root_import_${randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    const scoped = connectionForSchema(connectionString, schema);
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await seedOwnership(admin);
    return await use(scoped, admin);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedOwnership(client: Client): Promise<void> {
  await client.query("INSERT INTO users (user_id) VALUES ('actor-root-import')");
  await client.query(
    `INSERT INTO community_creation_intents (
       intent_id, actor_id, create_idempotency_key, create_request_hash, revision, status,
       draft, canonical_policy_revision, canonical_policy_hash, verification_requirement_hash,
       verification_provider_id, provider_configuration_kind, provider_configuration_ref,
       provider_configuration_version, expires_at
     ) VALUES (
       'intent-root-import', 'actor-root-import', 'create-root-import', $1, 1,
       'verification_required', '{}'::jsonb, 1, $1, $2, 'namespace-provider',
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
       'namespace-provider', $2, 'managed', 'namespace-config', 'v1', 'hns',
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
       'namespace_ownership', 1, $1, 'namespace-provider', $2, 'managed',
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
       $2, 'namespace-provider', $3, 'managed', 'namespace-config', 'v1',
       'hns-txt-v1', 'test', 'hns', 'newroot', 'newroot', 'app.newroot',
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
       'namespace-provider', $3, 'managed', 'namespace-config', 'v1', 'hns-txt-v1',
       'test', 'hns', 'newroot', 'newroot', 'app.newroot', '/c/app.newroot', NULL,
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

function startRecord(): HnsRootImportStartRecord {
  return {
    actor_id: "actor-root-import",
    creation_intent_id: "intent-root-import",
    ceremony_intent_id: "ceremony-root-import",
    namespace_session_id: "namespace-root-import",
    root_import_session_id: "root-import-session",
    ownership_generation: 1,
    ownership_expected_revision: 1,
    root_label: "newroot",
    challenge_txt_value: "pirate-verification=challenge",
    expires_at: expiresAt,
    idempotency_key: "root-import-idempotency",
    request_sha256: SHA_A,
    provision_job_id: "provision-root-import",
  };
}

function provisionRequest(record: HnsRootImportStartRecord) {
  const bytes = new TextEncoder().encode(
    canonicalJson({
      version: "pirate-hns-authority-provision-request-v1",
      root_import_session_id: record.root_import_session_id,
      namespace_session_id: record.namespace_session_id,
      root_label: record.root_label,
      challenge_txt_value: record.challenge_txt_value,
      expires_at: record.expires_at,
    }),
  );
  return { bytes, sha256: sha256(bytes) };
}

async function beginProvisioning(
  store: ReturnType<typeof makeControlPlaneHnsRootImportStore>,
  record: HnsRootImportStartRecord,
  ownershipResultHash: string,
) {
  const request = provisionRequest(record);
  const outcome = await Effect.runPromise(
    Effect.scoped(
      store.beginProvisioning({
        poll: {
          actor_id: record.actor_id,
          creation_intent_id: record.creation_intent_id,
          root_import_session_id: record.root_import_session_id,
          expected_revision: 1,
          idempotency_key: "provision-root-import-after-ownership",
        },
        poll_request_sha256: SHA_B,
        authorization: {
          kind: "namespace_ownership",
          result_sha256: ownershipResultHash,
        },
        provision_job_id: record.provision_job_id,
        provision_request_bytes: request.bytes,
        provision_request_sha256: request.sha256,
      }),
    ),
  );
  return { outcome, request };
}

async function provisionRootImport(
  store: ReturnType<typeof makeControlPlaneHnsRootImportStore>,
  admin: Client,
) {
  const record = startRecord();
  await Effect.runPromise(Effect.scoped(store.start(record)));
  const ownershipResultHash = await seedSatisfiedOwnership(admin);
  const provisioning = await beginProvisioning(store, record, ownershipResultHash);
  expect(provisioning.outcome).toMatchObject({
    kind: "provisioning",
    session: { status: "provisioning", revision: 2 },
  });
  const claim = await admin.query<{ lease_fence: string }>(
    "SELECT * FROM claim_hns_authority_provision_job_v1($1, $2)",
    ["authority-executor", 60],
  );
  const plan = await buildHnsRootImportPublishPlanV1({
    current_records: [{ type: "TXT", txt: ["preserve-me"] }],
    challenge_txt_value: record.challenge_txt_value,
    ds_records: [
      { key_tag: 12_345, algorithm: 13, digest_type: 2, digest: "1".repeat(64) },
      { key_tag: 12_345, algorithm: 13, digest_type: 4, digest: "2".repeat(96) },
    ],
  });
  const planBytes = new TextEncoder().encode(canonicalJson(plan));
  const resultBytes = new TextEncoder().encode(
    canonicalJson({ version: "test-provision-result-v1", root_label: "newroot" }),
  );
  await admin.query(
    "SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      record.provision_job_id,
      "authority-executor",
      Number(claim.rows[0]?.lease_fence),
      provisioning.request.sha256,
      "completed",
      Buffer.from(planBytes),
      sha256(planBytes),
      Buffer.from(resultBytes),
      sha256(resultBytes),
      null,
    ],
  );
  return { record, planBytes, resultBytes, ownershipResultHash };
}

async function seedSatisfiedOwnership(admin: Client): Promise<string> {
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
         'namespace-provider',$3,'managed','namespace-config','v1','hns-txt-v1','test',
         'hns','newroot','newroot','app.newroot','/c/app.newroot',NULL,
         'upstream-root-import',1,'pirate-hns-ownership-evidence-v1',
         'hns_parent_chain_txt','newroot',$2,TRUE,TRUE,TRUE,'hns-main',100,$2,1000,200,
         clock_timestamp()-interval '1 minute',$4::timestamptz,
         'provider-evidence-root-import',$2,$2,$2,
         '{"status":"verified"}'::jsonb,'{"status":"verified"}'::bytea
       )`,
      [SHA_B, SHA_A, SHA_C, expiresAt],
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
         $1,'namespace-provider',$2,'v1','complete-root-import',$3,'satisfied',$4,
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
         'newroot','newroot','app.newroot',$1,'namespace-provider',$2,'v1',$3,$3,1,
         transaction_timestamp()-interval '1 minute',$4::timestamptz)`,
      [SHA_B, SHA_C, SHA_A, expiresAt],
    );
    await admin.query(
      `UPDATE namespace_ownership_sessions
          SET status='completed',terminal_at=transaction_timestamp()-interval '1 minute',
              completed_at=transaction_timestamp()-interval '1 minute',updated_at=clock_timestamp()
        WHERE namespace_session_id='namespace-root-import'`,
    );
    await admin.query("COMMIT");
    return resultHash;
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function makeReadinessArtifact(input: {
  readonly inventoryVersion?: string;
  readonly validForSeconds?: number;
  readonly environment?: "test" | "production";
  readonly ownershipResultHash: string;
  readonly publishPlanSha256: string;
  readonly provisionResultSha256: string;
}) {
  const observedAt = new Date(Date.now() - 1_000).toISOString();
  const validUntil = new Date(Date.now() + (input.validForSeconds ?? 3600) * 1000).toISOString();
  const capabilities = [
    {
      capability_reference: "pdns-zone:newroot",
      scope_kind: "exact_root" as const,
      root_label: "newroot",
      active: true,
    },
  ];
  const nameserverGlue = [
    {
      authority_nameserver: "ns1.pirate",
      authority_address_family: "GLUE4" as const,
      authority_address: "192.0.2.53",
      active: true,
    },
    {
      authority_nameserver: "ns2.pirate",
      authority_address_family: "GLUE4" as const,
      authority_address: "192.0.2.54",
      active: true,
    },
  ];
  const capabilityDigest = await hnsAuthorityCapabilitySetDigest({
    environment: input.environment ?? "test",
    authoritative_nameserver_glue: nameserverGlue,
    dns_write_capabilities: capabilities,
  });
  const inventoryBytes = await encodeHnsAuthorityInventory({
    version: HNS_AUTHORITY_INVENTORY_VERSION,
    authority_inventory_reference: "hns-authority:newroot",
    authority_inventory_version:
      input.inventoryVersion ?? `readiness-${input.provisionResultSha256.slice(0, 16)}`,
    environment: input.environment ?? "test",
    completeness: "complete",
    runtime_capability_set_digest: capabilityDigest,
    published_at: observedAt,
    expires_at: validUntil,
    authoritative_nameserver_glue: nameserverGlue,
    dns_write_capabilities: capabilities,
  });
  const inventory = await decodeHnsAuthorityInventoryBytes(inventoryBytes);
  const managedZoneBytes = new TextEncoder().encode(
    canonicalJson({ root_label: "newroot", serial: 7, managed: true }),
  );
  const observedZoneBytesSha256 = sha256(managedZoneBytes);
  return encodeHnsRootImportReadinessResultV1({
    version: HNS_ROOT_IMPORT_READINESS_RESULT_VERSION,
    root_import_session_id: "root-import-session",
    namespace_session_id: "namespace-root-import",
    root_label: "newroot",
    ownership_result_sha256: input.ownershipResultHash,
    publish_plan_sha256: input.publishPlanSha256,
    provision_result_sha256: input.provisionResultSha256,
    chain_resource_sha256: SHA_A,
    powerdns_zone_serial: 7,
    managed_rrset_sha256: SHA_C,
    managed_zone_bytes_hex: Buffer.from(managedZoneBytes).toString("hex"),
    observed_zone_bytes_sha256: observedZoneBytesSha256,
    shared_tlsa_profile_sha256: SHA_B,
    ds_records: [
      { key_tag: 12_345, algorithm: 13, digest_type: 2, digest: "1".repeat(64) },
      { key_tag: 12_345, algorithm: 13, digest_type: 4, digest: "2".repeat(96) },
    ],
    dns_authority_reference: "pdns-zone:newroot",
    dnssec_keyset_reference: "pdns-keyset:newroot",
    dnssec_keyset_version: SHA_C,
    gateway_deployment_reference: "gateway-deployment-v1",
    gateway_certificate_spki_sha256: "e".repeat(64),
    gateway_http_status: 421,
    authority_views: nameserverGlue.map((entry, index) => ({
      authority_nameserver: entry.authority_nameserver,
      authority_address_family: entry.authority_address_family,
      authority_address: entry.authority_address,
      dnssec_validation: "secure" as const,
      challenge_present: true as const,
      validated_dnskey_response_sha256: index === 0 ? SHA_A : SHA_B,
      validated_control_response_sha256: index === 0 ? SHA_B : SHA_C,
      validated_chain_authority_digest: SHA_A,
      observed_zone_sha256: observedZoneBytesSha256,
    })) as never,
    delegation_matches: true,
    ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_healthy: true,
    authority_inventory_reference: inventory.inventory.authority_inventory_reference,
    authority_inventory_version: inventory.inventory.authority_inventory_version,
    authority_inventory_digest: inventory.inventory_digest,
    authority_inventory_bytes_hex: Buffer.from(inventoryBytes).toString("hex"),
    observed_at: observedAt,
    valid_until: validUntil,
  });
}

async function seedCommittedCommunityRoute(admin: Client): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query(
      `INSERT INTO communities (
         community_id,display_name,status,created_by_user_id,canonical_route_binding_id,
         route_authority_version,created_at,updated_at,route_slug
       ) VALUES ('community-root-import','Root import','active','actor-root-import',
         'route-binding-root-import','route_v1',clock_timestamp(),clock_timestamp(),NULL)`,
    );
    await admin.query(
      `INSERT INTO community_canonical_route_bindings (
         route_binding_id,community_id,family,root_label,root_label_display,ownership_status,
         route_lifecycle_status,binding_generation,verified_evidence_ref
       ) VALUES ('route-binding-root-import','community-root-import','hns','newroot','newroot',
         'verified','active',1,'evidence-root-import')`,
    );
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(
      `UPDATE community_creation_intents
          SET status='committed',committed_community_id='community-root-import',
              committed_resource_href='/c/app.newroot',updated_at=clock_timestamp()
        WHERE intent_id='intent-root-import' AND actor_id='actor-root-import'`,
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

suite("Postgres 17 HNS root-import repository", () => {
  test("retries transient provisioning, fences completion, and replays exact outcomes", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const record = startRecord();
      const created = await Effect.runPromise(Effect.scoped(store.start(record)));
      expect(created).toMatchObject({
        kind: "created",
        session: {
          root_import_session_id: "root-import-session",
          status: "awaiting_ownership",
          revision: 1,
          replayed: false,
        },
      });
      // The older creation path now commits its lifecycle row with its session,
      // so the operation has a server-decided phase from the moment it exists.
      const lifecycle = await admin.query<Record<string, unknown>>(
        `SELECT phase, revision, generation, policy_name
           FROM hns_root_import_lifecycle WHERE root_import_session_id = $1`,
        ["root-import-session"],
      );
      expect(lifecycle.rows).toHaveLength(1);
      expect(lifecycle.rows[0]).toMatchObject({
        phase: "preparing",
        revision: "1",
        generation: "1",
      });
      const rootExclusivity = await admin.query<{ predicate: string }>(
        `SELECT pg_get_expr(index.indpred, index.indrelid) AS predicate
           FROM pg_index AS index
           JOIN pg_class AS relation ON relation.oid = index.indexrelid
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE relation.relname = 'hns_root_import_sessions_active_root_unique'
            AND namespace.nspname = current_schema()`,
      );
      expect(rootExclusivity.rows).toHaveLength(1);
      expect(rootExclusivity.rows[0]?.predicate).not.toContain("awaiting_ownership");
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.start({
              ...record,
              root_import_session_id: "reserved-root-import-session",
              root_label: "pirate",
              idempotency_key: "reserved-root-import",
              request_sha256: SHA_B,
              provision_job_id: "reserved-root-provision-job",
            }),
          ),
        ),
      ).toEqual({ kind: "conflict" });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.start({
              ...record,
              root_import_session_id: "duplicate-root-import-session",
              idempotency_key: "duplicate-root-import",
              request_sha256: SHA_C,
              provision_job_id: "duplicate-root-provision-job",
            }),
          ),
        ),
      ).toEqual({ kind: "conflict" });

      expect(
        (
          await admin.query("SELECT * FROM claim_hns_authority_provision_job_v1($1, $2)", [
            "authority-executor",
            60,
          ])
        ).rows,
      ).toHaveLength(0);
      const ownershipResultHash = await seedSatisfiedOwnership(admin);
      const provisioning = await beginProvisioning(store, record, ownershipResultHash);
      expect(provisioning.outcome).toMatchObject({
        kind: "provisioning",
        session: { status: "provisioning", revision: 2 },
      });

      const claim = await admin.query<{
        provision_job_id: string;
        request_sha256: string;
        lease_fence: string;
      }>("SELECT * FROM claim_hns_authority_provision_job_v1($1, $2)", ["authority-executor", 60]);
      expect(claim.rows).toHaveLength(1);
      expect(claim.rows[0]).toMatchObject({
        provision_job_id: "provision-root-import",
        request_sha256: provisioning.request.sha256,
        lease_fence: "1",
      });

      const retry = await admin.query<{
        outcome: string;
        root_import_session_id: string;
        session_revision: string;
      }>("SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
        "provision-root-import",
        "authority-executor",
        1,
        provisioning.request.sha256,
        "retry",
        null,
        null,
        null,
        null,
        "authority_unavailable",
      ]);
      expect(retry.rows).toEqual([
        {
          outcome: "retry",
          root_import_session_id: "root-import-session",
          session_revision: "2",
        },
      ]);
      const retryClaim = await admin.query<{
        provision_job_id: string;
        lease_fence: string;
      }>("SELECT * FROM claim_hns_authority_provision_job_v1($1, $2)", ["authority-executor", 60]);
      expect(retryClaim.rows[0]).toMatchObject({
        provision_job_id: "provision-root-import",
        lease_fence: "2",
      });

      const plan = await buildHnsRootImportPublishPlanV1({
        current_records: [
          { type: "TXT", txt: ["preserve-me"] },
          { type: "NS", ns: "old-authority.example." },
        ],
        challenge_txt_value: record.challenge_txt_value,
        ds_records: [
          { key_tag: 12_345, algorithm: 13, digest_type: 2, digest: "1".repeat(64) },
          { key_tag: 12_345, algorithm: 13, digest_type: 4, digest: "2".repeat(96) },
        ],
      });
      const planBytes = new TextEncoder().encode(canonicalJson(plan));
      const resultBytes = new TextEncoder().encode(
        canonicalJson({
          version: "pirate-hns-authority-provision-result-v1",
          root_label: "newroot",
          primary_zone_serial: 1,
        }),
      );
      const completionArguments = [
        "provision-root-import",
        "authority-executor",
        2,
        provisioning.request.sha256,
        "completed",
        Buffer.from(planBytes),
        sha256(planBytes),
        Buffer.from(resultBytes),
        sha256(resultBytes),
        null,
      ] as const;
      const complete = await admin.query<{
        outcome: string;
        root_import_session_id: string;
        session_revision: string;
      }>("SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
        ...completionArguments,
      ]);
      expect(complete.rows).toEqual([
        {
          outcome: "completed",
          root_import_session_id: "root-import-session",
          session_revision: "3",
        },
      ]);

      const retained = await Effect.runPromise(
        Effect.scoped(
          store.get({
            actor_id: record.actor_id,
            creation_intent_id: record.creation_intent_id,
            root_import_session_id: record.root_import_session_id,
          }),
        ),
      );
      expect(retained).toMatchObject({
        status: "awaiting_owner_update",
        revision: 3,
        publish_plan: plan,
        publish_plan_sha256: sha256(planBytes),
      });

      const replay = await Effect.runPromise(Effect.scoped(store.start(record)));
      expect(replay).toMatchObject({
        kind: "replay",
        session: { status: "awaiting_owner_update", revision: 3, replayed: true },
      });
      expect(
        await Effect.runPromise(Effect.scoped(store.start({ ...record, request_sha256: SHA_B }))),
      ).toEqual({ kind: "conflict" });

      const exactFinalizeReplay = await admin.query<{ outcome: string }>(
        "SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [...completionArguments],
      );
      expect(exactFinalizeReplay.rows[0]?.outcome).toBe("replayed");
      const changedFinalizeReplay = await admin.query<{ outcome: string }>(
        "SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [...completionArguments.slice(0, 6), SHA_C, ...completionArguments.slice(7)],
      );
      expect(changedFinalizeReplay.rows[0]?.outcome).toBe("conflict");
      expect(
        (
          await admin.query("SELECT * FROM claim_hns_authority_provision_job_v1($1, $2)", [
            "authority-executor",
            60,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  }, 20_000);

  test("does not expire a lifecycle-managed operation whose phase deadlines remain open", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      await provisionRootImport(store, admin);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `UPDATE hns_root_import_sessions
              SET created_at=clock_timestamp()-interval '2 minutes',
                  expires_at=clock_timestamp()-interval '1 minute'
            WHERE root_import_session_id='root-import-session'`,
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const claim = await admin.query<{
        operation_kind: string;
      }>("SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)", [
        "authority-executor",
        60,
      ]);
      // The retired expiry no longer authorizes teardown for a
      // lifecycle-managed operation: the phase deadlines govern. The legacy
      // readiness performer may still take the observation job while the
      // ownership marker is disabled.
      expect(claim.rows.every((row) => row.operation_kind !== "teardown_root_v1")).toBe(true);
      const state = await admin.query<{ session_status: string }>(
        `SELECT status AS session_status FROM hns_root_import_sessions
          WHERE root_import_session_id='root-import-session'`,
      );
      expect(state.rows[0]?.session_status).not.toBe("expired");
    });
  }, 20_000);

  test("provisions from sanitized name proof and tears down a terminal session immediately", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
        { environment: "production" },
      );
      const record = startRecord();
      const started = await Effect.runPromise(Effect.scoped(store.start(record)));
      if (!("session" in started)) {
        throw new Error("expected root-import session");
      }
      if (started.session.status !== "awaiting_ownership") {
        throw new Error("expected awaiting ownership");
      }
      const signature = btoa("\u0001".repeat(64));
      const message = started.session.provisioning_authorization.message;
      const messageSha256 = sha256(new TextEncoder().encode(message));
      const signatureSha256 = sha256(new TextEncoder().encode(signature));
      const proofBytes = encodeHnsRootImportNameProofResultV1({
        version: HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION,
        root_label: record.root_label,
        message_sha256: messageSha256,
        signature_sha256: signatureSha256,
        safe: true,
        verified: true,
      });
      const request = provisionRequest(record);
      const rejectedProofBytes = encodeHnsRootImportNameProofResultV1({
        version: HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION,
        root_label: record.root_label,
        message_sha256: messageSha256,
        signature_sha256: signatureSha256,
        safe: true,
        verified: false,
      });
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.beginProvisioning({
              poll: {
                actor_id: record.actor_id,
                creation_intent_id: record.creation_intent_id,
                root_import_session_id: record.root_import_session_id,
                expected_revision: 1,
                idempotency_key: "reject-root-import-name-proof",
                provisioning_name_signature: signature,
              },
              poll_request_sha256: SHA_A,
              authorization: {
                kind: "hns_name_signature",
                result_bytes: rejectedProofBytes,
                result_sha256: sha256(rejectedProofBytes),
                message_sha256: messageSha256,
                signature_sha256: signatureSha256,
              },
              provision_job_id: record.provision_job_id,
              provision_request_bytes: request.bytes,
              provision_request_sha256: request.sha256,
            }),
          ),
        ),
      ).toEqual({ kind: "conflict" });
      expect(
        (
          await admin.query("SELECT * FROM claim_hns_authority_provision_job_v1($1,$2)", [
            "authority-executor",
            60,
          ])
        ).rows,
      ).toHaveLength(0);
      const provisioning = await Effect.runPromise(
        Effect.scoped(
          store.beginProvisioning({
            poll: {
              actor_id: record.actor_id,
              creation_intent_id: record.creation_intent_id,
              root_import_session_id: record.root_import_session_id,
              expected_revision: 1,
              idempotency_key: "provision-root-import-name-proof",
              provisioning_name_signature: signature,
            },
            poll_request_sha256: SHA_B,
            authorization: {
              kind: "hns_name_signature",
              result_bytes: proofBytes,
              result_sha256: sha256(proofBytes),
              message_sha256: messageSha256,
              signature_sha256: signatureSha256,
            },
            provision_job_id: record.provision_job_id,
            provision_request_bytes: request.bytes,
            provision_request_sha256: request.sha256,
          }),
        ),
      );
      expect(provisioning).toMatchObject({
        kind: "provisioning",
        session: { status: "provisioning", revision: 2 },
      });
      const retained = await admin.query<{
        provision_authorization_kind: string;
        ownership_result_sha256: string | null;
        result_text: string;
      }>(
        `SELECT session.provision_authorization_kind,session.ownership_result_sha256,
                convert_from(proof.result_bytes,'UTF8') AS result_text
           FROM hns_root_import_sessions AS session
           JOIN hns_root_import_name_proof_observations AS proof
             ON proof.root_import_session_id=session.root_import_session_id
          WHERE session.root_import_session_id=$1`,
        [record.root_import_session_id],
      );
      expect(retained.rows[0]).toMatchObject({
        provision_authorization_kind: "hns_name_signature",
        ownership_result_sha256: null,
      });
      expect(retained.rows[0]?.result_text).not.toContain(signature);

      const claim = await admin.query<{ lease_fence: string }>(
        "SELECT * FROM claim_hns_authority_provision_job_v1($1,$2)",
        ["authority-executor", 60],
      );
      expect(claim.rows).toHaveLength(1);
      const plan = await buildHnsRootImportPublishPlanV1({
        current_records: [],
        challenge_txt_value: record.challenge_txt_value,
        ds_records: [
          { key_tag: 12_345, algorithm: 13, digest_type: 2, digest: "1".repeat(64) },
          { key_tag: 12_345, algorithm: 13, digest_type: 4, digest: "2".repeat(96) },
        ],
      });
      const planBytes = new TextEncoder().encode(canonicalJson(plan));
      const resultBytes = new TextEncoder().encode(
        canonicalJson({ version: "test-provision-result-v1", root_label: record.root_label }),
      );
      await admin.query(
        "SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          record.provision_job_id,
          "authority-executor",
          Number(claim.rows[0]?.lease_fence),
          request.sha256,
          "completed",
          Buffer.from(planBytes),
          sha256(planBytes),
          Buffer.from(resultBytes),
          sha256(resultBytes),
          null,
        ],
      );
      const prematureObservationBytes = new TextEncoder().encode(
        canonicalJson({ version: "premature-observation", root_label: record.root_label }),
      );
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.beginObservation({
              poll: {
                actor_id: record.actor_id,
                creation_intent_id: record.creation_intent_id,
                root_import_session_id: record.root_import_session_id,
                expected_revision: 3,
                idempotency_key: "observe-before-chain-txt",
              },
              poll_request_sha256: SHA_A,
              ownership_result_sha256: "d".repeat(64),
              observation_job_id: "premature-name-proof-observation",
              observation_request_bytes: prematureObservationBytes,
              observation_request_sha256: sha256(prematureObservationBytes),
            }),
          ),
        ),
      ).toEqual({ kind: "conflict" });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "UPDATE hns_root_import_sessions SET status='failed' WHERE root_import_session_id=$1",
          [record.root_import_session_id],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const teardown = await admin.query<{
        observation_job_id: string;
        operation_kind: string;
        request_sha256: string;
        lease_fence: string;
      }>("SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)", [
        "authority-executor",
        60,
      ]);
      expect(teardown.rows[0]).toMatchObject({ operation_kind: "teardown_root_v1" });
      const finalized = await admin.query<{
        outcome: string;
        root_import_session_id: string;
        session_revision: string;
      }>("SELECT * FROM finalize_hns_root_import_observation_job_v1($1,$2,$3,$4,$5,$6,$7,$8)", [
        teardown.rows[0]?.observation_job_id,
        "authority-executor",
        Number(teardown.rows[0]?.lease_fence),
        teardown.rows[0]?.request_sha256,
        "failed",
        null,
        null,
        "session_expired",
      ]);
      expect(finalized.rows).toEqual([
        {
          outcome: "failed",
          root_import_session_id: record.root_import_session_id,
          session_revision: "3",
        },
      ]);
      const finalState = await admin.query<{ session_status: string; teardown_state: string }>(
        `SELECT session.status AS session_status,teardown.state AS teardown_state
           FROM hns_root_import_sessions AS session
           JOIN hns_root_import_teardown_jobs AS teardown
             ON teardown.root_import_session_id=session.root_import_session_id
          WHERE session.root_import_session_id=$1`,
        [record.root_import_session_id],
      );
      expect(finalState.rows).toEqual([{ session_status: "failed", teardown_state: "completed" }]);
    });
  }, 20_000);

  test.each([false, true])(
    "observes readiness and atomically activates serving plus handle issuance (inventory renewal %s)",
    async (inventoryRenewal) => {
      await withSchema(async (connection, admin) => {
        const store = makeControlPlaneHnsRootImportStore(
          makeDirectPostgresControlPlaneLayer(connection),
        );
        const provisioned = await provisionRootImport(store, admin);
        const ownershipResultHash = provisioned.ownershipResultHash;
        await seedCommittedCommunityRoute(admin);
        expect(
          await Effect.runPromise(
            Effect.scoped(
              store.activate({
                input: {
                  actor_id: provisioned.record.actor_id,
                  actor_kind: "user",
                  creation_intent_id: provisioned.record.creation_intent_id,
                  root_import_session_id: provisioned.record.root_import_session_id,
                  expected_revision: 3,
                  idempotency_key: "activate-before-ready",
                  publish_plan_sha256: sha256(provisioned.planBytes),
                  readiness_result_sha256: SHA_A,
                  acknowledged_complete_resource_replacement: true,
                },
                request_sha256: SHA_B,
                community_id: "community-root-import",
                current_evidence: null,
                dns_zone_activation_id: "dns-before-ready",
                app_host_activation_id: "app-before-ready",
                sale_namespace_activation_id: "sale-before-ready",
                operation_id: "root-import-before-ready",
              }),
            ),
          ),
        ).toEqual({ kind: "conflict" });
        const observationRequestBytes = new TextEncoder().encode(
          canonicalJson({
            version: "pirate-hns-root-readiness-observation-request-v1",
            root_import_session_id: provisioned.record.root_import_session_id,
            namespace_session_id: provisioned.record.namespace_session_id,
            root_label: provisioned.record.root_label,
          }),
        );
        const observation = await Effect.runPromise(
          Effect.scoped(
            store.beginObservation({
              poll: {
                actor_id: provisioned.record.actor_id,
                creation_intent_id: provisioned.record.creation_intent_id,
                root_import_session_id: provisioned.record.root_import_session_id,
                expected_revision: 3,
                idempotency_key: "observe-root-import",
              },
              poll_request_sha256: SHA_A,
              ownership_result_sha256: ownershipResultHash,
              observation_job_id: "observation-root-import",
              observation_request_bytes: observationRequestBytes,
              observation_request_sha256: sha256(observationRequestBytes),
            }),
          ),
        );
        expect(observation).toMatchObject({
          kind: "observing",
          session: { status: "observing", revision: 4 },
        });

        // The single readiness path: preparation, current and safe evidence
        // advance through the real lifecycle reducer, jobs and writers, and
        // the atomic readiness writer accepts the result and completes the
        // readiness job in one statement.
        const ready = await driveLifecycleToReady(admin, provisioned, {
          readinessValidForSeconds: inventoryRenewal ? 5 : 3600,
        });
        const readiness = ready.readiness;
        const lifecycleRevision = ready.lifecycleRevision;
        const lifecycleGeneration = ready.lifecycleGeneration;
        const lifecyclePlanDigest = ready.lifecyclePlanDigest;

        const activationInput = {
          actor_id: provisioned.record.actor_id,
          actor_kind: "user" as const,
          creation_intent_id: provisioned.record.creation_intent_id,
          root_import_session_id: provisioned.record.root_import_session_id,
          expected_revision: 5,
          idempotency_key: "activate-root-import",
          publish_plan_sha256: sha256(provisioned.planBytes),
          readiness_result_sha256: readiness.result_sha256,
          acknowledged_complete_resource_replacement: true as const,
        };
        const activation: HnsRootImportActivationRecord = {
          input: activationInput,
          request_sha256: sha256(
            new TextEncoder().encode(
              canonicalJson({ version: "root-activation-v1", activationInput }),
            ),
          ),
          community_id: "community-root-import",
          dns_zone_activation_id: "dns-root-import",
          app_host_activation_id: "app-root-import",
          sale_namespace_activation_id: "sale-root-import",
          operation_id: "root-import-activation-operation",
          current_evidence: {
            lifecycle_revision: lifecycleRevision,
            lifecycle_generation: lifecycleGeneration,
            observed_at_epoch_ms: Date.now() - 5_000,
            resource_sha256: lifecyclePlanDigest,
            qualifying: true,
          },
        };
        const activated = await Effect.runPromise(Effect.scoped(store.activate(activation)));
        expect(activated).toMatchObject({
          kind: "activated",
          response: {
            status: "activated",
            revision: 6,
            app_host: "app.newroot",
            handle_issuance_enabled: true,
            replayed: false,
          },
        });
        const state = await admin.query<{
          root_status: string;
          dns_root: string;
          app_host: string;
          sale_root: string;
          health_valid: boolean;
          delegation_matches: boolean;
          ds_authenticates_zone: boolean;
          retained_zone_digest_matches: boolean;
          gateway_healthy: boolean;
          dns_operation_state: string;
          health_seconds_remaining: number;
        }>(
          `SELECT session.status AS root_status,dns.canonical_root AS dns_root,
                app.normalized_host AS app_host,sale.canonical_root AS sale_root,
                health.valid_until > clock_timestamp() AS health_valid,
                health.delegation_matches,health.ds_authenticates_zone,
                health.retained_zone_digest_matches,health.gateway_healthy,
                operation.state AS dns_operation_state,
                floor(extract(epoch FROM health.valid_until-clock_timestamp()))::integer
                  AS health_seconds_remaining
           FROM hns_root_import_sessions AS session
           JOIN hns_dns_zone_activation_current AS dns
             ON dns.dns_zone_activation_id='dns-root-import'
           JOIN hns_community_app_host_activation_current AS app
             ON app.app_host_activation_id='app-root-import'
           JOIN community_handle_sale_namespace_activation_current AS sale
             ON sale.sale_namespace_activation_id='sale-root-import'
           JOIN hns_dns_zone_health_observations AS health
             ON health.dns_zone_activation_id=dns.dns_zone_activation_id
           JOIN hns_dns_zone_activation_operations AS operation
             ON operation.dns_zone_activation_id=dns.dns_zone_activation_id
          WHERE session.root_import_session_id='root-import-session'`,
        );
        expect(state.rows).toHaveLength(1);
        expect(state.rows[0]).toMatchObject({
          root_status: "activated",
          dns_root: "newroot",
          app_host: "app.newroot",
          sale_root: "newroot",
          health_valid: true,
          delegation_matches: true,
          ds_authenticates_zone: true,
          retained_zone_digest_matches: true,
          gateway_healthy: true,
          dns_operation_state: "finalized",
        });
        expect(state.rows[0]?.health_seconds_remaining).toBeGreaterThan(
          inventoryRenewal ? 0 : 3_590,
        );

        if (inventoryRenewal) {
          await verifyHnsImportedInventoryRenewal(
            admin,
            connection,
            (environment, validForSeconds) =>
              makeReadinessArtifact({
                ownershipResultHash,
                publishPlanSha256: sha256(provisioned.planBytes),
                provisionResultSha256: sha256(provisioned.resultBytes),
                inventoryVersion: `renewal-${randomUUID()}`,
                ...(environment === undefined ? {} : { environment }),
                ...(validForSeconds === undefined ? {} : { validForSeconds }),
              }),
          );
          return;
        }

        // The retired client observation job is still queued after the real
        // lifecycle path accepted evidence. Give it the removal migration's
        // named disposition for an existing operation crossing the cutover;
        // renewal must succeed without it ever reaching completed.
        const clientObservation = await admin.query<{ observation_job_id: string; state: string }>(
          `SELECT observation_job_id, state FROM hns_root_import_observation_jobs
            WHERE root_import_session_id='root-import-session'`,
        );
        expect(clientObservation.rows).toMatchObject([
          { observation_job_id: "observation-root-import", state: "queued" },
        ]);
        await admin.query(
          `UPDATE hns_root_import_observation_jobs
              SET state='failed', failure_code='readiness_single_owner_cutover',
                  completed_at=clock_timestamp(), updated_at=clock_timestamp()
            WHERE observation_job_id=$1`,
          [clientObservation.rows[0]?.observation_job_id],
        );

        const scheduled = await admin.query<{
          eligible_roots: number;
          enqueued_roots: number;
        }>("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
        expect(scheduled.rows).toMatchObject([{ eligible_roots: 1, enqueued_roots: 1 }]);
        const renewalClaim = await admin.query<{
          observation_job_id: string;
          operation_kind: string;
          request_sha256: string;
          lease_fence: string;
        }>("SELECT * FROM claim_hns_root_health_renewal_job_v1($1,$2)", ["authority-executor", 60]);
        expect(renewalClaim.rows).toMatchObject([{ operation_kind: "renew_health_v1" }]);
        const renewalReadiness = await makeReadinessArtifact({
          ownershipResultHash,
          publishPlanSha256: sha256(provisioned.planBytes),
          provisionResultSha256: sha256(provisioned.resultBytes),
        });
        const renewed = await admin.query<{
          outcome: string;
          root_import_session_id: string;
          session_revision: string;
        }>("SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,$5,$6,$7,$8)", [
          renewalClaim.rows[0]?.observation_job_id,
          "authority-executor",
          Number(renewalClaim.rows[0]?.lease_fence),
          renewalClaim.rows[0]?.request_sha256,
          "ready",
          Buffer.from(renewalReadiness.result_bytes),
          renewalReadiness.result_sha256,
          null,
        ]);
        expect(renewed.rows).toEqual([
          {
            outcome: "ready",
            root_import_session_id: "root-import-session",
            session_revision: "6",
          },
        ]);
        // Re-delivering the same accepted envelope and result replays.
        expect(
          (
            await admin.query(
              "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,'ready',$5,$6,NULL)",
              [
                renewalClaim.rows[0]?.observation_job_id,
                "authority-executor",
                Number(renewalClaim.rows[0]?.lease_fence),
                renewalClaim.rows[0]?.request_sha256,
                Buffer.from(renewalReadiness.result_bytes),
                renewalReadiness.result_sha256,
              ],
            )
          ).rows[0]?.outcome,
        ).toBe("replayed");
        // The retired job stays in its named cutover disposition throughout.
        expect(
          (
            await admin.query<{ state: string; failure_code: string }>(
              `SELECT state, failure_code FROM hns_root_import_observation_jobs
                WHERE observation_job_id='observation-root-import'`,
            )
          ).rows[0],
        ).toMatchObject({
          state: "failed",
          failure_code: "readiness_single_owner_cutover",
        });
        expect(
          (
            await admin.query<{ health_generation: string }>(
              `SELECT max(health_generation) AS health_generation
               FROM hns_dns_zone_health_observations
              WHERE dns_zone_activation_id='dns-root-import'`,
            )
          ).rows[0]?.health_generation,
        ).toBe("2");
        const heartbeat = await admin.query<{
          fresh: boolean;
          freshness_threshold_seconds: number;
        }>(
          `SELECT last_successful_tick_at > clock_timestamp()-freshness_threshold_seconds*interval '1 second' AS fresh,
                freshness_threshold_seconds
           FROM hns_root_health_renewal_scheduler_heartbeat`,
        );
        expect(heartbeat.rows).toEqual([{ fresh: true, freshness_threshold_seconds: 7200 }]);

        await verifyHnsRenewalRecovery(admin, connection, () =>
          makeReadinessArtifact({
            ownershipResultHash,
            publishPlanSha256: sha256(provisioned.planBytes),
            provisionResultSha256: sha256(provisioned.resultBytes),
          }),
        );
        expect(await Effect.runPromise(Effect.scoped(store.activate(activation)))).toMatchObject({
          kind: "replayed",
          response: { replayed: true, revision: 6 },
        });
        expect(
          await Effect.runPromise(
            Effect.scoped(
              store.activate({
                ...activation,
                input: { ...activation.input, idempotency_key: "activate-root-import-again" },
                request_sha256: SHA_B,
                operation_id: "root-import-activation-operation-again",
              }),
            ),
          ),
        ).toEqual({ kind: "conflict" });
        expect(
          await Effect.runPromise(
            Effect.scoped(
              store.activate({
                ...activation,
                input: { ...activation.input, actor_id: "another-actor" },
                request_sha256: SHA_C,
                operation_id: "root-import-activation-wrong-principal",
              }),
            ),
          ),
        ).toEqual({ kind: "not_found" });
      });
    },
    60_000,
  );

  test("atomically commits a community attachment before activating its HNS services", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const provisioned = await provisionRootImport(store, admin);
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          `INSERT INTO communities (community_id,display_name,status,created_by_user_id,
             canonical_route_binding_id,route_authority_version,route_slug,created_at,updated_at)
           VALUES ('community_123e4567-e89b-42d3-a456-426614174099','Attachment import','active','actor-root-import',
             NULL,'optional_route_v2',NULL,clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO community_route_authority_grants (grant_id,community_id,
             principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id)
           VALUES ('attachment-import-grant','community_123e4567-e89b-42d3-a456-426614174099','actor-root-import',
             'manage_routes','creator_owner','active',clock_timestamp(),'actor-root-import')`,
        );
        await admin.query(
          `INSERT INTO community_route_attachment_intents (
             attachment_intent_id,community_id,actor_id,authority_grant_id,
             create_idempotency_key,create_request_hash,revision,status,family,root_label,
             root_label_display,requirement_hash,provider_id,provider_binding_hash,
             provider_configuration_kind,provider_configuration_ref,
             provider_configuration_version,protocol_version,expires_at)
           VALUES ('attachment-import','community_123e4567-e89b-42d3-a456-426614174099','actor-root-import',
             'attachment-import-grant','attachment-create',$1,2,'commit_ready','hns','newroot',
             'newroot',$2,'namespace-provider',$3,'managed','test-provider','v1','hns-txt-v1',$4)`,
          [SHA_A, SHA_B, SHA_C, expiresAt],
        );
        await admin.query(
          `INSERT INTO community_route_attachment_requirement_states (
             attachment_intent_id,actor_id,requirement_kind,status,requirement_hash,
             provider_id,provider_binding_hash,provider_configuration_kind,
             provider_configuration_ref,provider_configuration_version,family,root_label,
             root_label_display,path_segment,generation,current_ceremony_intent_id,satisfied_at)
           VALUES ('attachment-import','actor-root-import','namespace_ownership','satisfied',$1,
             'namespace-provider',$2,'managed','test-provider','v1','hns','newroot','newroot',
             'app.newroot',1,'attachment-ceremony',clock_timestamp()-interval '1 minute')`,
          [SHA_B, SHA_C],
        );
        await admin.query(
          `INSERT INTO community_route_attachment_ceremony_attempts (
             ceremony_intent_id,attachment_intent_id,actor_id,requirement_kind,generation,
             requirement_hash,provider_id,provider_binding_hash,provider_configuration_kind,
             provider_configuration_ref,provider_configuration_version,family,root_label,
             root_label_display,path_segment,reservation_request_hash,reservation_request,expires_at)
           VALUES ('attachment-ceremony','attachment-import','actor-root-import',
             'namespace_ownership',1,$1,'namespace-provider',$2,'managed','test-provider','v1',
             'hns','newroot','newroot','app.newroot',$3,'{}'::jsonb,$4)`,
          [SHA_B, SHA_C, SHA_A, expiresAt],
        );
        await admin.query(
          `INSERT INTO community_route_attachment_start_reservations (
             reservation_id,namespace_session_id,actor_id,community_id,attachment_intent_id,
             ceremony_intent_id,generation,expected_revision,client_idempotency_key,
             request_hash,provider_id,provider_binding_hash,provider_configuration_kind,
             provider_configuration_ref,provider_configuration_version,protocol_version,
             environment,route_root_label,state,fence_token,lease_expires_at)
           VALUES ('attachment-reservation','namespace-root-import','actor-root-import',
             'community_123e4567-e89b-42d3-a456-426614174099','attachment-import',
             'attachment-ceremony',1,1,'attachment-start',$1,'namespace-provider',$2,
             'managed','test-provider','v1','hns-txt-v1','test','newroot','finalized',1,$3)`,
          [SHA_A, SHA_C, expiresAt],
        );
        await admin.query(
          `INSERT INTO community_route_attachment_namespace_sessions (
             namespace_session_id,actor_id,community_id,attachment_intent_id,
             ceremony_intent_id,start_reservation_id,start_fence_token,expected_revision,
             generation,requirement_hash,request_hash,provider_id,provider_binding_hash,
             provider_configuration_kind,provider_configuration_ref,
             provider_configuration_version,protocol_version,environment,route_root_label,
             upstream_session_ref,presentation_kind,presentation_payload,status,started_at,
             completed_at,terminal_at,expires_at)
           VALUES ('namespace-root-import','actor-root-import',
             'community_123e4567-e89b-42d3-a456-426614174099','attachment-import',
             'attachment-ceremony','attachment-reservation',1,1,1,$1,$2,
             'namespace-provider',$3,'managed','test-provider','v1','hns-txt-v1','test',
             'newroot','attachment-upstream','embedded_sdk','{}'::jsonb,'completed',
             transaction_timestamp()-interval '2 minutes',
             transaction_timestamp()-interval '1 minute',
             transaction_timestamp()-interval '1 minute',$4)`,
          [SHA_B, SHA_A, SHA_C, expiresAt],
        );
        await admin.query(
          `INSERT INTO community_route_attachment_ceremony_results (
             ceremony_intent_id,actor_id,attachment_intent_id,requirement_kind,generation,
             callback_idempotency_key,callback_request_hash,outcome_status,result_hash,
             evidence_ref,evidence_digest,provider_identity_digest,terminal_at,satisfied_at)
           VALUES ('attachment-ceremony','actor-root-import','attachment-import',
             'namespace_ownership',1,'attachment-result',$1,'satisfied',$2,
             'attachment-evidence',$3,$3,transaction_timestamp()-interval '1 minute',
             transaction_timestamp()-interval '1 minute')`,
          [SHA_A, provisioned.ownershipResultHash, SHA_C],
        );
        await admin.query(
          `INSERT INTO community_route_ownership_evidence (
             evidence_ref,creation_ceremony_intent_id,verified_by_actor_id,family,root_label,
             root_label_display,path_segment,requirement_hash,provider_id,provider_binding_hash,
             provider_configuration_version,provider_identity_digest,evidence_digest,
             binding_generation,verified_at,expires_at,origin,route_attachment_ceremony_intent_id)
           VALUES ('attachment-evidence',NULL,'actor-root-import','hns','newroot','newroot',
             'app.newroot',$1,'namespace-provider',$2,'v1',$3,$3,1,
             clock_timestamp()-interval '1 minute',$4,'route_attachment','attachment-ceremony')`,
          [SHA_B, SHA_C, SHA_C, expiresAt],
        );
        await admin.query(
          `UPDATE hns_root_import_sessions SET origin_kind='community_attachment',
             creation_intent_id=NULL,ceremony_intent_id=NULL,
             community_id='community_123e4567-e89b-42d3-a456-426614174099',attachment_intent_id='attachment-import'
           WHERE root_import_session_id='root-import-session'`,
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const discovery = makeControlPlaneHnsCommunityRootImportRepository({
        environment: "test",
        provider_binding: {
          requirement: "namespace_ownership",
          family: "hns",
          provider_id: "namespace-provider",
          protocol_version: "hns-txt-v1",
          provider_configuration: { kind: "managed", reference: "test-provider", version: "v1" },
        },
      });
      const discover = () =>
        Effect.runPromise(
          discovery
            .getCurrent({
              actor_id: "actor-root-import",
              community_id: "community_123e4567-e89b-42d3-a456-426614174099",
            })
            .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        );
      expect(await discover()).toMatchObject({
        session: {
          status: "awaiting_owner_update",
          publication_check_pending: false,
        },
      });
      await admin.query(
        `INSERT INTO community_route_attachment_completion_attempts (
        completion_attempt_id,namespace_session_id,actor_id,community_id,attachment_intent_id,
        ceremony_intent_id,expected_revision,attempt_number,idempotency_key,completion_request_sha256,
        evidence_ref,state,fence_token,lease_expires_at)
        VALUES ('panel-read-attempt','namespace-root-import','actor-root-import',
          'community_123e4567-e89b-42d3-a456-426614174099','attachment-import',
          'attachment-ceremony',1,1,'panel-read',$1,'panel-read-evidence',
          'released',1,clock_timestamp())`,
        [SHA_A],
      );
      expect(await discover()).toMatchObject({
        session: {
          status: "awaiting_owner_update",
          publication_check_pending: true,
          retry_after_seconds: 5,
        },
      });
      const retainedOwnership = (
        await admin.query(`SELECT completed_at,terminal_at
        FROM community_route_attachment_namespace_sessions
        WHERE namespace_session_id='namespace-root-import'`)
      ).rows[0];
      for (const status of ["failed", "expired"]) {
        try {
          await admin.query(
            `UPDATE community_route_attachment_namespace_sessions
            SET status=$1,completed_at=NULL,terminal_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE namespace_session_id='namespace-root-import'`,
            [status],
          );
          expect(await discover()).toMatchObject({
            session: { status, retry_after_seconds: null },
          });
        } finally {
          await admin.query(
            `UPDATE community_route_attachment_namespace_sessions
            SET status='completed',completed_at=$1,terminal_at=$2,updated_at=clock_timestamp()
            WHERE namespace_session_id='namespace-root-import'`,
            [retainedOwnership?.completed_at, retainedOwnership?.terminal_at],
          );
        }
      }
      const observationBytes = new TextEncoder().encode('{"observe":"community"}');
      const observation = await admin.query<{ outcome: string }>(
        `SELECT * FROM begin_hns_root_import_observation_v1(
          $1,$2,$3,$4,$5,$6,$7,$8,$9::bytea,$10)`,
        [
          "actor-root-import",
          "community_123e4567-e89b-42d3-a456-426614174099",
          "root-import-session",
          3,
          "community-observe",
          SHA_A,
          provisioned.ownershipResultHash,
          "community-observation",
          Buffer.from(observationBytes),
          sha256(observationBytes),
        ],
      );
      expect(observation.rows[0]?.outcome).toBe("observing");
      // The zone-mutation lock admits the rightful holder of the client
      // observation job. The observation claim is not a readiness route after
      // the cutover, so this fixture leases the client job directly to
      // exercise the lock against the real session state, then returns it to
      // the queue before the lifecycle claim runs.
      const observationJob = await admin.query<{ observation_job_id: string }>(
        `SELECT observation_job_id FROM hns_root_import_sessions
          WHERE root_import_session_id=$1`,
        ["root-import-session"],
      );
      const observationJobId = observationJob.rows[0]?.observation_job_id;
      if (observationJobId === undefined || observationJobId === null) {
        throw new Error("client observation job missing");
      }
      await admin.query(
        `UPDATE hns_root_import_observation_jobs
            SET state='leased', attempt_count=1, lease_fence=1,
                leased_by='authority-executor',
                lease_expires_at=clock_timestamp() + interval '10 minutes',
                updated_at=clock_timestamp()
          WHERE observation_job_id=$1`,
        [observationJobId],
      );
      expect(
        (
          await admin.query(
            `SELECT lock_hns_root_zone_mutation_v1(
              'newroot','pirate-verification=challenge',false,
              $1,'wrong-executor',1
            ) AS admitted`,
            [observationJobId],
          )
        ).rows,
      ).toEqual([{ admitted: false }]);
      expect(
        (
          await admin.query(
            `SELECT lock_hns_root_zone_mutation_v1(
              'newroot','pirate-verification=challenge',false,
              $1,'authority-executor',1
            ) AS admitted`,
            [observationJobId],
          )
        ).rows,
      ).toEqual([{ admitted: true }]);
      await admin.query(
        `UPDATE hns_root_import_observation_jobs
            SET state='queued', leased_by=NULL, lease_expires_at=NULL,
                lease_fence=0, updated_at=clock_timestamp()
          WHERE observation_job_id=$1`,
        [observationJobId],
      );
      const ready = await driveLifecycleToReady(admin, provisioned);
      const readiness = ready.readiness;
      const lifecycleRevision = ready.lifecycleRevision;
      const lifecycleGeneration = ready.lifecycleGeneration;
      const lifecyclePlanDigest = ready.lifecyclePlanDigest;

      const activationRecord = {
        input: {
          actor_id: "actor-root-import",
          actor_kind: "user",
          creation_intent_id: "attachment-import",
          root_import_session_id: "root-import-session",
          expected_revision: 5,
          idempotency_key: "activate-community-import",
          publish_plan_sha256: sha256(provisioned.planBytes),
          readiness_result_sha256: readiness.result_sha256,
          acknowledged_complete_resource_replacement: true,
        },
        request_sha256: SHA_B,
        community_id: "community_123e4567-e89b-42d3-a456-426614174099",
        dns_zone_activation_id: "dns-community-import",
        app_host_activation_id: "app-community-import",
        sale_namespace_activation_id: "sale-community-import",
        operation_id: "community-import-activation",
        current_evidence: {
          lifecycle_revision: lifecycleRevision,
          lifecycle_generation: lifecycleGeneration,
          observed_at_epoch_ms: Date.now() - 5_000,
          resource_sha256: lifecyclePlanDigest,
          qualifying: true,
        },
        community_origin: {
          attachment_intent_id: "attachment-import",
          route_binding_id: "route-community-import",
        },
      } as Parameters<typeof store.activate>[0] & {
        community_origin: {
          attachment_intent_id: string;
          route_binding_id: string;
        };
      };
      // Post-decision rollback through the community repository path: the
      // trigger fails the final activation-operation insert after the
      // lifecycle decision, and every attachment, route, DNS, app-host, sale,
      // session and lifecycle effect must survive or roll back together.
      await admin.query(
        `CREATE FUNCTION test_reject_community_activation_operation() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'forced post-decision failure'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER test_reject_community_activation_operation BEFORE INSERT
           ON hns_root_import_activation_operations
           FOR EACH ROW EXECUTE FUNCTION test_reject_community_activation_operation()`,
      );
      await expect(
        Effect.runPromise(Effect.scoped(store.activate(activationRecord))),
      ).rejects.toMatchObject({ _tag: "HnsRootImportStorageFailed" });
      const refused = await admin.query<{
        session_status: string;
        lifecycle_phase: string;
        lifecycle_events: number;
        attachment_status: string;
        route_binding_id: string | null;
        route_bindings: number;
        dns_activations: number;
        app_hosts: number;
        sale_activations: number;
        operations: number;
      }>(
        `SELECT session.status AS session_status, lifecycle.phase AS lifecycle_phase,
                (SELECT count(*)::integer FROM hns_root_import_lifecycle_history
                  WHERE root_import_session_id='root-import-session'
                    AND event_id LIKE 'activation:%') AS lifecycle_events,
                intent.status AS attachment_status,
                community.canonical_route_binding_id AS route_binding_id,
                (SELECT count(*)::integer FROM community_canonical_route_bindings
                  WHERE route_binding_id='route-community-import') AS route_bindings,
                (SELECT count(*)::integer FROM hns_dns_zone_activation_current
                  WHERE canonical_root='newroot') AS dns_activations,
                (SELECT count(*)::integer FROM hns_community_app_host_activation_current
                  WHERE community_id='community_123e4567-e89b-42d3-a456-426614174099') AS app_hosts,
                (SELECT count(*)::integer FROM community_handle_sale_namespace_activation_current
                  WHERE community_id='community_123e4567-e89b-42d3-a456-426614174099') AS sale_activations,
                (SELECT count(*)::integer FROM hns_root_import_activation_operations
                  WHERE root_import_session_id='root-import-session') AS operations
           FROM hns_root_import_sessions AS session
           JOIN hns_root_import_lifecycle AS lifecycle
             ON lifecycle.root_import_session_id=session.root_import_session_id
           JOIN communities AS community
             ON community.community_id='community_123e4567-e89b-42d3-a456-426614174099'
           JOIN community_route_attachment_intents AS intent
             ON intent.attachment_intent_id='attachment-import'
          WHERE session.root_import_session_id='root-import-session'`,
      );
      expect(refused.rows[0]).toMatchObject({
        session_status: "ready",
        lifecycle_phase: "ready",
        lifecycle_events: 0,
        attachment_status: "commit_ready",
        route_binding_id: null,
        route_bindings: 0,
        dns_activations: 0,
        app_hosts: 0,
        sale_activations: 0,
        operations: 0,
      });
      await admin.query(
        "DROP TRIGGER test_reject_community_activation_operation ON hns_root_import_activation_operations",
      );
      await admin.query("DROP FUNCTION test_reject_community_activation_operation()");
      const activated = await Effect.runPromise(Effect.scoped(store.activate(activationRecord)));
      expect(activated).toMatchObject({
        kind: "activated",
        response: { status: "activated", revision: 6 },
      });
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecord))),
      ).toMatchObject({
        kind: "replayed",
        response: { status: "activated", revision: 6, replayed: true },
      });
      expect(await discover()).toMatchObject({
        attachment: {
          status: "active",
          canonical_route: {
            family: "hns",
            root_label: "newroot",
            href: "/c/newroot",
            app_host: null,
          },
        },
        session: {
          root_import_session_id: "root-import-session",
          status: "activated",
          retry_after_seconds: null,
        },
      });
      await admin.query(
        "INSERT INTO users(user_id,status,account) VALUES ('route-reader','active','{}'::jsonb)",
      );
      await admin.query(`INSERT INTO community_route_authority_grants
        (grant_id,community_id,principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id)
        VALUES ('route-reader-grant','community_123e4567-e89b-42d3-a456-426614174099',
          'route-reader','manage_routes','creator_owner','active',clock_timestamp(),'actor-root-import')`);
      expect(
        await Effect.runPromise(
          discovery
            .getCurrent({
              actor_id: "route-reader",
              community_id: "community_123e4567-e89b-42d3-a456-426614174099",
            })
            .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      ).toMatchObject({
        attachment: { status: "active", canonical_route: { root_label: "newroot" } },
        session: null,
      });
      const state = await admin.query(
        `SELECT community.canonical_route_binding_id,intent.status AS attachment_status,
                session.status AS import_status,app.normalized_host,sale.canonical_root
           FROM communities AS community
           JOIN community_route_attachment_intents AS intent ON intent.community_id=community.community_id
           JOIN hns_root_import_sessions AS session ON session.attachment_intent_id=intent.attachment_intent_id
           JOIN hns_community_app_host_activation_current AS app ON app.community_id=community.community_id
           JOIN community_handle_sale_namespace_activation_current AS sale ON sale.community_id=community.community_id
          WHERE community.community_id='community_123e4567-e89b-42d3-a456-426614174099'`,
      );
      expect(state.rows[0]).toMatchObject({
        canonical_route_binding_id: "route-community-import",
        attachment_status: "committed",
        import_status: "activated",
        normalized_host: "app.newroot",
        canonical_root: "newroot",
      });
    });
  }, 30_000);

  type ProvisionedRootImport = Awaited<ReturnType<typeof provisionRootImport>>;
  type ReadinessArtifact = Awaited<ReturnType<typeof makeReadinessArtifact>>;
  type ReadyActivation = Readonly<{
    readonly provisioned: ProvisionedRootImport;
    readonly readiness: ReadinessArtifact;
    readonly lifecycleRevision: number;
    readonly lifecycleGeneration: number;
    readonly lifecyclePlanDigest: string;
  }>;

  const FIXTURE_SESSION = "root-import-session";

  async function lifecycleFixtureRow(admin: Client) {
    const state = await admin.query<{
      phase: string;
      revision: string;
      generation: string;
      plan_encoded_resource_sha256: string | null;
    }>(
      `SELECT phase, revision, generation, plan_encoded_resource_sha256
         FROM hns_root_import_lifecycle
        WHERE root_import_session_id=$1`,
      [FIXTURE_SESSION],
    );
    const row = state.rows[0];
    if (row === undefined) throw new Error("root-import lifecycle row missing");
    return row;
  }

  /**
   * Commits one lifecycle event through the same pure reducer and SQL decision
   * writer the provisioner's executor uses. The claimed job's identity and
   * fence are the decision's provenance, so the observation recorder can bind
   * its summary to the decision that accepted it.
   */
  async function commitLifecycleFixtureEvent(
    admin: Client,
    event: HnsRootImportLifecycleEventV1,
    job?: Readonly<{ readonly lifecycle_job_id: string; readonly lease_fence: string }>,
  ): Promise<void> {
    const loaded = await admin.query<Record<string, unknown>>(
      `SELECT phase, revision, generation, plan_exposed_at, publication_deadline_at,
              first_current_observation_at, finality_deadline_at, readiness_observed_at,
              pending_reason, next_check_at, observation_count,
              consecutive_operational_failures, last_useful_error, last_useful_error_at,
              terminal_decided_at
         FROM hns_root_import_lifecycle
        WHERE root_import_session_id=$1
        FOR UPDATE`,
      [FIXTURE_SESSION],
    );
    const row = loaded.rows[0];
    if (row === undefined) throw new Error("root-import lifecycle row missing");
    const applied = await admin.query<{ readonly event_id: string }>(
      "SELECT event_id FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1",
      [FIXTURE_SESSION],
    );
    const state = hnsRootImportLifecycleStateFromRowV1(
      row,
      applied.rows.map((entry) => entry.event_id),
    );
    const decision = decideHnsRootImportLifecycleV1(
      state,
      event,
      HNS_ROOT_IMPORT_POLICY_V1,
      Date.now(),
    );
    if (decision.outcome.kind !== "transition") {
      throw new Error(
        `fixture lifecycle event ${event.event} was ${decision.outcome.kind}: ${decision.outcome.reason}`,
      );
    }
    const next = decision.next_state;
    await admin.query(
      `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::bigint,$11::bigint)`,
      [
        FIXTURE_SESSION,
        state.revision,
        event.event_id,
        event.event,
        decision.outcome.kind,
        decision.outcome.reason,
        next === null ? null : next.phase,
        next === null ? "{}" : hnsRootImportLifecycleDeadlinePatchV1(next, state),
        JSON.stringify(
          decision.requested_work.map((work) => ({
            kind: work.kind,
            due_at: new Date(work.due_at_epoch_ms).toISOString(),
          })),
        ),
        job?.lifecycle_job_id ?? null,
        job?.lease_fence ?? null,
      ],
    );
  }

  async function queueLifecycleFixtureJob(admin: Client, kind: string): Promise<void> {
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle_jobs (
         root_import_session_id, job_kind, due_at, generation
       )
       SELECT lifecycle.root_import_session_id, $1,
              clock_timestamp() - interval '1 second', lifecycle.generation
         FROM hns_root_import_lifecycle AS lifecycle
        WHERE lifecycle.root_import_session_id=$2
          AND NOT EXISTS (
            SELECT 1 FROM hns_root_import_lifecycle_jobs AS pending
             WHERE pending.root_import_session_id=lifecycle.root_import_session_id
               AND pending.job_kind=$1 AND pending.state IN ('queued','leased')
          )`,
      [kind, FIXTURE_SESSION],
    );
  }

  async function makeNextLifecycleFixtureJobDue(admin: Client, kind: string): Promise<boolean> {
    const updated = await admin.query(
      `UPDATE hns_root_import_lifecycle_jobs
          SET due_at=clock_timestamp() - interval '1 second'
        WHERE root_import_session_id=$1 AND job_kind=$2 AND state='queued'`,
      [FIXTURE_SESSION, kind],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async function runLifecycleFixtureObservation(
    admin: Client,
    input: Readonly<{
      readonly event: HnsRootImportLifecycleEventV1;
      readonly job_kind: "observe_current" | "observe_safe";
      readonly view: "current" | "safe";
      readonly resource_sha256: string;
      readonly update_inclusion_height: number | null;
      readonly commitment_height: number | null;
    }>,
  ): Promise<void> {
    const claimed = await admin.query<Record<string, unknown>>(
      "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
      ["lifecycle-executor", 60],
    );
    const job = claimed.rows[0];
    if (job === undefined || job.job_kind !== input.job_kind) {
      throw new Error(`expected a ${input.job_kind} lifecycle job`);
    }
    const jobId = String(job.lifecycle_job_id);
    const fence = String(job.lease_fence);
    await commitLifecycleFixtureEvent(admin, input.event, {
      lifecycle_job_id: jobId,
      lease_fence: fence,
    });
    const recorded = await admin.query<{ outcome: string }>(
      `SELECT record_hns_root_import_lifecycle_observation_v1(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS outcome`,
      [
        FIXTURE_SESSION,
        jobId,
        "lifecycle-executor",
        fence,
        input.view,
        input.resource_sha256,
        100,
        input.update_inclusion_height,
        input.commitment_height,
        new Date(),
        input.event.event_id,
        3600,
      ],
    );
    expect(recorded.rows[0]?.outcome).toBe("recorded");
    const finalized = await admin.query<{ outcome: string }>(
      "SELECT * FROM finalize_hns_root_import_lifecycle_job_v1($1,$2,$3,$4,$5)",
      [jobId, "lifecycle-executor", fence, "completed", null],
    );
    expect(finalized.rows[0]?.outcome).toBe("completed");
  }

  /**
   * Drives preparation, the qualifying current observation and the qualifying
   * safe observation through the real reducer, job and SQL writer, then
   * accepts readiness through the one atomic readiness writer. The old fixture
   * accepted readiness through the removed legacy finalizer and edited the
   * ready phase directly; this path cannot produce a ready operation without
   * the lifecycle transitions the production runner performs.
   */
  async function driveLifecycleToReady(
    admin: Client,
    provisioned: ProvisionedRootImport,
    options: Readonly<{ readonly readinessValidForSeconds?: number }> = {},
  ): Promise<
    Readonly<{
      readiness: ReadinessArtifact;
      lifecycleRevision: number;
      lifecycleGeneration: number;
      lifecyclePlanDigest: string;
    }>
  > {
    const plan = JSON.parse(new TextDecoder().decode(provisioned.planBytes)) as {
      encoded_resource_sha256: string;
    };
    const digestOutcome = await admin.query<{ result: string }>(
      "SELECT set_hns_root_import_lifecycle_plan_digest_v1($1,$2) AS result",
      [FIXTURE_SESSION, plan.encoded_resource_sha256],
    );
    if (digestOutcome.rows[0]?.result !== "set") {
      throw new Error("lifecycle plan digest was not set");
    }
    await commitLifecycleFixtureEvent(admin, {
      event: "preparation_completed",
      event_id: "fixture:preparation_completed",
      occurred_at_epoch_ms: Date.now(),
    });
    await queueLifecycleFixtureJob(admin, "observe_current");
    await runLifecycleFixtureObservation(admin, {
      event: {
        event: "current_observation",
        event_id: "fixture:current_observation",
        occurred_at_epoch_ms: Date.now(),
        qualifying: true,
        mismatch: false,
        resource_sha256: plan.encoded_resource_sha256,
      },
      job_kind: "observe_current",
      view: "current",
      resource_sha256: plan.encoded_resource_sha256,
      update_inclusion_height: 90,
      commitment_height: null,
    });
    if (!(await makeNextLifecycleFixtureJobDue(admin, "observe_safe"))) {
      await queueLifecycleFixtureJob(admin, "observe_safe");
    }
    await runLifecycleFixtureObservation(admin, {
      event: {
        event: "safe_observation",
        event_id: "fixture:safe_observation",
        occurred_at_epoch_ms: Date.now(),
        qualifying: true,
        bracket_observed_at_epoch_ms: Date.now(),
      },
      job_kind: "observe_safe",
      view: "safe",
      resource_sha256: plan.encoded_resource_sha256,
      update_inclusion_height: 90,
      commitment_height: 80,
    });
    if (!(await makeNextLifecycleFixtureJobDue(admin, "observe_readiness"))) {
      await queueLifecycleFixtureJob(admin, "observe_readiness");
    }
    const readiness = await makeReadinessArtifact({
      ownershipResultHash: provisioned.ownershipResultHash,
      publishPlanSha256: sha256(provisioned.planBytes),
      provisionResultSha256: sha256(provisioned.resultBytes),
      ...(options.readinessValidForSeconds === undefined
        ? {}
        : { validForSeconds: options.readinessValidForSeconds }),
    });
    const claimed = await admin.query<Record<string, unknown>>(
      "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
      ["readiness-executor", 60],
    );
    const job = claimed.rows[0];
    if (job === undefined || job.job_kind !== "observe_readiness") {
      throw new Error("expected an observe_readiness lifecycle job");
    }
    const state = await lifecycleFixtureRow(admin);
    const accepted = await admin.query<{ outcome: string }>(
      `SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)`,
      [
        FIXTURE_SESSION,
        job.lifecycle_job_id,
        "readiness-executor",
        job.lease_fence,
        Number(state.revision),
        readiness.result_bytes,
        readiness.result_sha256,
      ],
    );
    if (accepted.rows[0]?.outcome !== "ready") {
      throw new Error(`readiness was not accepted: ${accepted.rows[0]?.outcome}`);
    }
    const after = await lifecycleFixtureRow(admin);
    // The client observation job is intentionally left in whatever cutover
    // disposition it holds. Renewal derives its request envelope from retained
    // session and lifecycle evidence and must not depend on this retired job
    // reaching a completed state.
    return {
      readiness,
      lifecycleRevision: Number(after.revision),
      lifecycleGeneration: Number(after.generation),
      lifecyclePlanDigest: String(after.plan_encoded_resource_sha256),
    };
  }

  /**
   * Brings one creation-path operation to the ready state the activation gate
   * accepts through the real lifecycle and readiness writers.
   */
  async function prepareReadyActivation(
    store: ReturnType<typeof makeControlPlaneHnsRootImportStore>,
    admin: Client,
  ): Promise<ReadyActivation> {
    const provisioned = await provisionRootImport(store, admin);
    const observationRequestBytes = new TextEncoder().encode(
      canonicalJson({
        version: "pirate-hns-root-readiness-observation-request-v1",
        root_import_session_id: provisioned.record.root_import_session_id,
        namespace_session_id: provisioned.record.namespace_session_id,
        root_label: provisioned.record.root_label,
      }),
    );
    const observation = await Effect.runPromise(
      Effect.scoped(
        store.beginObservation({
          poll: {
            actor_id: provisioned.record.actor_id,
            creation_intent_id: provisioned.record.creation_intent_id,
            root_import_session_id: provisioned.record.root_import_session_id,
            expected_revision: 3,
            idempotency_key: "observe-root-import",
          },
          poll_request_sha256: SHA_A,
          ownership_result_sha256: provisioned.ownershipResultHash,
          observation_job_id: "observation-root-import",
          observation_request_bytes: observationRequestBytes,
          observation_request_sha256: sha256(observationRequestBytes),
        }),
      ),
    );
    expect(observation).toMatchObject({ kind: "observing" });
    const ready = await driveLifecycleToReady(admin, provisioned);
    return {
      provisioned,
      readiness: ready.readiness,
      lifecycleRevision: ready.lifecycleRevision,
      lifecycleGeneration: ready.lifecycleGeneration,
      lifecyclePlanDigest: ready.lifecyclePlanDigest,
    };
  }

  function activationRecordFor(
    ready: ReadyActivation,
    overrides: {
      readonly expected_revision?: number;
      readonly idempotency_key?: string;
      readonly readiness_result_sha256?: string;
      readonly current_evidence?: HnsRootImportActivationRecord["current_evidence"];
    } = {},
  ): HnsRootImportActivationRecord {
    const input = {
      actor_id: ready.provisioned.record.actor_id,
      actor_kind: "user" as const,
      creation_intent_id: ready.provisioned.record.creation_intent_id,
      root_import_session_id: ready.provisioned.record.root_import_session_id,
      expected_revision: overrides.expected_revision ?? 5,
      idempotency_key: overrides.idempotency_key ?? "activate-root-import",
      publish_plan_sha256: sha256(ready.provisioned.planBytes),
      readiness_result_sha256: overrides.readiness_result_sha256 ?? ready.readiness.result_sha256,
      acknowledged_complete_resource_replacement: true as const,
    };
    return {
      input,
      request_sha256: sha256(
        new TextEncoder().encode(
          canonicalJson({ version: "root-activation-v1", activationInput: input }),
        ),
      ),
      community_id: "community-root-import",
      dns_zone_activation_id: "dns-root-import",
      app_host_activation_id: "app-root-import",
      sale_namespace_activation_id: "sale-root-import",
      operation_id: "root-import-activation-operation",
      current_evidence:
        overrides.current_evidence === undefined
          ? {
              lifecycle_revision: ready.lifecycleRevision,
              lifecycle_generation: ready.lifecycleGeneration,
              observed_at_epoch_ms: Date.now() - 5_000,
              resource_sha256: ready.lifecyclePlanDigest,
              qualifying: true,
            }
          : overrides.current_evidence,
    };
  }

  async function activationState(admin: Client) {
    const session = await admin.query<{ status: string; revision: string }>(
      `SELECT status, revision FROM hns_root_import_sessions
        WHERE root_import_session_id='root-import-session'`,
    );
    const lifecycle = await admin.query<{
      phase: string;
      revision: string;
      pending_reason: string | null;
      readiness_observed_at: string;
    }>(
      `SELECT phase, revision, pending_reason, readiness_observed_at
         FROM hns_root_import_lifecycle WHERE root_import_session_id='root-import-session'`,
    );
    const operations = await admin.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM hns_root_import_activation_operations",
    );
    const history = await admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_history
        WHERE root_import_session_id='root-import-session'
          AND event_id LIKE 'activation:%'`,
    );
    return {
      session: session.rows[0],
      lifecycle: lifecycle.rows[0],
      operations: operations.rows[0]?.count ?? -1,
      activationHistory: history.rows[0]?.count ?? -1,
    };
  }

  test("rolls back every effect when a post-decision activation write fails", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const ready = await prepareReadyActivation(store, admin);
      await seedCommittedCommunityRoute(admin);
      await admin.query(
        `CREATE FUNCTION test_reject_activation_operation() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'forced post-decision failure'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER test_reject_activation_operation BEFORE INSERT
           ON hns_root_import_activation_operations
           FOR EACH ROW EXECUTE FUNCTION test_reject_activation_operation()`,
      );
      await expect(
        Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).rejects.toMatchObject({ _tag: "HnsRootImportStorageFailed" });
      const state = await activationState(admin);
      expect(state.lifecycle).toMatchObject({ phase: "ready" });
      expect(state.session).toEqual({ status: "ready", revision: "5" });
      expect(state.operations).toBe(0);
      expect(state.activationHistory).toBe(0);
      await admin.query(
        "DROP TRIGGER test_reject_activation_operation ON hns_root_import_activation_operations",
      );
      await admin.query("DROP FUNCTION test_reject_activation_operation()");
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).toMatchObject({ kind: "activated", response: { status: "activated" } });
    });
  }, 30_000);

  test("preserves protected state when the lifecycle row is absent", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const ready = await prepareReadyActivation(store, admin);
      await seedCommittedCommunityRoute(admin);
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "DELETE FROM hns_root_import_lifecycle WHERE root_import_session_id='root-import-session'",
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).toEqual({ kind: "conflict" });
      const state = await activationState(admin);
      expect(state.session).toEqual({ status: "ready", revision: "5" });
      expect(state.operations).toBe(0);
      expect(state.activationHistory).toBe(0);
    });
  }, 30_000);

  test("the renewal request encoding matches the TypeScript canonical contract byte for byte", async () => {
    await withSchema(async (_connection, admin) => {
      const cases = [
        { namespace: "namespace-plain", challenge: "pirate-verification=plain" },
        { namespace: 'namespace-"quoted"', challenge: 'pirate-verification=quote"slash\\' },
        { namespace: "namespace-über-日本", challenge: "pirate-verification=unicode-✓" },
      ] as const;
      for (const [index, sample] of cases.entries()) {
        const session = `encode-probe-${index}`;
        const planBytes = Buffer.from(`{"probe":${index}}`);
        const planSha = sha256(planBytes);
        const evidenceSha = "a".repeat(64);
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          `INSERT INTO hns_root_import_sessions (
             root_import_session_id, actor_id, namespace_session_id, ownership_generation,
             ownership_expected_revision, root_label, challenge_txt_value, status, revision,
             start_idempotency_key, start_request_sha256, provision_job_id,
             provision_authorization_kind, provision_authorization_sha256,
             provision_idempotency_key, provision_poll_request_sha256,
             publish_plan_bytes, publish_plan_sha256, ownership_result_sha256,
             observation_job_id, observation_idempotency_key, observation_request_sha256,
             origin_kind, creation_intent_id, ceremony_intent_id, created_at, expires_at
           ) VALUES ($1,'encode-actor',$2,1,1,$7,$3,'observing',3,
             'start-'||$1,$4,'provision-'||$1,'namespace_ownership',$4,
             'idem-'||$1,$4,$5,$6,$4,'observation-'||$1,'obs-idem-'||$1,$4,
             'creation_intent','intent-'||$1,'ceremony-'||$1, clock_timestamp(),
             date_trunc('microseconds', clock_timestamp() + interval '30 days'))`,
          [
            session,
            sample.namespace,
            sample.challenge,
            evidenceSha,
            planBytes,
            planSha,
            `encodeprobe${index}`,
          ],
        );
        await admin.query(
          `INSERT INTO hns_authority_provision_jobs (
             provision_job_id, root_import_session_id, operation_kind,
             request_bytes, request_sha256, state, attempt_count, lease_fence,
             publish_plan_bytes, publish_plan_sha256, result_bytes, result_sha256, completed_at
           ) VALUES ('provision-'||$1,$1,'provision_root_v1',$2,$3,'completed',0,0,
             $4,$5,$2,$3,clock_timestamp())`,
          [session, planBytes, planSha, planBytes, planSha],
        );
        await admin.query("COMMIT");
        const encoded = await admin.query<{ request_bytes: Buffer; request_sha256: string }>(
          "SELECT request_bytes, request_sha256 FROM encode_hns_root_readiness_observation_request_v1($1)",
          [session],
        );
        const stored = await admin.query<{ expires_at: Date; publish_plan_sha256: string }>(
          "SELECT expires_at, publish_plan_sha256 FROM hns_root_import_sessions WHERE root_import_session_id=$1",
          [session],
        );
        const storedRow = stored.rows[0];
        if (storedRow === undefined) throw new Error("encoded session row missing");
        const expected = canonicalJson({
          version: "pirate-hns-root-readiness-observation-request-v1",
          root_import_session_id: session,
          namespace_session_id: sample.namespace,
          root_label: `encodeprobe${index}`,
          challenge_txt_value: sample.challenge,
          ownership_result_sha256: evidenceSha,
          publish_plan_sha256: storedRow.publish_plan_sha256,
          provision_result_sha256: planSha,
          expires_at: storedRow.expires_at.toISOString(),
        });
        const bytes = encoded.rows[0]?.request_bytes;
        if (!(bytes instanceof Uint8Array)) throw new Error("request bytes missing");
        expect(Buffer.from(bytes).toString("utf8")).toBe(expected);
        expect(encoded.rows[0]?.request_sha256).toBe(sha256(Buffer.from(expected)));
      }
    });
  }, 30_000);

  test("renewal refuses a broken plan binding by name and never replays a null digest", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const ready = await prepareReadyActivation(store, admin);
      await seedCommittedCommunityRoute(admin);
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).toMatchObject({ kind: "activated", response: { status: "activated" } });
      const replacement = Buffer.from('{"replacement":true}');
      const replacementSha = sha256(replacement);
      await admin.query(
        `UPDATE hns_authority_provision_jobs
            SET publish_plan_bytes=$1, publish_plan_sha256=$2,
                updated_at=clock_timestamp()
          WHERE root_import_session_id='root-import-session' AND state='completed'`,
        [replacement, replacementSha],
      );
      await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
      const claim = await admin.query(
        "SELECT * FROM claim_hns_root_health_renewal_job_v1('authority-executor',60)",
      );
      expect(claim.rows).toHaveLength(0);
      // A repairable plan-binding failure is a delayed disposition with a
      // persisted due time, not a terminal job that permanently occupies the
      // generation.
      expect(
        (
          await admin.query<{ state: string; failure_code: string; waiting: boolean }>(
            `SELECT state, failure_code, next_attempt_at > clock_timestamp() AS waiting
               FROM hns_root_health_renewal_jobs ORDER BY created_at DESC LIMIT 1`,
          )
        ).rows[0],
      ).toMatchObject({ state: "delayed", failure_code: "plan_binding_mismatch", waiting: true });

      // Pre-0170 completed renewals carry no derived request digest; a
      // re-delivery is a deliberate conflict, never a replay.
      await admin.query(
        `UPDATE hns_root_health_renewal_jobs
            SET state='completed', leased_by=NULL, lease_expires_at=NULL,
                result_bytes='legacy-result'::bytea,
                result_sha256=encode(sha256('legacy-result'::bytea),'hex'),
                request_bytes=NULL, request_sha256=NULL, next_attempt_at=NULL,
                completed_at=clock_timestamp(), failure_code=NULL
          WHERE root_import_session_id='root-import-session'`,
      );
      const legacy = await admin.query<{ renewal_job_id: string }>(
        "SELECT renewal_job_id FROM hns_root_health_renewal_jobs ORDER BY created_at DESC LIMIT 1",
      );
      const replayed = await admin.query<{ outcome: string }>(
        `SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,'authority-executor',1,'${"0".repeat(64)}','ready',$2,encode(sha256($2),'hex'),NULL)`,
        [legacy.rows[0]?.renewal_job_id, Buffer.from("legacy-result")],
      );
      expect(replayed.rows[0]?.outcome).toBe("conflict");
      expect(
        (
          await admin.query<{ state: string }>(
            "SELECT state FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
            [legacy.rows[0]?.renewal_job_id],
          )
        ).rows[0]?.state,
      ).toBe("completed");
    });
  }, 30_000);

  test("recoverable renewal evidence failures retry in place once the evidence is restored", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const ready = await prepareReadyActivation(store, admin);
      await seedCommittedCommunityRoute(admin);
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).toMatchObject({ kind: "activated", response: { status: "activated" } });

      const schedule = () =>
        admin.query<{ eligible_roots: number; enqueued_roots: number }>(
          "SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)",
        );
      const claim = async () =>
        (
          await admin.query<Record<string, unknown>>(
            "SELECT * FROM claim_hns_root_health_renewal_job_v1($1,$2)",
            ["authority-executor", 60],
          )
        ).rows[0];
      const latestJob = async () =>
        (
          await admin.query<{
            renewal_job_id: string;
            state: string;
            failure_code: string | null;
            next_attempt_at: Date | null;
            waiting: boolean;
          }>(
            `SELECT renewal_job_id, state, failure_code, next_attempt_at,
                    next_attempt_at > clock_timestamp() AS waiting
               FROM hns_root_health_renewal_jobs
              ORDER BY created_at DESC, renewal_job_id DESC LIMIT 1`,
          )
        ).rows[0];
      // The test clock boundary: the job is delayed with a persisted due time
      // and the test moves it due rather than resetting the job.
      const due = () =>
        admin.query(
          "UPDATE hns_root_health_renewal_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state='delayed'",
        );
      const finish = async (job: Record<string, unknown>) => {
        const result = await makeReadinessArtifact({
          ownershipResultHash: ready.provisioned.ownershipResultHash,
          publishPlanSha256: sha256(ready.provisioned.planBytes),
          provisionResultSha256: sha256(ready.provisioned.resultBytes),
        });
        return (
          await admin.query<{ outcome: string }>(
            "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,'ready',$5,$6,NULL)",
            [
              job.observation_job_id,
              "authority-executor",
              Number(job.lease_fence),
              job.request_sha256,
              Buffer.from(result.result_bytes),
              result.result_sha256,
            ],
          )
        ).rows[0]?.outcome;
      };
      const expectDelayedRefusal = async (reason: string) => {
        expect(await claim()).toBeUndefined();
        const job = await latestJob();
        expect(job).toMatchObject({ state: "delayed", failure_code: reason, waiting: true });
        expect(job?.next_attempt_at).not.toBeNull();
        // Duplicate suppression while not due: neither the scheduler nor a
        // direct claim creates or leases replacement work.
        expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 0 });
        expect(await claim()).toBeUndefined();
      };
      const recover = async () => {
        await due();
        expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 1 });
        const job = await claim();
        expect(job).toBeDefined();
        expect(await finish(job as Record<string, unknown>)).toBe("ready");
      };

      // Cycle one: a mismatched retained plan binding.
      expect((await schedule()).rows[0]).toMatchObject({ eligible_roots: 1, enqueued_roots: 1 });
      // Repeated scheduling is deduplicated by the deterministic job identity.
      expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 0 });
      const replacement = Buffer.from('{"replacement":true}');
      await admin.query(
        `UPDATE hns_authority_provision_jobs
            SET publish_plan_bytes=$1, publish_plan_sha256=$2, updated_at=clock_timestamp()
          WHERE root_import_session_id='root-import-session' AND state='completed'`,
        [replacement, sha256(replacement)],
      );
      await expectDelayedRefusal("plan_binding_mismatch");
      await admin.query(
        `UPDATE hns_authority_provision_jobs
            SET publish_plan_bytes=$1, publish_plan_sha256=$2, updated_at=clock_timestamp()
          WHERE root_import_session_id='root-import-session' AND state='completed'`,
        [ready.provisioned.planBytes, sha256(ready.provisioned.planBytes)],
      );
      await recover();

      // Cycle two: a missing retained plan binding (the provision record is
      // removed, then restored with its authoritative bytes).
      expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 1 });
      const provisionRow = (
        await admin.query<{ job: Record<string, unknown> }>(
          `SELECT to_jsonb(job) AS job FROM hns_authority_provision_jobs AS job
            WHERE root_import_session_id='root-import-session' AND state='completed'`,
        )
      ).rows[0]?.job;
      if (provisionRow === undefined) throw new Error("provision row missing");
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        "DELETE FROM hns_authority_provision_jobs WHERE root_import_session_id='root-import-session'",
      );
      await admin.query("COMMIT");
      await expectDelayedRefusal("plan_binding_missing");
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `INSERT INTO hns_authority_provision_jobs
         SELECT (jsonb_populate_record(NULL::hns_authority_provision_jobs, $1::jsonb)).*`,
        [JSON.stringify(provisionRow)],
      );
      await admin.query("COMMIT");
      await recover();

      // Cycle three: missing accepted readiness. The retention trigger derives
      // acceptance from the observation, so the fixture models an inherited
      // inconsistent row and restores acceptance under the same maintenance
      // boundary rather than touching the renewal job.
      expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 1 });
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `UPDATE hns_root_import_lifecycle SET readiness_accepted_at=NULL
          WHERE root_import_session_id='root-import-session'`,
      );
      await admin.query("COMMIT");
      await expectDelayedRefusal("readiness_evidence_missing");
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `UPDATE hns_root_import_lifecycle SET readiness_accepted_at=clock_timestamp()
          WHERE root_import_session_id='root-import-session'`,
      );
      await admin.query("COMMIT");
      await recover();

      // Obsolete work stays terminal: a queued job for a superseded health
      // generation is refused at claim time and never retried, while the new
      // health generation still schedules its own successor.
      expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 1 });
      await admin.query(`INSERT INTO hns_dns_zone_health_observations
        SELECT (jsonb_populate_record(NULL::hns_dns_zone_health_observations,
          to_jsonb(health)||jsonb_build_object('health_generation',5))).*
        FROM hns_dns_zone_health_observations AS health WHERE health_generation=4`);
      expect(await claim()).toBeUndefined();
      expect(await latestJob()).toMatchObject({
        state: "terminal",
        failure_code: "generation_superseded",
      });
      expect(await claim()).toBeUndefined();
      expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 1 });
    });
  }, 60_000);

  test("renewal continues after a manual lifecycle generation bump, not real adoption", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const ready = await prepareReadyActivation(store, admin);
      await seedCommittedCommunityRoute(admin);
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).toMatchObject({ kind: "activated", response: { status: "activated" } });
      // This fixture writes the lifecycle generation column directly to prove
      // renewal is anchored to retained evidence and the DNS generation. It
      // does not exercise real adoption of an activated root; the
      // operator-authorized recovery and adoption command owns that path and
      // is exercised by its own suites.
      await admin.query(
        `UPDATE hns_root_import_lifecycle
            SET generation=generation+1
          WHERE root_import_session_id='root-import-session'`,
      );
      const scheduled = await admin.query<{ eligible_roots: number; enqueued_roots: number }>(
        "SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)",
      );
      expect(scheduled.rows).toMatchObject([{ eligible_roots: 1, enqueued_roots: 1 }]);
      const claim = await admin.query<{
        observation_job_id: string;
        operation_kind: string;
        request_sha256: string;
        lease_fence: string;
      }>("SELECT * FROM claim_hns_root_health_renewal_job_v1($1,$2)", ["authority-executor", 60]);
      expect(claim.rows).toMatchObject([{ operation_kind: "renew_health_v1" }]);
      const result = await makeReadinessArtifact({
        ownershipResultHash: ready.provisioned.ownershipResultHash,
        publishPlanSha256: sha256(ready.provisioned.planBytes),
        provisionResultSha256: sha256(ready.provisioned.resultBytes),
      });
      const finalized = await admin.query<{ outcome: string }>(
        "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,'ready',$5,$6,NULL)",
        [
          claim.rows[0]?.observation_job_id,
          "authority-executor",
          Number(claim.rows[0]?.lease_fence),
          claim.rows[0]?.request_sha256,
          Buffer.from(result.result_bytes),
          result.result_sha256,
        ],
      );
      expect(finalized.rows[0]?.outcome).toBe("ready");
    });
  }, 30_000);

  test("survives and reuses a stale-readiness hold without duplicating refresh work", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const ready = await prepareReadyActivation(store, admin);
      await seedCommittedCommunityRoute(admin);
      await admin.query(
        `UPDATE hns_root_import_lifecycle
            SET readiness_observed_at=clock_timestamp() - interval '1 hour'
          WHERE root_import_session_id='root-import-session'`,
      );
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).toEqual({ kind: "conflict" });
      const firstHold = await activationState(admin);
      expect(firstHold.lifecycle).toMatchObject({
        phase: "ready",
        pending_reason: "readiness_evidence_stale",
      });
      const refreshJobs = await admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_jobs
          WHERE root_import_session_id='root-import-session'
            AND job_kind='observe_readiness' AND state IN ('queued','leased')`,
      );
      expect(refreshJobs.rows[0]?.count).toBe(1);
      // A repeated stale command reuses the pending hold rather than
      // scheduling a second refresh.
      expect(
        await Effect.runPromise(Effect.scoped(store.activate(activationRecordFor(ready)))),
      ).toEqual({ kind: "conflict" });
      expect(
        (
          await admin.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_jobs
              WHERE root_import_session_id='root-import-session'
                AND job_kind='observe_readiness' AND state IN ('queued','leased')`,
          )
        ).rows[0]?.count,
      ).toBe(1);
      // A completed refresh lets the same operation activate.
      await admin.query(
        `UPDATE hns_root_import_lifecycle
            SET readiness_observed_at=clock_timestamp(), pending_reason=NULL
          WHERE root_import_session_id='root-import-session'`,
      );
      const refreshedRevision = Number(firstHold.lifecycle?.revision ?? 0);
      expect(
        await Effect.runPromise(
          Effect.scoped(
            store.activate(
              activationRecordFor(ready, {
                idempotency_key: "activate-after-refresh",
                current_evidence: {
                  lifecycle_revision: refreshedRevision,
                  lifecycle_generation: ready.lifecycleGeneration,
                  observed_at_epoch_ms: Date.now() - 5_000,
                  resource_sha256: ready.lifecyclePlanDigest,
                  qualifying: true,
                },
              }),
            ),
          ),
        ),
      ).toMatchObject({ kind: "activated", response: { status: "activated" } });
    });
  }, 30_000);

  test("serializes a real activation behind a real readiness refresh", async () => {
    await withSchema(async (connection, admin) => {
      const store = makeControlPlaneHnsRootImportStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const ready = await prepareReadyActivation(store, admin);
      await seedCommittedCommunityRoute(admin);
      await admin.query(
        `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
          VALUES ('root-import-session','observe_readiness',clock_timestamp() - interval '1 second')`,
      );
      const job = (
        await admin.query<{ lifecycle_job_id: string; lease_fence: string }>(
          "SELECT * FROM claim_hns_root_import_lifecycle_job_v1($1,$2)",
          ["lifecycle-executor", 60],
        )
      ).rows[0];
      if (job === undefined) throw new Error("no readiness refresh job was claimable");
      const refresh = await makeReadinessArtifact({
        ownershipResultHash: ready.provisioned.ownershipResultHash,
        publishPlanSha256: sha256(ready.provisioned.planBytes),
        provisionResultSha256: sha256(ready.provisioned.resultBytes),
      });
      const holder = new Client({ connectionString: connection });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        const written = await holder.query<{ outcome: string }>(
          "SELECT * FROM commit_hns_root_import_readiness_v1($1,$2,$3,$4,$5,$6,$7)",
          [
            "root-import-session",
            Number(job.lifecycle_job_id),
            "lifecycle-executor",
            Number(job.lease_fence),
            ready.lifecycleRevision,
            refresh.result_bytes,
            refresh.result_sha256,
          ],
        );
        expect(written.rows[0]).toMatchObject({ outcome: "ready" });
        // The real repository path blocks behind the refresh's row lock and
        // then refuses the now-stale binding rather than corrupting state.
        const activation = Effect.runPromise(
          Effect.scoped(
            store.activate(
              activationRecordFor(ready, { idempotency_key: "activate-behind-refresh" }),
            ),
          ),
        );
        const settled = await Promise.race([
          activation.then(() => "settled" as const),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
        ]);
        expect(settled).toBe("blocked");
        await holder.query("COMMIT");
        expect(await activation).toEqual({ kind: "conflict" });
        const refreshed = await activationState(admin);
        expect(refreshed.lifecycle).toMatchObject({ phase: "ready" });
        expect(Number(refreshed.lifecycle?.revision)).toBeGreaterThan(ready.lifecycleRevision);
        expect(refreshed.session).toEqual({ status: "ready", revision: "6" });
        const freshRevision = Number(refreshed.lifecycle?.revision ?? 0);
        expect(
          await Effect.runPromise(
            Effect.scoped(
              store.activate(
                activationRecordFor(ready, {
                  expected_revision: 6,
                  idempotency_key: "activate-after-refresh",
                  readiness_result_sha256: refresh.result_sha256,
                  current_evidence: {
                    lifecycle_revision: freshRevision,
                    lifecycle_generation: ready.lifecycleGeneration,
                    observed_at_epoch_ms: Date.now() - 5_000,
                    resource_sha256: ready.lifecyclePlanDigest,
                    qualifying: true,
                  },
                }),
              ),
            ),
          ),
        ).toMatchObject({ kind: "activated", response: { status: "activated", revision: 7 } });
      } finally {
        await holder.end().catch(() => undefined);
      }
    });
  }, 30_000);
});
