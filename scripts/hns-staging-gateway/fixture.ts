import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  encodeHnsAuthorityInventory,
  hnsAuthorityCapabilitySetDigest,
} from "../../packages/application/src/namespace-ownership/hns-authority-inventory.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const reference = (value: string) => `hns-community-app-handle-gateway-sha256:${sha(value)}`;
const now = "2026-10-23T12:00:00.000Z";

export async function stagingGatewayFixture() {
  const raw = JSON.parse(
    gunzipSync(
      await Bun.file(
        new URL("../hns-continuity/fixtures/continuity-observation.json.gz", import.meta.url),
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
