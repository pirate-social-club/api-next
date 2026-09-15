import { describe, expect, test } from "bun:test";
import {
  ControlPlaneAcquireFailed,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  IdentityResolutionError,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
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

  test("distinguishes missing identities from identity-store availability failures", async () => {
    const failureCode = async (failure: IdentityResolutionError | ControlPlaneError) => {
      const verifier = makeRs256SessionTokenVerifier(crypto("browser-session"), {
        resolveCanonical: () => Effect.fail(failure),
      });
      const exit = await Effect.runPromiseExit(
        verifier.verify({ token: "token", requiredClassification: "user" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error("expected verification failure");
      const typedFailure = Cause.findError(exit.cause);
      if (!Result.isSuccess(typedFailure)) throw new Error("expected typed verification failure");
      return typedFailure.success.code;
    };

    expect(await failureCode(new IdentityResolutionError({ reason: "missing" }))).toBe(
      "control_plane_record_missing",
    );
    expect(await failureCode(new IdentityResolutionError({ reason: "deleted" }))).toBe(
      "control_plane_record_missing",
    );
    for (const failure of [
      new ControlPlaneAcquireFailed({ phase: "acquisition", limitMs: 1_000, elapsedMs: 1_000 }),
      new ControlPlaneStatementFailed({
        label: "resolve-session-identity",
        sqlState: "08006",
        constraint: null,
        outcomeCertainty: "not-started",
      }),
    ]) {
      expect(await failureCode(failure)).toBe("control_plane_unavailable");
    }
  });
});
