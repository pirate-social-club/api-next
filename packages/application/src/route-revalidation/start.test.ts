import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  HnsRouteRevalidationProviderFailed,
  type HnsRouteRevalidationProviderStartResult,
  type HnsRouteRevalidationSessionV1,
  type HnsRouteRevalidationStartReplayOutcome,
  type HnsRouteRevalidationStartServices,
  startHnsRouteRevalidation,
} from "./start.ts";

const input = {
  route_revalidation_id: "revalidation-1",
  revalidation_session_id: "session-1",
  community_id: "community-1",
  route_binding_id: "binding-1",
  expected_binding_generation: 1,
  expected_verified_evidence_ref: "evidence-1",
  provider_binding_hash: "b".repeat(64),
  provider_configuration: { kind: "managed" as const, reference: "hns-config", version: "1" },
  root_label: "jazleeuw",
  root_label_display: "jazleeuw",
  path_segment: "app.jazleeuw",
};

const providerResult: HnsRouteRevalidationProviderStartResult = {
  upstream_session_ref: "upstream-1",
  expires_at: "2099-01-01T00:00:00.000Z",
  presentation: {
    kind: "embedded_sdk",
    session_id: "upstream-1",
    protocol: "hns-txt-challenge",
    version: "1",
    payload: {
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.jazleeuw",
      challenge_value: "pirate-verification=upstream-1",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  },
};

function storedSession(): HnsRouteRevalidationSessionV1 {
  return {
    authority: {
      version: "pirate-hns-route-revalidation-authority-v1",
      route_revalidation_id: input.route_revalidation_id,
      community_id: input.community_id,
      route_binding_id: input.route_binding_id,
      principal_kind: "system",
      principal_id: "route-revalidation-scheduler",
      expected_binding_generation: input.expected_binding_generation,
      expected_verified_evidence_ref: input.expected_verified_evidence_ref,
      requirement_hash: "a".repeat(64),
      provider_id: "hns.owner.v1",
      provider_binding_hash: input.provider_binding_hash,
      provider_configuration_kind: input.provider_configuration.kind,
      provider_configuration_reference: input.provider_configuration.reference,
      provider_configuration_version: input.provider_configuration.version,
      protocol_version: "hns-txt-v1",
      environment: "test",
      family: "hns",
      root_label: input.root_label,
      root_label_display: input.root_label_display,
      path_segment: input.path_segment,
    },
    revalidation_session_id: input.revalidation_session_id,
    start_request_hash: "c".repeat(64),
    upstream_session_ref: providerResult.upstream_session_ref,
    start_presentation: providerResult.presentation,
    status: "pending",
    started_at: "2026-01-01T00:00:00.000Z",
    expires_at: providerResult.expires_at,
    terminal_at: null,
  };
}

function harness(
  options: Readonly<{
    readonly replay?: HnsRouteRevalidationStartReplayOutcome;
    readonly provider?: HnsRouteRevalidationProviderStartResult;
    readonly providerFailure?: boolean;
    readonly finalize?: "created" | "stale";
    readonly events?: string[];
  }> = {},
) {
  let providerCalls = 0;
  let releases = 0;
  const events = options.events ?? [];
  const store: HnsRouteRevalidationStartServices["store"] = {
    replay: () => {
      events.push("replay");
      return Effect.succeed(options.replay ?? { kind: "none" });
    },
    reserve: (value) => {
      events.push(`reserve:${value.start_request_hash.length}`);
      return Effect.succeed({
        kind: "acquired" as const,
        reservation: {
          route_revalidation_id: input.route_revalidation_id,
          revalidation_session_id: input.revalidation_session_id,
          fence_token: 1,
          lease_expires_at: "2099-01-01T00:00:06.000Z",
        },
      });
    },
    finalize: () => {
      events.push("finalize");
      return Effect.succeed(
        options.finalize === "stale"
          ? { kind: "stale" as const }
          : { kind: "created" as const, session: storedSession() },
      );
    },
    release: () => {
      events.push("release");
      releases += 1;
      return Effect.succeed(undefined);
    },
  };
  const services: HnsRouteRevalidationStartServices = {
    store,
    principal_id: "route-revalidation-scheduler",
    environment: "test",
    provider: {
      start: (wire) => {
        events.push(`provider:${wire.operation_kind}`);
        providerCalls += 1;
        return options.providerFailure === true
          ? Effect.fail(new HnsRouteRevalidationProviderFailed({ reason: "unavailable" }))
          : Effect.succeed(options.provider ?? providerResult);
      },
    },
  };
  return {
    services,
    events,
    get providerCalls() {
      return providerCalls;
    },
    get releases() {
      return releases;
    },
  };
}

describe("route revalidation start", () => {
  test("returns an exact durable replay without invoking the provider", async () => {
    const h = harness({ replay: { kind: "replay", session: storedSession() } });
    const result = await Effect.runPromise(startHnsRouteRevalidation(input, h.services));
    expect(result).toEqual({ session: storedSession(), replayed: true });
    expect(h.providerCalls).toBe(0);
  });

  test("calls the provider only after reservation and finalizes a strict presentation", async () => {
    const events: string[] = [];
    const h = harness({ events });
    const result = await Effect.runPromise(startHnsRouteRevalidation(input, h.services));
    expect(result.replayed).toBe(false);
    expect(events).toEqual(["replay", "reserve:64", "provider:route_revalidation", "finalize"]);
  });

  test("releases the matching fence on provider failure", async () => {
    const h = harness({ providerFailure: true });
    await expect(
      Effect.runPromise(startHnsRouteRevalidation(input, h.services)),
    ).rejects.toBeInstanceOf(HnsRouteRevalidationProviderFailed);
    expect(h.providerCalls).toBe(1);
    expect(h.releases).toBe(1);
  });

  test("releases malformed presentation and reports provider invalid response", async () => {
    const h = harness({
      provider: {
        ...providerResult,
        presentation: { ...providerResult.presentation, session_id: "wrong-session" },
      },
    });
    await expect(
      Effect.runPromise(startHnsRouteRevalidation(input, h.services)),
    ).rejects.toMatchObject({
      reason: "invalid_response",
    });
    expect(h.releases).toBe(1);
  });

  test("defers expiry liveness to the database-time finalizer", async () => {
    const events: string[] = [];
    const expiredAt = "2020-01-01T00:00:00.000Z";
    const h = harness({
      events,
      provider: {
        ...providerResult,
        expires_at: expiredAt,
        presentation: {
          ...providerResult.presentation,
          payload: { ...providerResult.presentation.payload, expires_at: expiredAt },
        },
      },
    });
    await Effect.runPromise(startHnsRouteRevalidation(input, h.services));
    expect(events).toEqual(["replay", "reserve:64", "provider:route_revalidation", "finalize"]);
  });

  test("does not turn a stale finalizer into a durable session", async () => {
    const h = harness({ finalize: "stale" });
    await expect(
      Effect.runPromise(startHnsRouteRevalidation(input, h.services)),
    ).rejects.toMatchObject({
      reason: "stale",
    });
    expect(h.providerCalls).toBe(1);
    expect(h.releases).toBe(0);
  });

  test("accepts the frozen upstream-session and evidence-reference byte ceilings", async () => {
    const upstream = "u".repeat(16_384);
    const evidence = "e".repeat(512);
    const h = harness({
      provider: {
        upstream_session_ref: upstream,
        expires_at: providerResult.expires_at,
        presentation: {
          ...providerResult.presentation,
          session_id: upstream,
          payload: {
            ...providerResult.presentation.payload,
            challenge_value: `pirate-verification=${upstream}`,
          },
        },
      },
    });
    const result = await Effect.runPromise(
      startHnsRouteRevalidation({ ...input, expected_verified_evidence_ref: evidence }, h.services),
    );
    expect(result.replayed).toBe(false);
    expect(h.providerCalls).toBe(1);
  });

  test("rejects values one byte beyond the frozen reference ceilings", async () => {
    const oversizedEvidence = harness();
    await expect(
      Effect.runPromise(
        startHnsRouteRevalidation(
          { ...input, expected_verified_evidence_ref: "e".repeat(513) },
          oversizedEvidence.services,
        ),
      ),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(oversizedEvidence.providerCalls).toBe(0);

    const upstream = "u".repeat(16_385);
    const oversizedUpstream = harness({
      provider: {
        upstream_session_ref: upstream,
        expires_at: providerResult.expires_at,
        presentation: {
          ...providerResult.presentation,
          session_id: upstream,
          payload: {
            ...providerResult.presentation.payload,
            challenge_value: `pirate-verification=${upstream}`,
          },
        },
      },
    });
    await expect(
      Effect.runPromise(startHnsRouteRevalidation(input, oversizedUpstream.services)),
    ).rejects.toMatchObject({ reason: "invalid_response" });
    expect(oversizedUpstream.releases).toBe(1);
  });
});
