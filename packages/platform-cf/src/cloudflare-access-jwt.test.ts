import { beforeAll, describe, expect, test } from "bun:test";
import {
  ACCESS_JWKS_CACHE_MAX_SECONDS,
  ACCESS_JWKS_MAX_BYTES,
  CloudflareAccessJwtFailure,
  makeCloudflareAccessJwtValidatorV1,
} from "./cloudflare-access-jwt.ts";

const issuer = "https://pirate-test.cloudflareaccess.com";
const audience = "access-application-audience-01";
const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
let oldKey: CryptoKeyPair;
let rotatedKey: CryptoKeyPair;
let unknownKey: CryptoKeyPair;

beforeAll(async () => {
  const generate = () =>
    crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
  [oldKey, rotatedKey, unknownKey] = await Promise.all([generate(), generate(), generate()]);
});

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function token(
  pair: CryptoKeyPair,
  kid: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid })));
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: issuer,
        aud: audience,
        iat: 1_770_000_000,
        exp: 1_770_000_300,
        ...overrides,
      }),
    ),
  );
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

async function jwk(pair: CryptoKeyPair, kid: string) {
  return {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  };
}

describe("Cloudflare Access JWT policy v1", () => {
  test("validates RS256 issuer, audience, signature, and time claims", async () => {
    const key = await jwk(oldKey, "old-key");
    const validator = makeCloudflareAccessJwtValidatorV1({
      issuer,
      audience,
      jwksUrl,
      clock: { nowUnixSeconds: () => 1_770_000_010 },
      fetchImpl: async () =>
        new Response(JSON.stringify({ keys: [key] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(validator.verify(await token(oldKey, "old-key"))).resolves.toBeUndefined();
    for (const invalid of [
      await token(oldKey, "old-key", { aud: "wrong" }),
      await token(oldKey, "old-key", { iss: "https://wrong.cloudflareaccess.com" }),
      await token(oldKey, "old-key", { exp: 1_769_999_949 }),
      await token(oldKey, "old-key", { nbf: 1_770_000_071 }),
      await token(unknownKey, "old-key"),
    ]) {
      await expect(validator.verify(invalid)).rejects.toBeInstanceOf(CloudflareAccessJwtFailure);
    }
  });

  test("caches success for at most one hour and forces one rotation refetch", async () => {
    const oldJwk = await jwk(oldKey, "old-key");
    const rotatedJwk = await jwk(rotatedKey, "rotated-key");
    let now = 1_770_000_010;
    let calls = 0;
    let served = oldJwk;
    const validator = makeCloudflareAccessJwtValidatorV1({
      issuer,
      audience,
      jwksUrl,
      clock: { nowUnixSeconds: () => now },
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ keys: [served] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await validator.verify(await token(oldKey, "old-key", { exp: 1_770_010_000 }));
    await validator.verify(await token(oldKey, "old-key", { exp: 1_770_010_000 }));
    expect(calls).toBe(1);
    served = rotatedJwk;
    await validator.verify(await token(rotatedKey, "rotated-key", { exp: 1_770_010_000 }));
    expect(calls).toBe(2);
    await expect(
      validator.verify(await token(unknownKey, "still-unknown", { exp: 1_770_010_000 })),
    ).rejects.toBeInstanceOf(CloudflareAccessJwtFailure);
    expect(calls).toBe(3);
    now += ACCESS_JWKS_CACHE_MAX_SECONDS;
    await validator.verify(
      await token(rotatedKey, "rotated-key", { iat: now - 1, exp: now + 300 }),
    );
    expect(calls).toBe(4);
  });

  test("does not cache failures and rejects redirects, HTML, and oversized sets", async () => {
    const key = await jwk(oldKey, "old-key");
    const validToken = await token(oldKey, "old-key");
    let calls = 0;
    let response = new Response("not-json", { headers: { "content-type": "application/json" } });
    const validator = makeCloudflareAccessJwtValidatorV1({
      issuer,
      audience,
      jwksUrl,
      clock: { nowUnixSeconds: () => 1_770_000_010 },
      fetchImpl: async () => {
        calls += 1;
        return response.clone();
      },
    });
    await expect(validator.verify(validToken)).rejects.toBeInstanceOf(CloudflareAccessJwtFailure);
    response = new Response(JSON.stringify({ keys: [key] }), {
      headers: { "content-type": "application/json" },
    });
    await validator.verify(validToken);
    expect(calls).toBe(2);

    for (const invalid of [
      new Response(null, { status: 302, headers: { location: "https://example.test" } }),
      new Response("<html>", { headers: { "content-type": "text/html" } }),
      new Response("x", {
        headers: {
          "content-type": "application/json",
          "content-length": String(ACCESS_JWKS_MAX_BYTES + 1),
        },
      }),
    ]) {
      const rejected = makeCloudflareAccessJwtValidatorV1({
        issuer,
        audience,
        jwksUrl,
        clock: { nowUnixSeconds: () => 1_770_000_010 },
        fetchImpl: async () => invalid,
      });
      await expect(rejected.verify(validToken)).rejects.toBeInstanceOf(CloudflareAccessJwtFailure);
    }
  });

  test("propagates caller abort while a JWKS fetch is pending", async () => {
    const validator = makeCloudflareAccessJwtValidatorV1({
      issuer,
      audience,
      jwksUrl,
      clock: { nowUnixSeconds: () => 1_770_000_010 },
      fetchImpl: () => new Promise<Response>(() => undefined),
    });
    const controller = new AbortController();
    const pending = validator.verify(await token(oldKey, "old-key"), controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
