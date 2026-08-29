import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
  encodeHnsAppHostTransitionDocumentV1,
  encodeHnsDnsHealthDocumentV1,
  encodeHnsDnsZonePersistenceDocumentV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  prepareHnsDnsZoneActivationDocumentV1,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  hnsAppHostTransitionStatementFromReviewedDocument,
  hnsDnsHealthStatementFromReviewedDocument,
  hnsDnsZoneFinalizationStatementFromReviewedDocument,
  makeControlPlaneHnsCommunityAppHostAuthoritySource,
  makeControlPlaneHnsFirstPartyHostPersistenceRepository,
} from "./hns-host-persistence-repository.ts";

function runtime(rows: readonly Record<string, unknown>[], calls: ControlPlaneStatement[]) {
  const execute = <R = unknown>(statement: ControlPlaneStatement) => {
    calls.push(statement);
    return Effect.succeed({
      rows: rows as readonly R[],
      rowCount: rows.length,
    } satisfies ControlPlaneResult<R>);
  };
  return Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  });
}

test("closes DNS activation endpoint authority over the repository", async () => {
  const calls: ControlPlaneStatement[] = [];
  const repository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(
    runtime(
      [
        {
          outcome: "reserved",
          operation_id: "dns-operation-1",
          dns_zone_activation_id: "dns-zone-1",
          fence_token: "1",
          lease_expires_at: new Date("2026-08-24T18:00:00.000Z"),
          activation_generation: null,
        },
      ],
      calls,
    ),
  );
  await expect(
    Effect.runPromise(
      repository.store.reserveDnsZoneActivation({
        operation_id: "dns-operation-1",
        idempotency_key: "dns-key-1",
        activation_document_digest: "a".repeat(64),
        dns_zone_activation_id: "dns-zone-1",
        expected_activation_generation: 0,
        lease_seconds: 30,
      }),
    ),
  ).resolves.toMatchObject({ outcome: "reserved", fence_token: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ label: "hns.hosts.dns-zone.reserve", readonly: false });
  expect(calls[0]?.text).toContain("reserve_hns_dns_zone_activation_v1");
  expect(calls[0]?.values).toEqual([
    "dns-operation-1",
    "dns-key-1",
    "a".repeat(64),
    "dns-zone-1",
    0,
    30,
  ]);
});

test("reads successor generation fences without reserving or writing", async () => {
  const calls: ControlPlaneStatement[] = [];
  const repository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(
    runtime(
      [
        {
          dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
          dns_current_generation: "5",
          app_host_activation_id: "hns-rehearsal-app-host-v1",
          app_host_current_generation: "9",
          successor_dns_latest_health_generation: "0",
        },
      ],
      calls,
    ),
  );

  await expect(
    Effect.runPromise(
      repository.readSuccessorGenerationSnapshot({
        dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
        app_host_activation_id: "hns-rehearsal-app-host-v1",
      }),
    ),
  ).resolves.toEqual({
    dns_zone_activation_id: "hns-rehearsal-dns-zone-v1",
    dns_current_generation: 5,
    app_host_activation_id: "hns-rehearsal-app-host-v1",
    app_host_current_generation: 9,
    successor_dns_latest_health_generation: 0,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    label: "hns.hosts.successor-generations.read",
    readonly: true,
  });
  expect(calls[0]?.text).not.toContain("reserve_hns");
  expect(calls[0]?.values).toEqual(["hns-rehearsal-dns-zone-v1", "hns-rehearsal-app-host-v1"]);
});

