import { describe, expect, test } from "bun:test";
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
};

const fakeSdk = {
  verify: async () => ({
    verified: true,
    uniqueIdentifier: "never-log-this",
    uniqueIdentifierType: 0 as const,
  }),
};

describe("ZKPassport verifier runtime", () => {
  test("uses injected local SDK core and returns a bounded result", async () => {
    await expect(verifyLocally(body, { sdkFactory: () => fakeSdk })).resolves.toEqual({
      verified: true,
      uniqueIdentifier: "never-log-this",
      uniqueIdentifierType: 0,
    });
  });

  test("health is public and verify requires bearer auth", async () => {
    const health = await handleZkPassportVerifierRequest(new Request("http://localhost/health"), {
      sharedSecret: "secret",
    });
    expect(health.status).toBe(200);
    const unauthorized = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", { method: "POST", body: JSON.stringify(body) }),
      { sharedSecret: "secret" },
    );
    expect(unauthorized.status).toBe(401);
    const missingConfig = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", { method: "POST", body: JSON.stringify(body) }),
      { sharedSecret: "" },
    );
    expect(missingConfig.status).toBe(503);
  });

  test("enforces body cap before SDK invocation", async () => {
    const request = new Request("http://localhost/verify", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleZkPassportVerifierRequest(
      request,
      { sharedSecret: "secret", maxBodyBytes: 2 },
      { sdkFactory: () => fakeSdk },
    );
    expect(response.status).toBe(413);
  });

  test("fails closed for an invalid body-cap configuration", async () => {
    const response = await handleZkPassportVerifierRequest(
      new Request("http://localhost/verify", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { sharedSecret: "secret", maxBodyBytes: Number.NaN },
      { sdkFactory: () => fakeSdk },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "not_configured" });
  });
});
