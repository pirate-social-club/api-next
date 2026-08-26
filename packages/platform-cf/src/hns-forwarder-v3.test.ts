import { describe, expect, test } from "bun:test";
import type {
  HnsCommunityAppHostAuthorityStateV1,
  HnsHandlePersonaHostAuthorityStateV1,
  HnsHostAuthorityStateV1,
} from "@pirate/application/hns-host-serving";
import { Effect } from "effect";
import {
  HnsForwarderFailure,
  makeHnsForwarderV3Gateway,
  makeHnsForwarderV3WorkerValidator,
  makeStaticHnsForwarderKeyRegistryV1,
} from "./hns-forwarder-v3.ts";

const now = 1_770_000_000;
const secret = new TextEncoder().encode("test-forwarder-hmac-key-with-32-bytes");
const limits = {
  max_body_bytes: 1_024,
  freshness_window_seconds: 300,
  future_clock_skew_seconds: 5,
};
const zone = {
  dns_zone_activation_id: "dns-zone-1",
  dns_zone_activation_generation: 4,
  status: "active" as const,
  stable_chain_delegation_matches: true,
  dnssec_ds_authenticates_zone: true,
  retained_zone_digest_matches: true,
  gateway_deployment_reference: "gateway-deployment-1",
  gateway_certificate_spki_sha256: "a".repeat(64),
  gateway_health: "healthy" as const,
};
const appState: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: "app.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  community_id: "com_cmt_public_namespace_test",
  app_host_activation_id: "app_host_activation_01",
  app_host_activation_generation: 3,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-zone-1",
  activation_dns_zone_generation: 4,
  activation_gateway_deployment_reference: "gateway-deployment-1",
  route_binding_id: "route-binding-1",
  route_binding_current: true,
  route_authority_kind: "operator_managed_route_v1",
  route_authority_reference: "operator_route_activation_01",
  route_authority_generation: 7,
  route_authority_effective: true,
  dns_zone: zone,
};
const handleState: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: "name.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  canonical_handle_label: "name",
  community_id: "com_cmt_public_namespace_test",
  sale_namespace_activation_id: "sale_namespace_activation_01",
  sale_namespace_activation_generation: 3,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: "dns-zone-1",
  sale_namespace_dns_zone_generation: 4,
  sale_namespace_gateway_deployment_reference: "gateway-deployment-1",
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "route_evidence_7",
  namespace_authority_generation: 7,
  namespace_authority_effective: true,
  handle_grant_id: "handle_grant_01",
  handle_grant_generation: 2,
  handle_grant_active: true,
  fulfillment_kind: "hosted_persona_v1",
  owner_persona_id: "persona_public_01",
  owner_persona_public: true,
  dns_zone: zone,
};

function registry() {
  return makeStaticHnsForwarderKeyRegistryV1([
    {
      key_id: "gateway-key-2026-08",
      key_bytes: secret,
      signing_enabled: true,
      verify_not_before: now - 3_600,
      verify_not_after: now + 3_600,
    },
  ]);
}

function harness(initial: HnsHostAuthorityStateV1) {
  let current: HnsHostAuthorityStateV1 | null = initial;
  let nonceCounter = 0;
  const consumed = new Set<string>();
  const source = {
    resolve: (host: string) => Effect.succeed(current?.normalized_host === host ? current : null),
  };
  const gateway = makeHnsForwarderV3Gateway({
    authority_source: source,
    key_registry: registry(),
    clock: { nowUnixSeconds: () => now },
    nonce_source: { next: () => `nonce-${++nonceCounter}` },
    limits,
  });
  const worker = makeHnsForwarderV3WorkerValidator({
    authority_source: source,
    key_registry: registry(),
    replay_store: {
      consume: async (keyId, nonce) => {
        const identity = `${keyId}:${nonce}`;
        if (consumed.has(identity)) return false;
        consumed.add(identity);
        return true;
      },
    },
    clock: { nowUnixSeconds: () => now },
    limits,
  });
  return {
    gateway,
    worker,
    setCurrent: (next: HnsHostAuthorityStateV1 | null) => {
      current = next;
    },
  };
}