test("derives every app-host and health SQL parameter only from reviewed bytes", () => {
  const app = {
    operation_id: "app-op",
    idempotency_key: "app-key",
    request_hash: "a".repeat(64),
    app_host_activation_id: "app-host",
    expected_activation_generation: 9,
    target_status: "active",
    reason_code: "canonical-authority",
  } as const;
  const health = {
    operation_id: "health-op",
    idempotency_key: "health-key",
    request_hash: "b".repeat(64),
    dns_zone_activation_id: "dns-zone",
    activation_generation: 6,
    expected_health_generation: 0,
    stable_chain_delegation_snapshot_reference: "delegation:jazleeuw",
    stable_chain_delegation_snapshot_digest: "c".repeat(64),
    observed_zone_bytes_digest: "d".repeat(64),
    observed_dnssec_keyset_reference: "keyset:jazleeuw",
    observed_dnssec_keyset_version: "key-tag-10875",
    observed_gateway_deployment_reference: "gateway:jazleeuw",
    observed_gateway_certificate_spki_sha256: "e".repeat(64),
    delegation_matches: true,
    ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_healthy: true,
    valid_for_seconds: 3600,
  } as const;
  expect(
    hnsAppHostTransitionStatementFromReviewedDocument(encodeHnsAppHostTransitionDocumentV1(app))
      .values,
  ).toEqual(["app-op", "app-key", "a".repeat(64), "app-host", 9, "active", "canonical-authority"]);
  expect(
    hnsDnsHealthStatementFromReviewedDocument(encodeHnsDnsHealthDocumentV1(health)).values,
  ).toEqual([
    "health-op",
    "health-key",
    "b".repeat(64),
    "dns-zone",
    6,
    0,
    "delegation:jazleeuw",
    "c".repeat(64),
    "d".repeat(64),
    "keyset:jazleeuw",
    "key-tag-10875",
    "gateway:jazleeuw",
    "e".repeat(64),
    true,
    true,
    true,
    true,
    3600,
  ]);

  const changedValue = (key: string, value: string | number | boolean) => {
    if (typeof value === "number") return value + 1;
    if (typeof value === "boolean") return !value;
    if (key === "target_status") return "suspended";
    if (key.includes("hash") || key.includes("digest") || key.includes("sha256")) {
      return `${value.startsWith("f") ? "e" : "f"}${value.slice(1)}`;
    }
    return `${value}-changed`;
  };
  const assertOneToOne = (
    input: Readonly<Record<string, string | number | boolean>>,
    statement: (changed: Readonly<Record<string, string | number | boolean>>) => readonly unknown[],
  ) => {
    const baseline = statement(input);
    Object.entries(input).forEach(([key, value], index) => {
      const changed = statement({ ...input, [key]: changedValue(key, value) });
      expect(
        changed.flatMap((entry, position) => (entry === baseline[position] ? [] : [position])),
      ).toEqual([index]);
    });
  };
  assertOneToOne(
    app,
    (changed) =>
      hnsAppHostTransitionStatementFromReviewedDocument(
        encodeHnsAppHostTransitionDocumentV1(changed as typeof app),
      ).values,
  );
  assertOneToOne(
    health,
    (changed) =>
      hnsDnsHealthStatementFromReviewedDocument(
        encodeHnsDnsHealthDocumentV1(changed as typeof health),
      ).values,
  );
});

test("derives every authority-controlled DNS finalization value from reviewed bytes", async () => {
  const document = await prepareHnsDnsZoneActivationDocumentV1({
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: "dns-zone",
      canonical_root: "jazleeuw",
      dns_authority: ["pirate_managed_dns_v1", "authority:jazleeuw", 6],
      pirate_dns_authority_inventory: ["inventory:jazleeuw", "v6", "a".repeat(64)],
      zone_revision: 6,
      dnssec_keyset: ["keyset:jazleeuw", "key-tag-10875"],
      gateway: ["gateway:jazleeuw", "b".repeat(64)],
      stable_chain_delegation_snapshot: ["delegation:jazleeuw", "c".repeat(64)],
    },
    zone_bytes: new TextEncoder().encode("$ORIGIN jazleeuw.\n"),
  });
  const statement = await hnsDnsZoneFinalizationStatementFromReviewedDocument(
    {
      outcome: "reserved",
      operation_id: "dns-operation",
      dns_zone_activation_id: "dns-zone",
      fence_token: 42,
      lease_expires_at: "2026-08-29T18:00:00.000Z",
      activation_generation: null,
    },
    encodeHnsDnsZonePersistenceDocumentV1(document),
  );
  expect(statement.values).toEqual([
    "dns-operation",
    42,
    document.activation_document_bytes,
    "dns-zone",
    "jazleeuw",
    "pirate_managed_dns_v1",
    "authority:jazleeuw",
    6,
    "inventory:jazleeuw",
    "v6",
    "a".repeat(64),
    6,
    document.zone_bytes,
    document.zone_bytes_digest,
    "keyset:jazleeuw",
    "key-tag-10875",
    "gateway:jazleeuw",
    "b".repeat(64),
    "delegation:jazleeuw",
    "c".repeat(64),
  ]);
});

