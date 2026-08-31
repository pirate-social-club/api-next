import { afterAll, describe, expect, test } from "bun:test";
import {
  activateOperatorManagedRoute,
  encodeHnsAppHostTransitionDocumentV1,
  encodeHnsDnsHealthDocumentV1,
  encodeHnsDnsZoneActivationDocumentV1,
  encodeHnsDnsZonePersistenceDocumentV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  isHnsCommunityAppHostAuthorityActive,
  revokeOperatorManagedRoute,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_READINESS_HOST,
  makePostgresHnsCommunityAppGatewayAuthorityV1,
} from "./hns-community-app-gateway-authority-postgres.ts";
import {
  makeControlPlaneHnsCommunityAppHostAuthoritySource,
  makeControlPlaneHnsFirstPartyHostPersistenceRepository,
} from "./hns-host-persistence-repository.ts";
import { makeControlPlaneOperatorManagedRouteStore } from "./operator-managed-route-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_HNS_HOST_PERSISTENCE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-hns-host-persistence-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-hns-host-persistence-suite-complete\n";
let completedTestCount = 0;

function schemaIdentifier(): string {
  return `api_next_hns_host_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(
  use: (connection: string, admin: Client) => Promise<A>,
  selectedSchema = schemaIdentifier(),
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = selectedSchema;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const inventoryReference = "authority-inventory:host-persistence";
const inventoryVersion = "2026-08-24.v1";
const gatewayReference = "gateway-deployment:host-persistence-v1";
const gatewaySpki = "b".repeat(64);
const delegationReference = "hns-delegation-snapshot:host-persistence-v1";
const delegationDigest = "c".repeat(64);
const keysetReference = "dnssec-keyset:host-persistence-v1";
const keysetVersion = "1";

async function seedInventory(admin: Client): Promise<string> {
  const bytes = new TextEncoder().encode("host-persistence-authority-inventory-v1");
  const digest = await sha256(bytes);
  await admin.query(
    `INSERT INTO hns_authority_inventories (
       registry_reference, authority_inventory_reference,
       authority_inventory_version, authority_inventory_digest, environment,
       runtime_capability_set_digest, inventory_bytes, published_at, expires_at
     ) VALUES (
       'authority-registry:host-persistence', $1, $2, $3, 'test', $4, $5,
       clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour'
     )`,
    [inventoryReference, inventoryVersion, digest, "d".repeat(64), bytes],
  );
  return digest;
}

async function seedOperatorRoute(connection: string, admin: Client) {
  const communityId = "community_123e4567-e89b-42d3-a456-426614174048";
  const registryReference = "operator-managed-roots-host-persistence";
  const registryBytes = new TextEncoder().encode(
    '["pirate-operator-managed-root-registry-v1","operator-managed-roots-host-persistence",1,[["hns","jazleeuw","active"]]]',
  );
  const registryDigest = await sha256(registryBytes);
  await admin.query("INSERT INTO users (user_id) VALUES ('host-persistence-owner')");
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id,
       created_at, updated_at, route_slug, route_authority_version
     ) VALUES ($1, 'Host persistence', 'active', 'host-persistence-owner',
       clock_timestamp(), clock_timestamp(), NULL, 'optional_route_v2')`,
    [communityId],
  );
  await admin.query(
    `INSERT INTO platform_operator_route_authority_grants (
       grant_id, operator_principal_id, authority, status,
       granted_at, granted_by_operator_principal_id
     ) VALUES ('host-persistence-grant', 'host-persistence-operator',
       'manage_operator_routes', 'active', clock_timestamp(), 'bootstrap-operator')`,
  );
  await admin.query(
    `INSERT INTO operator_managed_root_registry_versions (
       registry_reference, registry_version, registry_digest, registry_bytes,
       published_at, published_by_operator_principal_id
     ) VALUES ($1, 1, $2, $3, clock_timestamp(), 'host-persistence-operator')`,
    [registryReference, registryDigest, registryBytes],
  );
  await admin.query(
    `INSERT INTO operator_managed_root_registry_current (
       registry_kind, registry_reference, registry_version, registry_digest,
       activated_at, activated_by_operator_principal_id
     ) VALUES ('pirate-operator-managed-root-registry-v1', $1, 1, $2,
       clock_timestamp(), 'host-persistence-operator')`,
    [registryReference, registryDigest],
  );
  const operatorStore = makeControlPlaneOperatorManagedRouteStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  const activation = {
    operation_id: "host-persistence-route-operation",
    operator_principal_id: "host-persistence-operator",
    operator_authority_grant_id: "host-persistence-grant",
    idempotency_key: "host-persistence-route-key",
    community_id: communityId,
    canonical_root: "jazleeuw",
    registry_reference: registryReference,
    registry_version: 1,
    registry_digest: registryDigest,
    operator_route_activation_id: "host-persistence-route-activation",
    route_binding_id: "host-persistence-route-binding",
    reason_code: "first-party-host",
  } as const;
  await Effect.runPromise(activateOperatorManagedRoute(activation, { store: operatorStore }));
  return { activation, communityId, operatorStore };
}

