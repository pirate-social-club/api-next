ALTER TABLE protocol_issuance_batches
    ADD COLUMN proof_jobs_submitted INTEGER NOT NULL DEFAULT 0 CHECK (proof_jobs_submitted >= 0);
