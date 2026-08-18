import { describe, expect, test } from "bun:test";
import { CompleteVerificationCallback } from "@pirate/contracts";
import type {
  EvidenceBundle,
  ProofProviderManifest,
  ProofSession,
} from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { type VerificationProviderAdapter, VerificationProviderRejected } from "./adapter.ts";
import {
  HandleVerificationCallbackInput,
  handleVerificationCallback,
  stripVerificationCallbackCredentialHeaders,
  VerificationCallbackRejected,
} from "./callback.ts";
import type { StoredVerificationCompletion, VerificationCompletionStore } from "./completion.ts";
import { makeVerificationProviderRegistry } from "./registry.ts";

const RESULT_HASH = "a".repeat(64);
const ATTEMPT = {
  attempt_id: "attempt-test",
  fence_token: 1,
  lease_expires_at: "2099-08-17T00:00:00.000Z",
} as const;

function attemptMethods() {
  return {
    reserveAttempt: () => Effect.succeed({ kind: "acquired" as const, reservation: ATTEMPT }),
    releaseAttempt: () => Effect.void,
    consumeAttempt: () => Effect.void,
  };
}

const manifest: ProofProviderManifest = {
  provider_id: "test.callback",
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
  callback_mode: "signed_envelope",
  callback_header_allowlist: ["webhook-signature"],
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
  const adapterManifest = callback
    ? manifest
    : { ...manifest, callback_mode: "none" as const, callback_header_allowlist: [] };
  return {
    manifest: adapterManifest,
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
  test("strips platform and deployment credentials before application handling", () => {
    expect(
      stripVerificationCallbackCredentialHeaders(
        {
          Authorization: "Bearer platform-secret",
          Cookie: "session=platform-secret",
          "CF-Access-Client-Secret": "access-secret",
          "X-Pirate-Internal-Auth": "deployment-secret",
          "Webhook-Signature": "provider-signature",
        },
        ["x-pirate-internal-auth"],
      ),
    ).toEqual({ "Webhook-Signature": "provider-signature" });
  });

  test("keeps the HTTP callback envelope and application callback schema in parity", () => {
    const input = {
      provider_id: manifest.provider_id,
      raw_body: '{"signed":true}',
      headers: { "webhook-signature": "sig", "cf-ray": "trace" },
    };
    const request = CompleteVerificationCallback.request;
    if (request === undefined || (typeof request === "object" && !("headers" in request))) {
      throw new Error("callback request schema is missing headers");
    }
    expect(Schema.is(HandleVerificationCallbackInput)(input)).toBe(true);
    expect(Schema.is(request.headers as never)(input.headers)).toBe(true);
    expect(Schema.is(HandleVerificationCallbackInput)({ ...input, raw_body: "" })).toBe(false);
  });

  test("authenticates the exact callback before deriving actor identity and completing", async () => {
    const proofSession = session();
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([adapterFor(proofSession)]),
    );
    const store: VerificationCompletionStore = {
      ...attemptMethods(),
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
            ...attemptMethods(),
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
            ...attemptMethods(),
            load: () => Effect.succeed(stored(proofSession)),
            commit: () => Effect.die("commit must not run"),
          },
          hasher: { hash: () => Effect.die("hash must not run") },
        },
      ),
    );
    expect(failureOf(exit)).toEqual(new VerificationCallbackRejected({ reason: "unavailable" }));
  });

  test("strips credential and unlisted headers before provider authentication", async () => {
    let observedHeaders: Record<string, string> | undefined;
    const proofSession = session();
    const adapter = adapterFor(proofSession);
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([
        {
          ...adapter,
          verifyCallback: (input) => {
            observedHeaders = input.headers;
            return adapter.verifyCallback?.(input) ?? Effect.die("missing callback");
          },
        },
      ]),
    );
    const exit = await Effect.runPromiseExit(
      handleVerificationCallback(
        {
          provider_id: manifest.provider_id,
          raw_body: ' {\n  "signed": true\n} ',
          headers: {
            Authorization: "Bearer secret",
            "WebHook-Signature": "sig",
            "CF-Access-Client-Secret": "internal-secret",
            "cf-ray": "ordinary-cloudflare-header",
          },
        },
        {
          registry,
          store: {
            ...attemptMethods(),
            load: () => Effect.succeed(stored(proofSession)),
            commit: (input) =>
              Effect.succeed({ kind: "committed", result_hash: input.result_hash }),
          },
          hasher: { hash: () => Effect.succeed(RESULT_HASH) },
        },
      ),
    );
    expect(exit._tag).toBe("Success");
    expect(observedHeaders).toEqual({ "webhook-signature": "sig" });
  });

  test("session-bound proofs resolve an opaque ID before lookup and verify after lookup", async () => {
    const proofSession = session();
    const sessionBoundManifest: ProofProviderManifest = {
      ...manifest,
      callback_mode: "session_bound_proof",
      callback_header_allowlist: ["proof-signature"],
    };
    const base = adapterFor(proofSession, false);
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([
        {
          ...base,
          manifest: sessionBoundManifest,
          resolveCallback: ({ raw_body }) =>
            Effect.succeed({
              proof_session_id: raw_body,
              idempotency_key: "proof-1",
              submission: {
                channel: "provider_callback" as const,
                payload: { proof: "opaque" },
              },
            }),
        },
      ]),
    );
    const result = await Effect.runPromise(
      handleVerificationCallback(
        {
          provider_id: sessionBoundManifest.provider_id,
          raw_body: proofSession.id,
          headers: { "proof-signature": "present" },
        },
        {
          registry,
          store: {
            ...attemptMethods(),
            load: ({ proof_session_id }) => {
              expect(proof_session_id).toBe(proofSession.id);
              return Effect.succeed(stored(proofSession));
            },
            commit: (input) =>
              Effect.succeed({ kind: "committed", result_hash: input.result_hash }),
          },
          hasher: { hash: () => Effect.succeed(RESULT_HASH) },
        },
      ),
    );
    expect(result).toMatchObject({ proof_session_id: proofSession.id, replayed: false });
  });

  test("returns an adapter-owned callback acknowledgment on successful completion", async () => {
    const proofSession = session();
    const adapter = {
      ...adapterFor(proofSession),
      callbackResponse: ({
        session: resolved,
        status,
      }: {
        readonly session: ProofSession;
        readonly status: "verified" | "pending";
      }) => Effect.succeed({ result: status === "verified", status, id: resolved.id }),
    } satisfies VerificationProviderAdapter;
    const registry = await Effect.runPromise(makeVerificationProviderRegistry([adapter]));
    const result = await Effect.runPromise(
      handleVerificationCallback(
        {
          provider_id: manifest.provider_id,
          raw_body: ' {\n  "signed": true\n} ',
          headers: { "webhook-signature": "sig" },
        },
        {
          registry,
          store: {
            ...attemptMethods(),
            load: () => Effect.succeed(stored(proofSession)),
            commit: (input) =>
              Effect.succeed({ kind: "committed", result_hash: input.result_hash }),
          },
          hasher: { hash: () => Effect.succeed(RESULT_HASH) },
        },
      ),
    );
    expect(result).toEqual({ result: true, status: "verified", id: proofSession.id });
  });

  test("acknowledges handled provider rejection as pending after session resolution", async () => {
    const proofSession = session();
    const adapter = {
      ...adapterFor(proofSession),
      complete: () =>
        Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "complete",
          }),
        ),
      callbackResponse: ({
        session: resolved,
        status,
      }: {
        readonly session: ProofSession;
        readonly status: "verified" | "pending";
      }) => Effect.succeed({ result: status === "verified", status, id: resolved.id }),
    } satisfies VerificationProviderAdapter;
    const registry = await Effect.runPromise(makeVerificationProviderRegistry([adapter]));
    const result = await Effect.runPromise(
      handleVerificationCallback(
        {
          provider_id: manifest.provider_id,
          raw_body: ' {\n  "signed": true\n} ',
          headers: { "webhook-signature": "sig" },
        },
        {
          registry,
          store: {
            ...attemptMethods(),
            load: () => Effect.succeed(stored(proofSession)),
            commit: () => Effect.die("rejected completion must not commit"),
          },
          hasher: { hash: () => Effect.succeed(RESULT_HASH) },
        },
      ),
    );
    expect(result).toEqual({ result: false, status: "pending", id: proofSession.id });
  });
});
