import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "@pirate/domain";
import { requireHnsStagingRelocationReview } from "./hns-staging-relocation-review.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function fixture(root = "8s28") {
  const previous = [
    { type: "NS", ns: "ns1.8s28." },
    { type: "NS", ns: "ns2.8s28." },
    { type: "DS", keyTag: 31348, algorithm: 13, digestType: 2, digest: "ab".repeat(32) },
    ...(root === "8s28"
      ? [
          { type: "GLUE4", ns: "ns1.8s28.", address: "81.15.150.167" },
          { type: "GLUE4", ns: "ns2.8s28.", address: "94.103.168.209" },
        ]
      : []),
    { type: "TXT", txt: ["preserved"] },
  ];
  const next = previous.map((record) =>
    record.address === "81.15.150.167" ? { ...record, address: "94.103.168.209" } : record,
  );
  const manifest_json = JSON.stringify({
    schema: "pirate-hns-community-app-handle-gateway-staging-public-v1",
    mode: "staging-public-tls",
    public_tls_listener: "94.103.168.209:443",
    profile_sha256: "cd".repeat(32),
    handle_profile_sha256: "ef".repeat(32),
    gateway_certificate_spki_sha256: "ab".repeat(32),
  });
  const gateway = `hns-community-app-handle-gateway-sha256:${createHash("sha256").update(manifest_json).digest("hex")}`;
  const observedAt = "2026-10-21T19:00:00.000Z";
  return {
    review: {
      version: "hns-reviewed-staging-gateway-relocation-v1",
      root_label: root,
      previous_generation: 4,
      previous_health_generation: 2,
      previous_gateway_ipv4: "81.15.150.167",
      gateway_ipv4: "94.103.168.209",
      previous_chain_records: previous,
      chain_records: next,
      gateway_rotation: {
        version: "hns-reviewed-gateway-rotation-v1",
        previous_gateway_reference: "gateway-previous",
        gateway_reference: gateway,
        profile_sha256: "cd".repeat(32),
        handle_profile_sha256: "ef".repeat(32),
        manifest_json,
        observed_at: observedAt,
        readiness: "operator_attested_shadow_ready",
      },
    },
    predecessor: {
      environment: "staging",
      root_label: root,
      generation: 4,
      health_generation: 2,
      gateway_reference: "gateway-previous",
      certificate_spki: "ab".repeat(32),
      chain_reference: `hns-root-chain:${hash(previous)}`,
    },
    observed: {
      root_label: root,
      gateway_deployment_reference: gateway,
      gateway_certificate_spki_sha256: "ab".repeat(32),
      chain_resource_sha256: hash(next),
    },
    observed_at: observedAt,
  };
}

describe("reviewed staging relocation", () => {
  test("permits the single in-bailiwick glue move and preserves external delegation", async () => {
    for (const root of ["8s28", "a18n"])
      await expect(requireHnsStagingRelocationReview(fixture(root))).resolves.toMatchObject({
        gateway_ipv4: "94.103.168.209",
      });
  });
  test("refuses production, stale generations, identities and unreviewed chain changes", async () => {
    for (const patch of [
      { environment: "production" },
      { generation: 5 },
      { health_generation: 3 },
      { certificate_spki: "01".repeat(32) },
      { chain_reference: `hns-root-chain:${"00".repeat(32)}` },
    ]) {
      const input = fixture();
      await expect(
        requireHnsStagingRelocationReview({
          ...input,
          predecessor: { ...input.predecessor, ...patch },
        }),
      ).rejects.toThrow();
    }
    for (const extra of [
      { type: "TXT", txt: ["changed"] },
      { type: "GLUE4", ns: "ns2.8s28.", address: "192.0.2.1" },
      { type: "DS", keyTag: 31349, algorithm: 13, digestType: 2, digest: "ab".repeat(32) },
    ]) {
      const input = fixture();
      const changed = [...input.review.chain_records, extra];
      await expect(
        requireHnsStagingRelocationReview({
          ...input,
          review: { ...input.review, chain_records: changed },
          observed: { ...input.observed, chain_resource_sha256: hash(changed) },
        }),
      ).rejects.toThrow("unreviewed chain");
    }
    const input = fixture();
    await expect(
      requireHnsStagingRelocationReview({
        ...input,
        review: { ...input.review, unexpected: true },
      }),
    ).rejects.toThrow("malformed");
  });
});
