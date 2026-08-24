/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  type HnsOwnerActiveLeaseRenewalRequestV1,
  hnsActiveLeaseRenewalRequestHash,
} from "@pirate/application/namespace-ownership";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../apps/hns-owner-verifier/src/index.ts";
import type { HnsTargetObserverRuntime } from "../../apps/hns-owner-verifier/src/target-observer.ts";

async function renewalRequest(): Promise<HnsOwnerActiveLeaseRenewalRequestV1> {
  const withoutHash = {
    version: "pirate-hns-active-lease-renewal-request-v1" as const,
    operation_kind: "active_lease_renewal" as const,
    active_lease_renewal_id: "hns-renewal-workerd-01",
    active_lease_renewal_attempt_id: "hns-renewal-attempt-workerd-01",
    community_id: "community-workerd-01",
    route_binding_id: "route-binding-workerd-01",
    expected_binding_generation: 1,
    expected_verified_evidence_ref: "route-evidence-workerd-01",
    expected_evidence_digest: "a".repeat(64),
    expected_control_identity_digest: "b".repeat(64),
    expected_chain_authority_digest: "c".repeat(64),
    prior_provider_evidence_ref: `hns-observer-v1:sha256:${"d".repeat(64)}:hns-observer:workerd:prior-01`,
    attempt_number: 1,
    evidence_ref: "route-evidence-workerd-02",
    requirement_hash: "e".repeat(64),
    request_hash: "0".repeat(64),
    provider_id: "hns.owner.v1" as const,
    provider_binding_hash: "f".repeat(64),
    provider_configuration: {
      kind: "managed" as const,
      reference: "hns-owner-staging",
      version: "hns-owner-config-v1",
      digest: "1".repeat(64),
    },
    protocol_version: "hns-active-lease-renewal-v1" as const,
    environment: "staging",
    route: {
      family: "hns" as const,
      root_label: "jazleeuw",
      root_label_display: "jazleeuw",
      path_segment: "app.jazleeuw",
      href: "/c/app.jazleeuw",
      app_host: null,
    },
  };
  return { ...withoutHash, request_hash: await hnsActiveLeaseRenewalRequestHash(withoutHash) };
}

describe("HNS active renewal (workerd)", () => {
  it("returns exact ineligibility bytes without an observer exchange", async () => {
    const requestValue = await renewalRequest();
    let observerCalls = 0;
    const runtime: HnsTargetObserverRuntime = {
      configuration: {
        provider_id: "hns.owner.v1",
        provider_configuration_reference: "hns-owner-staging",
        provider_configuration_version: "hns-owner-config-v1",
        provider_configuration_digest: "1".repeat(64),
        environment: "staging",
        ownership_source: "hns_parent_chain_txt",
        observer_deadline_ms: 12_000,
        lease_policy: {
          expected_block_interval_seconds: 600,
          minimum_safe_remaining_blocks: 144,
          expiry_safety_blocks: 144,
          evidence_lease_seconds: 2_592_000,
        },
      },
      snapshot_reader: { read: async () => null },
      observer: {
        observe: async () => {
          observerCalls += 1;
          throw new Error("must not observe");
        },
      },
    };
    const response = await handleRequest(
      new Request("https://hns-owner.internal/internal/hns-owner/v1/active-lease-renewal", {
        method: "POST",
        headers: {
          Accept: "application/octet-stream",
          "Content-Type": "application/json",
          "Pirate-HNS-Active-Lease-Renewal-Id": requestValue.active_lease_renewal_id,
          "Pirate-HNS-Observation-Id": "observer-renewal-workerd-01",
        },
        body: JSON.stringify(requestValue),
      }),
      {
        HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
        HNS_EVIDENCE_TTL_SECONDS: "2592000",
        HNS_PROVIDER_ENVIRONMENT: "staging",
        HNS_PROVIDER_CONFIGURATION_REFERENCE: "hns-owner-staging",
        HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-v1",
      },
      { targetObserver: runtime },
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"error":"renewal_evidence_ineligible"}');
    expect(observerCalls).toBe(0);
  });
});
