import { describe, expect, test } from "bun:test";
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
      inspect_current_resource: async () => {
        order.push("inspect");
        return [
          { type: "SYNTH4", address: "192.0.2.40" },
          { type: "NS", ns: "old.example." },
        ];
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
    expect(order).toEqual(["inspect", "ensure"]);
    const plan = JSON.parse(new TextDecoder().decode(output.publish_plan_bytes));
    expect(plan).toMatchObject({
      replacement_semantics: "complete_resource",
      preserved_records: [{ type: "SYNTH4", address: "192.0.2.40" }],
      removed_conflicts: [{ type: "NS", ns: "old.example." }],
      acknowledgement_required: true,
    });
    expect(output.publish_plan_sha256).toMatch(/^[0-9a-f]{64}$/u);
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
        inspect_current_resource: async () => [{ type: "txt", txt: ["invalid"] }],
        ensure_zone: async () => {
          mutated = true;
          throw new Error("not used");
        },
      }),
    ).rejects.toThrow("root_unavailable");
    expect(mutated).toBe(false);
  });
});
