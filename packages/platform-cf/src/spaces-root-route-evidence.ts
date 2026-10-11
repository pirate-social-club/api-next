import { createHash } from "node:crypto";
import { Schema } from "effect";

/** Bounds the complete JSON response, including the base64 chain proof. */
export const SPACES_ROOT_ROUTE_MAX_RESPONSE_BYTES = 1_048_576;

const hex64 = /^[0-9a-f]{64}$/u;
const script = /^5120([0-9a-f]{64})$/u;
const outpoint = /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/u;
const nonnegative = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a nonnegative safe integer",
  ),
);

/**
 * The ownership-only verifier wire. It carries no certificate, commitment or
 * operator field: a community address depends only on who owns the root.
 */
const RootRouteEvidence = Schema.Struct({
  contract: Schema.Literal("spaces-verifier-root-route-v1"),
  network: Schema.Literal("mainnet"),
  root: Schema.String,
  outpoint: Schema.String,
  owner_script_pubkey_hex: Schema.String,
  owner_xonly_key_hex: Schema.String,
  expire_height: nonnegative,
  tip_height: nonnegative,
  tip_time: nonnegative,
  tip_age_seconds: nonnegative,
  anchor_height: nonnegative,
  anchor_block_hash: Schema.String,
  anchor_bound_outpoint: Schema.Literal(true),
  proof_anchor_height: nonnegative,
  proof_anchor_block_hash: Schema.String,
  proof_root_anchor_id_hex: Schema.String,
  chain_proof_sha256_hex: Schema.String,
  chain_proof_base64: Schema.String,
  owner_signature_verified: Schema.NullOr(Schema.Boolean),
});

export type SpacesRootRouteEvidenceV1 = Schema.Schema.Type<typeof RootRouteEvidence>;

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
 * Checks the verifier's response shape and internal consistency. It does not
 * re-verify the chain proof or the owner's signature; the verifier does.
 */
export function parseSpacesRootRouteEvidenceV1(
  responseBytes: Uint8Array,
  canonicalRoot: string,
  signatureExpected: boolean,
): SpacesRootRouteEvidenceV1 {
  const unavailable = () => new TypeError("Spaces root route evidence is unavailable");
  if (
    responseBytes.byteLength === 0 ||
    responseBytes.byteLength > SPACES_ROOT_ROUTE_MAX_RESPONSE_BYTES
  ) {
    throw unavailable();
  }
  let evidence: SpacesRootRouteEvidenceV1;
  try {
    const responseText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      responseBytes,
    );
    const parsed: unknown = JSON.parse(responseText);
    evidence = Schema.decodeUnknownSync(RootRouteEvidence, { onExcessProperty: "error" })(parsed);
    if (responseText !== JSON.stringify(parsed)) throw new Error("noncanonical JSON");
  } catch {
    throw unavailable();
  }
  if (
    evidence.root !== `@${canonicalRoot}` ||
    !outpoint.test(evidence.outpoint) ||
    !hex64.test(evidence.owner_xonly_key_hex) ||
    script.exec(evidence.owner_script_pubkey_hex)?.[1] !== evidence.owner_xonly_key_hex ||
    ![
      evidence.anchor_block_hash,
      evidence.proof_anchor_block_hash,
      evidence.proof_root_anchor_id_hex,
    ].every((value) => hex64.test(value)) ||
    evidence.proof_anchor_height > evidence.anchor_height ||
    evidence.anchor_height > evidence.tip_height ||
    evidence.tip_height - evidence.proof_anchor_height > 144 ||
    (evidence.proof_anchor_height === evidence.anchor_height &&
      evidence.proof_anchor_block_hash !== evidence.anchor_block_hash) ||
    evidence.expire_height <= evidence.tip_height ||
    evidence.tip_age_seconds > 21_600 ||
    !digestMatchesBase64(evidence.chain_proof_base64, evidence.chain_proof_sha256_hex) ||
    (signatureExpected && evidence.owner_signature_verified !== true) ||
    (!signatureExpected && evidence.owner_signature_verified !== null)
  ) {
    throw unavailable();
  }
  return evidence;
}
