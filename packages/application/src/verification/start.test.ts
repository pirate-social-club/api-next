import { describe, expect, test } from "bun:test";
import type { ProofProviderManifest, ProofSession } from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result } from "effect";
import type {
  ProviderSessionStart,
  VerificationProviderAdapter,
  VerificationProviderPlanResult,
} from "./adapter.ts";
import { VerificationProviderUnavailable } from "./adapter.ts";
import { makeVerificationProviderRegistry } from "./registry.ts";
import {
  startVerification,
  type VerificationSessionStartFinalizeOutcome,
  type VerificationSessionStartReservationInput,
  type VerificationSessionStartReservationOutcome,
  VerificationStartRejected,
} from "./start.ts";

const REGISTRY_OPTIONS = { now: () => Date.parse("2026-08-17T00:00:00.000Z") } as const;

const MANIFEST: ProofProviderManifest = {
  provider_id: "test.provider",
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: ["test-v1"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid"],
  claim_capabilities: [{ claim_id: "document.valid", request_modes: ["dynamic"] }],
  presentation_kinds: ["redirect"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "none",
};

const PLAN_INPUT = {
  method: "document",
  scope: { kind: "none" as const, issuer: MANIFEST.provider_id },
  requested_requirements: [{ claim_id: "document.valid" as const }],
  requested_claim_ids: ["document.valid" as const],
  subject_binding_intent: "none" as const,
  protocol_version: "test-v1",
  environment: "test",
};

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

function adapter(
  plan: VerificationProviderPlanResult = {
    status: "supported",
    request_mode: "dynamic",
    provider_configuration: { kind: "dynamic", reference: "test-query", version: "1" },
  },
  startFailure?: "unavailable",
  startCalls?: { value: number },
): VerificationProviderAdapter {
  return {
    manifest: MANIFEST,
    plan: () => Effect.succeed(plan),
    start: (input) => {
      if (startCalls !== undefined) startCalls.value += 1;
      if (startFailure === "unavailable") {
        return Effect.fail(
          new VerificationProviderUnavailable({
            provider_id: MANIFEST.provider_id,
            operation: "start",
          }),
        );
      }
      const session: ProofSession = {
        id: "proof-session-1",
        actor_id: input.actor_id,
        intent_id: input.intent_id,
        request_hash: input.request_hash,
        provider_id: MANIFEST.provider_id,
        upstream_session_ref: "provider-session-1",
        provider_configuration: input.provider_configuration,
        method: input.method,
        scope: input.scope,
        request_mode: input.request_mode,
        requested_requirements: input.requested_requirements,
        requested_claim_ids: input.requested_claim_ids,
        subject_binding_intent: input.subject_binding_intent,
        protocol_version: input.protocol_version,
        environment: input.environment,
        status: "pending",
        started_at: "2026-08-17T00:00:00.000Z",
        expires_at: "2099-08-17T00:00:00.000Z",
      };
      return Effect.succeed({
        session,
        presentation: {
          kind: "redirect",
          session_id: session.id,
          url: "https://provider.test/verify",
        },
      });
    },
    complete: () => Effect.die("complete is outside this use case"),
  };
}

async function services(input: {
  readonly plan?: VerificationProviderPlanResult;
  readonly intent?: unknown;
  readonly intentResolutions?: readonly unknown[];
  readonly commit?: Exclude<VerificationSessionStartFinalizeOutcome["kind"], "created" | "stale">;
  readonly finalize?: Exclude<
    VerificationSessionStartFinalizeOutcome["kind"],
    "created" | "replay"
  >;
  readonly reservation?: VerificationSessionStartReservationOutcome;
  readonly startFailure?: "unavailable";
  readonly startCalls?: { value: number };
}) {
  const registry = await Effect.runPromise(
    makeVerificationProviderRegistry(
      [adapter(input.plan, input.startFailure, input.startCalls)],
      REGISTRY_OPTIONS,
    ),
  );
  const commits: ProviderSessionStart[] = [];
  const reservations: VerificationSessionStartReservationInput[] = [];
  let releases = 0;
  let resolveCalls = 0;
  return {
    commits,
    reservations,
    get resolveCalls() {
      return resolveCalls;
    },
    get releases() {
      return releases;
    },
    value: {
      registry,
      intents: {
        resolve: () => {
          const resolution =
            input.intentResolutions !== undefined && resolveCalls < input.intentResolutions.length
              ? input.intentResolutions[resolveCalls]
              : Object.hasOwn(input, "intent")
                ? input.intent
                : PLAN_INPUT;
          resolveCalls += 1;
          return Effect.succeed(resolution);
        },
      },
      store: {
        reserve: (reservationInput: VerificationSessionStartReservationInput) => {
          reservations.push(reservationInput);
          if (input.reservation !== undefined) return Effect.succeed(input.reservation);
          return Effect.succeed(
            input.commit === "conflict"
              ? ({ kind: "conflict" } as const)
              : ({
                  kind: "acquired",
                  reservation: {
                    reservation_id: "reservation-1",
                    fence_token: 1,
                    lease_expires_at: "2099-08-17T00:00:00.000Z",
                  },
                } as const),
          );
        },
        finalize: (_reservation: unknown, start: ProviderSessionStart) => {
          commits.push(start);
          if (input.finalize !== undefined)
            return Effect.succeed({ kind: input.finalize } as const);
          return Effect.succeed({
            kind: input.commit === "replay" ? "replay" : "created",
            start,
          } as const);
        },
        release: () => {
          releases += 1;
          return Effect.succeed(undefined);
        },
      },
    },
  };
}

describe("verification start use case", () => {
  test("binds a creation start to the server-owned ceremony authority", async () => {
    const harness = await services({});
    await Effect.runPromise(
      startVerification(
        {
          actor_id: "user-1",
          provider_id: MANIFEST.provider_id,
          creation_intent_id: "creation-1",
          ceremony_intent_id: "creation-ceremony-1",
          requirement: "human_identity",
          generation: 2,
          expected_revision: 3,
          idempotency_key: "creation-launch-1",
        },
        harness.value,
      ),
    );
    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]).toMatchObject({
      start: { actor_id: "user-1", intent_id: "creation-ceremony-1" },
      creation: {
        creation_intent_id: "creation-1",
        requirement: "human_identity",
        generation: 2,
        expected_revision: 3,
        idempotency_key: "creation-launch-1",
        provider_id: MANIFEST.provider_id,
      },
    });
    expect(harness.commits[0]?.session.intent_id).toBe("creation-ceremony-1");
  });

  test("resolves the trusted intent, binds provider configuration, and returns only presentation", async () => {
    const harness = await services({});
    const result = await Effect.runPromise(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        harness.value,
      ),
    );
    expect(result).toEqual({
      proof_session_id: "proof-session-1",
      provider_id: MANIFEST.provider_id,
      presentation: {
        kind: "redirect",
        session_id: "proof-session-1",
        url: "https://provider.test/verify",
      },
      expires_at: "2099-08-17T00:00:00.000Z",
      replayed: false,
    });
    expect(harness.commits[0]?.session).toMatchObject({
      actor_id: "user-1",
      intent_id: "intent-1",
      provider_configuration: { kind: "dynamic", reference: "test-query", version: "1" },
    });
    expect(result).not.toHaveProperty("upstream_session_ref");
  });

  test("returns a committed replay without exposing the stored session", async () => {
    const harness = await services({ commit: "replay" });
    const result = await Effect.runPromise(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        harness.value,
      ),
    );
    expect(result.replayed).toBe(true);
    expect(result).not.toHaveProperty("provider_configuration");
  });

  test("returns a redacted completed terminal response without a presentation", async () => {
    const existing = adapter().start({
      actor_id: "user-1",
      intent_id: "intent-1",
      request_hash: "a".repeat(64),
      method: "document",
      scope: { kind: "none", issuer: MANIFEST.provider_id },
      requested_requirements: [{ claim_id: "document.valid" }] as const,
      requested_claim_ids: ["document.valid"] as const,
      subject_binding_intent: "none",
      protocol_version: "test-v1",
      environment: "test",
      request_mode: "dynamic",
      provider_configuration: { kind: "dynamic", reference: "test-query", version: "1" },
    });
    const start = await Effect.runPromise(existing);
    const harness = await services({
      reservation: { kind: "terminal", status: "completed", start },
    });
    const result = await Effect.runPromise(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        harness.value,
      ),
    );
    expect(result).toEqual({
      proof_session_id: start.session.id,
      provider_id: MANIFEST.provider_id,
      status: "completed",
      replayed: true,
    });
    expect(result).not.toHaveProperty("presentation");
  });

  test("fails closed for unavailable intents, unsupported plans, and local conflicts", async () => {
    const cases = [
      await services({ intent: null }),
      await services({ plan: { status: "unsupported" } }),
      await services({ plan: { status: "unknown" } }),
      await services({ commit: "conflict" }),
    ];
    const reasons = ["intent_unavailable", "unsupported", "indeterminate", "conflict"] as const;
    for (const [index, harness] of cases.entries()) {
      const reason = reasons[index];
      if (reason === undefined) throw new Error("missing expected failure reason");
      const exit = await Effect.runPromiseExit(
        startVerification(
          { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
          harness.value,
        ),
      );
      expect(failureOf(exit)).toEqual(new VerificationStartRejected({ reason }));
    }
  });

  test("rejects malformed actor and provider identifiers before resolving an intent", async () => {
    const harness = await services({});
    const exit = await Effect.runPromiseExit(
      startVerification(
        { actor_id: " user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        harness.value,
      ),
    );
    expect(failureOf(exit)).toEqual(new VerificationStartRejected({ reason: "invalid" }));
    expect(harness.commits).toEqual([]);
  });

  test("releases on provider failure and exposes in-flight reservations", async () => {
    const failed = await services({ startFailure: "unavailable" });
    const failedExit = await Effect.runPromiseExit(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        failed.value,
      ),
    );
    expect(failureOf(failedExit)).toBeInstanceOf(VerificationProviderUnavailable);
    expect(failed.releases).toBe(1);

    const inFlight = await services({
      reservation: { kind: "in_flight", retry_after_seconds: 3 },
    });
    const inFlightExit = await Effect.runPromiseExit(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        inFlight.value,
      ),
    );
    expect(failureOf(inFlightExit)).toEqual(
      new VerificationStartRejected({ reason: "in_flight", retry_after_seconds: 3 }),
    );
  });

  test("revalidates the intent after reservation and before the provider side effect", async () => {
    const startCalls = { value: 0 };
    const unavailable = await services({
      intentResolutions: [PLAN_INPUT, null],
      startCalls,
    });
    const unavailableExit = await Effect.runPromiseExit(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        unavailable.value,
      ),
    );
    expect(failureOf(unavailableExit)).toEqual(
      new VerificationStartRejected({ reason: "intent_unavailable" }),
    );
    expect(unavailable.resolveCalls).toBe(2);
    expect(unavailable.releases).toBe(1);
    expect(startCalls.value).toBe(0);
    expect(unavailable.commits).toEqual([]);

    const changed = await services({
      intentResolutions: [
        PLAN_INPUT,
        { ...PLAN_INPUT, requested_requirements: [{ claim_id: "human.personhood" }] },
      ],
      startCalls,
    });
    const changedExit = await Effect.runPromiseExit(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        changed.value,
      ),
    );
    expect(failureOf(changedExit)).toEqual(
      new VerificationStartRejected({ reason: "intent_unavailable" }),
    );
    expect(changed.releases).toBe(1);
    expect(startCalls.value).toBe(0);
    expect(changed.commits).toEqual([]);
  });

  test("allows a released provider failure to retry and persist the next success", async () => {
    let attempts = 0;
    let releases = 0;
    const base = adapter();
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry(
        [
          {
            ...base,
            start: (input) => {
              attempts += 1;
              if (attempts === 1) {
                return Effect.fail(
                  new VerificationProviderUnavailable({
                    provider_id: MANIFEST.provider_id,
                    operation: "start",
                  }),
                );
              }
              return base.start(input);
            },
          },
        ],
        REGISTRY_OPTIONS,
      ),
    );
    const store = {
      reserve: () =>
        Effect.succeed({
          kind: "acquired" as const,
          reservation: {
            reservation_id: "reservation-retry",
            fence_token: attempts + 1,
            lease_expires_at: "2099-08-17T00:00:00.000Z",
          },
        }),
      finalize: (_reservation: unknown, start: ProviderSessionStart) =>
        Effect.succeed({ kind: "created" as const, start }),
      release: () => {
        releases += 1;
        return Effect.succeed(undefined);
      },
    };
    const services = {
      registry,
      intents: { resolve: () => Effect.succeed(PLAN_INPUT) },
      store,
    };
    const input = {
      actor_id: "user-1",
      intent_id: "retry-intent",
      provider_id: MANIFEST.provider_id,
    };
    await expect(Effect.runPromise(startVerification(input, services))).rejects.toBeInstanceOf(
      VerificationProviderUnavailable,
    );
    const result = await Effect.runPromise(startVerification(input, services));
    expect(result.replayed).toBe(false);
    expect(attempts).toBe(2);
    expect(releases).toBe(1);
  });

  test("keeps finalize conflicts terminal while stale finalizers remain retryable", async () => {
    const conflict = await services({ finalize: "conflict" });
    const conflictExit = await Effect.runPromiseExit(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        conflict.value,
      ),
    );
    expect(failureOf(conflictExit)).toEqual(new VerificationStartRejected({ reason: "conflict" }));

    const stale = await services({ finalize: "stale" });
    const staleExit = await Effect.runPromiseExit(
      startVerification(
        { actor_id: "user-1", intent_id: "intent-1", provider_id: MANIFEST.provider_id },
        stale.value,
      ),
    );
    expect(failureOf(staleExit)).toEqual(
      new VerificationStartRejected({ reason: "in_flight", retry_after_seconds: 1 }),
    );
  });

  test("invokes the provider once when concurrent same-intent starts race for one reservation", async () => {
    const startCalls = { value: 0 };
    const harness = await services({ startCalls });
    let reservations = 0;
    const concurrentServices = {
      ...harness.value,
      store: {
        ...harness.value.store,
        reserve: () => {
          reservations += 1;
          return Effect.succeed(
            reservations === 1
              ? {
                  kind: "acquired" as const,
                  reservation: {
                    reservation_id: "reservation-concurrent",
                    fence_token: 1,
                    lease_expires_at: "2099-08-17T00:00:00.000Z",
                  },
                }
              : ({ kind: "in_flight", retry_after_seconds: 1 } as const),
          );
        },
      },
    };
    const input = {
      actor_id: "user-1",
      intent_id: "intent-concurrent",
      provider_id: MANIFEST.provider_id,
    };

    const outcomes = await Promise.allSettled([
      Effect.runPromise(startVerification(input, concurrentServices)),
      Effect.runPromise(startVerification(input, concurrentServices)),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(startCalls.value).toBe(1);
  });
});
