import { describe, expect, test } from "bun:test";
import type { ProofProviderManifest, ProofSession } from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result } from "effect";
import type {
  ProviderSessionStart,
  VerificationProviderAdapter,
  VerificationProviderPlanResult,
} from "./adapter.ts";
import { makeVerificationProviderRegistry } from "./registry.ts";
import {
  startVerification,
  type VerificationSessionStartCommitOutcome,
  VerificationStartRejected,
} from "./start.ts";

const MANIFEST: ProofProviderManifest = {
  provider_id: "test.provider",
  manifest_version: "1",
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
): VerificationProviderAdapter {
  return {
    manifest: MANIFEST,
    plan: () => Effect.succeed(plan),
    start: (input) => {
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
  readonly commit?: VerificationSessionStartCommitOutcome["kind"];
}) {
  const registry = await Effect.runPromise(makeVerificationProviderRegistry([adapter(input.plan)]));
  const commits: ProviderSessionStart[] = [];
  return {
    commits,
    value: {
      registry,
      intents: {
        resolve: () => Effect.succeed(Object.hasOwn(input, "intent") ? input.intent : PLAN_INPUT),
      },
      store: {
        commit: (start: ProviderSessionStart) => {
          commits.push(start);
          return Effect.succeed(
            input.commit === "conflict"
              ? ({ kind: "conflict" } as const)
              : ({ kind: input.commit ?? "created", start } as const),
          );
        },
      },
    },
  };
}

describe("verification start use case", () => {
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
});
