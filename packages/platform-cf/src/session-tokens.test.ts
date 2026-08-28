import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SessionCrypto } from "./session-crypto";
import { makeRs256SessionTokenVerifier } from "./session-tokens";

const crypto = (scope: string): SessionCrypto => ({
  issuer: "issuer",
  audience: "audience",
  defaultScope: "browser-session",
  defaultTtlSeconds: 3_600,
  sign: async () => "token",
  verify: async () => ({
    iss: "issuer",
    aud: "audience",
    sub: "account-test",
    scope,
    iat: 1,
    exp: 2,
  }),
  jwks: () => ({
    keys: [
      {
        kty: "RSA",
        kid: "test-key",
        n: "modulus",
        e: "AQAB",
        alg: "RS256",
        use: "sig",
        key_ops: ["verify"],
      },
    ],
  }),
});

const identities = {
  resolveCanonical: ({ sourceUserId }: { readonly sourceUserId: string }) =>
    Effect.succeed({
      sourceUserId,
      canonicalUserId: sourceUserId,
      aliasPath: [sourceUserId],
    }),
};

describe("RS256 session token classification", () => {
  test("admits only explicitly configured non-default user scopes", async () => {
    const setup = makeRs256SessionTokenVerifier(crypto("persona-wallet-setup-v1"), identities, {
      additionalUserScopes: ["persona-wallet-setup-v1"],
    });
    await expect(
      Effect.runPromise(setup.verify({ token: "token", requiredClassification: "user" })),
    ).resolves.toMatchObject({ classification: "user" });

    const unlisted = makeRs256SessionTokenVerifier(crypto("unlisted-scope"), identities, {
      additionalUserScopes: ["persona-wallet-setup-v1"],
    });
    await expect(
      Effect.runPromise(unlisted.verify({ token: "token", requiredClassification: "user" })),
    ).rejects.toMatchObject({ code: "classification_mismatch" });
  });
});