test("production mutation entry points accept reviewed documents only", async () => {
  const dnsCalls: ControlPlaneStatement[] = [];
  const dnsRepository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(
    runtime(
      [
        {
          outcome: "activated",
          dns_zone_activation_id: "dns-zone",
          activation_generation: 6,
        },
      ],
      dnsCalls,
    ),
  );
  const dnsDocument = await prepareHnsDnsZoneActivationDocumentV1({
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: "dns-zone",
      canonical_root: "jazleeuw",
      dns_authority: ["pirate_managed_dns_v1", "authority:jazleeuw", 6],
      pirate_dns_authority_inventory: ["inventory:jazleeuw", "v6", "a".repeat(64)],
      zone_revision: 6,
      dnssec_keyset: ["keyset:jazleeuw", "key-tag-10875"],
      gateway: ["gateway:jazleeuw", "b".repeat(64)],
      stable_chain_delegation_snapshot: ["delegation:jazleeuw", "c".repeat(64)],
    },
    zone_bytes: new TextEncoder().encode("$ORIGIN jazleeuw.\n"),
  });
  await Effect.runPromise(
    dnsRepository.store.finalizeDnsZoneActivation({
      reservation: {
        outcome: "reserved",
        operation_id: "dns-operation",
        dns_zone_activation_id: "dns-zone",
        fence_token: 42,
        lease_expires_at: "2026-08-29T18:00:00.000Z",
        activation_generation: null,
      },
      reviewed_document_bytes: encodeHnsDnsZonePersistenceDocumentV1(dnsDocument),
    }),
  );
  expect(dnsCalls[0]?.values[2]).toEqual(dnsDocument.activation_document_bytes);

  const healthCalls: ControlPlaneStatement[] = [];
  const healthRepository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(
    runtime(
      [
        {
          outcome: "recorded",
          dns_zone_activation_id: "dns-zone",
          activation_generation: 6,
          health_generation: 1,
        },
      ],
      healthCalls,
    ),
  );
  const healthBytes = encodeHnsDnsHealthDocumentV1({
    operation_id: "health-op",
    idempotency_key: "health-key",
    request_hash: "d".repeat(64),
    dns_zone_activation_id: "dns-zone",
    activation_generation: 6,
    expected_health_generation: 0,
    stable_chain_delegation_snapshot_reference: "delegation:jazleeuw",
    stable_chain_delegation_snapshot_digest: "c".repeat(64),
    observed_zone_bytes_digest: dnsDocument.zone_bytes_digest,
    observed_dnssec_keyset_reference: "keyset:jazleeuw",
    observed_dnssec_keyset_version: "key-tag-10875",
    observed_gateway_deployment_reference: "gateway:jazleeuw",
    observed_gateway_certificate_spki_sha256: "b".repeat(64),
    delegation_matches: true,
    ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_healthy: true,
    valid_for_seconds: 3600,
  });
  await Effect.runPromise(healthRepository.store.recordDnsZoneHealth(healthBytes));
  expect(healthCalls[0]?.values[0]).toBe("health-op");

  const appCalls: ControlPlaneStatement[] = [];
  const appRepository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(
    runtime(
      [
        {
          outcome: "changed",
          app_host_activation_id: "app-host",
          app_host_activation_generation: 10,
          status: "active",
        },
      ],
      appCalls,
    ),
  );
  const appBytes = encodeHnsAppHostTransitionDocumentV1({
    operation_id: "app-op",
    idempotency_key: "app-key",
    request_hash: "e".repeat(64),
    app_host_activation_id: "app-host",
    expected_activation_generation: 9,
    target_status: "active",
    reason_code: "canonical-authority",
  });
  await Effect.runPromise(appRepository.store.changeCommunityAppHostStatus(appBytes));
  expect(appCalls[0]?.values).toEqual([
    "app-op",
    "app-key",
    "e".repeat(64),
    "app-host",
    9,
    "active",
    "canonical-authority",
  ]);
});

test("resolves only by normalized host and decodes current database authority", async () => {
  const calls: ControlPlaneStatement[] = [];
  const source = makeControlPlaneHnsCommunityAppHostAuthoritySource(
    runtime(
      [
        {
          normalized_host: "app.pirate",
          canonical_root: "pirate",
          community_id: "community_123e4567-e89b-42d3-a456-426614174001",
          app_host_activation_id: "app-host-1",
          app_host_activation_generation: "1",
          app_host_activation_status: "active",
          activation_dns_zone_id: "dns-zone-1",
          activation_dns_zone_generation: "1",
          activation_gateway_deployment_reference: "gateway-1",
          route_binding_id: "route-binding-1",
          route_binding_current: true,
          route_authority_kind: "operator_managed_route_v1",
          route_authority_reference: "operator-route-1",
          route_authority_generation: "1",
          route_authority_effective: true,
          dns_zone_activation_id: "dns-zone-1",
          dns_zone_activation_generation: "1",
          dns_zone_status: "active",
          stable_chain_delegation_matches: true,
          dnssec_ds_authenticates_zone: true,
          retained_zone_digest_matches: true,
          gateway_deployment_reference: "gateway-1",
          gateway_certificate_spki_sha256: "b".repeat(64),
          gateway_health: "healthy",
        },
      ],
      calls,
    ),
  );
  await expect(Effect.runPromise(source.resolve("app.pirate"))).resolves.toMatchObject({
    variant: "community_app_v1",
    normalized_host: "app.pirate",
    route_authority_kind: "operator_managed_route_v1",
    dns_zone: { gateway_health: "healthy" },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    label: "hns.hosts.community-app.resolve-authority",
    values: ["app.pirate"],
    readonly: true,
  });
  expect(calls[0]?.text).toContain("clock_timestamp()");
});

test("rejects malformed database authority instead of widening it", async () => {
  const source = makeControlPlaneHnsCommunityAppHostAuthoritySource(
    runtime([{ normalized_host: "app.pirate" }], []),
  );
  await expect(Effect.runPromise(source.resolve("app.pirate"))).rejects.toThrow("invalid row");
});
