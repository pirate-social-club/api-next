-- Match the finite verifier response limit without changing evidence semantics.
ALTER TABLE spaces_owner_proof_ceremonies
  DROP CONSTRAINT spaces_owner_proof_ceremonies_start_verifier_bytes_check,
  ADD CONSTRAINT spaces_owner_proof_ceremonies_start_verifier_bytes_check
    CHECK (octet_length(start_verifier_bytes) BETWEEN 1 AND 1048576);

ALTER TABLE spaces_namespace_authority_evidence
  DROP CONSTRAINT spaces_namespace_authority_evidence_raw_verifier_evidence_check,
  ADD CONSTRAINT spaces_namespace_authority_evidence_raw_verifier_evidence_check
    CHECK (octet_length(raw_verifier_evidence) BETWEEN 1 AND 1048576);
