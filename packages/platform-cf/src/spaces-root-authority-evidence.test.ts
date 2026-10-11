import { describe, expect, it } from "bun:test";
import {
  parseSpacesRootAuthorityEvidenceV1,
  SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES,
} from "./spaces-root-authority-evidence.ts";

import { binary, bytes, fixture } from "./spaces-root-authority-test-fixture.ts";

describe("Spaces root authority response boundary", () => {
  it("accepts production-sized receipt evidence while retaining its digest checks", () => {
    const certificate = binary("r".repeat(224_079));
    const evidence = {
      ...fixture(),
      root_certificate_base64: certificate.base64,
      root_certificate_sha256_hex: certificate.sha256,
    };
    expect(bytes(evidence).byteLength).toBeGreaterThan(65_536);
    expect(parseSpacesRootAuthorityEvidenceV1(bytes(evidence), "yahoo", false).root).toBe("@yahoo");
    expect(() =>
      parseSpacesRootAuthorityEvidenceV1(
        bytes({ ...evidence, root_certificate_sha256_hex: "00".repeat(32) }),
        "yahoo",
        false,
      ),
    ).toThrow();
  });

  it("parses a valid body at the finite maximum and rejects one extra byte", () => {
    const baseline = fixture();
    // A JSON unknown commitment field may be padded without changing checked binary evidence.
    const unpadded = { ...baseline, commitment_count: 1, latest_commitment: { padding: "" } };
    const padding = "r".repeat(
      SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES - bytes(unpadded).byteLength,
    );
    const atLimit = bytes({ ...unpadded, latest_commitment: { padding } });
    expect(atLimit.byteLength).toBe(SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES);
    expect(parseSpacesRootAuthorityEvidenceV1(atLimit, "yahoo", false).root).toBe("@yahoo");
    expect(() =>
      parseSpacesRootAuthorityEvidenceV1(
        bytes({ ...unpadded, latest_commitment: { padding: `${padding}r` } }),
        "yahoo",
        false,
      ),
    ).toThrow();
  });

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
    expect(() =>
      parseSpacesRootAuthorityEvidenceV1(
        bytes({
          ...baseline,
          operator_num_live: true,
          operator_num_outpoint: `${"55".repeat(32)}:0`,
          operator_num_holder_script_pubkey_hex: "not-a-taproot-script",
        }),
        "yahoo",
        false,
      ),
    ).toThrow();
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
      parseSpacesRootAuthorityEvidenceV1(
        new Uint8Array(SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES + 1),
        "yahoo",
        false,
      ),
    ).toThrow();
  });
});
