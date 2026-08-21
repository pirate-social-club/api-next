import { describe, expect, test } from "bun:test";
import { NamespaceOwnershipProviderUnavailable } from "@pirate/application/namespace-ownership";
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

function providerFor(value: unknown): ReturnType<typeof makeHnsRouteRevalidationProvider> {
  return makeHnsRouteRevalidationProvider({
    transport: {
      start: () => Effect.succeed(new TextEncoder().encode(JSON.stringify(value))),
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
      },
    });
    await expect(Effect.runPromise(provider.start(wire))).rejects.toBeInstanceOf(
      HnsRouteRevalidationProviderFailed,
    );
    await expect(Effect.runPromise(provider.start(wire))).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
});
