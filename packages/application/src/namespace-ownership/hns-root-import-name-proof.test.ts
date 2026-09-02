import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@pirate/domain";
import { Option, Schema } from "effect";
import {
  decodeHnsRootImportNameProofResultV1,
  encodeHnsRootImportNameProofResultV1,
  HNS_ROOT_IMPORT_NAME_PROOF_NETWORK,
  HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION,
  HNS_ROOT_IMPORT_NAME_PROOF_VERSION,
  HnsRootImportNameSignature,
  hnsRootImportNameProofMessage,
} from "./hns-root-import-name-proof.ts";

const signature = btoa("\u0001".repeat(64));

describe("HNS root-import name proof", () => {
  test("binds the wallet message to every import authority field", () => {
    const input = {
      actor_id: "actor-1",
      creation_intent_id: "intent-1",
      ceremony_intent_id: "ceremony-1",
      root_import_session_id: "root-import-1",
      namespace_session_id: "namespace-1",
      root_label: "dankmemes",
      challenge_txt_value: "pirate-verification=namespace-1",
      environment: "production",
      expires_at: "2026-09-09T00:00:00.000Z",
    } as const;

    expect(hnsRootImportNameProofMessage(input)).toBe(
      canonicalJson([
        HNS_ROOT_IMPORT_NAME_PROOF_VERSION,
        input.actor_id,
        input.creation_intent_id,
        input.ceremony_intent_id,
        input.root_import_session_id,
        input.namespace_session_id,
        input.root_label,
        HNS_ROOT_IMPORT_NAME_PROOF_NETWORK,
        input.environment,
        input.expires_at,
        input.challenge_txt_value,
      ]),
    );
    expect(hnsRootImportNameProofMessage({ ...input, root_label: "11qx" })).not.toBe(
      hnsRootImportNameProofMessage(input),
    );
  });

  test("accepts only canonical 64-byte compact signatures", () => {
    expect(Schema.decodeUnknownOption(HnsRootImportNameSignature)(signature)).toEqual(
      Option.some(signature),
    );
    expect(Option.isNone(Schema.decodeUnknownOption(HnsRootImportNameSignature)("AQ=="))).toBe(
      true,
    );
    const nonCanonical = `${signature.slice(0, -3)}B==`;
    expect(
      Option.isNone(Schema.decodeUnknownOption(HnsRootImportNameSignature)(nonCanonical)),
    ).toBe(true);
  });

  test("round-trips only the bounded sanitized verifier result", () => {
    const result = {
      version: HNS_ROOT_IMPORT_NAME_PROOF_RESULT_VERSION,
      root_label: "dankmemes",
      message_sha256: "a".repeat(64),
      signature_sha256: "b".repeat(64),
      safe: true,
      verified: true,
    } as const;
    const bytes = encodeHnsRootImportNameProofResultV1(result);
    expect(decodeHnsRootImportNameProofResultV1(bytes)).toEqual(result);
    expect(new TextDecoder().decode(bytes)).not.toContain(signature);
    expect(() =>
      decodeHnsRootImportNameProofResultV1(
        new TextEncoder().encode(JSON.stringify({ ...result, signature })),
      ),
    ).toThrow();
  });
});