async function dnsDocument(inventoryDigest: string, generation: number, zoneRevision = generation) {
  const zoneBytes = new TextEncoder().encode(`$ORIGIN jazleeuw.\n; revision ${zoneRevision}\n`);
  const zoneDigest = await sha256(zoneBytes);
  const payload = {
    version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
    dns_zone_activation_id: "dns-zone-activation-jazleeuw",
    canonical_root: "jazleeuw",
    dns_authority: ["pirate_managed_dns_v1", "dns-authority:jazleeuw", generation] as const,
    pirate_dns_authority_inventory: [
      inventoryReference,
      inventoryVersion,
      inventoryDigest,
    ] as const,
    zone: [zoneRevision, zoneDigest] as const,
    dnssec_keyset: [keysetReference, keysetVersion] as const,
    gateway: [gatewayReference, gatewaySpki] as const,
    stable_chain_delegation_snapshot: [delegationReference, delegationDigest] as const,
  };
  return {
    activation_document_bytes: encodeHnsDnsZoneActivationDocumentV1(payload),
    dns_zone_activation_id: payload.dns_zone_activation_id,
    canonical_root: payload.canonical_root,
    dns_authority_kind: payload.dns_authority[0],
    dns_authority_reference: payload.dns_authority[1],
    dns_authority_generation: payload.dns_authority[2],
    pirate_dns_authority_inventory_reference: payload.pirate_dns_authority_inventory[0],
    pirate_dns_authority_inventory_version: payload.pirate_dns_authority_inventory[1],
    pirate_dns_authority_inventory_digest: payload.pirate_dns_authority_inventory[2],
    zone_revision: payload.zone[0],
    zone_bytes: zoneBytes,
    zone_bytes_digest: payload.zone[1],
    dnssec_keyset_reference: payload.dnssec_keyset[0],
    dnssec_keyset_version: payload.dnssec_keyset[1],
    gateway_deployment_reference: payload.gateway[0],
    gateway_certificate_spki_sha256: payload.gateway[1],
    stable_chain_delegation_snapshot_reference: payload.stable_chain_delegation_snapshot[0],
    stable_chain_delegation_snapshot_digest: payload.stable_chain_delegation_snapshot[1],
  } as const;
}

