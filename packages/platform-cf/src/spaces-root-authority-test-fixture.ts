import { createHash } from "node:crypto";

export const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const binary = (text: string) => {
  const value = Buffer.from(text);
  return {
    base64: value.toString("base64"),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
};

export const fixture = () => {
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
