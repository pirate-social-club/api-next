import { describe, expect, test } from "bun:test";
import type {
  EvidenceBundle,
  ProofProviderManifest,
  ProofSession,
} from "@pirate/domain/verification";
import { Effect } from "effect";
import type { VerificationProviderAdapter } from "./adapter.ts";
import {
  completeVerification,
  type StoredVerificationCompletion,
  VerificationCompletionHashFailed,
  VerificationCompletionRejected,
  type VerificationCompletionServices,
  type VerificationCompletionStore,
} from "./completion.ts";
import {
  type VerificationProviderRegistryService,
  VerificationProviderUnknown,
} from "./registry.ts";

const RESULT_HASH = "a".repeat(64);
const NOW = Date.parse("2026-08-17T00:30:00.000Z");

const manifest: ProofProviderManifest = {
  provider_id: "test.complete",
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: ["complete-v1"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid"],
  claim_capabilities: [{ claim_id: "document.valid", request_modes: ["dynamic"] }],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

function session(overrides: Partial<ProofSession> = {}): ProofSession {
  return {
    id: "proof-session-1",
    actor_id: "user-1",
    intent_id: "intent-1",
    request_hash: "1".repeat(64),
    provider_id: manifest.provider_id,
    method: "document",
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: "test.complete",
      rp_scope: "pirate.example",
    },
    request_mode: "dynamic",
    provider_configuration: { kind: "dynamic", reference: "test-query", version: "1" },
    requested_requirements: [{ claim_id: "document.valid" }],
    requested_claim_ids: ["document.valid"],
    subject_binding_intent: "establish",
    protocol_version: "complete-v1",
    environment: "test",
    status: "pending",
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: "2026-08-17T01:00:00.000Z",
    ...overrides,
  };
}

function bundle(proofSession: ProofSession): EvidenceBundle {
  return {
    id: "bundle-1",
    proof_session_id: proofSession.id,
    receipts: [
      {
        id: "receipt-1",
        proof_session_id: proofSession.id,
        provider_id: proofSession.provider_id,
        issuer: proofSession.scope.issuer,
        method: proofSession.method,
        scope: proofSession.scope,
        provider_configuration: proofSession.provider_configuration,
        protocol_version: proofSession.protocol_version,
        environment: proofSession.environment,
        provenance_kind: "proof_session",
        evidence_kind: "document",
        evidence_hash: "2".repeat(64),
        observed_at: "2026-08-17T00:20:00.000Z",
        subject_key_id: "subject-1",
      },
    ],
    subject_keys: [
      {
        id: "subject-1",
        issuer: proofSession.scope.issuer,
        method: proofSession.method,
        scope: {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: proofSession.scope.issuer,
          rp_scope: "pirate.example",
        },
        subject_digest: "3".repeat(64),
      },
    ],
    binding_groups: [{ id: "binding-1", kind: "same_subject", subject_key_id: "subject-1" }],
    assertions: [
      {
        id: "assertion-1",
        subject_key_id: "subject-1",
        evidence_receipt_id: "receipt-1",
        assurance: "document_zk",
        binding_group_id: "binding-1",
        observed_at: "2026-08-17T00:20:00.000Z",
        claim_id: "document.valid",
        value: { valid: true },
      },
    ],
  };
}

function adapterFor(
  proofSession: ProofSession,
  calls: { complete: number },
): VerificationProviderAdapter {
  return {
    manifest,
    plan: () => Effect.die("plan is outside this use case"),
    start: () => Effect.die("start is outside this use case"),
    complete: () => {
      calls.complete += 1;
      return Effect.succeed(bundle(proofSession));
    },
  };
}

function registryFor(adapter: VerificationProviderAdapter): VerificationProviderRegistryService {
  return {
    list: () => [manifest],
    resolve: (provider_id) =>
      provider_id === manifest.provider_id
        ? Effect.succeed(adapter)
        : Effect.fail(new VerificationProviderUnknown({ provider_id })),
  };
}

function input() {
  return {
    actor_id: "user-1",
    proof_session_id: "proof-session-1",
    idempotency_key: "callback-1",
    submission: { channel: "client_result" as const, payload: { credential: "signed" } },
  };
}

function servicesFor(
  stored: StoredVerificationCompletion,
  store: VerificationCompletionStore,
  calls: { complete: number },
): VerificationCompletionServices {
  return {
    registry: registryFor(adapterFor(stored.session, calls)),
    store,
    hasher: { hash: () => Effect.succeed(RESULT_HASH) },
    now: () => NOW,
  };
}

describe("verification completion use case", () => {
  test("authenticates the session and delegates one atomic evidence commit", async () => {
    const stored = { session: session(), terminal: null } satisfies StoredVerificationCompletion;
    const calls = { complete: 0, commit: 0 };
    const store: VerificationCompletionStore = {
      load: () => Effect.succeed(stored),
      commit: (commitInput) => {
        calls.commit += 1;
        expect(commitInput.actor_id).toBe("user-1");
        expect(commitInput.expected_session).toEqual(stored.session);
        expect(commitInput.bundle.proof_session_id).toBe(stored.session.id);
        return Effect.succeed({ kind: "committed", result_hash: commitInput.result_hash });
      },
    };

    await expect(
      Effect.runPromise(completeVerification(input(), servicesFor(stored, store, calls))),
    ).resolves.toEqual({
      proof_session_id: "proof-session-1",
      status: "completed",
      result_hash: RESULT_HASH,
      replayed: false,
    });
    expect(calls).toEqual({ complete: 1, commit: 1 });
  });

  test("returns a persisted terminal result on callback replay without calling the provider", async () => {
    const stored = {
      session: session({ status: "completed", completed_at: "2026-08-17T00:25:00.000Z" }),
      terminal: { status: "completed", idempotency_key: "callback-1", result_hash: RESULT_HASH },
    } satisfies StoredVerificationCompletion;
    const calls = { complete: 0, commit: 0 };
    const store: VerificationCompletionStore = {
      load: () => Effect.succeed(stored),
      commit: () => {
        calls.commit += 1;
        return Effect.die("commit must not run on replay");
      },
    };

    const result = await Effect.runPromise(
      completeVerification(input(), servicesFor(stored, store, calls)),
    );
    expect(result.replayed).toBe(true);
    expect(calls).toEqual({ complete: 0, commit: 0 });
  });

  test("rejects a terminal replay carrying a different idempotency key", async () => {
    const stored = {
      session: session({ status: "completed", completed_at: "2026-08-17T00:25:00.000Z" }),
      terminal: { status: "completed", idempotency_key: "callback-1", result_hash: RESULT_HASH },
    } satisfies StoredVerificationCompletion;
    const calls = { complete: 0 };
    const store: VerificationCompletionStore = {
      load: () => Effect.succeed(stored),
      commit: () => Effect.die("commit must not run for a conflicting replay"),
    };

    const error = await Effect.runPromise(
      completeVerification(
        { ...input(), idempotency_key: "callback-other" },
        servicesFor(stored, store, calls),
      ),
    ).catch((failure) => failure);
    expect(error).toMatchObject({ _tag: "VerificationCompletionRejected", reason: "terminal" });
    expect(calls.complete).toBe(0);
  });

  test("rejects another actor and exact expiry before provider work", async () => {
    for (const testCase of [
      {
        request: { ...input(), actor_id: "user-2" },
        stored: { session: session(), terminal: null },
        reason: "unavailable",
      },
      {
        request: input(),
        stored: {
          session: session({ expires_at: "2026-08-17T00:30:00.000Z" }),
          terminal: null,
        },
        reason: "expired",
      },
    ] as const) {
      const calls = { complete: 0 };
      const store: VerificationCompletionStore = {
        load: () => Effect.succeed(testCase.stored),
        commit: () => Effect.die("commit must not run for a rejected completion"),
      };
      const error = await Effect.runPromise(
        completeVerification(testCase.request, servicesFor(testCase.stored, store, calls)),
      ).catch((failure) => failure);
      expect(error).toBeInstanceOf(VerificationCompletionRejected);
      expect(error).toMatchObject({ reason: testCase.reason });
      expect(calls.complete).toBe(0);
    }
  });

  test("turns concurrent callbacks into one commit and one replay", async () => {
    const stored = { session: session(), terminal: null } satisfies StoredVerificationCompletion;
    const calls = { complete: 0 };
    const commitState: { hash: string | null } = { hash: null };
    let commitAttempts = 0;
    const store: VerificationCompletionStore = {
      load: () => Effect.succeed(stored),
      commit: ({ result_hash }) =>
        Effect.sync(() => {
          commitAttempts += 1;
          if (commitState.hash !== null) {
            return { kind: "replay", result_hash: commitState.hash } as const;
          }
          commitState.hash = result_hash;
          return { kind: "committed", result_hash } as const;
        }),
    };
    const services = servicesFor(stored, store, calls);

    const results = await Promise.all([
      Effect.runPromise(completeVerification(input(), services)),
      Effect.runPromise(completeVerification(input(), services)),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(commitAttempts).toBe(2);
    expect(commitState.hash).toBe(RESULT_HASH);
  });

  test("rechecks expiry after a slow provider before persistence", async () => {
    const stored = { session: session(), terminal: null } satisfies StoredVerificationCompletion;
    const calls = { complete: 0, now: 0 };
    const store: VerificationCompletionStore = {
      load: () => Effect.succeed(stored),
      commit: () => Effect.die("commit must not run after the ceremony expires"),
    };
    const clock = [NOW, Date.parse("2026-08-17T01:00:00.000Z")] as const;
    const services: VerificationCompletionServices = {
      ...servicesFor(stored, store, calls),
      now: () => clock[Math.min(calls.now++, clock.length - 1)] ?? clock[1],
    };

    const error = await Effect.runPromise(completeVerification(input(), services)).catch(
      (failure) => failure,
    );
    expect(error).toMatchObject({ _tag: "VerificationCompletionRejected", reason: "expired" });
    expect(calls.complete).toBe(1);
  });

  test("fails closed for a malformed result hash before persistence", async () => {
    const stored = { session: session(), terminal: null } satisfies StoredVerificationCompletion;
    const calls = { complete: 0 };
    const store: VerificationCompletionStore = {
      load: () => Effect.succeed(stored),
      commit: () => Effect.die("commit must not receive an invalid hash"),
    };
    const services: VerificationCompletionServices = {
      ...servicesFor(stored, store, calls),
      hasher: { hash: () => Effect.succeed("not-a-hash") },
    };

    const error = await Effect.runPromise(completeVerification(input(), services)).catch(
      (failure) => failure,
    );
    expect(error).toBeInstanceOf(VerificationCompletionHashFailed);
  });
});
