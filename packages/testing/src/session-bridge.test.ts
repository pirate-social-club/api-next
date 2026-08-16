import { describe, expect, test } from "bun:test";
import { makeSessionBridge } from "../../platform-cf/src/session-bridge";
import { mintWithRealOldApi, verifyWithRealOldApi } from "./real-old-session-verifier";
import {
  inspectSessionToken,
  materializeSessionCorpus,
  PIRATE_SESSION_CONTRACT,
  SESSION_CONFORMANCE_CORPUS,
  verifyOldReferenceBearerSession,
} from "./session-bridge";
import { OLD_API_SESSION_VENDOR } from "./session-bridge-vendor";

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function keyPairPems(
  keyPair: Awaited<ReturnType<typeof materializeSessionCorpus>>["keyPair"],
): Promise<{
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}> {
  return {
    privateKeyPem: toPem(
      "PRIVATE KEY",
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey as CryptoKey),
    ),
    publicKeyPem: toPem(
      "PUBLIC KEY",
      await crypto.subtle.exportKey("spki", keyPair.publicKey as CryptoKey),
    ),
  };
}

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

  test("retains historical characterization evidence without logging bearer material", async () => {
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

  test("runs the complete 32-vector matrix against the vendored old verifier and api-next runtime", async () => {
    const nowSeconds = 1_800_000_000;
    const corpus = await materializeSessionCorpus(nowSeconds);
    const { publicKeyPem } = await keyPairPems(corpus.keyPair);
    const { publicKeyPem: wrongPublicKeyPem } = await keyPairPems(corpus.wrongKeyPair);
    const observations: Array<{
      readonly id: string;
      readonly old: "accept" | "reject";
      readonly apiNext: "accept" | "reject";
    }> = [];

    for (const vector of corpus.vectors) {
      const oldResult = await verifyWithRealOldApi({
        token: vector.token,
        publicKeyPem: vector.id === "reject-wrong-public-key" ? wrongPublicKeyPem : publicKeyPem,
        nowSeconds,
      });
      const bridge = await makeSessionBridge({
        publicKeyPem: vector.id === "reject-wrong-public-key" ? wrongPublicKeyPem : publicKeyPem,
        nowSeconds: () => nowSeconds,
      });
      let apiNext: "accept" | "reject" = "accept";
      try {
        await bridge.verify(vector.token);
      } catch {
        apiNext = "reject";
      }
      observations.push({
        id: vector.id,
        old: oldResult.ok ? "accept" : "reject",
        apiNext,
      });
    }

    expect(observations).toHaveLength(32);
    expect(observations.filter((row) => row.old !== row.apiNext)).toEqual([
      { id: "valid-default-scope-when-omitted", old: "accept", apiNext: "reject" },
      { id: "valid-default-scope-when-empty", old: "accept", apiNext: "reject" },
    ]);
    expect(observations.filter((row) => row.old === "accept")).toHaveLength(15);
    expect(observations.filter((row) => row.old === "reject")).toHaveLength(17);
    expect(OLD_API_SESSION_VENDOR.sourceCommit).toBe("0b44698b0bdc16c057f9a8d33b61f8336d730abc");
  });

  test("proves both mint/verify directions for all five old issuance-site claim shapes", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000) + 10;
    const corpus = await materializeSessionCorpus(nowSeconds);
    const { privateKeyPem, publicKeyPem } = await keyPairPems(corpus.keyPair);
    const bridge = await makeSessionBridge({
      privateKeyPem,
      publicKeyPem,
      nowSeconds: () => nowSeconds,
    });
    const claimKeys = ["iss", "aud", "sub", "scope", "iat", "exp"] as const;

    for (const [index, site] of OLD_API_SESSION_VENDOR.issuanceSites.entries()) {
      const userId = `usr_issuance_${index}`;
      const scope = site.scopeInput === "requested" ? "profile:read" : undefined;
      const oldToken = await mintWithRealOldApi({
        privateKeyPem,
        userId,
        nowSeconds,
        ...(scope === undefined ? {} : { scope }),
      });
      const oldClaims = await inspectSessionToken(oldToken);
      expect(Object.keys(oldClaims.claims).sort()).toEqual([...claimKeys].sort());
      expect(site.claimShape).toEqual(claimKeys);
      const verifiedOldToken = await bridge.verify(oldToken);
      expect(verifiedOldToken).toMatchObject({
        iss: PIRATE_SESSION_CONTRACT.issuer,
        aud: PIRATE_SESSION_CONTRACT.audience,
        sub: userId,
        scope: scope ?? PIRATE_SESSION_CONTRACT.defaultScope,
      });
      expect(verifiedOldToken.iat).toBe(oldClaims.claims.iat as number);
      expect(verifiedOldToken.exp).toBe(oldClaims.claims.exp as number);

      const apiNextToken = await bridge.sign({
        sub: userId,
        scope: scope ?? PIRATE_SESSION_CONTRACT.defaultScope,
        iat: nowSeconds,
        exp: nowSeconds + PIRATE_SESSION_CONTRACT.defaultTtlSeconds,
      });
      await expect(
        verifyWithRealOldApi({ token: apiNextToken, publicKeyPem, nowSeconds }),
      ).resolves.toEqual({
        ok: true,
        value: {
          userId,
          scope: scope ?? PIRATE_SESSION_CONTRACT.defaultScope,
        },
      });
    }
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
