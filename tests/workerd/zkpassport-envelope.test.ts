/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { canonicalizeSignedVerifierResponse } from "@pirate/verifier-response-contract";
import { Cause, Effect, Exit, Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeZkPassportProvider,
  ZKPASSPORT_PROTOCOL_VERSION,
  ZKPASSPORT_RP_SCOPE,
  type ZkPassportVerifierInput,
  zkPassportConfiguration,
} from "../../packages/platform-cf/src/verification/providers/zkpassport.ts";

const RESPONSE_SECRET = "workerd-response-secret";
const RESPONSE_KEY_ID = "workerd-key-2026-08";
const NOW = "2099-01-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T01:00:00.000Z";
const HASH = "1".repeat(64);
const NONCE = "n".repeat(32);

async function signedResponse(input: ZkPassportVerifierInput) {
  const unsigned = {
    proof_session_id: input.proof_session_id,
    request_hash: input.request_hash,
    verdict: true,
    unique_identifier: "workerd-raw-id",
    unique_identifier_type: 0,
    protocol_version: input.protocol_version,
    nonce: input.nonce,
    expiry: input.expiry,
    key_id: input.key_id,
  } as const;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(RESPONSE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonicalizeSignedVerifierResponse(unsigned)),
    ),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    ...unsigned,
    signature: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
  };
}

function provider(tamper = false) {
  let next = 0;
  return makeZkPassportProvider({
    domain: "api.example",
    name: "Pirate",
    verifier: {
      verify: (input) =>
        Effect.promise(async () => {
          const signed = await signedResponse(input);
          return tamper ? { ...signed, unique_identifier: "tampered" } : signed;
        }),
    },
    clock: { now: () => NOW, expiresAt: () => EXPIRES },
    identifiers: {
      next: (kind) => {
        next += 1;
        return `${kind}-${next}`;
      },
    },
    digest: { digest: () => Effect.succeed("a".repeat(64)) },
    verifier_response_signing_secret: RESPONSE_SECRET,
    verifier_response_signing_key_id: RESPONSE_KEY_ID,
    nonce: () => NONCE,
  });
}

const input = {
  actor_id: "actor-1",
  intent_id: "intent-1",
  request_hash: HASH,
  method: "document" as const,
  scope: {
    kind: "named" as const,
    scope_semantics: "issuer_rp_scope" as const,
    issuer: "zkpassport",
    rp_scope: ZKPASSPORT_RP_SCOPE,
  },
  request_mode: "dynamic" as const,
  provider_configuration: zkPassportConfiguration({ domain: "api.example" }),
  requested_requirements: [
    { claim_id: "age.minimum" as const, minimum_age: "18" },
    { claim_id: "document.valid" as const },
  ] as const,
  requested_claim_ids: ["age.minimum", "document.valid"] as const,
  subject_binding_intent: "establish" as const,
  protocol_version: ZKPASSPORT_PROTOCOL_VERSION,
  environment: "test" as const,
};

function payload(sessionId: string) {
  return {
    proofs: [{}],
    queryResult: {
      bind: { custom_data: JSON.stringify({ proof_session_id: sessionId, request_hash: HASH }) },
      age: { gte: { expected: 18, result: true } },
    },
  };
}

function errorTag(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (!Exit.isFailure(exit)) return undefined;
  const found = Cause.findError(exit.cause);
  return Result.isSuccess(found) &&
    typeof found.success === "object" &&
    found.success !== null &&
    "_tag" in found.success
    ? String(found.success._tag)
    : undefined;
}

describe("ZKPassport signed verifier envelope (workerd)", () => {
  it("accepts a bound HMAC and rejects a post-signature identifier mutation", async () => {
    const valid = provider();
    const started = await Effect.runPromise(valid.start(input));
    await expect(
      Effect.runPromise(
        valid.complete({
          session: started.session,
          submission: { channel: "client_result", payload: payload(started.session.id) },
        }),
      ),
    ).resolves.toMatchObject({ assertions: expect.any(Array) });

    const invalid = provider(true);
    const failed = await Effect.runPromiseExit(
      invalid.complete({
        session: started.session,
        submission: { channel: "client_result", payload: payload(started.session.id) },
      }),
    );
    expect(errorTag(failed)).toBe("VerificationProviderInvalidResponse");
  });
});
