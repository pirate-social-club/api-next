import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import {
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
