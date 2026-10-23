import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  decodeHnsDnsHealthDocumentV1,
  decodeHnsDnsZonePersistenceDocumentV1,
} from "../packages/application/src/hns-host-persistence.ts";
import {
  encodeHnsAuthorityInventory,
  hnsAuthorityCapabilitySetDigest,
} from "../packages/application/src/namespace-ownership/hns-authority-inventory.ts";
import {
  applyStagingGatewaySuccessor,
  prepareStagingGatewaySuccessor,
} from "./hns-staging-gateway-successor.mjs";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const reference = (value: string) => `hns-community-app-handle-gateway-sha256:${sha(value)}`;
const now = "2026-10-23T12:00:00.000Z";

async function fixture() {
  const raw = JSON.parse(
    gunzipSync(
      await Bun.file(
        new URL("./hns-continuity/fixtures/continuity-observation.json.gz", import.meta.url),
      ).arrayBuffer(),
    ).toString(),
  );
  const spki = raw.state.dns.gateway_certificate_spki_sha256;
  const before = {
    schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
    mode: "staging-public-tls",
    public_tls_listener: "94.103.168.209:443",
    solid_origin: "https://hns-community-ingress-staging.pirate.sc",
    profile_sha256: "a".repeat(64),
    handle_profile_sha256: "b".repeat(64),
    gateway_certificate_spki_sha256: spki,
    bundle_sha256: "c".repeat(64),
    solid_ingress_composition_reference: `solid-hns-ingress-sha256:${"d".repeat(64)}`,
  };
  const previousManifest = JSON.stringify(before);
  const nextManifest = JSON.stringify({
    ...before,
    solid_ingress_composition_reference: `solid-hns-ingress-sha256:${"e".repeat(64)}`,
  });
  const states = [];
  for (const root of ["8s28", "a18n"]) {
    const state = JSON.parse(
      JSON.stringify(raw.state).replaceAll(raw.state.dns.canonical_root, root),
    );
    const inventory = JSON.parse(
      Buffer.from(raw.state.inventory.bytes_hex, "hex")
        .toString()
        .replaceAll(raw.state.dns.canonical_root, root),
    );
    inventory.environment = "staging";
    inventory.published_at = now;
    inventory.expires_at = "2026-10-25T12:00:00.000Z";
    inventory.runtime_capability_set_digest = await hnsAuthorityCapabilitySetDigest(inventory);
    const encoded = await encodeHnsAuthorityInventory(inventory);
    state.inventory.bytes_hex = Buffer.from(encoded).toString("hex");
    state.inventory.published_at = inventory.published_at;
    state.inventory.expires_at = inventory.expires_at;
    state.dns.pirate_dns_authority_inventory_digest = sha(encoded);
    state.dns.gateway_deployment_reference = reference(previousManifest);
    state.dns.dns_zone_activation_id = `fixture-dns-${root}`;
    const zone = Buffer.from(state.dns.zone_hex, "hex")
      .toString()
      .replaceAll(raw.state.dns.canonical_root, root);
    state.dns.zone_hex = Buffer.from(zone).toString("hex");
    state.dns.zone_bytes_digest = sha(zone);
    state.app.dns_zone_activation_id = state.dns.dns_zone_activation_id;
    state.app.gateway_deployment_reference = reference(previousManifest);
    state.sale.dns_zone_activation_id = state.dns.dns_zone_activation_id;
    state.health.dns_zone_activation_id = state.dns.dns_zone_activation_id;
    state.health.observed_zone_bytes_digest = state.dns.zone_bytes_digest;
    state.health.observed_gateway_deployment_reference = reference(previousManifest);
    state.health.checked_at = now;
    state.health.valid_until = "2026-10-25T13:00:00.000Z";
    state.database_time = now;
    state.successor_health_generation = 0;
    states.push(state);
  }
  return {
    states,
    previousManifest,
    nextManifest,
    sourceCommit: "f".repeat(40),
    executeBy: "2026-10-23T12:15:00.000Z",
    readiness: {
      version: "hns-reviewed-gateway-rotation-v1",
      previous_gateway_reference: reference(previousManifest),
      gateway_reference: reference(nextManifest),
      profile_sha256: before.profile_sha256,
      handle_profile_sha256: before.handle_profile_sha256,
      manifest_json: nextManifest,
      observed_at: now,
      readiness: "operator_attested_shadow_ready",
    },
  };
}

