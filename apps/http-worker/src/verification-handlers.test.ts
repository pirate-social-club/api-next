import { describe, expect, test } from "bun:test";
import type {
  StoredVerificationCompletion,
  VerificationCompletionStore,
} from "@pirate/application/use-cases/verification-completion";
import { NotFound } from "@pirate/contracts";
import type { ProofSession } from "@pirate/domain/verification";
import {
  makeFakeVerificationProvider,
  makeFakeVerificationProviderRegistry,
  NO_SUBJECT_FAKE_PROVIDER_MANIFEST,
} from "@pirate/testing/verification";
import { Effect } from "effect";
import { makeVerificationHandlers } from "./verification-handlers.ts";

const RESULT_HASH = "a".repeat(64);
const manifest = NO_SUBJECT_FAKE_PROVIDER_MANIFEST;

const planInput = {
  method: "document",
  scope: { kind: "none", issuer: manifest.provider_id },
  requested_requirements: [{ claim_id: "document.valid" }],
  requested_claim_ids: ["document.valid"],
  subject_binding_intent: "none",
  protocol_version: "fake-v2",
  environment: "test",
} as const;

function proofSession(status: "pending" | "completed" = "pending"): ProofSession {
  return {
    id: "fake-session-1",
    actor_id: "user-authenticated",
    intent_id: "intent-1",
    request_hash: "1".repeat(64),
    provider_id: manifest.provider_id,
    upstream_session_ref: "fake-upstream-session-1",
    method: planInput.method,
    scope: planInput.scope,
    request_mode: "dynamic",
    provider_configuration: { kind: "dynamic", reference: "fake-query", version: "1" },
    requested_requirements: planInput.requested_requirements,
    requested_claim_ids: planInput.requested_claim_ids,
    subject_binding_intent: planInput.subject_binding_intent,
    protocol_version: planInput.protocol_version,
    environment: planInput.environment,
    status,
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: "2099-08-17T01:00:00.000Z",
    ...(status === "completed" ? { completed_at: "2026-08-17T00:10:00.000Z" } : {}),
  };
}

function terminalStore(): VerificationCompletionStore {
  const stored: StoredVerificationCompletion = {
    session: proofSession("completed"),
    terminal: {
      status: "completed",
      idempotency_key: "webhook-1",
      result_hash: RESULT_HASH,
    },
  };
  return {
    reserveAttempt: () =>
      Effect.succeed({
        kind: "acquired" as const,
        reservation: {
          attempt_id: "attempt-terminal",
          fence_token: 1,
          lease_expires_at: "2099-08-17T00:00:00.000Z",
        },
      }),
    releaseAttempt: () => Effect.void,
    consumeAttempt: () => Effect.void,
    settleCompleted: () => Effect.void,
    load: () => Effect.succeed(stored),
    commit: () => Effect.die("terminal replay must not commit"),
  };
}

async function handlers(
  options: {
    readonly callback_registry?: {
      readonly list: () => readonly [typeof manifest];
      readonly resolve: () => Effect.Effect<ReturnType<typeof makeFakeVerificationProvider>>;
    };
    readonly callback_credential_headers?: readonly string[];
  } = {},
) {
  const registry = await Effect.runPromise(
    makeFakeVerificationProviderRegistry({
      mode: "no-subject",
      verifyCallback: () =>
        Effect.succeed({
          proof_session_id: "fake-session-1",
          idempotency_key: "webhook-1",
          submission: {
            channel: "provider_callback",
            payload: { authenticated: true },
          },
        }),
    }),
  );
  const completion = {
    registry,
    store: terminalStore(),
    hasher: { hash: () => Effect.succeed(RESULT_HASH) },
  };
  return makeVerificationHandlers({
    start: {
      registry,
      intents: { resolve: () => Effect.succeed(planInput) },
      store: {
        reserve: () =>
          Effect.succeed({
            kind: "acquired" as const,
            reservation: {
              reservation_id: "reservation-1",
              fence_token: 1,
              lease_expires_at: "2099-08-17T00:00:00.000Z",
            },
          }),
        finalize: (_reservation, start) => Effect.succeed({ kind: "created" as const, start }),
        release: () => Effect.succeed(undefined),
      },
    },
    completion,
    ...(options.callback_registry === undefined
      ? {}
      : { callback: { ...completion, registry: options.callback_registry } }),
    ...(options.callback_credential_headers === undefined
      ? {}
      : { callback_credential_headers: options.callback_credential_headers }),
  });
}