describe("HNS forwarder v3 WebCrypto adapter", () => {
  test("reproduces both frozen HMAC vectors in Bun", async () => {
    const app = harness(appState);
    const appEnvelope = await app.gateway.sign({
      method: "GET",
      normalized_host: appState.normalized_host,
      path_and_query: "/c/xn--pokmon-dva",
      headers: new Headers(),
      body_bytes: new Uint8Array(),
    });
    expect(appEnvelope.headers.get("x-pirate-hns-forwarder-signature")).toBe(
      "v3=b09e03ea0a1441654d481ca19f34245a4560f3db68b5abde3cda49f2bfb4f9eb",
    );
    const handle = harness(handleState);
    const handleEnvelope = await handle.gateway.sign({
      method: "GET",
      normalized_host: handleState.normalized_host,
      path_and_query: "/",
      headers: new Headers(),
      body_bytes: new Uint8Array(),
    });
    expect(handleEnvelope.headers.get("x-pirate-hns-forwarder-signature")).toBe(
      "v3=91716ea3c434df9b5fba3e5f177b2db6b0beac25cd81bb3906faf5fce8e338de",
    );
  });

  test("replaces every client-supplied reserved header and verifies current authority", async () => {
    const { gateway, worker } = harness(appState);
    const clientHeaders = new Headers({
      "x-pirate-hns-host": "attacker.invalid",
      "x-pirate-hns-forwarder-key-id": "attacker-key",
      "x-pirate-hns-forwarder-timestamp": "1",
      "x-pirate-hns-forwarder-path": "/private",
      "x-pirate-hns-forwarder-body-sha256": "0".repeat(64),
      "x-pirate-hns-forwarder-nonce": "attacker-nonce",
      "x-pirate-hns-forwarder-signature": `v2=${"0".repeat(64)}`,
      "x-pirate-hns-forwarder-authority": "attacker-authority",
      "x-client-header": "retained",
    });
    const envelope = await gateway.sign({
      method: "GET",
      normalized_host: appState.normalized_host,
      path_and_query: "/c/xn--pokmon-dva",
      headers: clientHeaders,
      body_bytes: new Uint8Array(),
    });
    expect(envelope.headers.get("x-client-header")).toBe("retained");
    expect(envelope.headers.get("x-pirate-hns-host")).toBe(appState.normalized_host);
    expect(envelope.headers.get("x-pirate-hns-forwarder-key-id")).toBe("gateway-key-2026-08");
    expect(envelope.headers.get("x-pirate-hns-forwarder-nonce")).toBe("");
    const verified = await worker.verify({
      method: "GET",
      url: "https://worker.internal/c/xn--pokmon-dva",
      headers: envelope.headers,
      body_bytes: new Uint8Array(),
    });
    expect(verified.host_authority).toEqual(envelope.authority.host_authority);
    expect(verified.community_id).toBe(appState.community_id);
  });

  test("rejects downgrade, tampering, stale time, wrong bytes, and authority drift", async () => {
    const { gateway, worker, setCurrent } = harness(appState);
    const envelope = await gateway.sign({
      method: "GET",
      normalized_host: appState.normalized_host,
      path_and_query: "/c/xn--pokmon-dva",
      headers: new Headers(),
      body_bytes: new Uint8Array(),
    });
    const expectReason = async (headers: Headers, reason: string, body = new Uint8Array()) => {
      await expect(
        worker.verify({
          method: "GET",
          url: "https://worker.internal/c/xn--pokmon-dva",
          headers,
          body_bytes: body,
        }),
      ).rejects.toMatchObject({ reason });
    };
    const downgraded = new Headers(envelope.headers);
    downgraded.set("x-pirate-hns-forwarder-signature", `v2=${"0".repeat(64)}`);
    await expectReason(downgraded, "invalid_signature");
    const wrongHost = new Headers(envelope.headers);
    wrongHost.set("x-pirate-hns-host", "app.pirate");
    await expectReason(wrongHost, "authority_unavailable");
    const stale = new Headers(envelope.headers);
    stale.set("x-pirate-hns-forwarder-timestamp", String(now - 301));
    await expectReason(stale, "stale");
    await expectReason(envelope.headers, "invalid_request", new TextEncoder().encode("changed"));
    setCurrent({ ...appState, route_authority_generation: 8 });
    await expectReason(envelope.headers, "invalid_signature");
  });

  test("re-resolves current authority only after authenticating the envelope", async () => {
    let current: HnsHostAuthorityStateV1 | null = appState;
    let calls = 0;
    const source = {
      resolve: (host: string) => {
        calls += 1;
        const observed = current?.normalized_host === host ? current : null;
        if (calls === 1) current = { ...appState, route_authority_generation: 8 };
        return Effect.succeed(observed);
      },
    };
    const gateway = makeHnsForwarderV3Gateway({
      authority_source: {
        resolve: (host) => Effect.succeed(host === appState.normalized_host ? appState : null),
      },
      key_registry: registry(),
      clock: { nowUnixSeconds: () => now },
      nonce_source: { next: () => "nonce" },
      limits,
    });
    const worker = makeHnsForwarderV3WorkerValidator({
      authority_source: source,
      key_registry: registry(),
      replay_store: { consume: async () => true },
      clock: { nowUnixSeconds: () => now },
      limits,
    });
    const envelope = await gateway.sign({
      method: "GET",
      normalized_host: appState.normalized_host,
      path_and_query: "/c/xn--pokmon-dva",
      headers: new Headers(),
      body_bytes: new Uint8Array(),
    });
    await expect(
      worker.verify({
        method: "GET",
        url: "https://worker.internal/c/xn--pokmon-dva",
        headers: envelope.headers,
        body_bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "authority_unavailable" });
    expect(calls).toBe(2);
  });

  test("consumes unsafe nonces once and enforces exact body bounds", async () => {
    const { gateway, worker } = harness(appState);
    const bytes = new TextEncoder().encode('{"title":"hello"}');
    const envelope = await gateway.sign({
      method: "POST",
      normalized_host: appState.normalized_host,
      path_and_query: "/c/xn--pokmon-dva/posts?draft=1",
      headers: new Headers(),
      body_bytes: bytes,
    });
    const request = {
      method: "POST",
      url: "https://worker.internal/c/xn--pokmon-dva/posts?draft=1",
      headers: envelope.headers,
      body_bytes: bytes,
    } as const;
    expect((await worker.verify(request)).nonce).toBe("nonce-1");
    await expect(worker.verify(request)).rejects.toMatchObject({ reason: "replayed" });
    const boundary = new Uint8Array(limits.max_body_bytes);
    await expect(
      gateway.sign({
        method: "POST",
        normalized_host: appState.normalized_host,
        path_and_query: "/c/xn--pokmon-dva/posts",
        headers: new Headers(),
        body_bytes: boundary,
      }),
    ).resolves.toMatchObject({ authority: { normalized_host: appState.normalized_host } });
    await expect(
      gateway.sign({
        method: "POST",
        normalized_host: appState.normalized_host,
        path_and_query: "/",
        headers: new Headers(),
        body_bytes: new Uint8Array(limits.max_body_bytes + 1),
      }),
    ).rejects.toBeInstanceOf(HnsForwarderFailure);
  });

  test("rejects unknown keys, future timestamps, and invalid nonce forms", async () => {
    const { gateway, worker } = harness(appState);
    const envelope = await gateway.sign({
      method: "GET",
      normalized_host: appState.normalized_host,
      path_and_query: "/c/xn--pokmon-dva",
      headers: new Headers(),
      body_bytes: new Uint8Array(),
    });
    const unknownKey = new Headers(envelope.headers);
    unknownKey.set("x-pirate-hns-forwarder-key-id", "unknown-key");
    await expect(
      worker.verify({
        method: "GET",
        url: "https://worker.internal/c/xn--pokmon-dva",
        headers: unknownKey,
        body_bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "invalid_signature" });
    const future = new Headers(envelope.headers);
    future.set("x-pirate-hns-forwarder-timestamp", String(now + 6));
    await expect(
      worker.verify({
        method: "GET",
        url: "https://worker.internal/c/xn--pokmon-dva",
        headers: future,
        body_bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "stale" });
    const safeNonce = new Headers(envelope.headers);
    safeNonce.set("x-pirate-hns-forwarder-nonce", "not-empty");
    await expect(
      worker.verify({
        method: "GET",
        url: "https://worker.internal/c/xn--pokmon-dva",
        headers: safeNonce,
        body_bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect(() =>
      makeHnsForwarderV3Gateway({
        authority_source: {
          resolve: (host) => Effect.succeed(host === appState.normalized_host ? appState : null),
        },
        key_registry: registry(),
        clock: { nowUnixSeconds: () => now },
        nonce_source: { next: () => "nonce\nwith-control" },
        limits,
      }),
    ).not.toThrow();
    const invalidNonceGateway = makeHnsForwarderV3Gateway({
      authority_source: {
        resolve: (host) => Effect.succeed(host === appState.normalized_host ? appState : null),
      },
      key_registry: registry(),
      clock: { nowUnixSeconds: () => now },
      nonce_source: { next: () => "nonce\nwith-control" },
      limits,
    });
    await expect(
      invalidNonceGateway.sign({
        method: "POST",
        normalized_host: appState.normalized_host,
        path_and_query: "/c/xn--pokmon-dva/posts",
        headers: new Headers(),
        body_bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "misconfigured" });
  });

  test("keeps the handle variant read-only, root-only, and session-free", async () => {
    const { gateway, worker } = harness(handleState);
    const clientHeaders = new Headers({
      Cookie: "session=must-not-cross",
      Authorization: "Bearer must-not-cross",
      "X-CSRF-Token": "must-not-cross",
    });
    const envelope = await gateway.sign({
      method: "HEAD",
      normalized_host: handleState.normalized_host,
      path_and_query: "/",
      headers: clientHeaders,
      body_bytes: new Uint8Array(),
    });
    expect(envelope.headers.has("cookie")).toBe(false);
    expect(envelope.headers.has("authorization")).toBe(false);
    expect(envelope.headers.has("x-csrf-token")).toBe(false);
    expect(
      (
        await worker.verify({
          method: "HEAD",
          url: "https://worker.internal/",
          headers: envelope.headers,
          body_bytes: new Uint8Array(),
        })
      ).state.variant,
    ).toBe("handle_persona_v1");
    await expect(
      gateway.sign({
        method: "POST",
        normalized_host: handleState.normalized_host,
        path_and_query: "/",
        headers: new Headers(),
        body_bytes: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "invalid_request" });
  });
});
