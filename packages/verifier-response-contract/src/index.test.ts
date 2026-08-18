import { expect, test } from "bun:test";
import { canonicalizeSignedVerifierResponse } from "./index.ts";

test("canonical signed verifier response golden vector is stable", () => {
  expect(
    canonicalizeSignedVerifierResponse({
      proof_session_id: "session-1",
      request_hash: "1".repeat(64),
      verdict: true,
      unique_identifier: "identifier",
      unique_identifier_type: 0,
      protocol_version: "zkpassport-v2",
      nonce: "nonce-1",
      expiry: "2099-01-01T01:00:00.000Z",
      key_id: "key-2026-08",
    }),
  ).toBe(
    '{"proof_session_id":"session-1","request_hash":"1111111111111111111111111111111111111111111111111111111111111111","verdict":true,"unique_identifier":"identifier","unique_identifier_type":0,"protocol_version":"zkpassport-v2","nonce":"nonce-1","expiry":"2099-01-01T01:00:00.000Z","key_id":"key-2026-08"}',
  );
});
