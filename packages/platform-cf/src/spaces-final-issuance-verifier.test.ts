import { describe, expect, test } from "bun:test";
import type { SpacesVerificationTargetV1 } from "@pirate/application";
import { Effect } from "effect";
import { makeSpacesFinalIssuanceVerifier } from "./spaces-final-issuance-verifier.ts";

const target: SpacesVerificationTargetV1 = {
  claim_id: "claim-1",
  lease_token: "lease-1",
  network: "mainnet",
  namespace_root: "xn--fn8h",
  handle_label: "membername",
  script_pubkey_hex: `5120${"1".repeat(64)}`,
};
const credentials = {
  accessClientId: "id-for-test",
  accessClientSecret: "secret-for-test",
  bearerToken: "bearer-for-test",
};
const finalEvidence = {
  contract: "spaces-verifier-v1",
  network: "mainnet",
  name: "membername@xn--fn8h",
  root: "@xn--fn8h",
  recipient_script_pubkey_hex: target.script_pubkey_hex,
  tip_height: 1000,
  tip_age_seconds: 60,
  commitment_height: 800,
  commitment_root_hex: "a".repeat(64),
  certificate_sha256_hex: "b".repeat(64),
};

describe("Spaces final issuance verifier adapter", () => {
  test("binds the exact name and recipient to final independent evidence", async () => {
    const verifier = makeSpacesFinalIssuanceVerifier(credentials, async (url, init) => {
      expect(url).toBe("https://spaces-verifier.pirate.sc/v1/verify-name");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({
        "CF-Access-Client-Id": credentials.accessClientId,
        authorization: `Bearer ${credentials.bearerToken}`,
      });
      expect(JSON.parse(String(init.body))).toEqual({
        root: "@xn--fn8h",
        name: "membername@xn--fn8h",
        recipient_script_pubkey_hex: target.script_pubkey_hex,
      });
      return Response.json(finalEvidence);
    });
    const result = await Effect.runPromise(verifier.verify(target));
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.evidence.mined_height).toBe(800);
      expect(result.evidence.verified_tip_height).toBe(1000);
      expect(result.evidence.commitment_root_hex).toBe("a".repeat(64));
    }
  });

  test("a missing final certificate remains pending after both checks", async () => {
    const paths: string[] = [];
    const verifier = makeSpacesFinalIssuanceVerifier(credentials, async (url, init) => {
      paths.push(url);
      if (url.endsWith("/v1/observe-name")) {
        expect(JSON.parse(String(init.body))).toEqual({
          root: "@xn--fn8h",
          name: "membername@xn--fn8h",
        });
      }
      return Response.json({ error: "chain_fact_conflict" }, { status: 409 });
    });
    expect(await Effect.runPromise(verifier.verify(target))).toEqual({ kind: "pending" });
    expect(paths).toEqual([
      "https://spaces-verifier.pirate.sc/v1/verify-name",
      "https://spaces-verifier.pirate.sc/v1/observe-name",
    ]);
  });

  test("records a different recipient only after a final observed certificate", async () => {
    const otherScript = `5120${"2".repeat(64)}`;
    const verifier = makeSpacesFinalIssuanceVerifier(credentials, async (url) =>
      url.endsWith("/v1/verify-name")
        ? Response.json({ error: "chain_fact_conflict" }, { status: 409 })
        : Response.json({
            ...finalEvidence,
            contract: "spaces-verifier-name-observation-v1",
            recipient_script_pubkey_hex: otherScript,
          }),
    );
    const result = await Effect.runPromise(verifier.verify(target));
    expect(result.kind).toBe("occupied_other");
    if (result.kind === "occupied_other") {
      expect(result.observed_script_pubkey_hex).toBe(otherScript);
      expect(result.evidence.verifier_version).toBe("spaces-verifier-name-observation-v1");
    }
  });

  test("a verified observation with the requested recipient can finalize after a racing 409", async () => {
    const verifier = makeSpacesFinalIssuanceVerifier(credentials, async (url) =>
      url.endsWith("/v1/verify-name")
        ? Response.json({ error: "chain_fact_conflict" }, { status: 409 })
        : Response.json({ ...finalEvidence, contract: "spaces-verifier-name-observation-v1" }),
    );
    expect((await Effect.runPromise(verifier.verify(target))).kind).toBe("final");
  });

  test("refuses malformed conflict evidence and a missing observation endpoint", async () => {
    for (const observed of [
      { ...finalEvidence, contract: "spaces-verifier-name-observation-v1", name: "other@xn--fn8h" },
      { ...finalEvidence, contract: "spaces-verifier-name-observation-v1", commitment_height: 856 },
      {
        ...finalEvidence,
        contract: "spaces-verifier-name-observation-v1",
        recipient_script_pubkey_hex: "0014bad",
      },
    ]) {
      const verifier = makeSpacesFinalIssuanceVerifier(credentials, async (url) =>
        url.endsWith("/v1/verify-name")
          ? Response.json({ error: "chain_fact_conflict" }, { status: 409 })
          : Response.json(observed),
      );
      expect(Effect.runPromise(verifier.verify(target))).rejects.toThrow(
        "Spaces final verification unavailable",
      );
    }
    const olderVerifier = makeSpacesFinalIssuanceVerifier(
      credentials,
      async (url) => new Response(null, { status: url.endsWith("/v1/verify-name") ? 409 : 404 }),
    );
    expect(Effect.runPromise(olderVerifier.verify(target))).rejects.toThrow(
      "Spaces final verification unavailable",
    );
  });

  test("refuses stale, wrong-recipient, and nonfinal evidence", async () => {
    for (const evidence of [
      { ...finalEvidence, name: "othername@xn--fn8h" },
      { ...finalEvidence, recipient_script_pubkey_hex: `5120${"2".repeat(64)}` },
      { ...finalEvidence, commitment_height: 856 },
      { ...finalEvidence, tip_age_seconds: 10_801 },
    ]) {
      const verifier = makeSpacesFinalIssuanceVerifier(credentials, async () =>
        Response.json(evidence),
      );
      expect(Effect.runPromise(verifier.verify(target))).rejects.toThrow(
        "Spaces final verification unavailable",
      );
    }
  });

  test("refuses network mismatches and Access failures", async () => {
    const verifier = makeSpacesFinalIssuanceVerifier(
      credentials,
      async () => new Response(null, { status: 403 }),
    );
    expect(Effect.runPromise(verifier.verify(target))).rejects.toThrow(
      "Spaces final verification unavailable",
    );
    expect(Effect.runPromise(verifier.verify({ ...target, network: "regtest" }))).rejects.toThrow(
      "Spaces final verification unavailable",
    );
  });
});
