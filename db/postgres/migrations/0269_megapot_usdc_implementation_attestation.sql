-- Preserve the implementation identity observed during production attestation.
-- Test and staging rows may omit it; production rows must carry both fields.
ALTER TABLE megapot_deployment_attestations
  ADD COLUMN usdc_implementation_address TEXT,
  ADD COLUMN usdc_implementation_code_hash TEXT,
  ADD CONSTRAINT megapot_usdc_implementation_pair CHECK (
    (usdc_implementation_address IS NULL AND usdc_implementation_code_hash IS NULL)
    OR (
      usdc_implementation_address IS NOT NULL
      AND usdc_implementation_code_hash IS NOT NULL
      AND
      usdc_implementation_address ~ '^0x[0-9a-f]{40}$'
      AND usdc_implementation_address <> '0x0000000000000000000000000000000000000000'
      AND usdc_implementation_code_hash ~ '^0x[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT megapot_production_usdc_implementation_required CHECK (
    environment <> 'production'
    OR (usdc_implementation_address IS NOT NULL AND usdc_implementation_code_hash IS NOT NULL)
  );