describe("verification HTTP handlers", () => {
  test("derives the start actor from the authenticated principal", async () => {
    const result = await (await handlers()).StartVerificationSession({
      principal: { kind: "user", subject: "user-authenticated" },
      body: { intent_id: "intent-1", provider_id: manifest.provider_id },
      params: undefined,
      query: undefined,
    });
    expect(result).toMatchObject({
      body: {
        proof_session_id: "fake-session-1",
        provider_id: manifest.provider_id,
        replayed: false,
      },
      status: 201,
    });
    expect(JSON.stringify(result)).not.toContain("fake-upstream-session-1");
  });

  test("marks app completion as client-result and returns a redacted replay", async () => {
    const result = await (await handlers()).CompleteVerificationSession({
      principal: { kind: "user", subject: "user-authenticated" },
      body: { idempotency_key: "webhook-1", payload: { proofs: [] } },
      params: { proofSessionId: "fake-session-1" },
      query: undefined,
    });
    expect(result).toEqual({
      proof_session_id: "fake-session-1",
      status: "completed",
      replayed: true,
    });
    expect(result).not.toHaveProperty("result_hash");
  });

  test("accepts exact raw public callbacks without accepting actor identity", async () => {
    const result = await (await handlers()).CompleteVerificationCallback({
      principal: null,
      body: ' {\n  "signed": true\n} ',
      headers: { "webhook-signature": "sig" },
      params: { providerId: manifest.provider_id },
      query: undefined,
    });
    expect(result).toEqual({
      proof_session_id: "fake-session-1",
      status: "completed",
      replayed: true,
    });
  });

  test("strips standard and deployment credentials before application callback code", async () => {
    let observedHeaders: Readonly<Record<string, string>> | undefined;
    const adapter = makeFakeVerificationProvider({
      mode: "no-subject",
      verifyCallback: (input) => {
        observedHeaders = input.headers;
        return Effect.succeed({
          proof_session_id: "fake-session-1",
          idempotency_key: "webhook-1",
          submission: { channel: "provider_callback", payload: { authenticated: true } },
        });
      },
    });
    // Intentionally bypass the registry guard here so this test isolates the
    // earlier handler boundary. The provider double itself remains in testing.
    const callbackRegistry = {
      list: () => [adapter.manifest] as const,
      resolve: () => Effect.succeed(adapter),
    };
    const configured = await handlers({
      callback_registry: callbackRegistry,
      callback_credential_headers: ["x-pirate-internal-auth"],
    });

    await configured.CompleteVerificationCallback({
      principal: null,
      body: "{}",
      headers: {
        authorization: "Bearer platform-secret",
        cookie: "session=platform-secret",
        "cf-access-client-secret": "access-secret",
        "x-pirate-internal-auth": "deployment-secret",
        "webhook-signature": "sig",
        "x-trace": "trace",
      },
      params: { providerId: manifest.provider_id },
      query: undefined,
    });

    expect(observedHeaders).toEqual({ "webhook-signature": "sig", "x-trace": "trace" });
  });

  test("maps an arbitrary unknown provider ID without adding a provider enum", async () => {
    const configured = await handlers();
    await expect(
      configured.StartVerificationSession({
        principal: { kind: "user", subject: "user-authenticated" },
        body: { intent_id: "intent-1", provider_id: "future.provider" },
        params: undefined,
        query: undefined,
      }),
    ).rejects.toBeInstanceOf(NotFound);
  });

  test("returns a redacted not-found for an unknown callback provider", async () => {
    const configured = await handlers();
    await expect(
      configured.CompleteVerificationCallback({
        principal: null,
        body: "{}",
        headers: {},
        params: { providerId: "future.provider" },
        query: undefined,
      }),
    ).rejects.toBeInstanceOf(NotFound);
  });
});
