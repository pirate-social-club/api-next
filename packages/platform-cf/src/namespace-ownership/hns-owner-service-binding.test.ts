import { describe, expect, test } from "bun:test";
import {
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderRejected,
  NamespaceOwnershipProviderUnavailable,
} from "@pirate/application";
import type { HnsOwnerRouteRevalidationStartWireV1 } from "@pirate/application/route-revalidation/hashes";
import { Effect } from "effect";
import {
  makeHnsOwnerRouteRevalidationTransport,
  makeHnsOwnerServiceBindingTransport,
} from "./hns-owner-service-binding.ts";

const input = {
  actor_id: "user-1",
  creation_intent_id: "creation-1",
  ceremony_intent_id: "ceremony-1",
  requirement_hash: "1".repeat(64),
  generation: 1,
  request_hash: "2".repeat(64),
  provider_binding_hash: "3".repeat(64),
  provider_configuration: {
    kind: "managed" as const,
    reference: "hns-owner-staging",
    version: "1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route: {
    family: "hns" as const,
    root_label: "xn--pokmon-dva",
    root_label_display: "pokémon",
    path_segment: "app.xn--pokmon-dva",
    href: "/c/app.xn--pokmon-dva",
    app_host: null,
  },
};
const context = { namespace_session_id: "namespace-session-1" };
const startDocument = {
  upstream_session_ref: "upstream-1",
  expires_at: "2026-08-22T00:00:00.000Z",
  presentation: {
    kind: "embedded_sdk",
    session_id: "upstream-1",
    protocol: "hns-txt-challenge",
    version: "1",
    payload: {
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.xn--pokmon-dva",
      challenge_value: "pirate-verification=upstream-1",
      expires_at: "2026-08-22T00:00:00.000Z",
    },
  },
};
const session = {
  ...input,
  provider_id: "hns.owner.v1",
  upstream_session_ref: "upstream-1",
  expires_at: "2026-08-22T00:00:00.000Z",
};

const routeWire: HnsOwnerRouteRevalidationStartWireV1 = {
  operation_kind: "route_revalidation",
  route_revalidation_id: "route-revalidation-1",
  revalidation_session_id: "revalidation-session-1",
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 7,
  expected_verified_evidence_ref: "evidence-6",
  principal_kind: "system",
  principal_id: "route-revalidation-scheduler",
  requirement_hash: "4".repeat(64),
  start_request_hash: "5".repeat(64),
  provider_binding_hash: "6".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route: {
    family: "hns",
    root_label: "xn--pokmon-dva",
    root_label_display: "pokémon",
    path_segment: "app.xn--pokmon-dva",
    href: "/c/app.xn--pokmon-dva",
    app_host: null,
  },
};

function response(
  body: string | Uint8Array,
  status = 200,
  contentType = "application/json",
): Response {
  const responseBody =
    typeof body === "string"
      ? body
      : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  return new Response(responseBody, { status, headers: { "content-type": contentType } });
}

