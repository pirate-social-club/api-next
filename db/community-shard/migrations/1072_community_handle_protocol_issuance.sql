CREATE TABLE IF NOT EXISTS protocol_issuance_batches (
    protocol_issuance_batch_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    parent_space TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('open', 'processing', 'published', 'failed')
    ),
    worker_checkpoint TEXT NOT NULL CHECK (
        worker_checkpoint IN (
            'pending_stage',
            'staged',
            'batched',
            'committed',
            'proving_submitted',
            'proving_complete',
            'broadcast',
            'confirming',
            'published',
            'failed'
        )
    ),
    subsd_root_before TEXT,
    subsd_root_after TEXT,
    proof_required INTEGER NOT NULL DEFAULT 0 CHECK (proof_required IN (0, 1)),
    runpod_job_id TEXT,
    runpod_status TEXT,
    proof_input_ref TEXT,
    proof_receipt_ref TEXT,
    bitcoin_txid TEXT,
    bitcoin_commit_ref TEXT,
    fabric_submission_ref TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    committed_at TEXT,
    proving_submitted_at TEXT,
    proving_completed_at TEXT,
    broadcast_at TEXT,
    published_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE INDEX IF NOT EXISTS idx_protocol_issuance_batches_parent_checkpoint
    ON protocol_issuance_batches(parent_space, worker_checkpoint, created_at);

CREATE INDEX IF NOT EXISTS idx_protocol_issuance_batches_status
    ON protocol_issuance_batches(status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_issuance_batches_runpod_job
    ON protocol_issuance_batches(runpod_job_id)
    WHERE runpod_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_issuance_batches_bitcoin_tx
    ON protocol_issuance_batches(bitcoin_txid)
    WHERE bitcoin_txid IS NOT NULL;

CREATE TABLE IF NOT EXISTS community_handle_protocol_issuances (
    community_handle_protocol_issuance_id TEXT PRIMARY KEY,
    community_handle_id TEXT NOT NULL,
    protocol_issuance_batch_id TEXT,
    community_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    public_status TEXT NOT NULL CHECK (
        public_status IN ('issuing', 'issued', 'failed')
    ),
    parent_space TEXT NOT NULL,
    sname TEXT NOT NULL,
    script_pubkey_hex TEXT NOT NULL,
    cert_ref TEXT,
    certificate_payload_ref TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    issued_at TEXT,
    FOREIGN KEY (community_handle_id) REFERENCES community_handles(community_handle_id) ON DELETE CASCADE,
    FOREIGN KEY (protocol_issuance_batch_id) REFERENCES protocol_issuance_batches(protocol_issuance_batch_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_issuances_handle_once
    ON community_handle_protocol_issuances(community_handle_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_issuances_sname_active
    ON community_handle_protocol_issuances(parent_space, sname)
    WHERE public_status IN ('issuing', 'issued');

CREATE INDEX IF NOT EXISTS idx_protocol_issuances_pending_parent
    ON community_handle_protocol_issuances(parent_space, public_status, created_at)
    WHERE protocol_issuance_batch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_protocol_issuances_batch
    ON community_handle_protocol_issuances(protocol_issuance_batch_id);
