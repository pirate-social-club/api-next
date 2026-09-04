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
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
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
  const plan = buildHnsRootImportPublishPlanV1({
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
  readonly ownershipResultHash: string;
  readonly publishPlanSha256: string;
  readonly provisionResultSha256: string;
}) {
  const observedAt = new Date(Date.now() - 1_000).toISOString();
  const validUntil = new Date(Date.now() + 3_600_000).toISOString();
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
    environment: "test",
    authoritative_nameserver_glue: nameserverGlue,
    dns_write_capabilities: capabilities,
  });
  const inventoryBytes = await encodeHnsAuthorityInventory({
    version: HNS_AUTHORITY_INVENTORY_VERSION,
    authority_inventory_reference: "hns-authority:newroot",
    authority_inventory_version: `readiness-${input.provisionResultSha256.slice(0, 16)}`,
    environment: "test",
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

      const plan = buildHnsRootImportPublishPlanV1({
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

  test("leases teardown before expiring a provisioned root abandoned before broadcast", async () => {
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
        observation_job_id: string;
        operation_kind: string;
        request_sha256: string;
        lease_fence: string;
      }>("SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)", [
        "authority-executor",
        60,
      ]);
      expect(claim.rows).toHaveLength(1);
      expect(claim.rows[0]).toMatchObject({ operation_kind: "teardown_root_v1" });
      const finalized = await admin.query<{
        outcome: string;
        root_import_session_id: string;
        session_revision: string;
      }>("SELECT * FROM finalize_hns_root_import_observation_job_v1($1,$2,$3,$4,$5,$6,$7,$8)", [
        claim.rows[0]?.observation_job_id,
        "authority-executor",
        Number(claim.rows[0]?.lease_fence),
        claim.rows[0]?.request_sha256,
        "failed",
        null,
        null,
        "session_expired",
      ]);
      expect(finalized.rows).toEqual([
        {
          outcome: "failed",
          root_import_session_id: "root-import-session",
          session_revision: "4",
        },
      ]);
      const state = await admin.query<{ teardown_state: string; session_status: string }>(
        `SELECT teardown.state AS teardown_state,session.status AS session_status
           FROM hns_root_import_teardown_jobs AS teardown
           JOIN hns_root_import_sessions AS session
             ON session.root_import_session_id=teardown.root_import_session_id
          WHERE teardown.root_import_session_id='root-import-session'`,
      );
      expect(state.rows).toEqual([{ teardown_state: "completed", session_status: "expired" }]);
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
      const plan = buildHnsRootImportPublishPlanV1({
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

  test("observes readiness and atomically activates serving plus handle issuance", async () => {
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

      const firstClaim = await admin.query<{
        lease_fence: string;
        request_sha256: string;
      }>("SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)", [
        "authority-executor",
        60,
      ]);
      const pending = await admin.query<{
        outcome: string;
        root_import_session_id: string;
        session_revision: string;
      }>("SELECT * FROM finalize_hns_root_import_observation_job_v1($1,$2,$3,$4,$5,$6,$7,$8)", [
        "observation-root-import",
        "authority-executor",
        Number(firstClaim.rows[0]?.lease_fence),
        firstClaim.rows[0]?.request_sha256,
        "retry",
        null,
        null,
        "owner_update_pending",
      ]);
      expect(pending.rows).toEqual([
        {
          outcome: "retry",
          root_import_session_id: "root-import-session",
          session_revision: "4",
        },
      ]);
      await admin.query(
        "UPDATE hns_root_import_observation_jobs SET attempt_count=19 WHERE observation_job_id=$1",
        ["observation-root-import"],
      );
      const claim = await admin.query<{
        lease_fence: string;
        request_sha256: string;
      }>("SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)", [
        "authority-executor",
        60,
      ]);
      expect(claim.rows).toHaveLength(1);
      expect(
        (
          await admin.query<{ attempt_count: number }>(
            "SELECT attempt_count FROM hns_root_import_observation_jobs WHERE observation_job_id=$1",
            ["observation-root-import"],
          )
        ).rows[0]?.attempt_count,
      ).toBe(20);
      const readiness = await makeReadinessArtifact({
        ownershipResultHash,
        publishPlanSha256: sha256(provisioned.planBytes),
        provisionResultSha256: sha256(provisioned.resultBytes),
      });
      const finalized = await admin.query<{
        outcome: string;
        session_revision: string;
      }>("SELECT * FROM finalize_hns_root_import_observation_job_v1($1,$2,$3,$4,$5,$6,$7,$8)", [
        "observation-root-import",
        "authority-executor",
        Number(claim.rows[0]?.lease_fence),
        claim.rows[0]?.request_sha256,
        "ready",
        Buffer.from(readiness.result_bytes),
        readiness.result_sha256,
        null,
      ]);
      expect(finalized.rows).toMatchObject([{ outcome: "ready", session_revision: "5" }]);

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
      expect(state.rows[0]?.health_seconds_remaining).toBeGreaterThan(3_590);

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
        { outcome: "ready", root_import_session_id: "root-import-session", session_revision: "6" },
      ]);
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

      await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const boundedClaim = await admin.query<{
          observation_job_id: string;
          request_sha256: string;
          lease_fence: string;
        }>("SELECT * FROM claim_hns_root_health_renewal_job_v1($1,$2)", ["authority-executor", 60]);
        const bounded = await admin.query<{ outcome: string }>(
          "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,'retry',NULL,NULL,'authority_unavailable')",
          [
            boundedClaim.rows[0]?.observation_job_id,
            "authority-executor",
            Number(boundedClaim.rows[0]?.lease_fence),
            boundedClaim.rows[0]?.request_sha256,
          ],
        );
        expect(bounded.rows[0]?.outcome).toBe(attempt < 3 ? "retry" : "failed");
      }
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
  }, 20_000);

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
      const claim = await admin.query<{ lease_fence: string; request_sha256: string }>(
        "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
        ["authority-executor", 60],
      );
      const readiness = await makeReadinessArtifact({
        ownershipResultHash: provisioned.ownershipResultHash,
        publishPlanSha256: sha256(provisioned.planBytes),
        provisionResultSha256: sha256(provisioned.resultBytes),
      });
      await admin.query(
        "SELECT * FROM finalize_hns_root_import_observation_job_v1($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          "community-observation",
          "authority-executor",
          Number(claim.rows[0]?.lease_fence),
          claim.rows[0]?.request_sha256,
          "ready",
          Buffer.from(readiness.result_bytes),
          readiness.result_sha256,
          null,
        ],
      );
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
});
