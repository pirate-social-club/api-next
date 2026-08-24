import { describe, expect, test } from "bun:test";
import {
  encodeHnsActiveLeaseRenewalRequest,
  type HnsActiveLeaseRenewalAuthorityV1,
  type HnsOwnerActiveLeaseRenewalRequestV1,
  hnsActiveLeaseRenewalRequestHash,
  hnsActiveLeaseRenewalRequirementHash,
} from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import {
  HNS_OWNER_ACTIVE_LEASE_RENEWAL_DEADLINE_MS,
  makeHnsOwnerActiveLeaseRenewalServiceBindingProvider,
} from "./hns-owner-active-lease-renewal-service-binding.ts";

const authority: HnsActiveLeaseRenewalAuthorityV1 = {
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 12,
  expected_verified_evidence_ref: "route_evidence_12",
  expected_evidence_digest: "a".repeat(64),
  expected_control_identity_digest:
    "bad01043ba07ebaceef26497266b269d966c72f8f0b14bac44c9b7d44922f236",
  expected_chain_authority_digest:
    "6c176a02ca14aedd62328e805389409a1f4b520b97bb90c2e7f90b47d43557d6",
  prior_provider_evidence_ref:
    "hns-observer-v1:sha256:7d531a8cbb5f778c7394dc734ba61790d34872373f8dcf3b98e46d1187cead5e:hns-observer:regtest:01",
  principal_id: "hns-route-renewal-scheduler",
  provider_id: "hns.owner.v1",
  provider_binding_hash: "4".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-observer-regtest",
    version: "hns-observer-config-v1",
    digest: "1".repeat(64),
  },
  protocol_version: "hns-active-lease-renewal-v1",
  environment: "test",
  route: {
    family: "hns",
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
    href: "/c/app.jazleeuw",
    app_host: null,
  },
};

async function renewalRequest(): Promise<HnsOwnerActiveLeaseRenewalRequestV1> {
  const value = {
    version: "pirate-hns-active-lease-renewal-request-v1" as const,
    operation_kind: "active_lease_renewal" as const,
    active_lease_renewal_id: "hns_renewal_01",
    active_lease_renewal_attempt_id: "hns_renewal_attempt_01",
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    expected_verified_evidence_ref: authority.expected_verified_evidence_ref,
    expected_evidence_digest: authority.expected_evidence_digest,
    expected_control_identity_digest: authority.expected_control_identity_digest,
    expected_chain_authority_digest: authority.expected_chain_authority_digest,
    prior_provider_evidence_ref: authority.prior_provider_evidence_ref,
    attempt_number: 1,
    evidence_ref: "route_evidence_13",
    requirement_hash: await hnsActiveLeaseRenewalRequirementHash(authority),
    request_hash: "0".repeat(64),
    provider_id: authority.provider_id,
    provider_binding_hash: authority.provider_binding_hash,
    provider_configuration: authority.provider_configuration,
    protocol_version: authority.protocol_version,
    environment: authority.environment,
    route: authority.route,
  };
  return { ...value, request_hash: await hnsActiveLeaseRenewalRequestHash(value) };
}

function response(
  body: string | Uint8Array,
  status = 200,
  contentType = "application/octet-stream",
): Response {
  const responseBody =
    typeof body === "string"
      ? body
      : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  return new Response(responseBody, { status, headers: { "content-type": contentType } });
}

describe("HNS active-renewal service-binding provider", () => {
  test("sends one exact bound request and returns owned response bytes", async () => {
    const request = await renewalRequest();
    const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
    const expectedResponse = new Uint8Array([1, 2, 3]);
    const provider = makeHnsOwnerActiveLeaseRenewalServiceBindingProvider({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response(expectedResponse);
      },
    });
    const received = await Effect.runPromise(
      provider.renew(request, authority, {
        deadline_ms: HNS_OWNER_ACTIVE_LEASE_RENEWAL_DEADLINE_MS,
        observation_id: "observer-renewal-01",
      }),
    );
    expect(received).toEqual(expectedResponse);
    expect(received).not.toBe(expectedResponse);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(
      "https://hns-owner.internal/internal/hns-owner/v1/active-lease-renewal",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.headers).toEqual([
      ["Content-Type", "application/json"],
      ["Accept", "application/octet-stream"],
      ["Pirate-HNS-Active-Lease-Renewal-Id", request.active_lease_renewal_id],
      ["Pirate-HNS-Observation-Id", "observer-renewal-01"],
    ]);
    expect(calls[0]?.init?.body).toEqual(
      await encodeHnsActiveLeaseRenewalRequest(request, authority),
    );
  });

  test("maps only the exact ineligibility error and never retries", async () => {
    const request = await renewalRequest();
    for (const [body, reason] of [
      ['{"error":"renewal_evidence_ineligible"}', "renewal_evidence_ineligible"],
      ['{"error":"renewal_evidence_ineligible"}\n', "invalid_response"],
      ['{"error":"other"}', "invalid_response"],
    ] as const) {
      let calls = 0;
      const provider = makeHnsOwnerActiveLeaseRenewalServiceBindingProvider({
        fetch: async () => {
          calls += 1;
          return response(body, 409, "application/json");
        },
      });
      await expect(
        Effect.runPromise(
          provider.renew(request, authority, {
            deadline_ms: HNS_OWNER_ACTIVE_LEASE_RENEWAL_DEADLINE_MS,
            observation_id: "observer-renewal-01",
          }),
        ),
      ).rejects.toMatchObject({ reason });
      expect(calls).toBe(1);
    }
  });

  test("maps outages, malformed responses, and invalid local authority fail closed", async () => {
    const request = await renewalRequest();
    for (const [status, reason] of [
      [429, "unavailable"],
      [503, "unavailable"],
      [400, "invalid_response"],
      [404, "invalid_response"],
      [422, "invalid_response"],
      [301, "invalid_response"],
    ] as const) {
      let calls = 0;
      const provider = makeHnsOwnerActiveLeaseRenewalServiceBindingProvider({
        fetch: async () => {
          calls += 1;
          return response("failure", status);
        },
      });
      await expect(
        Effect.runPromise(
          provider.renew(request, authority, {
            deadline_ms: HNS_OWNER_ACTIVE_LEASE_RENEWAL_DEADLINE_MS,
            observation_id: "observer-renewal-01",
          }),
        ),
      ).rejects.toMatchObject({ reason });
      expect(calls).toBe(1);
    }

    let calls = 0;
    const provider = makeHnsOwnerActiveLeaseRenewalServiceBindingProvider({
      fetch: async () => {
        calls += 1;
        return response(new Uint8Array([1]));
      },
    });
    await expect(
      Effect.runPromise(
        provider.renew(request, authority, {
          deadline_ms: 11_999,
          observation_id: "observer-renewal-01",
        }),
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    expect(calls).toBe(0);
  });
});
