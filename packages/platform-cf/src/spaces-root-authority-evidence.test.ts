import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { parseSpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const binary = (text: string) => {
  const value = Buffer.from(text);
  return {
    base64: value.toString("base64"),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
};

const fixture = () => {
  const certificate = binary("certificate");
  const proof = binary("chain proof");
  return {
    contract: "spaces-verifier-root-authority-v1",
    network: "mainnet",
    root: "@yahoo",
    outpoint: `${"11".repeat(32)}:1`,
    owner_script_pubkey_hex: `5120${"22".repeat(32)}`,
    owner_xonly_key_hex: "22".repeat(32),
    tip_height: 968544,
    tip_time: 1_790_000_000,
    tip_age_seconds: 300,
    anchor_height: 968544,
    anchor_block_hash: "33".repeat(32),
    operator_num_id: "num1exampleoperator",
    operator_num_live: false,
    operator_num_outpoint: null,
    operator_num_holder_script_pubkey_hex: null,
    reverse_delegation_matches: true,
    latest_commitment: null,
    latest_final_commitment: null,
    commitment_count: 0,
    root_certificate_sha256_hex: certificate.sha256,
    root_certificate_base64: certificate.base64,
    owner_signature_verified: null,
    anchor_bound_outpoint: true,
    proof_anchor_height: 968544,
    proof_anchor_block_hash: "33".repeat(32),
    proof_root_anchor_id_hex: "44".repeat(32),
    certificate_anchor_height: 968544,
    certificate_anchor_block_hash: "33".repeat(32),
    certificate_root_anchor_id_hex: "44".repeat(32),
    chain_proof_sha256_hex: proof.sha256,
    chain_proof_base64: proof.base64,
  };
};

describe("Spaces root authority response boundary", () => {
  it("accepts a checked slot without calling it a live operator", () => {
    expect(
      parseSpacesRootAuthorityEvidenceV1(bytes(fixture()), "yahoo", false).operator_num_live,
    ).toBe(false);
  });

  it("refuses the old wire and inconsistent slot or live-num states", () => {
    const baseline = fixture();
    const { operator_num_live: _live, ...oldWire } = baseline;
    expect(() => parseSpacesRootAuthorityEvidenceV1(bytes(oldWire), "yahoo", false)).toThrow();
    for (const changed of [
      { ...baseline, operator_num_live: true },
      { ...baseline, operator_num_id: null, reverse_delegation_matches: true },
      { ...baseline, operator_num_outpoint: `${"55".repeat(32)}:0` },
      { ...baseline, operator_num_holder_script_pubkey_hex: `5120${"66".repeat(32)}` },
    ]) {
      expect(() => parseSpacesRootAuthorityEvidenceV1(bytes(changed), "yahoo", false)).toThrow();
    }
    expect(
      parseSpacesRootAuthorityEvidenceV1(
        bytes({
          ...baseline,
          operator_num_live: true,
          operator_num_outpoint: `${"55".repeat(32)}:0`,
          operator_num_holder_script_pubkey_hex: `5120${"66".repeat(32)}`,
        }),
        "yahoo",
        false,
      ).operator_num_live,
    ).toBe(true);
  });

  it("rejects changed roots, stale anchors, altered bytes, and false signatures", () => {
    const baseline = fixture();
    for (const changed of [
      { ...baseline, root: "@ceramic" },
      { ...baseline, outpoint: `${"77".repeat(32)}:1`, anchor_bound_outpoint: false },
      { ...baseline, proof_anchor_height: 968507 },
      { ...baseline, tip_height: 968689 },
      { ...baseline, proof_anchor_block_hash: "99".repeat(32) },
      { ...baseline, owner_xonly_key_hex: "88".repeat(32) },
      { ...baseline, chain_proof_base64: binary("tampered").base64 },
      { ...baseline, root_certificate_base64: binary("tampered").base64 },
      { ...baseline, owner_signature_verified: false },
    ]) {
      expect(() => parseSpacesRootAuthorityEvidenceV1(bytes(changed), "yahoo", false)).toThrow();
    }
    expect(() => parseSpacesRootAuthorityEvidenceV1(bytes(baseline), "yahoo", true)).toThrow();
    expect(
      parseSpacesRootAuthorityEvidenceV1(
        bytes({
          ...baseline,
          owner_signature_verified: true,
        }),
        "yahoo",
        true,
      ).owner_signature_verified,
    ).toBe(true);
  });

  it("refuses excess, noncanonical, and oversized response bodies", () => {
    const baseline = fixture();
    expect(() =>
      parseSpacesRootAuthorityEvidenceV1(bytes({ ...baseline, unreviewed: true }), "yahoo", false),
    ).toThrow();
    expect(() =>
      parseSpacesRootAuthorityEvidenceV1(
        new TextEncoder().encode(`${JSON.stringify(baseline)} `),
        "yahoo",
        false,
      ),
    ).toThrow();
    expect(() =>
      parseSpacesRootAuthorityEvidenceV1(new Uint8Array(65_537), "yahoo", false),
    ).toThrow();
  });
});