function capturedHeaders(init: RequestInit | undefined): Readonly<Record<string, string>> {
  if (!Array.isArray(init?.headers)) throw new Error("expected ordered request headers");
  return Object.fromEntries(
    (init.headers as readonly (readonly [string, string])[]).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
}

describe("HNS owner service-binding transport", () => {
  test("sends exact internal start request bytes and correlation header", async () => {
    const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
    const bytes = new TextEncoder().encode(JSON.stringify(startDocument));
    const transport = makeHnsOwnerServiceBindingTransport({
      fetch: async (request, init) => {
        calls.push({ input: request, init });
        return response(bytes);
      },
    });

    await expect(Effect.runPromise(transport.start({ input, context }))).resolves.toEqual(bytes);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://hns-owner.internal/internal/hns-owner/v1/start");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.headers).toEqual([
      ["Content-Type", "application/json"],
      ["Accept", "application/json"],
      ["Pirate-Namespace-Session-Id", "namespace-session-1"],
    ]);
    const headers = capturedHeaders(calls[0]?.init);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.accept).toBe("application/json");
    expect(headers["pirate-namespace-session-id"]).toBe("namespace-session-1");
    expect(new TextDecoder().decode(calls[0]?.init?.body as Uint8Array)).toBe(
      JSON.stringify(input),
    );
  });

  test("uses persisted target correlation for poll and preserves exact bytes", async () => {
    const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const transport = makeHnsOwnerServiceBindingTransport({
      fetch: async (request, init) => {
        calls.push({ input: request, init });
        return response(bytes, 200, "application/octet-stream");
      },
    });
    await expect(
      Effect.runPromise(transport.poll({ session, payload: {}, context })),
    ).resolves.toEqual(bytes);
    expect(String(calls[0]?.input)).toBe("https://hns-owner.internal/internal/hns-owner/v1/poll");
    const headers = capturedHeaders(calls[0]?.init);
    expect(headers.accept).toBe("application/octet-stream");
    expect(headers["pirate-namespace-session-id"]).toBe("namespace-session-1");
    expect(new TextDecoder().decode(calls[0]?.init?.body as Uint8Array)).toBe(
      JSON.stringify({ session, payload: {} }),
    );
  });

  test("maps retryable, bound-rejection, and malformed responses without fallback", async () => {
    for (const [status, expected] of [
      [429, NamespaceOwnershipProviderUnavailable],
      [503, NamespaceOwnershipProviderUnavailable],
      [409, NamespaceOwnershipProviderRejected],
    ] as const) {
      const transport = makeHnsOwnerServiceBindingTransport({
        fetch: async () => response("failure", status),
      });
      await expect(Effect.runPromise(transport.start({ input, context }))).rejects.toBeInstanceOf(
        expected,
      );
    }

    const wrongType = makeHnsOwnerServiceBindingTransport({
      fetch: async () => response(JSON.stringify(startDocument), 200, "text/plain"),
    });
    await expect(Effect.runPromise(wrongType.start({ input, context }))).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderInvalidResponse,
    );

    const oversized = makeHnsOwnerServiceBindingTransport({
      fetch: async () =>
        new Response("x", {
          headers: { "content-type": "application/json", "content-length": "65537" },
        }),
    });
    await expect(Effect.runPromise(oversized.start({ input, context }))).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderInvalidResponse,
    );

    let cancelled = false;
    const rejectedStream = makeHnsOwnerServiceBindingTransport({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      Effect.runPromise(rejectedStream.start({ input, context })),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnavailable);
    expect(cancelled).toBe(true);
  });

  test("sends route START bytes in frozen order with the persisted session header", async () => {
    const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
    const bytes = new TextEncoder().encode(JSON.stringify(startDocument));
    const transport = makeHnsOwnerRouteRevalidationTransport({
      fetch: async (request, init) => {
        calls.push({ input: request, init });
        return response(bytes);
      },
    });

    await expect(
      Effect.runPromise(
        transport.start({ wire: routeWire, revalidation_session_id: "persisted-session-7" }),
      ),
    ).resolves.toEqual(bytes);
    expect(String(calls[0]?.input)).toBe("https://hns-owner.internal/internal/hns-owner/v1/start");
    expect(calls[0]?.init?.headers).toEqual([
      ["Content-Type", "application/json"],
      ["Accept", "application/json"],
      ["Pirate-Namespace-Session-Id", "persisted-session-7"],
    ]);
    expect(new TextDecoder().decode(calls[0]?.init?.body as Uint8Array)).toBe(
      JSON.stringify({
        operation_kind: routeWire.operation_kind,
        route_revalidation_id: routeWire.route_revalidation_id,
        revalidation_session_id: routeWire.revalidation_session_id,
        community_id: routeWire.community_id,
        route_binding_id: routeWire.route_binding_id,
        expected_binding_generation: routeWire.expected_binding_generation,
        expected_verified_evidence_ref: routeWire.expected_verified_evidence_ref,
        principal_kind: routeWire.principal_kind,
        principal_id: routeWire.principal_id,
        requirement_hash: routeWire.requirement_hash,
        start_request_hash: routeWire.start_request_hash,
        provider_binding_hash: routeWire.provider_binding_hash,
        provider_configuration: routeWire.provider_configuration,
        protocol_version: routeWire.protocol_version,
        environment: routeWire.environment,
        route: routeWire.route,
      }),
    );
  });

  test("accepts the bounded 200 JSON START response", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(startDocument));
    const transport = makeHnsOwnerRouteRevalidationTransport({
      fetch: async () => response(bytes, 200, "application/json"),
    });
    await expect(
      Effect.runPromise(
        transport.start({
          wire: routeWire,
          revalidation_session_id: routeWire.revalidation_session_id,
        }),
      ),
    ).resolves.toEqual(bytes);
  });

  test("rejects a streamed START response over the byte ceiling", async () => {
    const transport = makeHnsOwnerRouteRevalidationTransport({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65_537));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      Effect.runPromise(
        transport.start({
          wire: routeWire,
          revalidation_session_id: routeWire.revalidation_session_id,
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
  });

  test("maps redirects to invalid response and guarded transport failures to unavailable", async () => {
    const redirect = makeHnsOwnerRouteRevalidationTransport({
      fetch: async () => response("redirect", 302),
    });
    await expect(
      Effect.runPromise(
        redirect.start({
          wire: routeWire,
          revalidation_session_id: routeWire.revalidation_session_id,
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);

    let guarded = false;
    const unavailable = makeHnsOwnerRouteRevalidationTransport({
      fetch: async (_request, init) => {
        guarded = init?.signal instanceof AbortSignal;
        throw new Error("transport unavailable");
      },
    });
    await expect(
      Effect.runPromise(
        unavailable.start({
          wire: routeWire,
          revalidation_session_id: routeWire.revalidation_session_id,
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnavailable);
    expect(guarded).toBe(true);
  });
});