describe("staging gateway fingerprint successor", () => {
  test("freezes distinct root operations, retains DNS identities and caps the actual health lifetime", async () => {
    const input = await fixture();
    const plan = await prepareStagingGatewaySuccessor(input);
    expect(plan.entries[0].successor_id).not.toBe(plan.entries[1].successor_id);
    expect(await prepareStagingGatewaySuccessor(input)).toEqual(plan);
    for (const entry of plan.entries) {
      const dns = await decodeHnsDnsZonePersistenceDocumentV1(Buffer.from(entry.dns_hex, "hex"));
      const health = decodeHnsDnsHealthDocumentV1(Buffer.from(entry.health_hex, "hex"));
      expect(dns.zone_bytes_digest).toBe(entry.predecessor.dns.zone_bytes_digest);
      expect(dns.zone_revision).toBe(Number(entry.predecessor.dns.zone_revision) + 1);
      expect(dns.gateway_deployment_reference).toBe(reference(input.nextManifest));
      expect(dns.pirate_dns_authority_inventory_digest).toBe(
        entry.predecessor.dns.pirate_dns_authority_inventory_digest,
      );
      expect(Date.parse(plan.execute_by) + health.valid_for_seconds * 1000).toBeLessThan(
        Date.parse(entry.health_deadline),
      );
      expect(entry.inherited_health_checked_at).toBe(now);
    }
  });

  test("refuses a broader manifest change and a different or stale readiness observation", async () => {
    const input = await fixture();
    for (const change of [
      { nextManifest: `${input.nextManifest}\n` },
      {
        nextManifest: JSON.stringify({
          ...JSON.parse(input.nextManifest),
          bundle_sha256: "0".repeat(64),
        }),
      },
      { readiness: { ...input.readiness, observed_at: "2026-10-23T10:00:00.000Z" } },
      { readiness: { ...input.readiness, manifest_json: input.previousManifest } },
      { executeBy: "2026-10-23T12:15:01.000Z" },
    ])
      await expect(prepareStagingGatewaySuccessor({ ...input, ...change })).rejects.toThrow();
  });

  test("refuses expired, contradictory, mixed or incomplete predecessor evidence", async () => {
    for (const mutate of [
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states.pop();
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].health.valid_until = value.executeBy;
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].health.ds_authenticates_zone = false;
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].health.observed_zone_bytes_digest = "0".repeat(64);
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].app.dns_zone_activation_generation = "999";
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].inventory.expires_at = value.executeBy;
      },
    ]) {
      const input = await fixture();
      mutate(input);
      await expect(prepareStagingGatewaySuccessor(input)).rejects.toThrow();
    }
  });

  test("rejects edited reviewed bytes before connecting or opening a transaction", async () => {
    const plan = await prepareStagingGatewaySuccessor(await fixture());
    const hash = sha(JSON.stringify(plan));
    const query = () => {
      throw new Error("must not reach database");
    };
    const changed = structuredClone(plan);
    changed.entries[0].health_hex = changed.entries[1].health_hex;
    await expect(
      applyStagingGatewaySuccessor({ client: { query }, plan: changed, confirmedSha256: hash }),
    ).rejects.toThrow("Unreviewed plan");
    await expect(
      applyStagingGatewaySuccessor({
        client: { query },
        plan: changed,
        confirmedSha256: sha(JSON.stringify(changed)),
      }),
    ).rejects.toThrow("Plan does not reproduce exactly");
  });
});
