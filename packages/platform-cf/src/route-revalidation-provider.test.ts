import { describe, expect, test } from "bun:test";
import { NamespaceOwnershipProviderUnavailable } from "@pirate/application/namespace-ownership";
import type { HnsRouteRevalidationSessionV1 } from "@pirate/application/route-revalidation";
import type { HnsOwnerRouteRevalidationStartWireV1 } from "@pirate/application/route-revalidation/hashes";
import { HnsRouteRevalidationProviderFailed } from "@pirate/application/route-revalidation/start";
import { Effect } from "effect";
import { makeHnsRouteRevalidationProvider } from "./route-revalidation-provider";

const wire: HnsOwnerRouteRevalidationStartWireV1 = {
  operation_kind: "route_revalidation",
  route_revalidation_id: "route-revalidation-1",
  revalidation_session_id: "revalidation-session-1",
  community_id: "community-1",
  route_binding_id: "binding-1",
  expected_binding_generation: 1,
  expected_verified_evidence_ref: "evidence-1",
  principal_kind: "system",
  principal_id: "route-revalidation-scheduler",
  requirement_hash: "a".repeat(64),
  start_request_hash: "b".repeat(64),
  provider_binding_hash: "c".repeat(64),
  provider_configuration: { kind: "managed", reference: "hns-owner", version: "1" },
  protocol_version: "hns-txt-v1",
  environment: "test",
  route: {
    family: "hns",
    root_label: "example_root",
    root_label_display: "example_root",
    path_segment: "app.example_root",
    href: "/c/app.example_root",
    app_host: null,
  },
};

const response = {
  upstream_session_ref: "upstream-session-1",
  expires_at: "2099-08-21T00:00:00.000Z",
  presentation: {
    kind: "embedded_sdk" as const,
    session_id: "upstream-session-1",
    protocol: "hns-txt-challenge" as const,
    version: "1" as const,
    payload: {
      ownership_source: "owner_authoritative_dns_txt" as const,
      challenge_name: "_pirate.example_root",
      challenge_value: "pirate-verification=upstream-session-1",
      expires_at: "2099-08-21T00:00:00.000Z",
    },
  },
};
const revalidationSession: HnsRouteRevalidationSessionV1 = {
  authority: {
    version: "pirate-hns-route-revalidation-authority-v1",
    route_revalidation_id: wire.route_revalidation_id,
    community_id: wire.community_id,
    route_binding_id: wire.route_binding_id,
    principal_kind: "system",
    principal_id: wire.principal_id,
    expected_binding_generation: wire.expected_binding_generation,
    expected_verified_evidence_ref: wire.expected_verified_evidence_ref,
    requirement_hash: wire.requirement_hash,
    provider_id: "hns.owner.v1",
    provider_binding_hash: wire.provider_binding_hash,
    provider_configuration_kind: wire.provider_configuration.kind,
    provider_configuration_reference: wire.provider_configuration.reference,
    provider_configuration_version: wire.provider_configuration.version,
    protocol_version: wire.protocol_version,
    environment: wire.environment,
    family: "hns",
    root_label: wire.route.root_label,
    root_label_display: wire.route.root_label_display,
    path_segment: wire.route.path_segment,
  },
  revalidation_session_id: wire.revalidation_session_id,
  start_request_hash: wire.start_request_hash,
  upstream_session_ref: "upstream-session-1",
  start_presentation: response.presentation,
  status: "pending",
  started_at: "2026-08-21T00:00:00.000Z",
  expires_at: "2099-08-21T00:00:00.000Z",
  terminal_at: null,
};
const verifiedPollResponse = {
  status: "verified" as const,
  observation: {
    ownership_source: "owner_authoritative_dns_txt" as const,
    challenge_name: "_pirate.example_root",
    challenge_value: "pirate-verification=upstream-session-1",
    root_exists: true as const,
    root_control_verified: true as const,
    expiry_horizon_sufficient: true as const,
    chain_network: "main",
    chain_anchor_height: 10,
    chain_anchor_block_hash: "1".repeat(64),
    chain_anchor_median_time: 9,
    expiry_height: 20,
    observed_at: "2099-08-20T00:00:00.000Z",
    expires_at: "2099-08-21T00:00:00.000Z",
    provider_evidence_ref: "provider-evidence-1",
  },
};

function providerFor(
  value: unknown,
  pollValue: unknown = { status: "pending" },
): ReturnType<typeof makeHnsRouteRevalidationProvider> {
  return makeHnsRouteRevalidationProvider({
    transport: {
      start: () => Effect.succeed(new TextEncoder().encode(JSON.stringify(value))),
      complete: () => Effect.succeed(new TextEncoder().encode(JSON.stringify(pollValue))),
    },
  });
}

describe("HNS route-revalidation provider adapter", () => {
  test("strict-decodes the creation-free start response", async () => {
    const provider = providerFor(response);
    await expect(Effect.runPromise(provider.start(wire))).resolves.toEqual(response);
  });

  test("rejects malformed or excess response members", async () => {
    const provider = providerFor({ ...response, unexpected: true });
    await expect(Effect.runPromise(provider.start(wire))).rejects.toMatchObject({
      _tag: "HnsRouteRevalidationProviderFailed",
      reason: "invalid_response",
    });
  });

  test("maps low-level transport failure without calling a fallback", async () => {
    const provider = makeHnsRouteRevalidationProvider({
      transport: {
        start: () =>
          Effect.fail(
            new NamespaceOwnershipProviderUnavailable({
              provider_id: "hns.owner.v1",
              operation: "start",
            }),
          ),
        complete: () => Effect.succeed(new Uint8Array()),
      },
    });
    await expect(Effect.runPromise(provider.start(wire))).rejects.toBeInstanceOf(
      HnsRouteRevalidationProviderFailed,
    );
    await expect(Effect.runPromise(provider.start(wire))).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  test("strict-decodes pending and verified poll results while retaining exact bytes", async () => {
    const provider = providerFor(response, verifiedPollResponse);
    await expect(
      Effect.runPromise(provider.complete({ session: revalidationSession })),
    ).resolves.toMatchObject({
      status: "verified",
      observation: verifiedPollResponse.observation,
      raw_response_bytes: new TextEncoder().encode(JSON.stringify(verifiedPollResponse)),
    });
    const pending = providerFor(response, { status: "pending" });
    await expect(
      Effect.runPromise(pending.complete({ session: revalidationSession })),
    ).resolves.toEqual({ status: "pending" });
  });

  test("rejects semantic challenge mismatch and malformed poll output", async () => {
    const mismatch = providerFor(response, {
      ...verifiedPollResponse,
      observation: { ...verifiedPollResponse.observation, challenge_value: "wrong" },
    });
    await expect(
      Effect.runPromise(mismatch.complete({ session: revalidationSession })),
    ).rejects.toMatchObject({
      _tag: "HnsRouteRevalidationProviderFailed",
      reason: "observation_rejected",
    });
    const malformed = providerFor(response, { status: "pending", extra: true });
    await expect(
      Effect.runPromise(malformed.complete({ session: revalidationSession })),
    ).rejects.toMatchObject({
      _tag: "HnsRouteRevalidationProviderFailed",
      reason: "invalid_response",
    });
  });
});
