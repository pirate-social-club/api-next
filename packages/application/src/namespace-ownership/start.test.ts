import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Result } from "effect";
import {
  type NamespaceOwnershipProviderAdapter,
  type NamespaceOwnershipProviderStartResult,
  NamespaceOwnershipProviderUnavailable,
} from "./adapter.ts";
import { makeNamespaceOwnershipProviderRegistry } from "./registry.ts";
import {
  type NamespaceOwnershipStartAuthority,
  NamespaceOwnershipStartRejected,
  type NamespaceOwnershipStartReservationInput,
  type NamespaceOwnershipStartReservationOutcome,
  startNamespaceOwnership,
} from "./start.ts";

const authority: NamespaceOwnershipStartAuthority = {
  actor_id: "actor-1",
  creation_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  expected_revision: 3,
  requirement_hash: "a".repeat(64),
  generation: 1,
  provider_id: "hns.owner.v1",
  provider_binding_hash: "b".repeat(64),
  provider_configuration: { kind: "managed", reference: "hns-config", version: "1" },
  route: {
    family: "hns",
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
    href: "/c/app.jazleeuw",
    app_host: null,
  },
};

const manifest = {
  provider_id: "hns.owner.v1",
  manifest_version: "1",
  supported_families: ["hns" as const],
  protocol_versions: ["hns-txt-v1"],
  environments: ["test"],
  submission_channels: ["poll_result" as const],
  operation_deadlines: { plan_ms: 1_000, start_ms: 5_000, complete_ms: 5_000 },
} as const;

