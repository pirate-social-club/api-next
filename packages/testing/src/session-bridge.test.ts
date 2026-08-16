import { describe, expect, test } from "bun:test";
import {
  inspectSessionToken,
  materializeSessionCorpus,
  PIRATE_SESSION_CONTRACT,
  SESSION_CONFORMANCE_CORPUS,
  verifyOldReferenceBearerSession,
} from "./session-bridge";

describe("session bridge conformance corpus", () => {
  test("keeps every vector source-pinned and distinguishes exchange proofs from bearer sessions", () => {
    expect(SESSION_CONFORMANCE_CORPUS.length).toBe(32);
    for (const vector of SESSION_CONFORMANCE_CORPUS) {
      expect(vector.sourceEvidence.length).toBeGreaterThan(0);
      expect(vector.id).not.toContain("token");
      if (vector.credential.credentialType === "exchange-proof") {
        expect(vector.credential.resultingCredential).toBe("bearer-session");
      }
    }
    expect(
      SESSION_CONFORMANCE_CORPUS.filter((vector) => vector.expectation.oldReference === "accept")
        .length,
    ).toBe(16);
    expect(
      SESSION_CONFORMANCE_CORPUS.filter((vector) => vector.expectation.oldReference === "reject")
        .length,
    ).toBe(16);
    expect(
      SESSION_CONFORMANCE_CORPUS.filter(
        (vector) => vector.expectation.oldReference !== vector.expectation.contract,
      ).length,
    ).toBe(7);
  });

  test("proves old-reference green and red evidence without logging bearer material", async () => {
    const corpus = await materializeSessionCorpus(1_800_000_000);
    const observations = [] as Array<{ id: string; evidence: "green" | "red" }>;

    for (const vector of corpus.vectors) {
      const result = await verifyOldReferenceBearerSession({
        token: vector.token,
        publicKey: vector.verificationKey,
        controlPlane: vector.controlPlane,
        nowSeconds: corpus.nowSeconds,
        ...(vector.requiredScope === undefined ? {} : { requiredScope: vector.requiredScope }),
      });
      const accepted = result.ok;
      expect(accepted ? "accept" : "reject").toBe(vector.expectation.oldReference);
      if (!accepted && vector.expectation.oldFailure) {
        expect(result.failure.code).toBe(vector.expectation.oldFailure);
      }
      if (accepted && vector.expectedPrincipal) {
        expect(result.principal).toMatchObject({
          userId: vector.expectedPrincipal.userId,
          classification: vector.expectedPrincipal.classification,
          scope: { value: vector.expectedPrincipal.scope },
          canonical: { canonicalUserId: vector.expectedPrincipal.canonicalUserId },
        });
      }
      observations.push({ id: vector.id, evidence: accepted ? "green" : "red" });
    }

    expect(observations.filter((observation) => observation.evidence === "green").length).toBe(16);
    expect(observations.filter((observation) => observation.evidence === "red").length).toBe(16);
    expect(
      observations.find((observation) => observation.id === "reject-wrong-public-key")?.evidence,
    ).toBe("red");
    expect(
      observations.find((observation) => observation.id === "reject-wrong-algorithm")?.evidence,
    ).toBe("red");
  });

  test("checks exact valid JWT claims and positive TTL without persisting a key", async () => {
    const nowSeconds = 1_800_000_000;
    const corpus = await materializeSessionCorpus(nowSeconds);
    const valid = corpus.vectors.find(
      (vector) => vector.id === "valid-normal-pirate-application-session",
    );
    if (!valid) throw new Error("valid application vector missing");

    const token = await inspectSessionToken(valid.token);
    expect(token.header).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(token.claims).toMatchObject({
      iss: PIRATE_SESSION_CONTRACT.issuer,
      aud: PIRATE_SESSION_CONTRACT.audience,
      sub: "usr_session_vector",
      scope: PIRATE_SESSION_CONTRACT.defaultScope,
      iat: nowSeconds,
      exp: nowSeconds + PIRATE_SESSION_CONTRACT.defaultTtlSeconds,
    });
    expect((token.claims.exp as number) - (token.claims.iat as number)).toBe(3_600);
    expect(corpus.keyPair.jwks.keys).toHaveLength(1);
    expect(corpus.keyPair.jwks.keys[0]).toMatchObject({
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    });
    const jwk = corpus.keyPair.jwks.keys[0];
    if (!jwk) throw new Error("JWKS verification key missing");
    const thumbprintDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })),
    );
    expect(jwk.kid).toBe(Buffer.from(thumbprintDigest).toString("base64url"));
    expect(jwk).not.toHaveProperty("d");
    expect(jwk.kid).not.toBe(corpus.wrongKeyPair.jwks.keys[0]?.kid);
  });

  test("keeps future-contract gaps explicit instead of faking an api-next verifier", () => {
    const gaps = SESSION_CONFORMANCE_CORPUS.filter(
      (vector) => vector.expectation.oldReference !== vector.expectation.contract,
    ).map((vector) => vector.id);
    expect(gaps).toEqual([
      "reject-wrong-typ-contract",
      "contract-reject-missing-iat",
      "contract-reject-missing-exp",
      "contract-reject-classification-mismatch",
      "contract-reject-missing-canonical-user",
      "contract-reject-malformed-iat",
      "contract-reject-nonstring-scope",
    ]);
  });
});
