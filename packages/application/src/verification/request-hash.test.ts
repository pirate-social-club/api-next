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
    expect(hash).toBe("d30bcbe842ef8e7046be5cf21531d99fe95f2cb7e92d3efe1f46e094b4fa833b");
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

  test("binds provider, scope, request mode, and requirements", async () => {
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
      ["test.adversarial", { ...INPUT, requested_requirements: [{ claim_id: "document.valid" }] }],
    ];
    for (const [providerId, input] of variants) {
      expect(await computeVerificationRequestHash(providerId, input)).not.toBe(baseline);
    }
  });
});
