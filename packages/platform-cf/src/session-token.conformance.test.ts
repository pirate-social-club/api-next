import { describe, expect, test } from "bun:test";
import { IdentityResolutionError, type IdentityStore } from "@pirate/application";
import {
  materializeSessionCorpus,
  PIRATE_SESSION_CONTRACT,
  SESSION_CONFORMANCE_CORPUS,
} from "@pirate/testing";
import { Cause, Effect, Exit, Result } from "effect";
import { makeSessionBridge } from "./session-bridge";
import { makeRs256SessionTokenVerifier, SessionTokenVerificationError } from "./session-tokens";

async function pemFromKey(
  format: "pkcs8" | "spki",
  key: object,
  label: "PRIVATE KEY" | "PUBLIC KEY",
): Promise<string> {
  const exported = await crypto.subtle.exportKey(format, key as CryptoKey);
  const base64 = Buffer.from(exported).toString("base64");
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("expected a failed effect");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected a typed token failure");
  return failure.success;
}

describe("RS256 session layers against Lane B conformance", () => {
  test("covers all five issuance credential shapes", () => {
    const exchangeProofs = new Set(
      SESSION_CONFORMANCE_CORPUS.flatMap((vector) =>
        vector.credential.credentialType === "exchange-proof"
          ? [vector.credential.exchangeProof]
          : [],
      ),
    );
    expect([...exchangeProofs].sort()).toEqual([
      "bot_admin_token",
      "jwt_based_auth",
      "oauth_device_code",
      "telegram_mini_app_init_data",
    ]);
    expect(
      SESSION_CONFORMANCE_CORPUS.some(
        (vector) => vector.credential.credentialType === "bearer-session",
      ),
    ).toBe(true);
  });

  test("accepts and rejects every vector with the real bridge and verifier", async () => {
    const corpus = await materializeSessionCorpus(1_800_000_000);
    const publicPem = await pemFromKey("spki", corpus.keyPair.publicKey, "PUBLIC KEY");
    const wrongPublicPem = await pemFromKey("spki", corpus.wrongKeyPair.publicKey, "PUBLIC KEY");
    const bridges = new Map<string, Awaited<ReturnType<typeof makeSessionBridge>>>();
    bridges.set(
      "valid",
      await makeSessionBridge({ publicKeyPem: publicPem, nowSeconds: () => corpus.nowSeconds }),
    );
    bridges.set(
      "wrong",
      await makeSessionBridge({
        publicKeyPem: wrongPublicPem,
        nowSeconds: () => corpus.nowSeconds,
      }),
    );

    for (const vector of corpus.vectors) {
      const bridge = bridges.get(vector.id === "reject-wrong-public-key" ? "wrong" : "valid");
      if (bridge === undefined) throw new Error("session bridge fixture missing");
      const identityRepository: Pick<IdentityStore["Service"], "resolveCanonical"> = {
        resolveCanonical: () => {
          if (vector.expectedPrincipal !== undefined) {
            return Effect.succeed({
              sourceUserId:
                (vector.recipe.claims?.sub as string | undefined) ?? "usr_session_vector",
              canonicalUserId: vector.expectedPrincipal.canonicalUserId,
              aliasPath: [],
            });
          }
          return Effect.fail(
            new IdentityResolutionError({
              reason:
                vector.expectation.contractFailure === "canonical_alias_invalid"
                  ? "cyclic"
                  : "missing",
            }),
          );
        },
      };
      const verifier = makeRs256SessionTokenVerifier(bridge, identityRepository);
      const result = await Effect.runPromiseExit(
        verifier.verify({
          token: vector.token,
          ...(vector.requiredScope === undefined ? {} : { requiredScope: vector.requiredScope }),
          ...(vector.requiredClassification === undefined
            ? {}
            : { requiredClassification: vector.requiredClassification }),
        }),
      );

      if (vector.expectation.contract === "accept") {
        if (!Exit.isSuccess(result)) throw failureOf(result);
        expect(result.value).toMatchObject({
          userId: vector.expectedPrincipal?.canonicalUserId,
          classification: vector.expectedPrincipal?.classification,
          scope: {
            value: vector.expectedPrincipal?.scope,
          },
        });
      } else {
        const failure = failureOf(result);
        const expectedFailure = vector.expectation.contractFailure;
        if (expectedFailure === undefined) throw new Error("conformance failure code missing");
        expect(failure).toBeInstanceOf(SessionTokenVerificationError);
        expect((failure as SessionTokenVerificationError).code).toBe(expectedFailure);
      }
    }
  });

  test("mints the exact shared claims through the real RS256 layer", async () => {
    const corpus = await materializeSessionCorpus(1_800_000_000);
    const privatePem = await pemFromKey("pkcs8", corpus.keyPair.privateKey, "PRIVATE KEY");
    const publicPem = await pemFromKey("spki", corpus.keyPair.publicKey, "PUBLIC KEY");
    const bridge = await makeSessionBridge({
      privateKeyPem: privatePem,
      publicKeyPem: publicPem,
      nowSeconds: () => corpus.nowSeconds,
    });
    const token = await bridge.sign({
      sub: "usr_session_vector",
      scope: PIRATE_SESSION_CONTRACT.defaultScope,
    });
    expect(await bridge.verify(token)).toMatchObject({
      iss: PIRATE_SESSION_CONTRACT.issuer,
      aud: PIRATE_SESSION_CONTRACT.audience,
      sub: "usr_session_vector",
      scope: PIRATE_SESSION_CONTRACT.defaultScope,
      iat: corpus.nowSeconds,
      exp: corpus.nowSeconds + PIRATE_SESSION_CONTRACT.defaultTtlSeconds,
    });
  });
});