suite("HNS first-party host persistence on PostgreSQL 17", () => {
  test("resolves through the exact read-only role with an empty caller search path", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const schema = String(
        (await admin.query("SELECT current_schema() AS schema")).rows[0]?.schema,
      );
      const role = `hns_authority_reader_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const quotedRole = quoteIdentifier(role);
      const quotedSchema = quoteIdentifier(schema);
      await admin.query(`CREATE ROLE ${quotedRole} NOLOGIN`);
      try {
        await admin.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`);
        await admin.query(
          `GRANT SELECT ON TABLE
             ${quotedSchema}.communities,
             ${quotedSchema}.community_canonical_route_bindings,
             ${quotedSchema}.community_route_ownership_evidence,
             ${quotedSchema}.operator_managed_route_activations,
             ${quotedSchema}.hns_community_app_host_activation_current,
             ${quotedSchema}.hns_community_app_host_activation_revisions,
             ${quotedSchema}.hns_dns_zone_activation_current,
             ${quotedSchema}.hns_dns_zone_activation_revisions,
             ${quotedSchema}.hns_authority_inventories,
             ${quotedSchema}.hns_dns_zone_health_observations
           TO ${quotedRole}`,
        );
        await admin.query(
          `GRANT EXECUTE ON FUNCTION
             ${quotedSchema}.effective_active_route(TEXT, TIMESTAMPTZ),
             ${quotedSchema}.effective_route_authority_v2(TEXT, TIMESTAMPTZ),
             ${quotedSchema}.resolve_hns_community_app_host_authority_v1(TEXT, TIMESTAMPTZ)
           TO ${quotedRole}`,
        );
        await admin.query(`SET ROLE ${quotedRole}`);
        await admin.query("SET search_path = ''");
        const result = await admin.query(
          `SELECT * FROM ${quotedSchema}.resolve_hns_community_app_host_authority_v1(
             'app.-pirate-readiness-invalid', clock_timestamp()
           )`,
        );
        expect(result.rows).toEqual([]);
        await admin.query("RESET ROLE");
      } finally {
        await admin.query("RESET ROLE");
        await admin.query(`DROP OWNED BY ${quotedRole}`);
        await admin.query(`DROP ROLE ${quotedRole}`);
      }
      completedTestCount += 1;
    });
  }, 30_000);

  test("replays exactly and fails route, DNS, delegation, DS, generation, and time drift closed", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const inventoryDigest = await seedInventory(admin);
      const { activation, communityId, operatorStore } = await seedOperatorRoute(connection, admin);
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const repository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(runtime);
      const source = makeControlPlaneHnsCommunityAppHostAuthoritySource(runtime);
      const firstDocument = await dnsDocument(inventoryDigest, 1);
      const firstReviewedBytes = encodeHnsDnsZonePersistenceDocumentV1(firstDocument);
      const reservation = await Effect.runPromise(
        repository.store.reserveDnsZoneActivation(firstReviewedBytes, 30),
      );
      await expect(
        Effect.runPromise(
          repository.store.finalizeDnsZoneActivation({
            reservation,
            reviewed_document_bytes: firstReviewedBytes,
          }),
        ),
      ).resolves.toEqual({
        outcome: "activated",
        dns_zone_activation_id: firstDocument.dns_zone_activation_id,
        activation_generation: 1,
      });
      const replay = await Effect.runPromise(
        repository.store.reserveDnsZoneActivation(firstReviewedBytes, 30),
      );
      expect(replay).toMatchObject({ outcome: "replayed", activation_generation: 1 });
      await expect(
        Effect.runPromise(
          repository.store.finalizeDnsZoneActivation({
            reservation: replay,
            reviewed_document_bytes: firstReviewedBytes,
          }),
        ),
      ).resolves.toMatchObject({ outcome: "replayed", activation_generation: 1 });

      const healthy = {
        operation_id: "dns-health-operation-1",
        idempotency_key: "dns-health-key-1",
        request_hash: "1".repeat(64),
        dns_zone_activation_id: firstDocument.dns_zone_activation_id,
        activation_generation: 1,
        expected_health_generation: 0,
        stable_chain_delegation_snapshot_reference: delegationReference,
        stable_chain_delegation_snapshot_digest: delegationDigest,
        observed_zone_bytes_digest: firstDocument.zone_bytes_digest,
        observed_dnssec_keyset_reference: keysetReference,
        observed_dnssec_keyset_version: keysetVersion,
        observed_gateway_deployment_reference: gatewayReference,
        observed_gateway_certificate_spki_sha256: gatewaySpki,
        delegation_matches: true,
        ds_authenticates_zone: true,
        retained_zone_digest_matches: true,
        gateway_healthy: true,
        valid_for_seconds: 3600,
      } as const;
      await Effect.runPromise(
        repository.store.recordDnsZoneHealth(encodeHnsDnsHealthDocumentV1(healthy)),
      );
      const appActivation = await admin.query(
        `SELECT * FROM activate_hns_community_app_host_v1(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12::bigint, $13
        )`,
        [
          "app-host-operation-1",
          "app-host-key-1",
          "2".repeat(64),
          "app-host-activation-jazleeuw",
          communityId,
          "jazleeuw",
          activation.route_binding_id,
          "operator_managed_route_v1",
          activation.operator_route_activation_id,
          1,
          firstDocument.dns_zone_activation_id,
          1,
          gatewayReference,
        ],
      );
      expect(appActivation.rows[0]).toMatchObject({
        outcome: "activated",
        app_host_activation_generation: "1",
      });
      const active = await Effect.runPromise(source.resolve("app.jazleeuw"));
      expect(active).not.toBeNull();
      expect(
        active?.variant === "community_app_v1" && isHnsCommunityAppHostAuthorityActive(active),
      ).toBeTrue();

      if (active === null) throw new Error("expected active HNS community authority fixture");
      const gatewayAuthority = makePostgresHnsCommunityAppGatewayAuthorityV1(connection);
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          Effect.runPromise(
            gatewayAuthority.authority_source.resolve(
              index % 2 === 0
                ? active.normalized_host
                : HNS_COMMUNITY_APP_GATEWAY_AUTHORITY_READINESS_HOST,
            ),
          ),
        ),
      );
      expect(concurrent.filter((state) => state !== null)).toHaveLength(4);
      expect(concurrent.filter((state) => state === null)).toHaveLength(4);

      const future = await admin.query(
        "SELECT * FROM resolve_hns_community_app_host_authority_v1('app.jazleeuw', clock_timestamp() + interval '2 hours')",
      );
      expect(future.rows[0]).toMatchObject({
        stable_chain_delegation_matches: false,
        dnssec_ds_authenticates_zone: false,
        retained_zone_digest_matches: false,
        gateway_health: "unavailable",
      });

      await Effect.runPromise(
        repository.store.recordDnsZoneHealth(
          encodeHnsDnsHealthDocumentV1({
            ...healthy,
            operation_id: "dns-health-operation-2",
            idempotency_key: "dns-health-key-2",
            request_hash: "3".repeat(64),
            expected_health_generation: 1,
            delegation_matches: false,
            ds_authenticates_zone: false,
          }),
        ),
      );
      const drifted = await Effect.runPromise(source.resolve("app.jazleeuw"));
      expect(drifted).toMatchObject({
        dns_zone: {
          stable_chain_delegation_matches: false,
          dnssec_ds_authenticates_zone: false,
        },
      });
      expect(
        drifted?.variant === "community_app_v1" && isHnsCommunityAppHostAuthorityActive(drifted),
      ).toBeFalse();

      const secondDocument = await dnsDocument(inventoryDigest, 2);
      const secondReviewedBytes = encodeHnsDnsZonePersistenceDocumentV1(secondDocument);
      const secondReservation = await Effect.runPromise(
        repository.store.reserveDnsZoneActivation(secondReviewedBytes, 30),
      );
      await Effect.runPromise(
        repository.store.finalizeDnsZoneActivation({
          reservation: secondReservation,
          reviewed_document_bytes: secondReviewedBytes,
        }),
      );
      const staleGeneration = await Effect.runPromise(source.resolve("app.jazleeuw"));
      expect(staleGeneration).toMatchObject({
        activation_dns_zone_generation: 1,
        dns_zone: { dns_zone_activation_generation: 2 },
      });
      expect(
        staleGeneration?.variant === "community_app_v1" &&
          isHnsCommunityAppHostAuthorityActive(staleGeneration),
      ).toBeFalse();

      await expect(
        Effect.runPromise(
          repository.store.changeCommunityAppHostStatus(
            encodeHnsAppHostTransitionDocumentV1({
              operation_id: "app-host-active-refresh-operation",
              idempotency_key: "app-host-active-refresh-key",
              request_hash: "9".repeat(64),
              app_host_activation_id: "app-host-activation-jazleeuw",
              expected_activation_generation: 1,
              target_status: "active",
              reason_code: "canonical-authority",
            }),
          ),
        ),
      ).resolves.toMatchObject({
        outcome: "changed",
        app_host_activation_generation: 2,
        status: "active",
      });
      const refreshedGeneration = await Effect.runPromise(source.resolve("app.jazleeuw"));
      expect(refreshedGeneration).toMatchObject({
        app_host_activation_generation: 2,
        activation_dns_zone_generation: 2,
        dns_zone: { dns_zone_activation_generation: 2 },
      });

      await admin.query(
        "SELECT * FROM change_hns_dns_zone_activation_status_v1($1, $2, $3, $4, $5::bigint, $6, $7)",
        [
          "dns-zone-revoke-operation",
          "dns-zone-revoke-key",
          "4".repeat(64),
          secondDocument.dns_zone_activation_id,
          2,
          "revoked",
          "authority-retired",
        ],
      );
      const dnsRevoked = await Effect.runPromise(source.resolve("app.jazleeuw"));
      expect(dnsRevoked).toMatchObject({ dns_zone: { status: "revoked" } });
      expect(
        dnsRevoked?.variant === "community_app_v1" &&
          isHnsCommunityAppHostAuthorityActive(dnsRevoked),
      ).toBeFalse();

      await Effect.runPromise(
        revokeOperatorManagedRoute(
          {
            operation_id: "host-persistence-route-revoke-operation",
            operator_principal_id: activation.operator_principal_id,
            operator_authority_grant_id: activation.operator_authority_grant_id,
            idempotency_key: "host-persistence-route-revoke-key",
            community_id: communityId,
            canonical_root: "jazleeuw",
            operator_route_activation_id: activation.operator_route_activation_id,
            route_binding_id: activation.route_binding_id,
            expected_activation_generation: 1,
            reason_code: "route-retired",
          },
          { store: operatorStore },
        ),
      );
      const routeRevoked = await Effect.runPromise(source.resolve("app.jazleeuw"));
      expect(routeRevoked).toMatchObject({
        route_binding_current: false,
        route_authority_effective: false,
      });
      expect(
        routeRevoked?.variant === "community_app_v1" &&
          isHnsCommunityAppHostAuthorityActive(routeRevoked),
      ).toBeFalse();
      completedTestCount += 1;
    }, "api_next");
  }, 30_000);

  test("rejects stale finalizers and contradictory exact documents", async () => {
    await withSchema(async (connection, admin) => {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      const inventoryDigest = await seedInventory(admin);
      const repository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const document = await dnsDocument(inventoryDigest, 1);
      const reviewedBytes = encodeHnsDnsZonePersistenceDocumentV1(document);
      const stale = await Effect.runPromise(
        repository.store.reserveDnsZoneActivation(reviewedBytes, 4),
      );
      await admin.query("SELECT pg_sleep(4.1)");
      const current = await Effect.runPromise(
        repository.store.reserveDnsZoneActivation(reviewedBytes, 4),
      );
      expect(current.fence_token).toBe(stale.fence_token + 1);
      await expect(
        Effect.runPromise(
          repository.store.finalizeDnsZoneActivation({
            reservation: stale,
            reviewed_document_bytes: encodeHnsDnsZonePersistenceDocumentV1(document),
          }),
        ),
      ).rejects.toBeDefined();
      await expect(
        Effect.runPromise(
          repository.store.finalizeDnsZoneActivation({
            reservation: current,
            reviewed_document_bytes: encodeHnsDnsZonePersistenceDocumentV1({
              ...document,
              gateway_deployment_reference: "gateway-deployment:forged",
            }),
          }),
        ),
      ).rejects.toBeDefined();
      await expect(
        Effect.runPromise(
          repository.store.finalizeDnsZoneActivation({
            reservation: current,
            reviewed_document_bytes: encodeHnsDnsZonePersistenceDocumentV1(document),
          }),
        ),
      ).resolves.toMatchObject({ outcome: "activated", activation_generation: 1 });
      completedTestCount += 1;
    });
  }, 30_000);
});

afterAll(async () => {
  if (connectionString === undefined || completedTestCount !== 3) return;
  await Bun.write(sentinelPath, sentinelContents);
});
