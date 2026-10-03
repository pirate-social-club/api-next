import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeTelegramOidcClient } from "../../packages/platform-cf/src/telegram-oidc.ts";

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("Telegram login evidence in workerd", () => {
  it.each(["none", "token", "jwks"] as const)(
    "uses native fetch with host-side outbound fixtures: %s",
    async (redirectStage) => {
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const jwk = {
        ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
        kid: "native-fetch-fixture",
        use: "sig",
        alg: "RS256",
      };
      const now = Math.floor(Date.now() / 1000);
      const input = { code: "fixture-code", nonce: "n".repeat(43), verifier: "v".repeat(43) };
      const signingInput = `${encoded({ alg: "RS256", kid: jwk.kid })}.${encoded({
        iss: "https://oauth.telegram.org",
        aud: "10000001",
        sub: "opaque-subject",
        id: 987654321,
        nonce: input.nonce,
        iat: now,
        exp: now + 3600,
      })}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      );
      const token = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
      const configured = await fetch("https://telegram-oidc-fixture.test/configure", {
        method: "POST",
        body: JSON.stringify({ token, jwk, redirectStage }),
      });
      expect(configured.ok).toBe(true);
      // Omit fetcher: both exchange and JWKS must use workerd's real global fetch.
      const client = makeTelegramOidcClient({
        clientId: "10000001",
        clientSecret: "fixture-client-secret",
        redirectUri: "https://web.test/telegram/link/callback",
      });
      if (redirectStage === "none") {
        expect(await Effect.runPromise(client.exchange(input))).toEqual({
          telegramUserId: "987654321",
        });
      } else {
        expect((await Effect.runPromise(Effect.flip(client.exchange(input)))).reason).toBe(
          "provider_unavailable",
        );
      }
      const calls = await (await fetch("https://telegram-oidc-fixture.test/calls")).json();
      expect(calls).toEqual([
        { url: "https://oauth.telegram.org/token", method: "POST", authorization: true },
        ...(redirectStage === "token"
          ? []
          : [
              {
                url: "https://oauth.telegram.org/.well-known/jwks.json",
                method: "GET",
                authorization: false,
              },
            ]),
      ]);
    },
  );

  it("constructs server PKCE material with native Web Crypto", async () => {
    const client = makeTelegramOidcClient({
      clientId: "10000001",
      clientSecret: "fixture-client-secret",
      redirectUri: "https://web.test/telegram/link/callback",
      fetcher: async () => {
        throw new Error("No network in this fixture");
      },
    });
    const result = await Effect.runPromise(client.authorize());
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(result.verifier.length).toBe(43);
    expect(url.searchParams.get("code_challenge")).toBe(
      Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result.verifier)),
      ).toString("base64url"),
    );
    expect(result.authorizationUrl).not.toContain(result.verifier);
  });

  it("verifies native RSA and nonce, strips profile and rejects owner-client tokens", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwk = {
      ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      kid: "fixture",
      use: "sig",
      alg: "RS256",
    };
    const now = Math.floor(Date.now() / 1000);
    const nonce = "n".repeat(43);
    let audience = "10000001";
    const client = makeTelegramOidcClient({
      clientId: audience,
      clientSecret: "fixture-client-secret",
      redirectUri: "https://web.test/telegram/link/callback",
      fetcher: async (url) => {
        if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
        const claims = {
          iss: "https://oauth.telegram.org",
          aud: audience,
          sub: "opaque-subject",
          id: 987654321,
          nonce,
          iat: now,
          exp: now + 3600,
          name: "learner",
          preferred_username: "learner_fixture",
        };
        const signingInput = `${encoded({ alg: "RS256", kid: "fixture" })}.${encoded(claims)}`;
        const signature = await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          pair.privateKey,
          new TextEncoder().encode(signingInput),
        );
        const token = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
        return Response.json({ id_token: token });
      },
    });
    const input = { code: "fixture-code", nonce, verifier: "v".repeat(43) };
    expect(await Effect.runPromise(client.exchange(input))).toEqual({
      telegramUserId: "987654321",
    });
    audience = "20000002";
    expect((await Effect.runPromise(Effect.flip(client.exchange(input)))).reason).toBe(
      "invalid_proof",
    );
  });
});
