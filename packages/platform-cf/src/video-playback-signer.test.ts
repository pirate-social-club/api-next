import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeVideoPlaybackSigner } from "./video-playback-signer.ts";

const key = () =>
  crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    false,
    ["sign", "verify"],
  );
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

describe("playback signer with local test keys, not provider acceptance", () => {
  test("signs only the bounded subject, key and expiry claims", async () => {
    const pair = await key();
    const sign = makeVideoPlaybackSigner({
      keyId: "test-key",
      privateKey: pair.privateKey,
      nowSeconds: () => 1000,
    });
    const token = await Effect.runPromise(
      sign({ providerVideoId: "test-video", expiresAtSeconds: 1300 }),
    );
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) throw new Error("compact token required");
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({
      alg: "RS256",
      kid: "test-key",
    });
    expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toEqual({
      sub: "test-video",
      kid: "test-key",
      exp: 1300,
    });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pair.publicKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    for (const expiresAtSeconds of [1000, 1301, Number.NaN]) {
      await expect(
        Effect.runPromise(sign({ providerVideoId: "test-video", expiresAtSeconds })),
      ).rejects.toThrow("Playback signing unavailable");
    }
  });
  test("rejects public signing material and URL subjects", async () => {
    const pair = await key();
    expect(() =>
      makeVideoPlaybackSigner({
        keyId: "test-key",
        privateKey: pair.publicKey,
        nowSeconds: () => 1000,
      }),
    ).toThrow("Invalid playback signing configuration");
    const sign = makeVideoPlaybackSigner({
      keyId: "test-key",
      privateKey: pair.privateKey,
      nowSeconds: () => 1000,
    });
    await expect(
      Effect.runPromise(
        sign({ providerVideoId: "https://example.test/video", expiresAtSeconds: 1300 }),
      ),
    ).rejects.toThrow("Playback signing unavailable");
  });
});
