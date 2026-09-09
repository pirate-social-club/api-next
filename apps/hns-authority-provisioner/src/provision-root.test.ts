import { describe, expect, test } from "bun:test";
import {
  encodeHnsResourceV1,
  HNS_RESOURCE_MAX_WIRE_BYTES_V1,
  type HnsChainObservationResultV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import {
  decodeHnsAuthorityProvisionRequestV1,
  HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  provisionHnsAuthorityRootV1,
} from "./provision-root.ts";

const encoder = new TextEncoder();
const request = {
  version: HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  root_import_session_id: "root-import-session",
  namespace_session_id: "namespace-session",
  root_label: "newroot",
  challenge_txt_value: "pirate-verification=challenge",
  expires_at: "2099-01-01T00:00:00.000Z",
} as const;

function observedCurrent(records: readonly unknown[]): Promise<HnsChainObservationResultV1> {
  return Promise.resolve({
    kind: "observed",
    observation: {
      view: "current",
      network: "main",
      genesis_block_hash: `${"0".repeat(63)}1`,
      anchor: {
        network: "main",
        genesis_block_hash: `${"0".repeat(63)}1`,
        height: 812_345,
        best_block_hash: "aa".repeat(32),
        median_time_past_epoch_seconds: 1_770_000_000,
        header_time_epoch_seconds: 1_770_000_030,
        confirmations: 1,
      },
      tip_height: 812_345,
      update_inclusion_height: 800_000,
      commitment: null,
      observed_at_epoch_ms: 1_770_000_060_000,
      records: structuredClone(records) as never,
      resource_sha256: `${"1".repeat(64)}`,
    },
  });
}

describe("HNS authority root provision operation", () => {
  test("inspects before mutation and returns a complete preserved wallet plan", async () => {
    const order: string[] = [];
    const managedZoneBytes = encoder.encode("managed-zone");
    const managedZoneSha256 = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", managedZoneBytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const output = await provisionHnsAuthorityRootV1(request, {
      observe_current_resource: async () => {
        order.push("inspect");
        return observedCurrent([
          { type: "SYNTH4", address: "192.0.2.40" },
          { type: "NS", ns: "old.example." },
        ]);
      },
      ensure_zone: async () => {
        order.push("ensure");
        return {
          created: true,
          dnssec: true,
          serial: 2_026_090_101,
          ds_records: [
            { key_tag: 10_875, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
            { key_tag: 10_875, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
          ],
          managed_rrset_sha256: managedZoneSha256,
          managed_zone_bytes: managedZoneBytes,
          shared_tlsa_profile_sha256: "d".repeat(64),
          gateway_ipv4: "192.0.2.10",
          gateway_deployment_reference: "gateway-deployment-v1",
          gateway_certificate_spki_sha256: "e".repeat(64),
          ttl_seconds: 300,
        };
      },
    });
    expect(order).toEqual(["inspect", "ensure", "inspect"]);
    const plan = JSON.parse(new TextDecoder().decode(output.publish_plan_bytes));
    expect(plan).toMatchObject({
      replacement_semantics: "complete_resource",
      preserved_records: [{ type: "SYNTH4", address: "192.0.2.40" }],
      removed_conflicts: [{ type: "NS", ns: "old.example." }],
      acknowledgement_required: true,
    });
    expect(output.publish_plan_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(output.current_snapshot_sha256).toBe(`${"1".repeat(64)}`);
    expect(JSON.parse(new TextDecoder().decode(output.result_bytes))).toMatchObject({
      root_label: "newroot",
      zone_created: true,
      zone_dnssec: true,
    });
  });

  test("accepts only the exact canonical request envelope", () => {
    expect(decodeHnsAuthorityProvisionRequestV1(encoder.encode(canonicalJson(request)))).toEqual(
      request,
    );
    expect(() =>
      decodeHnsAuthorityProvisionRequestV1(
        encoder.encode(JSON.stringify({ ...request, expanded_target: "forbidden" })),
      ),
    ).toThrow("invalid_request");
  });

  test("refuses a malformed HSD resource before mutating authority state", async () => {
    let mutated = false;
    await expect(
      provisionHnsAuthorityRootV1(request, {
        observe_current_resource: async () => observedCurrent([{ type: "txt", txt: ["invalid"] }]),
        ensure_zone: async () => {
          mutated = true;
          throw new Error("not used");
        },
      }),
    ).rejects.toThrow("root_unavailable");
    expect(mutated).toBe(false);
  });

  test("refuses unavailable current-view evidence before mutating authority state", async () => {
    for (const result of [
      { kind: "unavailable", classification: "transport_failure" },
      { kind: "unavailable", classification: "chain_moving" },
      { kind: "unavailable", classification: "node_stale" },
      { kind: "finding", classification: "resource_absent" },
    ] as const) {
      let mutated = false;
      await expect(
        provisionHnsAuthorityRootV1(request, {
          observe_current_resource: async () => result as HnsChainObservationResultV1,
          ensure_zone: async () => {
            mutated = true;
            throw new Error("not used");
          },
        }),
      ).rejects.toThrow("root_unavailable");
      expect(mutated).toBe(false);
    }
  });
});

describe("HNS authority root provision preflight encoding boundaries", () => {
  const managedZoneBytes = encoder.encode("managed-zone");
  async function zoneResult() {
    return {
      created: true,
      dnssec: true,
      serial: 7,
      ds_records: [
        { key_tag: 10_875, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
        { key_tag: 10_875, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
      ],
      managed_rrset_sha256: await sha256Hex(managedZoneBytes),
      managed_zone_bytes: managedZoneBytes,
      shared_tlsa_profile_sha256: "c".repeat(64),
      gateway_ipv4: "192.0.2.10",
      gateway_deployment_reference: "gateway-deployment-v1",
      gateway_certificate_spki_sha256: "d".repeat(64),
      ttl_seconds: 300,
    } as const;
  }

  function boundaryRecords(targetBytes: number): { type: "TXT"; txt: string[] }[] {
    // Derive preserved TXT records whose real encoding lands the complete
    // replacement at exactly targetBytes. The probe is the plan's
    // replacement set without the preserved padding records; each TXT
    // record costs 3 bytes plus its chunk length on the wire.
    const probe = encodeHnsResourceV1([
      { type: "NS", ns: "ns1.pirate." },
      { type: "NS", ns: "ns2.pirate." },
      { type: "TXT", txt: ["pirate-verification=challenge"] },
      { type: "DS", keyTag: 10_875, algorithm: 13, digestType: 2, digest: "a".repeat(64) },
      { type: "DS", keyTag: 10_875, algorithm: 13, digestType: 4, digest: "b".repeat(96) },
    ]);
    const base = probe.byteLength;
    let gap = targetBytes - base;
    const records: { type: "TXT"; txt: string[] }[] = [];
    while (gap > 0) {
      if (records.length >= 8) throw new Error(`boundary ${targetBytes} unreachable`);
      const chunk = Math.min(gap - 3, 255);
      if (chunk < 1) throw new Error(`boundary ${targetBytes} unreachable from base ${base}`);
      records.push({ type: "TXT", txt: ["x".repeat(chunk)] });
      gap -= 3 + chunk;
    }
    if (gap !== 0) throw new Error(`boundary ${targetBytes} unreachable from base ${base}`);
    return records;
  }

  async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function provisionWithPadding(records: { type: "TXT"; txt: string[] }[]) {
    let zoneEnsured = 0;
    const output = await provisionHnsAuthorityRootV1(request, {
      observe_current_resource: async () => observedCurrent(records),
      ensure_zone: async () => {
        zoneEnsured += 1;
        return zoneResult();
      },
    });
    return { output, zoneEnsured };
  }

  test("exposes a plan whose real encoding is exactly 511 bytes", async () => {
    const { output } = await provisionWithPadding(boundaryRecords(511));
    const plan = JSON.parse(new TextDecoder().decode(output.publish_plan_bytes)) as {
      replacement_records: never[];
      encoded_resource_sha256: string;
    };
    const encoded = encodeHnsResourceV1(plan.replacement_records);
    expect(encoded.byteLength).toBe(511);
    expect(encoded.byteLength).toBeLessThanOrEqual(HNS_RESOURCE_MAX_WIRE_BYTES_V1);
    expect(plan.encoded_resource_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("exposes a plan whose real encoding is exactly 512 bytes at the consensus boundary", async () => {
    const { output } = await provisionWithPadding(boundaryRecords(512));
    const plan = JSON.parse(new TextDecoder().decode(output.publish_plan_bytes)) as {
      replacement_records: never[];
    };
    expect(encodeHnsResourceV1(plan.replacement_records).byteLength).toBe(512);
  });

  test("rejects a resource needing 513 bytes after the zone was retained, so DS values stay final", async () => {
    let zoneEnsured = false;
    await expect(
      provisionHnsAuthorityRootV1(request, {
        observe_current_resource: async () => observedCurrent(boundaryRecords(513)),
        ensure_zone: async () => {
          zoneEnsured = true;
          return zoneResult();
        },
      }),
    ).rejects.toThrow("invalid_authority_result");
    // Partial provisioning is retained: the provisional keys were created
    // before the preflight rejected the oversized resource.
    expect(zoneEnsured).toBe(true);
  });

  test("final DS values in the plan equal the retained zone keyset", async () => {
    const { output } = await provisionWithPadding([{ type: "TXT", txt: ["small"] }]);
    const plan = JSON.parse(new TextDecoder().decode(output.publish_plan_bytes)) as {
      added_records: Array<{ type: string; keyTag?: number; digestType?: number }>;
    };
    expect(
      plan.added_records
        .filter((record) => record.type === "DS")
        .map((record) => [record.keyTag, record.digestType]),
    ).toEqual([
      [10_875, 2],
      [10_875, 4],
    ]);
  });
});
