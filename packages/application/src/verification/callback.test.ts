import { describe, expect, test } from "bun:test";
import type {
  EvidenceBundle,
  ProofProviderManifest,
  ProofSession,
} from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result } from "effect";
import type { VerificationProviderAdapter } from "./adapter.ts";
import { handleVerificationCallback, VerificationCallbackRejected } from "./callback.ts";
import type { StoredVerificationCompletion, VerificationCompletionStore } from "./completion.ts";
import { makeVerificationProviderRegistry } from "./registry.ts";

const RESULT_HASH = "a".repeat(64);

const manifest: ProofProviderManifest = {
  provider_id: "test.callback",
  manifest_version: "1",
  protocol_versions: ["callback-v1"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid"],
  claim_capabilities: [{ claim_id: "document.valid", request_modes: ["dynamic"] }],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "none",
};

function session(overrides: Partial<ProofSession> = {}): ProofSession {
  return {
    id: "proof-session-1",
    actor_id: "user-1",
    intent_id: "intent-1",
    request_hash: "1".repeat(64),
    provider_id: manifest.provider_id,
    method: "document",
    scope: { kind: "none", issuer: manifest.provider_id },
    request_mode: "dynamic",
    provider_configuration: { kind: "dynamic", reference: "callback-query", version: "1" },
    requested_requirements: [{ claim_id: "document.valid" }],
    requested_claim_ids: ["document.valid"],
    subject_binding_intent: "none",
    protocol_version: "callback-v1",
    environment: "test",
    status: "pending",
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: "2099-08-17T01:00:00.000Z",
    ...overrides,
  };
}

function bundle(proofSession: ProofSession): EvidenceBundle {
  return {
    id: "bundle-1",
    proof_session_id: proofSession.id,
    subject_keys: [],
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
      },
    ],
    binding_groups: [{ id: "binding-1", kind: "same_receipt", evidence_receipt_id: "receipt-1" }],
    assertions: [
      {
        id: "assertion-1",
        evidence_receipt_id: "receipt-1",
        claim_id: "document.valid",
        value: { valid: true },
        assurance: "document_zk",
        binding_group_id: "binding-1",
        observed_at: "2026-08-17T00:20:00.000Z",
      },
    ],
  };
}

function adapterFor(proofSession: ProofSession, callback = true): VerificationProviderAdapter {
  return {
    manifest,
    plan: () => Effect.die("plan is outside this use case"),
    start: () => Effect.die("start is outside this use case"),
    complete: ({ submission }) => {
      if (submission.channel !== "provider_callback") {
        return Effect.die("callback channel was not preserved");
      }
      return Effect.succeed(bundle(proofSession));
    },
    ...(callback
      ? {
          verifyCallback: ({ raw_body, headers }) => {
            if (raw_body !== ' {\n  "signed": true\n} ' || headers["webhook-signature"] !== "sig") {
              return Effect.die("raw callback was changed");
            }
            return Effect.succeed({
              proof_session_id: proofSession.id,
              idempotency_key: "webhook-1",
              submission: {
                channel: "provider_callback" as const,
                payload: { authenticated: true },
              },
            });
          },
        }
      : {}),
  };
}

function stored(proofSession: ProofSession): StoredVerificationCompletion {
  return { session: proofSession, terminal: null };
}

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

describe("verification provider callback", () => {
  test("authenticates the exact callback before deriving actor identity and completing", async () => {
    const proofSession = session();
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([adapterFor(proofSession)]),
    );
    const store: VerificationCompletionStore = {
      load: () => Effect.succeed(stored(proofSession)),
      commit: (input) => {
        expect(input.actor_id).toBe("user-1");
        expect(input.idempotency_key).toBe("webhook-1");
        return Effect.succeed({ kind: "committed", result_hash: input.result_hash });
      },
    };

    const result = await Effect.runPromise(
      handleVerificationCallback(
        {
          provider_id: manifest.provider_id,
          raw_body: ' {\n  "signed": true\n} ',
          headers: { "webhook-signature": "sig" },
        },
        {
          registry,
          store,
          hasher: { hash: () => Effect.succeed(RESULT_HASH) },
        },
      ),
    );

    expect(result).toEqual({
      proof_session_id: proofSession.id,
      status: "completed",
      result_hash: RESULT_HASH,
      replayed: false,
    });
  });

  test("fails closed when the provider has no callback capability", async () => {
    const proofSession = session();
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([adapterFor(proofSession, false)]),
    );
    const exit = await Effect.runPromiseExit(
      handleVerificationCallback(
        { provider_id: manifest.provider_id, raw_body: "{}", headers: {} },
        {
          registry,
          store: {
            load: () => Effect.die("session lookup must not run"),
            commit: () => Effect.die("commit must not run"),
          },
          hasher: { hash: () => Effect.die("hash must not run") },
        },
      ),
    );
    expect(failureOf(exit)).toEqual(new VerificationCallbackRejected({ reason: "unsupported" }));
  });

  test("does not allow a callback route to cross provider identity", async () => {
    const proofSession = session({ provider_id: "other.provider" });
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([adapterFor(proofSession)]),
    );
    const exit = await Effect.runPromiseExit(
      handleVerificationCallback(
        {
          provider_id: manifest.provider_id,
          raw_body: ' {\n  "signed": true\n} ',
          headers: { "webhook-signature": "sig" },
        },
        {
          registry,
          store: {
            load: () => Effect.succeed(stored(proofSession)),
            commit: () => Effect.die("commit must not run"),
          },
          hasher: { hash: () => Effect.die("hash must not run") },
        },
      ),
    );
    expect(failureOf(exit)).toEqual(new VerificationCallbackRejected({ reason: "unavailable" }));
  });
});
