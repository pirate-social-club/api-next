/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from "cloudflare:test";
import {
  buildHnsOwnerRecoveryProviderStart,
  encodeHnsOwnerRecoveryProviderStart,
  type HnsOwnerRecoveryAuthorityV1,
} from "@pirate/application/route-revalidation";
import { describe, expect, it } from "vitest";

const authority: HnsOwnerRecoveryAuthorityV1 = {
  actor_id: "user-recovery-workerd-1",
  community_id: "community-recovery-workerd-1",
  route_binding_id: "route-binding-recovery-workerd-1",
  expected_binding_generation: 8,
  recovery_authority_kind: "database_time_expiry_transition",
  recovery_authority_reference: "route-transition-recovery-workerd-1",
  provider_id: "hns.owner.v1",
  provider_binding_hash: "4".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
    digest: "1".repeat(64),
  },
  protocol_version: "hns-owner-recovery-v1",
  environment: "staging",
  route: {
    family: "hns",
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
    href: "/c/app.jazleeuw",
    app_host: null,
  },
};

function body(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

describe("HNS verifier default composition (workerd)", () => {
  it("fails closed without complete target configuration or private bindings", async () => {
    const providerStart = await buildHnsOwnerRecoveryProviderStart({
      route_recovery_id: "route-recovery-workerd-disabled-1",
      session_id: "recovery-session-workerd-disabled-1",
      authority,
      database_started_at: "2026-02-02T03:04:05.000Z",
    });
    const bytes = await encodeHnsOwnerRecoveryProviderStart(providerStart);
    const verifierEnv = env as unknown as Record<string, unknown>;

    expect(verifierEnv.HNS_OWNERSHIP_SOURCE).toBe("hns_parent_chain_txt");
    expect(verifierEnv.HNS_PROVIDER_CONFIGURATION_REFERENCE).toBe("hns-owner-staging");
    expect("HNS_OWNER_VERIFIER" in verifierEnv).toBe(false);
    expect("HNS_OBSERVER_DRIVER" in verifierEnv).toBe(false);
    expect("CONTROL_PLANE" in verifierEnv).toBe(false);
    expect("HNS_PROVIDER_CONFIGURATION_DIGEST" in verifierEnv).toBe(false);
    expect(["HNS", "LEGACY", "VERIFIER", "URL"].join("_") in verifierEnv).toBe(false);
    expect(["HNS", "LEGACY", "VERIFIER", "BEARER"].join("_") in verifierEnv).toBe(false);
    const response = await SELF.fetch("https://hns-owner.internal/internal/hns-owner/v1/start", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Pirate-Namespace-Session-Id": providerStart.session_id,
      },
      body: body(bytes),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_misconfigured" });
  });
});
