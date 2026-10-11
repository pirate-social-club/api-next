import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { makeSpacesRootRouteObserver } from "./spaces-root-authority-observer.ts";
import {
  parseSpacesRootRouteEvidenceV1,
  type SpacesRootRouteEvidenceV1,
} from "./spaces-root-route-evidence.ts";

const key = "ab".repeat(32);
const proof = Buffer.from("proof");
const fixture = (): SpacesRootRouteEvidenceV1 => ({
  contract: "spaces-verifier-root-route-v1",
  network: "mainnet",
  root: "@yahoo",
  outpoint: `${"22".repeat(32)}:1`,
  owner_script_pubkey_hex: `5120${key}`,
  owner_xonly_key_hex: key,
  expire_height: 1_020_000,
  tip_height: 970_300,
  tip_time: 1,
  tip_age_seconds: 1,
  anchor_height: 970_296,
  anchor_block_hash: "44".repeat(32),
  anchor_bound_outpoint: true,
  proof_anchor_height: 970_296,
  proof_anchor_block_hash: "44".repeat(32),
  proof_root_anchor_id_hex: "66".repeat(32),
  chain_proof_sha256_hex: createHash("sha256").update(proof).digest("hex"),
  chain_proof_base64: proof.toString("base64"),
  owner_signature_verified: null,
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("Spaces root route evidence", () => {
  test("accepts the ownership-only wire and nothing from the issuance wire", () => {
    expect(parseSpacesRootRouteEvidenceV1(bytes(fixture()), "yahoo", false)).toEqual(fixture());
    expect(() =>
      parseSpacesRootRouteEvidenceV1(bytes({ ...fixture(), commitment_count: 0 }), "yahoo", false),
    ).toThrow();
    expect(() =>
      parseSpacesRootRouteEvidenceV1(
        bytes({ ...fixture(), contract: "spaces-verifier-root-authority-v1" }),
        "yahoo",
        false,
      ),
    ).toThrow();
  });

  test("refuses another root, an expired root, a stale proof and a mismatched signature state", () => {
    const refused: readonly (readonly [Partial<SpacesRootRouteEvidenceV1>, string, boolean])[] = [
      [{}, "csca", false],
      [{ expire_height: 970_300 }, "yahoo", false],
      [{ proof_anchor_height: 970_100 }, "yahoo", false],
      [{ owner_xonly_key_hex: "cd".repeat(32) }, "yahoo", false],
      [{ chain_proof_sha256_hex: "00".repeat(32) }, "yahoo", false],
      [{ tip_age_seconds: 21_601 }, "yahoo", false],
      [{}, "yahoo", true],
      [{ owner_signature_verified: true }, "yahoo", false],
    ];
    for (const [change, root, signed] of refused) {
      expect(() =>
        parseSpacesRootRouteEvidenceV1(bytes({ ...fixture(), ...change }), root, signed),
      ).toThrow("Spaces root route evidence is unavailable");
    }
    expect(
      parseSpacesRootRouteEvidenceV1(
        bytes({ ...fixture(), owner_signature_verified: true }),
        "yahoo",
        true,
      ).owner_signature_verified,
    ).toBe(true);
  });

  test("the route observer calls only the ownership-only verifier route", async () => {
    const seen: string[] = [];
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(`${String(input)} ${String(init?.body)}`);
        return new Response(bytes(fixture()));
      },
      {
        preconnect: () => {
          throw new Error("Unexpected test preconnection");
        },
      },
    );
    const observer = makeSpacesRootRouteObserver(
      { accessClientId: "id", accessClientSecret: "secret", bearerToken: "bearer" },
      fetchImpl,
    );
    const result = await observer.observe({ canonicalRoot: "yahoo" });
    expect(result.kind).toBe("verified");
    expect(seen).toEqual([
      'https://spaces-verifier.pirate.sc/v1/observe-root-route {"root":"@yahoo"}',
    ]);
  });
});
