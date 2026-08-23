export type StagingOperation = Readonly<{
  called: boolean;
  status: number | null;
  code: string | null;
}>;

export type StagingHeadEvidence = StagingOperation &
  Readonly<{
    etag: string | null;
    size_bytes: number | null;
    content_type: string | null;
    checksum_sha256: string | null;
    version_id: string | null;
  }>;

export type StagingCleanupKey = Readonly<{
  key: string;
  ownership: "confirmed" | "ambiguous";
  candidate_verified: boolean;
  verification: StagingOperation;
  residual_reason:
    | "none"
    | "not-found"
    | "metadata-mismatch"
    | "checksum-unavailable"
    | "etag-unavailable"
    | "delete-failed"
    | "absence-check-failed";
  delete: StagingOperation;
  absence: StagingOperation;
  absent: boolean;
}>;

export type StagingEvidence = Readonly<{
  schema_version: "r2-seal-staging-evidence-v1";
  run: Readonly<{
    run_id: string;
    started_at: string;
    completed_at: string;
    deterministic: false;
  }>;
  account_id: string;
  bucket: string;
  prefix: string;
  source_key: string;
  destination_key: string;
  mode: "staging-execute";
  transport: "r2-s3-sigv4";
  provider_contacted: true;
  credentials_read: true;
  preflight: Readonly<{
    source: StagingHeadEvidence;
    destination: StagingHeadEvidence;
    safe_to_write: boolean;
  }>;
  upload: Readonly<{
    called: boolean;
    status: number | null;
    code: string | null;
    etag: string | null;
    checksum_sha256: string | null;
    version_id: string | null;
    owned_after_success: boolean;
    ownership: "confirmed" | "ambiguous" | "none";
  }>;
  sealing: Readonly<{
    outcome:
      | "success"
      | "source_missing"
      | "expectation_mismatch"
      | "conditional_precondition_ambiguous"
      | "verification_mismatch"
      | "provider_response_unknown"
      | "transport_error";
    source_head: StagingHeadEvidence;
    conditional_copy: StagingOperation &
      Readonly<{
        etag: string | null;
        checksum_sha256: string | null;
        version_id: string | null;
        source_version_id: string | null;
      }>;
    destination_head: StagingHeadEvidence | null;
    automatic_retry: false;
    destination_verified: boolean;
  }>;
  metadata: Readonly<{
    source_etag: string | null;
    destination_etag: string | null;
    source_checksum_sha256: Readonly<{ available: boolean; value: string | null }>;
    destination_checksum_sha256: Readonly<{ available: boolean; value: string | null }>;
    source_version_id: string | null;
    destination_version_id: string | null;
    version_binding: "matched" | "unavailable" | "mismatch";
  }>;
  cleanup: Readonly<{
    status: "complete" | "partial" | "not-attempted";
    attempted: boolean;
    keys: readonly StagingCleanupKey[];
    bucket_deleted: false;
  }>;
  safety: Readonly<{
    acknowledged_execute_flag: true;
    shared_412_is_ambiguous: true;
    conditional_copy_is_never_retried: true;
    post_412_destination_head: false;
    destination_head_only_after_copy_success: true;
    preexisting_keys_fail_closed: true;
    cleanup_is_exact_run_owned_keys: true;
    bucket_was_not_created_or_deleted: true;
    ambiguous_mutation_candidates_fail_closed: true;
    secrets_emitted: false;
    urls_headers_bodies_emitted: false;
  }>;
  remaining_decisions: readonly string[];
}>;

const FORBIDDEN_VALUE =
  /(?:https?:\/\/|authorization|x-amz-(?:credential|signature)|(?:credential|signature)=|[\r\n])/i;
const SAFE_ID = /^.{1,512}$/s;

function safeValue(value: string | null, field: string): string | null {
  if (value !== null && (FORBIDDEN_VALUE.test(value) || !SAFE_ID.test(value))) {
    throw new Error(`unsafe ${field} value refused by staging evidence allowlist`);
  }
  return value;
}

function operation(value: StagingOperation): StagingOperation {
  return {
    called: value.called,
    status: value.status,
    code: safeValue(value.code, "operation.code"),
  };
}

function head(value: StagingHeadEvidence): StagingHeadEvidence {
  return {
    ...operation(value),
    etag: safeValue(value.etag, "head.etag"),
    size_bytes: value.size_bytes,
    content_type: safeValue(value.content_type, "head.content_type"),
    checksum_sha256: safeValue(value.checksum_sha256, "head.checksum_sha256"),
    version_id: safeValue(value.version_id, "head.version_id"),
  };
}

