import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { loadVideoPlaybackSecurity } from "./video-playback-security.ts";

const base = {
  customerHost: "customer-fixture.cloudflarestream.com",
  signingKeyId: "fixture-key",
  signingJwkBase64: "placeholder",
  sourceHmacBase64: btoa("x".repeat(32)),
  namespace: {
    getByName: () => ({ check: async () => ({ allowed: true, retryAfterSeconds: 0 }) }),
  },
  nowSeconds: () => 1000,
};
describe("video access composition security", () => {
  test.each([
    "customerHost",
    "signingKeyId",
    "signingJwkBase64",
    "sourceHmacBase64",
    "namespace",
  ] as const)("missing %s refuses composition", async (name) => {
    await expect(loadVideoPlaybackSecurity({ ...base, [name]: undefined })).rejects.toThrow(
      "binding is required",
    );
  });
  test("imports local-only test material and never requires a provider request", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ["sign", "verify"],
    );
    const jwk = {
      ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
      kid: base.signingKeyId,
    };
    const deployment = { ...base, signingJwkBase64: btoa(JSON.stringify(jwk)) };
    const security = await loadVideoPlaybackSecurity(deployment);
    const token = await Effect.runPromise(
      security.sign({ providerVideoId: "fixture-video", expiresAtSeconds: 1300 }),
    );
    expect(token.split(".")).toHaveLength(3);
    await expect(
      loadVideoPlaybackSecurity({ ...deployment, sourceHmacBase64: btoa("short") }),
    ).rejects.toThrow("HMAC_BASE64 binding is invalid");
    await expect(
      loadVideoPlaybackSecurity({ ...deployment, signingKeyId: "different" }),
    ).rejects.toThrow("JWK_BASE64 binding is invalid");
  });
  test("redacts corrupt key material", async () => {
    await expect(loadVideoPlaybackSecurity(base)).rejects.toThrow(
      "VIDEO_STREAM_SIGNING_JWK_BASE64 binding is invalid",
    );
  });
});
