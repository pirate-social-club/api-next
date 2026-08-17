import { describe, expect, test } from "bun:test";
import { Sha256Hex } from "@pirate/domain/verification";
import { Schema } from "effect";
import {
  computeVerificationRequestHash,
  type VerificationRequestHashInput,
} from "./request-hash.ts";

const INPUT: VerificationRequestHashInput = {
  actor_id: "user-1",
  intent_id: "intent-1",
  method: "document",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: "test.adversarial",
    rp_scope: "pirate.test",
  },
  request_mode: "dynamic",
  provider_configuration: { kind: "dynamic", reference: "test-query", version: "1" },
  requested_requirements: [
    { claim_id: "credential.subject_unique" },
    { claim_id: "document.valid" },
  ],
  subject_binding_intent: "establish",
  protocol_version: "test-v1",
  environment: "test",
};

describe("verification request hashing", () => {
  test("has a stable, canonical SHA-256 vector", async () => {
    const hash = await computeVerificationRequestHash("test.adversarial", INPUT);
    expect(hash).toBe("8894e655b50bebf543a857a265449d0eac5c9908b156dce4a5c4707a4e740f22");
    expect(Schema.decodeUnknownSync(Sha256Hex)(hash)).toBe(hash);
  });

  test("canonicalizes nested JSON object key order", async () => {
    const first: VerificationRequestHashInput = {
      ...INPUT,
      requested_requirements: [
        {
          claim_id: "disclosed.predicate",
          predicate: "document.custom",
          expected_value: { z: [2, { b: true, a: false }], a: 1 },
        },
      ],
    };
    const second: VerificationRequestHashInput = {
      ...first,
      requested_requirements: [
        {
          claim_id: "disclosed.predicate",
          predicate: "document.custom",
          expected_value: { a: 1, z: [2, { a: false, b: true }] },
        },
      ],
    };
    expect(await computeVerificationRequestHash("test.adversarial", first)).toBe(
      await computeVerificationRequestHash("test.adversarial", second),
    );
  });

  test("binds provider, scope, configuration, request mode, and requirements", async () => {
    const baseline = await computeVerificationRequestHash("test.adversarial", INPUT);
    const variants: readonly [string, VerificationRequestHashInput][] = [
      ["other.provider", INPUT],
      [
        "test.adversarial",
        {
          ...INPUT,
          scope: {
            kind: "named",
            scope_semantics: "issuer_rp_scope",
            issuer: "test.adversarial",
            rp_scope: "other.test",
          },
        },
      ],
      ["test.adversarial", { ...INPUT, request_mode: "curated" }],
      [
        "test.adversarial",
        {
          ...INPUT,
          provider_configuration: {
            ...INPUT.provider_configuration,
            reference: "other-query",
          },
        },
      ],
      [
        "test.adversarial",
        {
          ...INPUT,
          provider_configuration: { ...INPUT.provider_configuration, version: "2" },
        },
      ],
      ["test.adversarial", { ...INPUT, requested_requirements: [{ claim_id: "document.valid" }] }],
    ];
    for (const [providerId, input] of variants) {
      expect(await computeVerificationRequestHash(providerId, input)).not.toBe(baseline);
    }
  });
});
