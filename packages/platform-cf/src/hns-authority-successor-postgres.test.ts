import {
  decodeHnsAuthorityInventoryBytes,
  encodeHnsAuthorityInventory,
  hnsAuthorityCapabilitySetDigest,
} from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  makeHnsAuthoritySuccessorGenerationReaderFromRepositoryV1,
  makeHnsAuthoritySuccessorInventoryReaderFromResolverV1,
  makeHnsAuthoritySuccessorPostgresReadersV1,
} from "./hns-authority-successor-postgres.ts";

async function inventoryBytes(): Promise<Uint8Array> {
  const glue = [
    {
      authority_nameserver: "ns1.pirate",
      authority_address_family: "GLUE4" as const,
      authority_address: "94.103.168.161",
      active: true,
    },
    {
      authority_nameserver: "ns2.pirate",
      authority_address_family: "GLUE4" as const,
      authority_address: "81.15.150.159",
      active: true,
    },
  ];
  const capabilities = [
    {
      capability_reference: "dns-write:jazleeuw",
      scope_kind: "exact_root" as const,
      root_label: "jazleeuw",
      active: true,
    },
  ];
  return encodeHnsAuthorityInventory({
    version: "pirate-hns-authority-inventory-v1",
    authority_inventory_reference: "authority-inventory:jazleeuw",
    authority_inventory_version: "v6",
    environment: "production",
    completeness: "complete",
    runtime_capability_set_digest: await hnsAuthorityCapabilitySetDigest({
      environment: "production",
      authoritative_nameserver_glue: glue,
      dns_write_capabilities: capabilities,
    }),
    published_at: "2026-08-30T08:00:00.000Z",
    expires_at: "2026-08-30T16:00:00.000Z",
    authoritative_nameserver_glue: glue,
    dns_write_capabilities: capabilities,
  });
}

test("derives the exact generation snapshot through the read-only repository", async () => {
  const calls: unknown[] = [];
  const reader = makeHnsAuthoritySuccessorGenerationReaderFromRepositoryV1({
    readSuccessorGenerationObservation: (identity) => {
      calls.push(identity);
      return Effect.succeed({
        database_time: "2026-08-30T12:00:00.000Z",
        snapshot: {
          dns_zone_activation_id: "dns-zone:jazleeuw",
          dns_current_generation: 5,
          app_host_activation_id: "app-host:app.jazleeuw",
          app_host_current_generation: 9,
          successor_dns_latest_health_generation: 0,
        },
      });
    },
  });
  const result = await reader.read(
    { canonical_root: "jazleeuw", normalized_app_host: "app.jazleeuw" },
    { signal: new AbortController().signal },
  );

  expect(calls).toEqual([{ canonical_root: "jazleeuw", normalized_app_host: "app.jazleeuw" }]);
  expect(result).toEqual({
    database_time: "2026-08-30T12:00:00.000Z",
    snapshot: {
      dns_zone_activation_id: "dns-zone:jazleeuw",
      dns_current_generation: 5,
      app_host_activation_id: "app-host:app.jazleeuw",
      app_host_current_generation: 9,
      successor_dns_latest_health_generation: 0,
    },
  });
});

test("refuses an aborted generation read before opening the repository", async () => {
  let called = false;
  const reader = makeHnsAuthoritySuccessorGenerationReaderFromRepositoryV1({
    readSuccessorGenerationObservation: () => {
      called = true;
      return Effect.die("must not run");
    },
  });
  const controller = new AbortController();
  controller.abort();

  await expect(
    reader.read(
      { canonical_root: "jazleeuw", normalized_app_host: "app.jazleeuw" },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ reason: "source_unavailable" });
  expect(called).toBe(false);
});

test("maps generation repository failure to source unavailability", async () => {
  const reader = makeHnsAuthoritySuccessorGenerationReaderFromRepositoryV1({
    readSuccessorGenerationObservation: () => Effect.die("database unavailable"),
  });

  await expect(
    reader.read(
      { canonical_root: "jazleeuw", normalized_app_host: "app.jazleeuw" },
      { signal: new AbortController().signal },
    ),
  ).rejects.toMatchObject({ reason: "source_unavailable" });
});

test("accepts only digest- and identity-bound inventory bytes", async () => {
  const bytes = await inventoryBytes();
  const decoded = await decodeHnsAuthorityInventoryBytes(bytes);
  const resolved = {
    authority_inventory_reference: decoded.inventory.authority_inventory_reference,
    authority_inventory_version: decoded.inventory.authority_inventory_version,
    authority_inventory_digest: decoded.inventory_digest,
    inventory_bytes: bytes,
  };
  const reader = makeHnsAuthoritySuccessorInventoryReaderFromResolverV1(
    { resolve: async () => resolved },
    5_000,
  );
  const result = await reader.read({ signal: new AbortController().signal });
  expect(result).toEqual(bytes);
  expect(result).not.toBe(bytes);

  const mismatch = makeHnsAuthoritySuccessorInventoryReaderFromResolverV1(
    {
      resolve: async () => ({
        ...resolved,
        authority_inventory_reference: "authority-inventory:other",
      }),
    },
    5_000,
  );
  await expect(mismatch.read({ signal: new AbortController().signal })).rejects.toMatchObject({
    reason: "invalid_row",
  });

  const malformed = makeHnsAuthoritySuccessorInventoryReaderFromResolverV1(
    {
      resolve: async () => ({
        ...resolved,
        inventory_bytes: new TextEncoder().encode("not-json"),
      }),
    },
    5_000,
  );
  await expect(malformed.read({ signal: new AbortController().signal })).rejects.toMatchObject({
    reason: "invalid_row",
  });
});

test("refuses missing inventory and invalid PostgreSQL source configuration", async () => {
  const reader = makeHnsAuthoritySuccessorInventoryReaderFromResolverV1(
    { resolve: async () => null },
    5_000,
  );
  await expect(reader.read({ signal: new AbortController().signal })).rejects.toMatchObject({
    reason: "source_unavailable",
  });

  const unavailable = makeHnsAuthoritySuccessorInventoryReaderFromResolverV1(
    { resolve: async () => Promise.reject(new Error("database unavailable")) },
    5_000,
  );
  await expect(unavailable.read({ signal: new AbortController().signal })).rejects.toMatchObject({
    reason: "source_unavailable",
  });

  expect(() =>
    makeHnsAuthoritySuccessorPostgresReadersV1({
      connection_string: "",
      authority_inventory_registry_reference: "authority-inventory-registry:production",
      authority_inventory_response_max_bytes: 65_536,
      authority_inventory_deadline_ms: 5_000,
    }),
  ).toThrow("invalid_configuration");
});
