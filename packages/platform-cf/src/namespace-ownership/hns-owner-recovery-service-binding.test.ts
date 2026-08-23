import { describe, expect, test } from "bun:test";
import {
  buildHnsOwnerRecoveryProviderPoll,
  buildHnsOwnerRecoveryProviderStart,
  encodeHnsOwnerRecoveryProviderPollRequest,
  encodeHnsOwnerRecoveryProviderStart,
  finalizeHnsOwnerRecoveryProviderStart,
  type HnsOwnerRecoveryAuthorityV1,
  type HnsOwnerRecoveryPersistedSessionAuthority,
  hnsOwnerRecoveryPublicStartHash,
  hnsOwnerRecoveryRequirementHash,
} from "@pirate/application/route-revalidation";
import { Effect } from "effect";
import {
  HNS_OWNER_RECOVERY_POLL_DEADLINE_MS,
  HNS_OWNER_RECOVERY_START_DEADLINE_MS,
  makeHnsOwnerRecoveryServiceBindingProvider,
} from "./hns-owner-recovery-service-binding.ts";

const authority: HnsOwnerRecoveryAuthorityV1 = {
  actor_id: "user-1",
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 13,
  recovery_authority_kind: "database_time_expiry_transition",
  recovery_authority_reference: "route_lifecycle_transition_01",
  provider_id: "hns.owner.v1",
  provider_binding_hash: "4".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-observer-regtest",
    version: "hns-observer-config-v1",
    digest: "1".repeat(64),
  },
  protocol_version: "hns-owner-recovery-v1",
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
const startRequest = {
  expected_generation: 13,
  idempotency_key: "recovery-start-01",
} as const;

function startResponse(expiresAt = "2026-02-02T05:38:20.000Z") {
  return {
    upstream_session_ref: "nvs_recovery_01",
    expires_at: expiresAt,
    presentation: {
      kind: "embedded_sdk",
      session_id: "nvs_recovery_01",
      protocol: "hns-txt-challenge",
      version: "1",
      payload: {
        ownership_source: "hns_parent_chain_txt",
        challenge_name: "jazleeuw",
        challenge_value: "pirate-verification=nvs_recovery_01",
        expires_at: expiresAt,
      },
    },
  } as const;
}

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

function capturedBody(init: RequestInit | undefined): Uint8Array {
  if (!(init?.body instanceof Uint8Array)) throw new Error("expected exact request bytes");
  return init.body;
}

async function fixture() {
  const requirementHash = await hnsOwnerRecoveryRequirementHash(authority);
  const publicStartHash = await hnsOwnerRecoveryPublicStartHash({
    actor_id: authority.actor_id,
    community_id: authority.community_id,
    route_binding_id: authority.route_binding_id,
    expected_binding_generation: authority.expected_binding_generation,
    idempotency_key: startRequest.idempotency_key,
    requirement_hash: requirementHash,
  });
  const providerStart = await buildHnsOwnerRecoveryProviderStart({
    route_recovery_id: "hns_recovery_01",
    session_id: "hns_recovery_session_01",
    authority,
    database_started_at: "2026-02-02T04:38:20.000Z",
  });
  const finalized = await finalizeHnsOwnerRecoveryProviderStart({
    provider_start: providerStart,
    public_start_hash: publicStartHash,
    start_request: startRequest,
    started_at: "2026-02-02T04:38:20.000Z",
    provider_response: startResponse(),
  });
  const sessionAuthority: HnsOwnerRecoveryPersistedSessionAuthority = {
    expected_route_recovery_id: finalized.session.route_recovery_id,
    expected_session_id: finalized.session.session_id,
    start_idempotency_key: startRequest.idempotency_key,
    expected_public_start_hash: finalized.session.public_start_hash,
    expected_upstream_session_ref: finalized.session.upstream_session_ref,
    expected_ownership_source: finalized.session.ownership_source,
    expected_challenge_expires_at: finalized.session.challenge_expires_at,
  };
  return {
    providerStart,
    providerPoll: await buildHnsOwnerRecoveryProviderPoll(finalized.session, sessionAuthority),
  };
}

