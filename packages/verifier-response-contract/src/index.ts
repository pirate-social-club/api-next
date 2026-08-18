/**
 * Generic signed verifier response envelope.  This contract deliberately
 * contains no provider SDK types, so independent verifier runtimes can share
 * one byte-identical canonicalization implementation.
 */
export type SignedVerifierResponseUnsigned = Readonly<{
  readonly proof_session_id: string;
  readonly request_hash: string;
  readonly verdict: boolean;
  readonly unique_identifier: string | null;
  readonly unique_identifier_type: string | number | null;
  readonly protocol_version: string;
  readonly nonce: string;
  readonly expiry: string;
  readonly key_id: string;
}>;

export type SignedVerifierResponseEnvelope = Readonly<
  SignedVerifierResponseUnsigned & {
    readonly signature: string;
  }
>;

/** Property order and null normalization are part of the cross-runtime ABI. */
export function canonicalizeSignedVerifierResponse(value: SignedVerifierResponseUnsigned): string {
  return JSON.stringify({
    proof_session_id: value.proof_session_id,
    request_hash: value.request_hash,
    verdict: value.verdict,
    unique_identifier: value.unique_identifier,
    unique_identifier_type: value.unique_identifier_type,
    protocol_version: value.protocol_version,
    nonce: value.nonce,
    expiry: value.expiry,
    key_id: value.key_id,
  });
}