function provider(
  calls: { plan: number; start: number },
  events: string[] = [],
  failure: false | "plan" | "start" = false,
): NamespaceOwnershipProviderAdapter {
  return {
    manifest,
    plan: () => {
      events.push("plan");
      calls.plan += 1;
      if (failure === "plan") {
        return Effect.fail(
          new NamespaceOwnershipProviderUnavailable({
            provider_id: manifest.provider_id,
            operation: "plan",
          }),
        );
      }
      return Effect.succeed({
        status: "supported" as const,
        provider_configuration: authority.provider_configuration,
        protocol_version: "hns-txt-v1",
      });
    },
    start: (input) => {
      events.push("start");
      calls.start += 1;
      if (failure === "start") {
        return Effect.fail(
          new NamespaceOwnershipProviderUnavailable({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      const result: NamespaceOwnershipProviderStartResult = {
        session: {
          ...input,
          provider_id: manifest.provider_id,
          upstream_session_ref: "upstream-1",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
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
      return Effect.succeed(result);
    },
    complete: () => Effect.die("not used"),
  };
}

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) return undefined;
  const found = Cause.findError(exit.cause);
  return Result.isSuccess(found) ? found.success : undefined;
}

async function harness(
  options: {
    readonly reservation?: NamespaceOwnershipStartReservationOutcome;
    readonly replay?: import("./start.ts").NamespaceOwnershipStartReplayOutcome;
    readonly intent?: NamespaceOwnershipStartAuthority | null;
    readonly secondIntent?: NamespaceOwnershipStartAuthority | null;
    readonly failure?: "plan" | "start";
    readonly unavailableRegistry?: boolean;
  } = {},
) {
  const calls = { plan: 0, start: 0 };
  const events: string[] = [];
  const registry = await Effect.runPromise(
    makeNamespaceOwnershipProviderRegistry([provider(calls, events, options.failure)]),
  );
  let resolveCalls = 0;
  let releases = 0;
  let reservedTtlMs: number | null = null;
  const reservation = options.reservation ?? {
    kind: "acquired" as const,
    reservation: {
      reservation_id: "reservation-1",
      namespace_session_id: "namespace-session-1",
      expected_revision: authority.expected_revision,
      fence_token: 1,
      lease_expires_at: "2099-01-01T00:00:00.000Z",
    },
  };
  const startResult = provider({ plan: 0, start: 0 }).start(
    {
      actor_id: authority.actor_id,
      creation_intent_id: authority.creation_intent_id,
      ceremony_intent_id: authority.ceremony_intent_id,
      requirement_hash: authority.requirement_hash,
      generation: authority.generation,
      request_hash: "c".repeat(64),
      provider_binding_hash: authority.provider_binding_hash,
      provider_configuration: authority.provider_configuration,
      protocol_version: "hns-txt-v1",
      environment: "test",
      route: authority.route,
    },
    { namespace_session_id: "namespace-session-1" },
  );
  const started = await Effect.runPromise(startResult);
  return {
    calls,
    events,
    get releases() {
      return releases;
    },
    get reservedTtlMs() {
      return reservedTtlMs;
    },
    value: {
      environment: "test",
      intents: {
        resolve: () => {
          events.push("resolve");
          const value =
            resolveCalls++ === 0
              ? (options.intent ?? authority)
              : (options.secondIntent ?? authority);
          return Effect.succeed(value);
        },
      },
      registry: {
        list: registry.list,
        resolve: (family: Parameters<typeof registry.resolve>[0]) => {
          events.push("registry");
          if (options.unavailableRegistry) return Effect.die("registry must not resolve on replay");
          return registry.resolve(family);
        },
      },
      store: {
        replay: () => {
          events.push("replay");
          return Effect.succeed(options.replay ?? ({ kind: "none" } as const));
        },
        reserve: (input: NamespaceOwnershipStartReservationInput) => {
          events.push("reserve");
          reservedTtlMs = input.ttl_ms;
          return Effect.succeed(reservation);
        },
        finalize: (_reservation: unknown, start: NamespaceOwnershipProviderStartResult) => {
          events.push("finalize");
          return Effect.succeed({
            kind: "created" as const,
            namespace_session_id: "namespace-session-1",
            start,
          });
        },
        release: () => {
          events.push("release");
          releases += 1;
          return Effect.succeed(undefined);
        },
      },
    },
    started,
  };
}

describe("namespace ownership start use case", () => {
  test("plans, revalidates, and returns a redacted pending result", async () => {
    const h = await harness();
    const result = await Effect.runPromise(
      startNamespaceOwnership(
        {
          actor_id: authority.actor_id,
          creation_intent_id: authority.creation_intent_id,
          ceremony_intent_id: authority.ceremony_intent_id,
          expected_revision: authority.expected_revision,
          idempotency_key: "key-1",
        },
        h.value,
      ),
    );
    expect(result).toMatchObject({
      creation_intent_id: authority.creation_intent_id,
      ceremony_intent_id: authority.ceremony_intent_id,
      generation: 1,
      session_id: "namespace-session-1",
      channel: "poll_result",
      status: "pending",
      challenge: {
        ownership_source: "owner_authoritative_dns_txt",
        challenge_name: "_pirate.jazleeuw",
        challenge_value: "pirate-verification=upstream-1",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      replayed: false,
    });
    expect(result).not.toHaveProperty("provider_configuration");
    expect(result).not.toHaveProperty("presentation");
    expect(h.calls).toEqual({ plan: 1, start: 1 });
    expect(h.reservedTtlMs).toBe(7_000);
    expect(h.events).toEqual([
      "replay",
      "resolve",
      "registry",
      "reserve",
      "resolve",
      "plan",
      "start",
      "finalize",
    ]);
  });

  test("replays a pending target session without calling the provider", async () => {
    const h = await harness({
      unavailableRegistry: true,
      replay: {
        kind: "replay",
        namespace_session_id: "namespace-session-existing",
        start: {
          session: {
            actor_id: authority.actor_id,
            creation_intent_id: authority.creation_intent_id,
            ceremony_intent_id: authority.ceremony_intent_id,
            requirement_hash: authority.requirement_hash,
            generation: 1,
            request_hash: "c".repeat(64),
            provider_id: authority.provider_id,
            provider_binding_hash: authority.provider_binding_hash,
            provider_configuration: authority.provider_configuration,
            protocol_version: "hns-txt-v1",
            environment: "test",
            route: authority.route,
            upstream_session_ref: "upstream-existing",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
          presentation: {
            kind: "embedded_sdk",
            session_id: "upstream-existing",
            protocol: "hns-txt-challenge",
            version: "1",
            payload: {
              ownership_source: "owner_authoritative_dns_txt",
              challenge_name: "_pirate.jazleeuw",
              challenge_value: "pirate-verification=upstream-existing",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          },
        },
      },
    });
    const result = await Effect.runPromise(
      startNamespaceOwnership(
        {
          actor_id: authority.actor_id,
          creation_intent_id: authority.creation_intent_id,
          ceremony_intent_id: authority.ceremony_intent_id,
          expected_revision: authority.expected_revision,
          idempotency_key: "key-1",
        },
        h.value,
      ),
    );
    expect(result).toMatchObject({ session_id: "namespace-session-existing", replayed: true });
    expect(h.calls).toEqual({ plan: 0, start: 0 });
    expect(h.events).toEqual(["replay"]);
  });

  test("rejects a persisted replay whose public challenge contradicts its bound session", async () => {
    const h = await harness({
      unavailableRegistry: true,
      replay: {
        kind: "replay",
        namespace_session_id: "namespace-session-existing",
        start: {
          session: {
            ...authority,
            request_hash: "c".repeat(64),
            protocol_version: "hns-txt-v1",
            environment: "test",
            upstream_session_ref: "upstream-existing",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
          presentation: {
            kind: "embedded_sdk",
            session_id: "upstream-existing",
            protocol: "hns-txt-challenge",
            version: "1",
            payload: {
              ownership_source: "hns_parent_chain_txt",
              challenge_name: "_pirate.jazleeuw",
              challenge_value: "pirate-verification=upstream-existing",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          },
        },
      },
    });
    const exit = await Effect.runPromiseExit(
      startNamespaceOwnership(
        {
          actor_id: authority.actor_id,
          creation_intent_id: authority.creation_intent_id,
          ceremony_intent_id: authority.ceremony_intent_id,
          expected_revision: authority.expected_revision,
          idempotency_key: "key-1",
        },
        h.value,
      ),
    );
    expect(failureOf(exit)).toEqual(new NamespaceOwnershipStartRejected({ reason: "invalid" }));
    expect(h.calls).toEqual({ plan: 0, start: 0 });
    expect(h.events).toEqual(["replay"]);
  });

  test("rejects a stale revision before resolving or calling the provider", async () => {
    const h = await harness({ intent: { ...authority, expected_revision: 4 } });
    const exit = await Effect.runPromiseExit(
      startNamespaceOwnership(
        {
          actor_id: authority.actor_id,
          creation_intent_id: authority.creation_intent_id,
          ceremony_intent_id: authority.ceremony_intent_id,
          expected_revision: 3,
          idempotency_key: "key-stale",
        },
        h.value,
      ),
    );
    expect(failureOf(exit)).toEqual(
      new NamespaceOwnershipStartRejected({ reason: "intent_unavailable" }),
    );
    expect(h.calls).toEqual({ plan: 0, start: 0 });
  });

  test("does not call the provider when revalidation changes authority", async () => {
    const h = await harness({ secondIntent: { ...authority, generation: 2 } });
    const exit = await Effect.runPromiseExit(
      startNamespaceOwnership(
        {
          actor_id: authority.actor_id,
          creation_intent_id: authority.creation_intent_id,
          ceremony_intent_id: authority.ceremony_intent_id,
          expected_revision: authority.expected_revision,
          idempotency_key: "key-1",
        },
        h.value,
      ),
    );
    expect(failureOf(exit)).toEqual(
      new NamespaceOwnershipStartRejected({ reason: "intent_unavailable" }),
    );
    expect(h.calls.start).toBe(0);
    expect(h.releases).toBe(1);
  });

  test("releases the matching fence after provider failure", async () => {
    const h = await harness({ failure: "start" });
    await expect(
      Effect.runPromise(
        startNamespaceOwnership(
          {
            actor_id: authority.actor_id,
            creation_intent_id: authority.creation_intent_id,
            ceremony_intent_id: authority.ceremony_intent_id,
            expected_revision: authority.expected_revision,
            idempotency_key: "key-1",
          },
          h.value,
        ),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnavailable);
    expect(h.releases).toBe(1);
  });

  test("releases the reservation when provider planning fails", async () => {
    const h = await harness({ failure: "plan" });
    await expect(
      Effect.runPromise(
        startNamespaceOwnership(
          {
            actor_id: authority.actor_id,
            creation_intent_id: authority.creation_intent_id,
            ceremony_intent_id: authority.ceremony_intent_id,
            expected_revision: authority.expected_revision,
            idempotency_key: "key-plan-failure",
          },
          h.value,
        ),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnavailable);
    expect(h.releases).toBe(1);
    expect(h.calls).toEqual({ plan: 1, start: 0 });
    expect(h.events).toEqual([
      "replay",
      "resolve",
      "registry",
      "reserve",
      "resolve",
      "plan",
      "release",
    ]);
  });
});