function cleanUpKey(value: StagingCleanupKey): StagingCleanupKey {
  return {
    key: safeValue(value.key, "cleanup.key") ?? "",
    ownership: value.ownership,
    candidate_verified: value.candidate_verified,
    verification: operation(value.verification),
    residual_reason: value.residual_reason,
    delete: operation(value.delete),
    absence: operation(value.absence),
    absent: value.absent,
  };
}

/** Project live evidence through a closed key and value allowlist. */
export function redactStagingEvidence(input: StagingEvidence): StagingEvidence {
  return {
    schema_version: "r2-seal-staging-evidence-v1",
    run: {
      run_id: safeValue(input.run.run_id, "run.run_id") ?? "",
      started_at: safeValue(input.run.started_at, "run.started_at") ?? "",
      completed_at: safeValue(input.run.completed_at, "run.completed_at") ?? "",
      deterministic: false,
    },
    account_id: safeValue(input.account_id, "account_id") ?? "",
    bucket: safeValue(input.bucket, "bucket") ?? "",
    prefix: safeValue(input.prefix, "prefix") ?? "",
    source_key: safeValue(input.source_key, "source_key") ?? "",
    destination_key: safeValue(input.destination_key, "destination_key") ?? "",
    mode: "staging-execute",
    transport: "r2-s3-sigv4",
    provider_contacted: true,
    credentials_read: true,
    preflight: {
      source: head(input.preflight.source),
      destination: head(input.preflight.destination),
      safe_to_write: input.preflight.safe_to_write,
    },
    upload: {
      called: input.upload.called,
      status: input.upload.status,
      code: safeValue(input.upload.code, "upload.code"),
      etag: safeValue(input.upload.etag, "upload.etag"),
      checksum_sha256: safeValue(input.upload.checksum_sha256, "upload.checksum_sha256"),
      version_id: safeValue(input.upload.version_id, "upload.version_id"),
      owned_after_success: input.upload.owned_after_success,
      ownership: input.upload.ownership,
    },
    sealing: {
      outcome: input.sealing.outcome,
      source_head: head(input.sealing.source_head),
      conditional_copy: {
        ...operation(input.sealing.conditional_copy),
        etag: safeValue(input.sealing.conditional_copy.etag, "copy.etag"),
        checksum_sha256: safeValue(
          input.sealing.conditional_copy.checksum_sha256,
          "copy.checksum_sha256",
        ),
        version_id: safeValue(input.sealing.conditional_copy.version_id, "copy.version_id"),
        source_version_id: safeValue(
          input.sealing.conditional_copy.source_version_id,
          "copy.source_version_id",
        ),
      },
      destination_head:
        input.sealing.destination_head === null ? null : head(input.sealing.destination_head),
      automatic_retry: false,
      destination_verified: input.sealing.destination_verified,
    },
    metadata: {
      source_etag: safeValue(input.metadata.source_etag, "metadata.source_etag"),
      destination_etag: safeValue(input.metadata.destination_etag, "metadata.destination_etag"),
      source_checksum_sha256: {
        available: input.metadata.source_checksum_sha256.available,
        value: safeValue(input.metadata.source_checksum_sha256.value, "metadata.source_checksum"),
      },
      destination_checksum_sha256: {
        available: input.metadata.destination_checksum_sha256.available,
        value: safeValue(
          input.metadata.destination_checksum_sha256.value,
          "metadata.destination_checksum",
        ),
      },
      source_version_id: safeValue(input.metadata.source_version_id, "metadata.source_version_id"),
      destination_version_id: safeValue(
        input.metadata.destination_version_id,
        "metadata.destination_version_id",
      ),
      version_binding: input.metadata.version_binding,
    },
    cleanup: {
      status: input.cleanup.status,
      attempted: input.cleanup.attempted,
      keys: input.cleanup.keys.map(cleanUpKey),
      bucket_deleted: false,
    },
    safety: {
      acknowledged_execute_flag: input.safety.acknowledged_execute_flag,
      shared_412_is_ambiguous: true,
      conditional_copy_is_never_retried: true,
      post_412_destination_head: false,
      destination_head_only_after_copy_success: true,
      preexisting_keys_fail_closed: true,
      cleanup_is_exact_run_owned_keys: true,
      bucket_was_not_created_or_deleted: true,
      ambiguous_mutation_candidates_fail_closed:
        input.safety.ambiguous_mutation_candidates_fail_closed,
      secrets_emitted: false,
      urls_headers_bodies_emitted: false,
    },
    remaining_decisions: input.remaining_decisions.map(
      (value) => safeValue(value, "decision") ?? "",
    ),
  };
}
