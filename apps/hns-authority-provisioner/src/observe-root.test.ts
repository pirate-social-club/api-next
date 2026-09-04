import { describe, expect, test } from "bun:test";
import { decodeHnsRootImportReadinessResultV1 } from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import {
  HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
  HnsRootReadinessObservationError,
  observeHnsRootReadinessV1,
} from "./observe-root.ts";
import {
  HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  type HnsAuthorityZoneResult,
  provisionHnsAuthorityRootV1,
} from "./provision-root.ts";

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture() {
  const managedZoneBytes = encoder.encode(
    canonicalJson({ root_label: "newroot", serial: 7, managed: true }),
  );
  const zone: HnsAuthorityZoneResult = {
    created: true,
    dnssec: true,
    serial: 7,
    ds_records: [
      { key_tag: 10_875, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
      { key_tag: 10_875, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
    ],
    managed_rrset_sha256: await sha256(managedZoneBytes),
    managed_zone_bytes: managedZoneBytes,
    shared_tlsa_profile_sha256: "c".repeat(64),
    gateway_ipv4: "192.0.2.10",
    gateway_deployment_reference: "gateway-deployment-v1",
    gateway_certificate_spki_sha256: "d".repeat(64),
    ttl_seconds: 300,
  };
  const provision = await provisionHnsAuthorityRootV1(
    {
      version: HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
      root_import_session_id: "root-import-session",
      namespace_session_id: "namespace-session",
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    {
      inspect_current_resource: async () => [{ type: "TXT", txt: ["preserved"] }],
      ensure_zone: async () => zone,
    },
  );
  const plan = JSON.parse(new TextDecoder().decode(provision.publish_plan_bytes)) as {
    readonly replacement_records: readonly unknown[];
  };
  const observedZoneSha256 = await sha256(managedZoneBytes);
  const authorityView = (ordinal: 1 | 2) => ({
    authority_nameserver: `ns${ordinal}.pirate`,
    authority_address_family: "GLUE4" as const,
    authority_address: `192.0.2.${String(52 + ordinal)}`,
    dnssec_validation: "secure" as const,
    challenge_present: true as const,
    validated_dnskey_response_sha256: ordinal === 1 ? "1".repeat(64) : "2".repeat(64),
    validated_control_response_sha256: ordinal === 1 ? "3".repeat(64) : "4".repeat(64),
    validated_chain_authority_digest: "5".repeat(64),
    observed_zone_bytes: managedZoneBytes,
    observed_zone_sha256: observedZoneSha256,
  });
  const live = {
    authority_views: [authorityView(1), authorityView(2)],
    gateway: {
      normalized_host: "app.newroot",
      gateway_address: "192.0.2.10",
      certificate_spki_sha256: "d".repeat(64),
      http_status: 421 as const,
    },
  } as const;
  return {
    zone,
    provision,
    plan,
    live,
    request: {
      version: HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
      root_import_session_id: "root-import-session",
      namespace_session_id: "namespace-session",
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
      ownership_result_sha256: "e".repeat(64),
      publish_plan_sha256: provision.publish_plan_sha256,
      provision_result_sha256: provision.result_sha256,
      expires_at: "2099-01-01T00:00:00.000Z",
    } as const,
  };
}

describe("HNS root readiness observation", () => {
  test("retains exact chain, signed-zone, shared TLSA, and bounded inventory evidence", async () => {
    const state = await fixture();
    const observed = await observeHnsRootReadinessV1({
      operation_kind: "observe_root_v1",
      request: state.request,
      publish_plan_bytes: state.provision.publish_plan_bytes,
      provision_result_bytes: state.provision.result_bytes,
      ports: {
        inspect_current_resource: async () =>
          [...state.plan.replacement_records].reverse() as never,
        inspect_zone: async () => ({ ...state.zone, created: false }),
        observe_live: async () => state.live,
      },
      config: {
        environment: "test",
        valid_for_seconds: 86_400,
        now: () => Date.parse("2026-09-01T06:00:00.000Z"),
      },
    });
    const decoded = await decodeHnsRootImportReadinessResultV1(observed.result_bytes);
    expect(decoded.result).toMatchObject({
      root_label: "newroot",
      powerdns_zone_serial: 7,
      gateway_deployment_reference: "gateway-deployment-v1",
      gateway_http_status: 421,
      delegation_matches: true,
      ds_authenticates_zone: true,
      retained_zone_digest_matches: true,
      gateway_healthy: true,
      valid_until: "2026-09-02T06:00:00.000Z",
    });
    expect(decoded.managed_zone_bytes).toEqual(state.zone.managed_zone_bytes);
    expect(decoded.authority_inventory.dns_write_capabilities).toEqual([
      {
        capability_reference: "pdns-zone:newroot",
        scope_kind: "exact_root",
        root_label: "newroot",
        active: true,
      },
    ]);
  });

  test("reports owner-update pending without inspecting authority", async () => {
    const state = await fixture();
    let inspectedZone = false;
    await expect(
      observeHnsRootReadinessV1({
        operation_kind: "observe_root_v1",
        request: state.request,
        publish_plan_bytes: state.provision.publish_plan_bytes,
        provision_result_bytes: state.provision.result_bytes,
        ports: {
          inspect_current_resource: async () => [{ type: "TXT", txt: ["old"] }],
          inspect_zone: async () => {
            inspectedZone = true;
            return state.zone;
          },
          observe_live: async () => state.live,
        },
        config: { environment: "test", valid_for_seconds: 86_400 },
      }),
    ).rejects.toEqual(new HnsRootReadinessObservationError("owner_update_pending"));
    expect(inspectedZone).toBe(false);
  });

  test("refuses forged health facts and mismatched authority-zone evidence", async () => {
    const state = await fixture();
    const observed = await observeHnsRootReadinessV1({
      operation_kind: "observe_root_v1",
      request: state.request,
      publish_plan_bytes: state.provision.publish_plan_bytes,
      provision_result_bytes: state.provision.result_bytes,
      ports: {
        inspect_current_resource: async () => state.plan.replacement_records as never,
        inspect_zone: async () => ({ ...state.zone, created: false }),
        observe_live: async () => state.live,
      },
      config: {
        environment: "test",
        valid_for_seconds: 86_400,
        now: () => Date.parse("2026-09-01T06:00:00.000Z"),
      },
    });
    const forgedFacts = JSON.parse(new TextDecoder().decode(observed.result_bytes)) as Record<
      string,
      unknown
    >;
    forgedFacts.gateway_healthy = false;
    await expect(
      decodeHnsRootImportReadinessResultV1(encoder.encode(canonicalJson(forgedFacts))),
    ).rejects.toBeInstanceOf(TypeError);

    const mismatchedViews = JSON.parse(new TextDecoder().decode(observed.result_bytes)) as {
      authority_views: Array<Record<string, unknown>>;
    };
    if (mismatchedViews.authority_views[1] !== undefined) {
      mismatchedViews.authority_views[1].observed_zone_sha256 = "f".repeat(64);
    }
    await expect(
      decodeHnsRootImportReadinessResultV1(encoder.encode(canonicalJson(mismatchedViews))),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("keeps import observations expiry-gated while allowing activated-root renewal", async () => {
    const state = await fixture();
    const request = { ...state.request, expires_at: "2026-09-07T06:00:00.000Z" };
    const ports = {
      inspect_current_resource: async () => state.plan.replacement_records as never,
      inspect_zone: async () => ({ ...state.zone, created: false }),
      observe_live: async () => state.live,
    };
    const config = {
      environment: "test",
      valid_for_seconds: 86_400,
      now: () => Date.parse("2026-09-08T06:00:00.000Z"),
    } as const;

    await expect(
      observeHnsRootReadinessV1({
        operation_kind: "observe_root_v1",
        request,
        publish_plan_bytes: state.provision.publish_plan_bytes,
        provision_result_bytes: state.provision.result_bytes,
        ports,
        config,
      }),
    ).rejects.toEqual(new HnsRootReadinessObservationError("invalid_request"));

    const renewed = await observeHnsRootReadinessV1({
      operation_kind: "renew_health_v1",
      request,
      publish_plan_bytes: state.provision.publish_plan_bytes,
      provision_result_bytes: state.provision.result_bytes,
      ports,
      config,
    });
    const decoded = await decodeHnsRootImportReadinessResultV1(renewed.result_bytes);
    expect(decoded.result).toMatchObject({
      observed_at: "2026-09-08T06:00:00.000Z",
      valid_until: "2026-09-09T06:00:00.000Z",
    });
  });
});
