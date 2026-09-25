import { createHash } from "node:crypto";
import { Schema } from "effect";

const hex64 = /^[0-9a-f]{64}$/u;
const script = /^5120([0-9a-f]{64})$/u;
const outpoint = /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/u;
const nonnegative = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a nonnegative safe integer",
  ),
);

/** The complete top-level shape of the independently checked authority wire. */
const RootAuthorityEvidence = Schema.Struct({
  contract: Schema.Literal("spaces-verifier-root-authority-v1"),
  network: Schema.Literal("mainnet"),
  root: Schema.String,
  outpoint: Schema.String,
  owner_script_pubkey_hex: Schema.String,
  owner_xonly_key_hex: Schema.String,
  tip_height: nonnegative,
  tip_time: nonnegative,
  tip_age_seconds: nonnegative,
  anchor_height: nonnegative,
  anchor_block_hash: Schema.String,
  operator_num_id: Schema.NullOr(Schema.String),
  operator_num_live: Schema.Boolean,
  operator_num_outpoint: Schema.NullOr(Schema.String),
  operator_num_holder_script_pubkey_hex: Schema.NullOr(Schema.String),
  reverse_delegation_matches: Schema.Boolean,
  latest_commitment: Schema.Unknown,
  latest_final_commitment: Schema.Unknown,
  commitment_count: nonnegative,
  root_certificate_sha256_hex: Schema.String,
  root_certificate_base64: Schema.String,
  owner_signature_verified: Schema.NullOr(Schema.Boolean),
  anchor_bound_outpoint: Schema.Literal(true),
  proof_anchor_height: nonnegative,
  proof_anchor_block_hash: Schema.String,
  proof_root_anchor_id_hex: Schema.String,
  certificate_anchor_height: nonnegative,
  certificate_anchor_block_hash: Schema.String,
  certificate_root_anchor_id_hex: Schema.String,
  chain_proof_sha256_hex: Schema.String,
  chain_proof_base64: Schema.String,
});

export type SpacesRootAuthorityEvidenceV1 = Schema.Schema.Type<typeof RootAuthorityEvidence>;

function digestMatchesBase64(encoded: string, expectedHex: string): boolean {
  if (
    !hex64.test(expectedHex) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    return false;
  }
  const bytes = Buffer.from(encoded, "base64");
  return (
    bytes.length > 0 &&
    bytes.toString("base64") === encoded &&
    createHash("sha256").update(bytes).digest("hex") === expectedHex
  );
}

/**
 * Rejects the old authority response, mixed slot/live-num states, changed
 * roots, unanchored proof, and evidence whose bytes do not match its digests.
 * This parser checks the verifier's response shape; it does not independently
 * verify the chain proof or the owner's Schnorr signature.
 */
export function parseSpacesRootAuthorityEvidenceV1(
  responseBytes: Uint8Array,
  canonicalRoot: string,
  signatureExpected: boolean,
): SpacesRootAuthorityEvidenceV1 {
  if (responseBytes.byteLength === 0 || responseBytes.byteLength > 65_536) {
    throw new TypeError("Spaces root authority evidence is unavailable");
  }
  let evidence: SpacesRootAuthorityEvidenceV1;
  try {
    const responseText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      responseBytes,
    );
    const parsed: unknown = JSON.parse(responseText);
    evidence = Schema.decodeUnknownSync(RootAuthorityEvidence, { onExcessProperty: "error" })(
      parsed,
    );
    if (responseText !== JSON.stringify(parsed)) throw new Error("noncanonical JSON");
  } catch {
    throw new TypeError("Spaces root authority evidence is unavailable");
  }

  const slot = evidence.operator_num_id;
  const live = evidence.operator_num_live;
  const liveOutpoint = evidence.operator_num_outpoint;
  const holderScript = evidence.operator_num_holder_script_pubkey_hex;
  const validSlot = slot === null || /^num1[a-z0-9]{8,120}$/u.test(slot);
  const slotState = live
    ? slot !== null &&
      liveOutpoint !== null &&
      outpoint.test(liveOutpoint) &&
      holderScript !== null &&
      script.test(holderScript) !== null &&
      evidence.reverse_delegation_matches
    : liveOutpoint === null &&
      holderScript === null &&
      evidence.reverse_delegation_matches === (slot !== null);
  if (
    evidence.root !== `@${canonicalRoot}` ||
    !outpoint.test(evidence.outpoint) ||
    !hex64.test(evidence.owner_xonly_key_hex) ||
    script.exec(evidence.owner_script_pubkey_hex)?.[1] !== evidence.owner_xonly_key_hex ||
    !validSlot ||
    !slotState ||
    ![
      evidence.anchor_block_hash,
      evidence.proof_anchor_block_hash,
      evidence.proof_root_anchor_id_hex,
      evidence.certificate_anchor_block_hash,
      evidence.certificate_root_anchor_id_hex,
    ].every((value) => hex64.test(value)) ||
    evidence.proof_anchor_height < evidence.certificate_anchor_height ||
    evidence.proof_anchor_height > evidence.anchor_height ||
    evidence.anchor_height > evidence.tip_height ||
    evidence.tip_height - evidence.proof_anchor_height > 144 ||
    (evidence.proof_anchor_height === evidence.anchor_height &&
      evidence.proof_anchor_block_hash !== evidence.anchor_block_hash) ||
    (evidence.proof_anchor_height === evidence.certificate_anchor_height &&
      evidence.proof_anchor_block_hash !== evidence.certificate_anchor_block_hash) ||
    evidence.tip_age_seconds > 21_600 ||
    (evidence.commitment_count === 0 &&
      (evidence.latest_commitment !== null || evidence.latest_final_commitment !== null)) ||
    !digestMatchesBase64(evidence.root_certificate_base64, evidence.root_certificate_sha256_hex) ||
    !digestMatchesBase64(evidence.chain_proof_base64, evidence.chain_proof_sha256_hex) ||
    (signatureExpected && evidence.owner_signature_verified !== true) ||
    (!signatureExpected && evidence.owner_signature_verified !== null)
  ) {
    throw new TypeError("Spaces root authority evidence is unavailable");
  }
  return evidence;
}