describe("HNS owner-recovery service-binding provider", () => {
  test("sends exact start bytes, bound identity, and the frozen deadline", async () => {
    const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
    const { providerStart } = await fixture();
    const provider = makeHnsOwnerRecoveryServiceBindingProvider({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response(JSON.stringify(startResponse()));
      },
    });
    await expect(
      Effect.runPromise(
        provider.start(providerStart, { deadline_ms: HNS_OWNER_RECOVERY_START_DEADLINE_MS }),
      ),
    ).resolves.toEqual(startResponse());
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://hns-owner.internal/internal/hns-owner/v1/start");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.headers).toEqual([
      ["Content-Type", "application/json"],
      ["Accept", "application/json"],
      ["Pirate-Namespace-Session-Id", providerStart.session_id],
    ]);
    expect([...capturedBody(calls[0]?.init)]).toEqual([
      ...(await encodeHnsOwnerRecoveryProviderStart(providerStart)),
    ]);
  });

  test("sends the canonical poll body and returns an owned exact byte snapshot", async () => {
    const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
    const { providerPoll } = await fixture();
    const providerBytes = new Uint8Array([0, 1, 2, 3]);
    const provider = makeHnsOwnerRecoveryServiceBindingProvider({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response(providerBytes, 200, "application/octet-stream");
      },
    });
    const received = await Effect.runPromise(
      provider.poll(providerPoll, { deadline_ms: HNS_OWNER_RECOVERY_POLL_DEADLINE_MS }),
    );
    expect(received).toEqual(providerBytes);
    expect(received).not.toBe(providerBytes);
    expect(String(calls[0]?.input)).toBe("https://hns-owner.internal/internal/hns-owner/v1/poll");
    expect(capturedHeaders(calls[0]?.init)).toEqual({
      "content-type": "application/json",
      accept: "application/octet-stream",
      "pirate-namespace-session-id": providerPoll.session.session_id,
    });
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect([...capturedBody(calls[0]?.init)]).toEqual([
      ...encodeHnsOwnerRecoveryProviderPollRequest(providerPoll),
    ]);
  });

  test("maps transport outages and private protocol rejection without retry or fallback", async () => {
    const { providerStart } = await fixture();
    for (const [status, reason] of [
      [429, "unavailable"],
      [503, "unavailable"],
      [400, "invalid_response"],
      [404, "invalid_response"],
      [409, "invalid_response"],
      [422, "invalid_response"],
      [301, "invalid_response"],
    ] as const) {
      let calls = 0;
      const provider = makeHnsOwnerRecoveryServiceBindingProvider({
        fetch: async () => {
          calls += 1;
          return response("failure", status);
        },
      });
      await expect(
        Effect.runPromise(
          provider.start(providerStart, { deadline_ms: HNS_OWNER_RECOVERY_START_DEADLINE_MS }),
        ),
      ).rejects.toMatchObject({ _tag: "HnsOwnerRecoveryProviderFailed", reason });
      expect(calls).toBe(1);
    }

    let networkCalls = 0;
    const unavailable = makeHnsOwnerRecoveryServiceBindingProvider({
      fetch: async () => {
        networkCalls += 1;
        throw new Error("private binding unavailable");
      },
    });
    await expect(
      Effect.runPromise(
        unavailable.start(providerStart, {
          deadline_ms: HNS_OWNER_RECOVERY_START_DEADLINE_MS,
        }),
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(networkCalls).toBe(1);
  });

  test("strictly rejects malformed start responses and wrong content types", async () => {
    const { providerStart } = await fixture();
    for (const providerResponse of [
      response(JSON.stringify(startResponse()), 200, "text/plain"),
      response(
        JSON.stringify({
          expires_at: startResponse().expires_at,
          upstream_session_ref: startResponse().upstream_session_ref,
          presentation: startResponse().presentation,
        }),
      ),
      response(JSON.stringify({ ...startResponse(), diagnostic: "private" })),
    ]) {
      const provider = makeHnsOwnerRecoveryServiceBindingProvider({
        fetch: async () => providerResponse,
      });
      await expect(
        Effect.runPromise(
          provider.start(providerStart, { deadline_ms: HNS_OWNER_RECOVERY_START_DEADLINE_MS }),
        ),
      ).rejects.toMatchObject({ reason: "invalid_response" });
    }
  });

  test("cancels a streamed response once the strict byte ceiling is crossed", async () => {
    const { providerStart } = await fixture();
    let cancelled = false;
    const provider = makeHnsOwnerRecoveryServiceBindingProvider({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(65_537));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      Effect.runPromise(
        provider.start(providerStart, { deadline_ms: HNS_OWNER_RECOVERY_START_DEADLINE_MS }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_response" });
    expect(cancelled).toBe(true);
  });

  test("refuses any caller-selected deadline before touching the binding", async () => {
    const { providerStart, providerPoll } = await fixture();
    let calls = 0;
    const provider = makeHnsOwnerRecoveryServiceBindingProvider({
      fetch: async () => {
        calls += 1;
        return response(JSON.stringify(startResponse()));
      },
    });
    await expect(
      Effect.runPromise(
        provider.start(providerStart, {
          deadline_ms: HNS_OWNER_RECOVERY_START_DEADLINE_MS - 1,
        }),
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    await expect(
      Effect.runPromise(
        provider.poll(providerPoll, {
          deadline_ms: HNS_OWNER_RECOVERY_POLL_DEADLINE_MS + 1,
        }),
      ),
    ).rejects.toMatchObject({ reason: "misconfigured" });
    expect(calls).toBe(0);
  });
});
