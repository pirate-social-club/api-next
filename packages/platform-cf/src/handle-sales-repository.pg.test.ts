import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  HandleRecipientTokenVault,
  HandleSalesRejected,
  IdGen,
  makeHandleSalesService,
} from "@pirate/application";
import { handleSaleNamespaceActivationHash } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeHandleRecipientTokenVault } from "./handle-recipient-token-vault.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const migrations = await loadPostgresMigrations();
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_HANDLE_SALES_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-handle-sales-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-handle-sales-suite-complete\n";
const testCount = 3;
let completedTestCount = 0;

const schemaIdentifier = (): string =>
  `api_next_handle_sales_${crypto.randomUUID().replaceAll("-", "")}`;
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

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

async function seedAccount(admin: Client, accountId: string): Promise<string> {
  await admin.query(`INSERT INTO users (user_id,status) VALUES ($1,'active')`, [accountId]);
  const result = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
    [accountId],
  );
  const personaId = result.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona missing");
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
  return personaId;
}

async function seedSaleNamespace(admin: Client, sellerId: string, communityId: string) {
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

async function seedHealthySaleDependencies(admin: Client, sellerId: string, communityId: string) {
  await admin.query(
    `INSERT INTO communities (
       community_id,display_name,status,created_by_user_id,created_at,updated_at,
       route_slug,route_authority_version
     ) VALUES ($1,'Live Handle Test','active',$2,clock_timestamp(),clock_timestamp(),NULL,
               'optional_route_v2')`,
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
  const namespaceAuthorityReference = "sale-evidence-live";
  const dnsZoneActivationId = "dns-zone-live";
  const inventoryReference = "authority-inventory:handle-sales-live";
  const inventoryVersion = "1";
  const inventoryBytes = Buffer.from("handle-sales-live-authority-inventory-v1");
  const inventoryDigest = createHash("sha256").update(inventoryBytes).digest("hex");
  const zoneBytes = Buffer.from("$ORIGIN charizard.\n; handle-sales-live-v1\n");
  const zoneDigest = createHash("sha256").update(zoneBytes).digest("hex");
  const activationBytes = Buffer.from("handle-sales-live-dns-activation-v1");
  const activationDigest = createHash("sha256").update(activationBytes).digest("hex");

  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO community_route_ownership_evidence (
         evidence_ref,creation_ceremony_intent_id,verified_by_actor_id,family,root_label,
         root_label_display,path_segment,requirement_hash,provider_id,provider_binding_hash,
         provider_configuration_version,provider_identity_digest,evidence_digest,
         binding_generation,verified_at,expires_at,origin
       ) VALUES ($1,'sale-ceremony-live',$2,'hns','charizard','charizard','app.charizard',
                 $3,'sale-provider',$4,'1',$5,$6,1,clock_timestamp()-interval '1 minute',
                 clock_timestamp()+interval '1 hour','creation_ceremony')`,
      [
        namespaceAuthorityReference,
        sellerId,
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
        "4".repeat(64),
      ],
    );
    await admin.query(
      `INSERT INTO community_canonical_route_bindings (
         route_binding_id,community_id,family,root_label,root_label_display,ownership_status,
         route_lifecycle_status,binding_generation,verified_evidence_ref
       ) VALUES ('unattached-sale-proof-live',$1,'hns','charizard','charizard','verified',
                 'active',1,$2)`,
      [communityId, namespaceAuthorityReference],
    );
    await admin.query(
      `INSERT INTO hns_authority_inventories (
         registry_reference,authority_inventory_reference,authority_inventory_version,
         authority_inventory_digest,environment,runtime_capability_set_digest,inventory_bytes,
         published_at,expires_at
       ) VALUES ('authority-registry:handle-sales-live',$1,$2,$3,'test',$4,$5,
                 clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
      [inventoryReference, inventoryVersion, inventoryDigest, "5".repeat(64), inventoryBytes],
    );
    await admin.query(
      `INSERT INTO hns_dns_zone_activation_revisions (
         dns_zone_activation_id,dns_zone_activation_generation,activation_document_bytes,
         activation_document_digest,canonical_root,dns_authority_kind,dns_authority_reference,
         dns_authority_generation,pirate_dns_authority_inventory_reference,
         pirate_dns_authority_inventory_version,pirate_dns_authority_inventory_digest,
         zone_revision,zone_bytes,zone_bytes_digest,dnssec_keyset_reference,
         dnssec_keyset_version,gateway_deployment_reference,gateway_certificate_spki_sha256,
         stable_chain_delegation_snapshot_reference,stable_chain_delegation_snapshot_digest,
         status,reason_code,activated_at,suspended_at,revoked_at
       ) VALUES ($1,1,$2,$3,'charizard','pirate_managed_dns_v1','dns-authority:charizard',1,
                 $4,$5,$6,1,$7,$8,'dnssec-keyset:charizard','1',
                 'gateway-deployment:handle-sales-live',$9,
                 'hns-delegation-snapshot:handle-sales-live',$10,'active',NULL,
                 clock_timestamp(),NULL,NULL)`,
      [
        dnsZoneActivationId,
        activationBytes,
        activationDigest,
        inventoryReference,
        inventoryVersion,
        inventoryDigest,
        zoneBytes,
        zoneDigest,
        "6".repeat(64),
        "7".repeat(64),
      ],
    );
    await admin.query(
      `INSERT INTO hns_dns_zone_activation_current (
         dns_zone_activation_id,canonical_root,current_generation,updated_at
       ) VALUES ($1,'charizard',1,clock_timestamp())`,
      [dnsZoneActivationId],
    );
    await admin.query(
      `INSERT INTO hns_dns_zone_health_observations (
         dns_zone_activation_id,activation_generation,health_generation,
         stable_chain_delegation_snapshot_reference,stable_chain_delegation_snapshot_digest,
         observed_zone_bytes_digest,observed_dnssec_keyset_reference,
         observed_dnssec_keyset_version,observed_gateway_deployment_reference,
         observed_gateway_certificate_spki_sha256,delegation_matches,ds_authenticates_zone,
         retained_zone_digest_matches,gateway_healthy,checked_at,valid_until
       ) VALUES ($1,1,1,'hns-delegation-snapshot:handle-sales-live',$2,$3,
                 'dnssec-keyset:charizard','1','gateway-deployment:handle-sales-live',$4,
                 TRUE,TRUE,TRUE,TRUE,clock_timestamp(),clock_timestamp()+interval '1 hour')`,
      [dnsZoneActivationId, "7".repeat(64), zoneDigest, "6".repeat(64)],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  return { namespaceAuthorityReference, dnsZoneActivationId, zoneDigest };
}

const terms = (activationId: string) =>
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

const directGrantTerms = (
  activationId: string,
  policy: Readonly<{ policy_id: string; policy_revision: number }>,
  handleLabel: string,
) =>
  ({
    sale_namespace_activation_id: activationId,
    expected_sale_namespace_activation_generation: 1,
    label_scope: {
      kind: "exact_label_v2",
      label_grammar_id: "hns_ascii_ldh_1_63_v1",
      handle_label: handleLabel,
      reserved_labels_id: "reserved_labels_01",
      expected_reserved_labels_revision: 1,
    },
    allocation_kind: "direct_grant_v1",
    fulfillment_kind: "hosted_persona_v1",
    qualification_policy_id: policy.policy_id,
    expected_qualification_policy_revision: policy.policy_revision,
    pricing_id: "platform_free_handles_v1",
    expected_pricing_revision: 1,
    issuance_driver_id: "hosted_persona-local",
    expected_issuance_driver_version: "1",
    quote_ttl_seconds: 120,
    reservation_ttl_seconds: 300,
  }) as const;

suite("community handle sales on PostgreSQL 17", () => {
  test("backfills one deterministic sales authority for an existing community", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const finalMigration = migrations[migrations.length - 1];
    if (finalMigration?.version !== "0053_community_handle_sales.sql") {
      throw new Error("0053 must be the final migration in this exclusive lane");
    }
    const schema = schemaIdentifier();
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    const scopedConnection = connectionForSchema(connectionString, schema);
    const layer = makeDirectPostgresControlPlaneLayer(scopedConnection);
    try {
      await Effect.runPromise(
        Effect.scoped(applyPostgresMigrations(migrations.slice(0, -1)).pipe(Effect.provide(layer))),
      );
      await admin.query(
        "INSERT INTO users (user_id,status) VALUES ('legacy-handle-owner','active')",
      );
      const communityId = "community_123e4567-e89b-42d3-a456-426614174052";
      await admin.query(
        `INSERT INTO communities (
           community_id,display_name,status,created_by_user_id,created_at,updated_at,
           route_slug,route_authority_version
         ) VALUES ($1,'Legacy Handle Community','active','legacy-handle-owner',
                   clock_timestamp(),clock_timestamp(),NULL,'optional_route_v2')`,
        [communityId],
      );
      await Effect.runPromise(
        Effect.scoped(applyPostgresMigrations(migrations).pipe(Effect.provide(layer))),
      );
      const grants = await admin.query(
        `SELECT source_kind,status,
                grant_id=community_handle_sales_creator_grant_id_v1(
                  community_id,principal_account_id
                ) AS deterministic
           FROM community_handle_sales_authority_grants
          WHERE community_id=$1 AND principal_account_id='legacy-handle-owner'`,
        [communityId],
      );
      expect(grants.rows).toEqual([
        {
          deterministic: true,
          source_kind: "creator_owner",
          status: "active",
        },
      ]);
      await Effect.runPromise(
        Effect.scoped(applyPostgresMigrations(migrations).pipe(Effect.provide(layer))),
      );
      const count = await admin.query<{ readonly count: number }>(
        `SELECT count(*)::int AS count FROM community_handle_sales_authority_grants
          WHERE community_id=$1`,
        [communityId],
      );
      expect(count.rows[0]?.count).toBe(1);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    completedTestCount += 1;
  }, 20_000);

  test("authors a private direct-grant policy and issues a replay-safe free hosted grant", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      await seedAccount(admin, "seller-account");
      const recipientPersona = await seedAccount(admin, "recipient-account");
      const communityId = "community_123e4567-e89b-42d3-a456-426614174053";
      const activationId = await seedSaleNamespace(admin, "seller-account", communityId);
      const store = makeControlPlaneHandleSalesStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const sales = makeHandleSalesService(store);
      const vault = makeHandleRecipientTokenVault({
        hmacKeys: `h1:${key(11)}`,
        envelopeKeys: `e1:${key(12)}`,
      });
      let sequence = 0;
      const run = <A, E>(effect: Effect.Effect<A, E, IdGen | HandleRecipientTokenVault>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(IdGen, {
              next: Effect.sync(() => `${++sequence}`.padStart(4, "0")),
            }),
            Effect.provideService(HandleRecipientTokenVault, vault),
          ),
        );

      const token = await run(
        sales.createRecipientToken({
          accountId: "recipient-account",
          communityId,
          idempotencyKey: "recipient-token-key",
        }),
      );
      expect(token.recipient_token).toMatch(/^hgrt_[A-Za-z0-9_-]{43}$/u);
      await expect(
        run(
          sales.createRecipientToken({
            accountId: "recipient-account",
            communityId,
            idempotencyKey: "recipient-token-key",
          }),
        ),
      ).resolves.toEqual({ ...token, replayed: true });
      const storedToken = await admin.query<{
        readonly ttl_seconds: number;
        readonly private_row: string;
      }>(
        `SELECT extract(epoch FROM expires_at-created_at)::int AS ttl_seconds,
                to_jsonb(token)::text AS private_row
           FROM handle_direct_grant_recipient_tokens AS token
          WHERE recipient_account_id='recipient-account' AND status='current'`,
      );
      expect(storedToken.rows[0]?.ttl_seconds).toBe(600);
      expect(storedToken.rows[0]?.private_row).not.toContain(token.recipient_token);

      const policy = await run(
        sales.createQualificationPolicy({
          accountId: "seller-account",
          communityId,
          idempotencyKey: "policy-key",
          recipientToken: token.recipient_token,
          expectedAccountDirectoryBindingVersion: "1",
        }),
      );
      expect(policy.qualification_policy).toMatchObject({ kind: "curated_policy_v1" });
      expect(JSON.stringify(policy)).not.toContain("recipient-account");
      expect(JSON.stringify(policy)).not.toContain(token.recipient_token);
      const consumedToken = await admin.query<{
        readonly status: string;
        readonly ciphertext_dropped: boolean;
      }>(
        `SELECT status,token_ciphertext IS NULL AS ciphertext_dropped
           FROM handle_direct_grant_recipient_tokens
          WHERE recipient_account_id='recipient-account'`,
      );
      expect(consumedToken.rows[0]).toEqual({ status: "consumed", ciphertext_dropped: true });
      await expect(
        run(
          sales.createQualificationPolicy({
            accountId: "seller-account",
            communityId,
            idempotencyKey: "policy-key",
            recipientToken: token.recipient_token,
            expectedAccountDirectoryBindingVersion: "1",
          }),
        ),
      ).resolves.toEqual({ ...policy, replayed: true });

      const offering = await run(
        sales.createOffering({
          accountId: "seller-account",
          communityId,
          idempotencyKey: "offering-key",
          terms: terms(activationId),
        }),
      );
      expect(offering.offering.max_active_grants_per_account).toBe(1);
      await run(
        sales.confirmPersonaReuse({
          accountId: "recipient-account",
          personaId: recipientPersona,
          offeringId: offering.offering.offering_id,
          idempotencyKey: "link-key",
        }),
      );
      const quote = await run(
        sales.createQuote({
          accountId: "recipient-account",
          personaId: recipientPersona,
          offeringId: offering.offering.offering_id,
          desiredLabel: "longname",
          idempotencyKey: "quote-key",
        }),
      );
      if (quote.kind !== "quoted") throw new Error("expected a quote");
      await expect(
        admin.query("UPDATE handle_quotes SET offering_hash=$2 WHERE quote_id=$1", [
          quote.quote.quote_id,
          "f".repeat(64),
        ]),
      ).rejects.toMatchObject({ message: "handle quote transition is invalid" });
      const reservation = await run(
        sales.createReservation({
          accountId: "recipient-account",
          personaId: recipientPersona,
          quoteId: quote.quote.quote_id,
          expectedQuoteHash: quote.quote.quote_hash,
          idempotencyKey: "reservation-key",
        }),
      );
      const claim = await run(
        sales.submitFreeClaim({
          accountId: "recipient-account",
          personaId: recipientPersona,
          reservationId: reservation.reservation.reservation_id,
          expectedReservationHash: reservation.reservation.reservation_hash,
          idempotencyKey: "claim-key",
        }),
      );
      expect(claim.claim).toMatchObject({
        state: "issued",
        display_identifier: "longname.charizard",
        grant: { status: "active", owner_persona_id: recipientPersona },
      });
      await expect(
        run(
          sales.submitFreeClaim({
            accountId: "recipient-account",
            personaId: recipientPersona,
            reservationId: reservation.reservation.reservation_id,
            expectedReservationHash: reservation.reservation.reservation_hash,
            idempotencyKey: "claim-key",
          }),
        ),
      ).resolves.toEqual({ ...claim, replayed: true });
      const publicGrant = await run(
        sales.getPublicGrant({
          family: "hns",
          namespaceRoot: "charizard",
          handleLabel: "longname",
        }),
      );
      expect(publicGrant).toMatchObject({
        owner_persona: { persona_id: recipientPersona },
        host: { kind: "unavailable", reason: "host_not_activated" },
      });

      const siblingPersona = "persona-recipient-sibling";
      await admin.query(
        `INSERT INTO personas (persona_id,account_id,status,is_first_persona)
         VALUES ($1,'recipient-account','active',FALSE)`,
        [siblingPersona],
      );
      await run(
        sales.confirmPersonaReuse({
          accountId: "recipient-account",
          personaId: siblingPersona,
          offeringId: offering.offering.offering_id,
          idempotencyKey: "second-link-key",
        }),
      );
      await expect(
        run(
          sales.createQuote({
            accountId: "recipient-account",
            personaId: siblingPersona,
            offeringId: offering.offering.offering_id,
            desiredLabel: "otherlong",
            idempotencyKey: "second-quote-key",
          }),
        ),
      ).rejects.toMatchObject(
        new HandleSalesRejected({
          reason: "account_grant_limit_reached",
          retryable: false,
        }),
      );

      const directOffering = await run(
        sales.createOffering({
          accountId: "seller-account",
          communityId,
          idempotencyKey: "direct-offering-key",
          terms: directGrantTerms(activationId, policy.qualification_policy, "shortname"),
        }),
      );
      expect(directOffering.offering).toMatchObject({
        allocation: { kind: "direct_grant_v1" },
        max_active_grants_per_account: null,
        qualification_policy: policy.qualification_policy,
      });
      const firstOfferingPage = await run(sales.listOfferings({ communityId, limit: 1 }));
      expect(firstOfferingPage.items).toHaveLength(1);
      expect(firstOfferingPage.next_cursor).toStartWith("hcp1.");
      expect(firstOfferingPage.next_cursor).not.toBe(firstOfferingPage.items[0]?.offering_id);
      const firstOfferingCursor = firstOfferingPage.next_cursor;
      if (firstOfferingCursor === null) throw new Error("missing offering page cursor");
      const secondOfferingPage = await run(
        sales.listOfferings({
          communityId,
          limit: 1,
          cursor: firstOfferingCursor,
        }),
      );
      expect(secondOfferingPage.items).toHaveLength(1);
      expect(secondOfferingPage.items[0]?.offering_id).not.toBe(
        firstOfferingPage.items[0]?.offering_id,
      );
      expect(secondOfferingPage.next_cursor).toBeNull();
      await expect(
        run(
          sales.listSaleNamespaces({
            communityId,
            cursor: firstOfferingCursor,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "HandleSalesPageRejected",
        reason: "invalid_cursor",
      });
      for (const [desiredLabel, reason] of [
        ["tiny", "not_offered"],
        ["admin", "handle_unavailable"],
        ["BadLabel", "invalid_handle"],
      ] as const) {
        await expect(
          run(
            sales.createQuote({
              accountId: "recipient-account",
              personaId: recipientPersona,
              offeringId: offering.offering.offering_id,
              desiredLabel,
              idempotencyKey: `classifier-${reason}`,
            }),
          ),
        ).rejects.toMatchObject({ _tag: "HandleSalesRejected", reason });
      }
      await expect(
        run(
          sales.createQuote({
            accountId: "recipient-account",
            personaId: recipientPersona,
            offeringId: offering.offering.offering_id,
            desiredLabel: "shortname",
            idempotencyKey: "classifier-wrong-offering",
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "HandleSalesRejected",
        reason: "offering_not_applicable",
        effectiveOfferingId: directOffering.offering.offering_id,
      });
      await run(
        sales.confirmPersonaReuse({
          accountId: "recipient-account",
          personaId: recipientPersona,
          offeringId: directOffering.offering.offering_id,
          idempotencyKey: "direct-link-key",
        }),
      );
      const directQuote = await run(
        sales.createQuote({
          accountId: "recipient-account",
          personaId: recipientPersona,
          offeringId: directOffering.offering.offering_id,
          desiredLabel: "shortname",
          idempotencyKey: "direct-quote-key",
        }),
      );
      expect(directQuote.kind).toBe("quoted");
      const sellerPersona = await admin.query<{ readonly persona_id: string }>(
        `SELECT persona_id FROM personas WHERE account_id='seller-account' AND is_first_persona`,
      );
      const ineligible = await run(
        sales.createQuote({
          accountId: "seller-account",
          personaId: sellerPersona.rows[0]?.persona_id ?? "missing",
          offeringId: directOffering.offering.offering_id,
          desiredLabel: "shortname",
          idempotencyKey: "wrong-recipient-quote-key",
        }),
      );
      expect(ineligible).toMatchObject({
        kind: "eligibility_required",
        reason: "qualification_unsatisfied",
      });

      const contenderA = await seedAccount(admin, "contender-a");
      const contenderB = await seedAccount(admin, "contender-b");
      const contenderInputs = [
        { accountId: "contender-a", personaId: contenderA, suffix: "a" },
        { accountId: "contender-b", personaId: contenderB, suffix: "b" },
      ] as const;
      const contenderQuotes = [];
      for (const contender of contenderInputs) {
        await run(
          sales.confirmPersonaReuse({
            accountId: contender.accountId,
            personaId: contender.personaId,
            offeringId: offering.offering.offering_id,
            idempotencyKey: `contender-link-${contender.suffix}`,
          }),
        );
        const contenderQuote = await run(
          sales.createQuote({
            accountId: contender.accountId,
            personaId: contender.personaId,
            offeringId: offering.offering.offering_id,
            desiredLabel: "contended",
            idempotencyKey: `contender-quote-${contender.suffix}`,
          }),
        );
        if (contenderQuote.kind !== "quoted") throw new Error("expected contender quote");
        contenderQuotes.push({ contender, quote: contenderQuote.quote });
      }
      const reservationResults = await Promise.allSettled(
        contenderQuotes.map(({ contender, quote: contenderQuote }) =>
          run(
            sales.createReservation({
              accountId: contender.accountId,
              personaId: contender.personaId,
              quoteId: contenderQuote.quote_id,
              expectedQuoteHash: contenderQuote.quote_hash,
              idempotencyKey: `contender-reservation-${contender.suffix}`,
            }),
          ).then((reservation) => ({ contender, reservation })),
        ),
      );
      const winners = reservationResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const loserReasons = reservationResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(winners).toHaveLength(1);
      expect(loserReasons).toHaveLength(1);
      expect(loserReasons[0]).toMatchObject({
        _tag: "HandleSalesRejected",
        reason: "handle_unavailable",
      });
      const winner = winners[0];
      if (winner === undefined) throw new Error("missing reservation winner");
      const contestedClaim = await run(
        sales.submitFreeClaim({
          accountId: winner.contender.accountId,
          personaId: winner.contender.personaId,
          reservationId: winner.reservation.reservation.reservation_id,
          expectedReservationHash: winner.reservation.reservation.reservation_hash,
          idempotencyKey: `contender-claim-${winner.contender.suffix}`,
        }),
      );
      expect(contestedClaim.claim).toMatchObject({
        state: "issued",
        display_identifier: "contended.charizard",
      });

      const capPersonaA = await seedAccount(admin, "cap-account");
      const capPersonaB = "persona-cap-sibling";
      await admin.query(
        `INSERT INTO personas (persona_id,account_id,status,is_first_persona)
         VALUES ($1,'cap-account','active',FALSE)`,
        [capPersonaB],
      );
      const capReservations = [];
      for (const [personaId, label, suffix] of [
        [capPersonaA, "capalpha", "a"],
        [capPersonaB, "capbravo", "b"],
      ] as const) {
        await run(
          sales.confirmPersonaReuse({
            accountId: "cap-account",
            personaId,
            offeringId: offering.offering.offering_id,
            idempotencyKey: `cap-link-${suffix}`,
          }),
        );
        const capQuote = await run(
          sales.createQuote({
            accountId: "cap-account",
            personaId,
            offeringId: offering.offering.offering_id,
            desiredLabel: label,
            idempotencyKey: `cap-quote-${suffix}`,
          }),
        );
        if (capQuote.kind !== "quoted") throw new Error("expected cap quote");
        const capReservation = await run(
          sales.createReservation({
            accountId: "cap-account",
            personaId,
            quoteId: capQuote.quote.quote_id,
            expectedQuoteHash: capQuote.quote.quote_hash,
            idempotencyKey: `cap-reservation-${suffix}`,
          }),
        );
        capReservations.push({ personaId, suffix, reservation: capReservation.reservation });
      }
      const capRace = await Promise.allSettled(
        capReservations.map(({ personaId, suffix, reservation: capReservation }) =>
          run(
            sales.submitFreeClaim({
              accountId: "cap-account",
              personaId,
              reservationId: capReservation.reservation_id,
              expectedReservationHash: capReservation.reservation_hash,
              idempotencyKey: `cap-claim-${suffix}`,
            }),
          ),
        ),
      );
      expect(capRace.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const capLosers = capRace.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(capLosers).toHaveLength(1);
      expect(capLosers[0]?.reason).toMatchObject({
        _tag: "HandleSalesRejected",
        reason: "account_grant_limit_reached",
      });

      await seedAccount(admin, "delegated-seller");
      await seedAccount(admin, "direct-target");
      await admin.query(
        `INSERT INTO community_handle_sales_authority_grants (
           grant_id,community_id,principal_account_id,authority,source_kind,source_policy_ref,
           status,granted_at,granted_by_account_id
         ) VALUES ('delegated-handle-sales-grant',$1,'delegated-seller','manage_handle_sales',
                   'community_policy','test-delegated-seller','active',clock_timestamp(),
                   'seller-account')`,
        [communityId],
      );
      const supersededToken = await run(
        sales.createRecipientToken({
          accountId: "direct-target",
          communityId,
          idempotencyKey: "superseded-token-key",
        }),
      );
      const currentToken = await run(
        sales.createRecipientToken({
          accountId: "direct-target",
          communityId,
          idempotencyKey: "current-token-key",
        }),
      );
      await expect(
        run(
          sales.createQualificationPolicy({
            accountId: "seller-account",
            communityId,
            idempotencyKey: "superseded-policy-key",
            recipientToken: supersededToken.recipient_token,
            expectedAccountDirectoryBindingVersion: "1",
          }),
        ),
      ).rejects.toMatchObject({ _tag: "HandleDirectGrantRecipientUnavailable" });
      const policyRace = await Promise.allSettled(
        ["seller-account", "delegated-seller"].map((seller) =>
          run(
            sales.createQualificationPolicy({
              accountId: seller,
              communityId,
              idempotencyKey: `concurrent-policy-${seller}`,
              recipientToken: currentToken.recipient_token,
              expectedAccountDirectoryBindingVersion: "1",
            }),
          ),
        ),
      );
      expect(policyRace.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const policyRaceLosers = policyRace.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(policyRaceLosers).toHaveLength(1);
      expect(policyRaceLosers[0]?.reason).toMatchObject({
        _tag: "HandleDirectGrantRecipientUnavailable",
      });
      expect(JSON.stringify(policyRace)).not.toContain("direct-target");

      await seedAccount(admin, "authority-order-target");
      const authorityOrderToken = await run(
        sales.createRecipientToken({
          accountId: "authority-order-target",
          communityId,
          idempotencyKey: "authority-order-token-key",
        }),
      );
      await expect(
        run(
          sales.createQualificationPolicy({
            accountId: "recipient-account",
            communityId,
            idempotencyKey: "unauthorized-policy-key",
            recipientToken: authorityOrderToken.recipient_token,
            expectedAccountDirectoryBindingVersion: "1",
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "HandleSalesRejected",
        reason: "offering_unavailable",
      });
      const authorityOrderState = await admin.query<{ readonly status: string }>(
        `SELECT status FROM handle_direct_grant_recipient_tokens
          WHERE recipient_account_id='authority-order-target'`,
      );
      expect(authorityOrderState.rows[0]?.status).toBe("current");
      await expect(
        run(
          sales.createQualificationPolicy({
            accountId: "seller-account",
            communityId,
            idempotencyKey: "authorized-policy-key",
            recipientToken: authorityOrderToken.recipient_token,
            expectedAccountDirectoryBindingVersion: "1",
          }),
        ),
      ).resolves.toMatchObject({ kind: "account_allowlist_policy_authored_v2" });
    });
    completedTestCount += 1;
  }, 20_000);

  test("activates an unrouted HNS root and fails delegation drift and terminal revocation closed", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      await seedAccount(admin, "activation-seller");
      const communityId = "community_123e4567-e89b-42d3-a456-426614174054";
      const dependencies = await seedHealthySaleDependencies(
        admin,
        "activation-seller",
        communityId,
      );
      const store = makeControlPlaneHandleSalesStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const sales = makeHandleSalesService(store);
      let sequence = 0;
      const run = <A, E>(effect: Effect.Effect<A, E, IdGen | HandleRecipientTokenVault>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(IdGen, {
              next: Effect.sync(() => `activation-${++sequence}`),
            }),
            Effect.provideService(
              HandleRecipientTokenVault,
              makeHandleRecipientTokenVault({
                hmacKeys: `h1:${key(21)}`,
                envelopeKeys: `e1:${key(22)}`,
              }),
            ),
          ),
        );
      const authorityInput = {
        namespaceAuthorityReference: dependencies.namespaceAuthorityReference,
        expectedNamespaceAuthorityGeneration: 1,
        dnsZoneActivationId: dependencies.dnsZoneActivationId,
        expectedDnsZoneActivationGeneration: 1,
        dedicatedRootReplacementConfirmed: true,
      } as const;

      const activation = await run(
        sales.createSaleNamespace({
          accountId: "activation-seller",
          communityId,
          idempotencyKey: "activation-create-key",
          ...authorityInput,
        }),
      );
      expect(activation.activation).toMatchObject({
        family: "hns",
        canonical_root: "charizard",
        status: "active",
      });
      const community = await admin.query(
        "SELECT canonical_route_binding_id FROM communities WHERE community_id=$1",
        [communityId],
      );
      expect(community.rows[0]?.canonical_route_binding_id).toBeNull();
      await expect(run(sales.listSaleNamespaces({ communityId }))).resolves.toMatchObject({
        items: [{ status: "active" }],
      });

      await admin.query(
        `INSERT INTO hns_dns_zone_health_observations (
           dns_zone_activation_id,activation_generation,health_generation,
           stable_chain_delegation_snapshot_reference,stable_chain_delegation_snapshot_digest,
           observed_zone_bytes_digest,observed_dnssec_keyset_reference,
           observed_dnssec_keyset_version,observed_gateway_deployment_reference,
           observed_gateway_certificate_spki_sha256,delegation_matches,ds_authenticates_zone,
           retained_zone_digest_matches,gateway_healthy,checked_at,valid_until
         ) VALUES ($1,1,2,'hns-delegation-snapshot:handle-sales-live',$2,$3,
                   'dnssec-keyset:charizard','1','gateway-deployment:handle-sales-live',$4,
                   FALSE,TRUE,TRUE,TRUE,clock_timestamp(),clock_timestamp()+interval '1 hour')`,
        [dependencies.dnsZoneActivationId, "7".repeat(64), dependencies.zoneDigest, "6".repeat(64)],
      );
      await expect(run(sales.listSaleNamespaces({ communityId }))).resolves.toEqual({
        items: [],
        next_cursor: null,
      });
      await expect(
        run(
          sales.createOffering({
            accountId: "activation-seller",
            communityId,
            idempotencyKey: "drifted-offering-key",
            terms: terms(activation.activation.sale_namespace_activation_id),
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "HandleSalesRejected",
        reason: "sale_namespace_inactive",
      });

      const suspended = await run(
        sales.reviseSaleNamespace({
          accountId: "activation-seller",
          communityId,
          activationId: activation.activation.sale_namespace_activation_id,
          expectedActivationHash: activation.activation.sale_namespace_activation_hash,
          requestedStatus: "suspended",
          idempotencyKey: "activation-suspend-key",
          ...authorityInput,
        }),
      );
      expect(suspended.activation).toMatchObject({
        sale_namespace_activation_generation: 2,
        status: "suspended",
      });

      await admin.query(
        `INSERT INTO hns_dns_zone_health_observations (
           dns_zone_activation_id,activation_generation,health_generation,
           stable_chain_delegation_snapshot_reference,stable_chain_delegation_snapshot_digest,
           observed_zone_bytes_digest,observed_dnssec_keyset_reference,
           observed_dnssec_keyset_version,observed_gateway_deployment_reference,
           observed_gateway_certificate_spki_sha256,delegation_matches,ds_authenticates_zone,
           retained_zone_digest_matches,gateway_healthy,checked_at,valid_until
         ) VALUES ($1,1,3,'hns-delegation-snapshot:handle-sales-live',$2,$3,
                   'dnssec-keyset:charizard','1','gateway-deployment:handle-sales-live',$4,
                   TRUE,TRUE,TRUE,TRUE,clock_timestamp(),clock_timestamp()+interval '1 hour')`,
        [dependencies.dnsZoneActivationId, "7".repeat(64), dependencies.zoneDigest, "6".repeat(64)],
      );
      const restored = await run(
        sales.reviseSaleNamespace({
          accountId: "activation-seller",
          communityId,
          activationId: suspended.activation.sale_namespace_activation_id,
          expectedActivationHash: suspended.activation.sale_namespace_activation_hash,
          requestedStatus: "active",
          idempotencyKey: "activation-restore-key",
          ...authorityInput,
        }),
      );
      expect(restored.activation).toMatchObject({
        sale_namespace_activation_generation: 3,
        status: "active",
      });
      const revoked = await run(
        sales.reviseSaleNamespace({
          accountId: "activation-seller",
          communityId,
          activationId: restored.activation.sale_namespace_activation_id,
          expectedActivationHash: restored.activation.sale_namespace_activation_hash,
          requestedStatus: "revoked",
          idempotencyKey: "activation-revoke-key",
          ...authorityInput,
        }),
      );
      expect(revoked.activation).toMatchObject({
        sale_namespace_activation_generation: 4,
        status: "revoked",
      });
      await expect(
        run(
          sales.reviseSaleNamespace({
            accountId: "activation-seller",
            communityId,
            activationId: revoked.activation.sale_namespace_activation_id,
            expectedActivationHash: revoked.activation.sale_namespace_activation_hash,
            requestedStatus: "active",
            idempotencyKey: "activation-illegal-restore-key",
            ...authorityInput,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "HandleSalesRejected",
        reason: "sale_namespace_inactive",
      });
    });
    completedTestCount += 1;
  }, 20_000);
});

afterAll(async () => {
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});
