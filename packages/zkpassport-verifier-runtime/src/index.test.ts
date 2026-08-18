import { describe, expect, test } from "bun:test";
import { canonicalizeSignedVerifierResponse } from "@pirate/verifier-response-contract";
import {
  handleZkPassportVerifierRequest,
  verifyLocally,
  type ZkPassportVerifyRequest,
} from "./index.ts";

const body: ZkPassportVerifyRequest = {
  domain: "api.example",
  proofs: [{ proof: "opaque" }],
  originalQuery: { bind: { custom_data: "binding" } },
  queryResult: { bind: { custom_data: "binding" } },
  validity: 3600,
  scope: "pirate-social",
  devMode: false,
  proof_session_id: "session-1",
  request_hash: "1".repeat(64),
  protocol_version: "zkpassport-v2",
  nonce: "n".repeat(32),
  expiry: "2099-01-01T01:00:00.000Z",
  key_id: "key-2026-08",
};

const fakeSdk = {
  verify: async () => ({
    verified: true,
    uniqueIdentifier: "never-log-this",
    uniqueIdentifierType: 0 as const,
  }),
};

describe("ZKPassport verifier runtime", () => {
  test("passes validity to the SDK and returns an exactly verifiable signed result", async () => {
    let sdkInput: unknown;
    const result = await verifyLocally(body, {
      sdkFactory: () => ({
        verify: async (input) => {
          sdkInput = input;
          return fakeSdk.verify();
        },
      }),
      responseSigningSecret: "response-secret",
    });
    expect(sdkInput).toMatchObject({ validity: 3600 });
    expect(result).toMatchObject({
      verdict: true,
      unique_identifier: "never-log-this",
      unique_identifier_type: 0,
      proof_session_id: "session-1",
      key_id: "key-2026-08",
    });
    const { signature, ...unsigned } = result;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("response-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const padded = `${signature.replaceAll("-", "+").replaceAll("_", "/")}=`;
    const signatureBytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    await expect(
      crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        new TextEncoder().encode(canonicalizeSignedVerifierResponse(unsigned)),
      ),
    ).resolves.toBe(true);
  });

  test("health is public and verify requires bearer auth", async () => {
    const health = await handleZkPassportVerifierRequest(new Request("http://localhost/health"), {
      sharedSecret: "secret",
      responseSigningSecret: "response-secret",
      responseSigningKeyId: "key-2026-08",
    });
    expect(health.status).toBe(200);
    const unauthorized = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", { method: "POST", body: JSON.stringify(body) }),
      {
        sharedSecret: "secret",
        responseSigningSecret: "response-secret",
        responseSigningKeyId: "key-2026-08",
      },
    );
    expect(unauthorized.status).toBe(401);
    const missingConfig = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", { method: "POST", body: JSON.stringify(body) }),
      {
        sharedSecret: "",
        responseSigningSecret: "response-secret",
        responseSigningKeyId: "key-2026-08",
      },
    );
    expect(missingConfig.status).toBe(503);
    const unhealthy = await handleZkPassportVerifierRequest(
      new Request("http://localhost/health"),
      { sharedSecret: "", responseSigningSecret: "", responseSigningKeyId: "" },
    );
    expect(unhealthy.status).toBe(503);
    await expect(unhealthy.json()).resolves.toEqual({ code: "not_configured" });
  });

  test("enforces body cap before SDK invocation", async () => {
    const request = new Request("http://localhost/verify", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleZkPassportVerifierRequest(
      request,
      {
        sharedSecret: "secret",
        responseSigningSecret: "response-secret",
        responseSigningKeyId: "key-2026-08",
        maxBodyBytes: 2,
      },
      { sdkFactory: () => fakeSdk },
    );
    expect(response.status).toBe(413);
  });

  test("rejects caller-selected signing key IDs before local verification", async () => {
    const request = new Request("http://localhost/verify", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ ...body, key_id: "retired-key" }),
    });
    const response = await handleZkPassportVerifierRequest(
      request,
      {
        sharedSecret: "secret",
        responseSigningSecret: "response-secret",
        responseSigningKeyId: "key-2026-08",
      },
      { sdkFactory: () => fakeSdk },
    );
    expect(response.status).toBe(400);
  });

  test("fails closed for an invalid body-cap configuration", async () => {
    const response = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      {
        sharedSecret: "secret",
        responseSigningSecret: "response-secret",
        responseSigningKeyId: "key-2026-08",
        maxBodyBytes: Number.NaN,
      },
      { sdkFactory: () => fakeSdk },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "not_configured" });
  });

  test("rejects a response-signing secret reused as the request bearer", async () => {
    const response = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", {
        method: "POST",
        headers: { authorization: "Bearer shared-secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      {
        sharedSecret: "shared-secret",
        responseSigningSecret: "shared-secret",
        responseSigningKeyId: "key-2026-08",
      },
      { sdkFactory: () => fakeSdk },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "not_configured" });
  });

  test("rejects an invalid configured signing key ID", async () => {
    const response = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", {
        method: "POST",
        headers: { authorization: "Bearer bearer-secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      {
        sharedSecret: "bearer-secret",
        responseSigningSecret: "response-secret",
        responseSigningKeyId: "bad key id",
      },
      { sdkFactory: () => fakeSdk },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "not_configured" });
  });
});
