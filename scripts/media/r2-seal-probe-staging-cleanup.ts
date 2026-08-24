import type { StagingCleanupKey, StagingOperation } from "./r2-seal-probe-staging-evidence";
import type {
  StagingBodySha256Result,
  StagingDeleteResult,
  StagingHeadResult,
} from "./r2-seal-probe-staging-transport";

type CleanupTransport = Readonly<{
  deleteObject: (bucket: string, key: string, ifMatch?: string) => Promise<StagingDeleteResult>;
  headObject: (bucket: string, key: string) => Promise<StagingHeadResult>;
  preflightObject: (bucket: string, key: string) => Promise<StagingHeadResult>;
  readObjectSha256?: (
    bucket: string,
    key: string,
    ifMatch: string,
    expectedSizeBytes: number,
  ) => Promise<StagingBodySha256Result>;
}>;

export type CleanupCandidate = Readonly<{
  key: string;
  ownership: "confirmed" | "ambiguous";
  ownershipMarker: string;
  expectedEtag?: string;
  expected: Readonly<{
    sizeBytes: number;
    contentType: string;
    sha256: string;
  }>;
}>;

export type CleanupResult = Readonly<{
  status: "complete" | "partial" | "not-attempted";
  keys: readonly StagingCleanupKey[];
}>;

export class CleanupResidualError extends Error {
  constructor(readonly result: CleanupResult) {
    super("staging cleanup left a run-owned object present");
    this.name = "CleanupResidualError";
  }
}

function operation(result: StagingOperation): StagingOperation {
  return { ...result, called: true };
}

export async function cleanupOwnedKeys(
  transport: CleanupTransport,
  bucket: string,
  prefix: string,
  candidates: readonly CleanupCandidate[],
): Promise<CleanupResult> {
  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [candidate.key, candidate])).values(),
  ];
  if (uniqueCandidates.length === 0) return { status: "not-attempted", keys: [] };
  const results: StagingCleanupKey[] = [];
  for (const candidate of uniqueCandidates) {
    const key = candidate.key;
    if (!key.startsWith(prefix) || key === prefix || key.includes("..")) {
      throw new Error("cleanup key is outside the exact run-owned prefix");
    }
    const verification = await transport.headObject(bucket, key);
    const verificationOperation = operation({
      called: true,
      status: verification.status,
      code: verification.code,
    });
    if (verification.kind === "missing") {
      results.push({
        key,
        ownership: candidate.ownership,
        ownership_marker: candidate.ownershipMarker,
        marker_verified: false,
        expected_etag: candidate.expectedEtag ?? null,
        etag_verified: false,
        body_sha256_verified: false,
        candidate_verified: false,
        verification: verificationOperation,
        residual_reason: "not-found",
        delete: operation({ called: false, status: null, code: null }),
        absence: verificationOperation,
        absent: true,
      });
      continue;
    }
    const markerVerified =
      verification.kind === "found" && verification.ownershipMarker === candidate.ownershipMarker;
    const etagVerified =
      verification.kind === "found" &&
      verification.etag !== undefined &&
      (candidate.expectedEtag === undefined || verification.etag === candidate.expectedEtag);
    const fixedMetadataVerified =
      verification.kind === "found" &&
      markerVerified &&
      etagVerified &&
      verification.sizeBytes === candidate.expected.sizeBytes &&
      verification.contentType === candidate.expected.contentType;
    let bodySha256Verified = false;
    if (
      fixedMetadataVerified &&
      verification.sha256 === undefined &&
      verification.etag !== undefined &&
      transport.readObjectSha256 !== undefined
    ) {
      const body = await transport.readObjectSha256(
        bucket,
        key,
        verification.etag,
        candidate.expected.sizeBytes,
      );
      bodySha256Verified = body.kind === "verified" && body.sha256 === candidate.expected.sha256;
    }
    const candidateVerified =
      fixedMetadataVerified &&
      (verification.sha256 === candidate.expected.sha256 || bodySha256Verified);
    if (!candidateVerified) {
      const reason = !markerVerified
        ? "ownership-marker-mismatch"
        : candidate.expectedEtag !== undefined && !etagVerified
          ? "confirmed-etag-mismatch"
          : verification.kind === "found" && verification.etag === undefined
            ? "etag-unavailable"
            : verification.kind === "found" && verification.sha256 === undefined
              ? "checksum-unavailable"
              : "metadata-mismatch";
      results.push({
        key,
        ownership: candidate.ownership,
        ownership_marker: candidate.ownershipMarker,
        marker_verified: markerVerified,
        expected_etag: candidate.expectedEtag ?? null,
        etag_verified: etagVerified,
        body_sha256_verified: bodySha256Verified,
        candidate_verified: false,
        verification: verificationOperation,
        residual_reason: reason,
        delete: operation({ called: false, status: null, code: null }),
        absence: operation({ called: false, status: null, code: null }),
        absent: false,
      });
      continue;
    }
    const deletion = await transport.deleteObject(bucket, key, verification.etag);
    const absence = await transport.preflightObject(bucket, key);
    const absent = absence.kind === "missing" && absence.code === "NoSuchKey";
    results.push({
      key,
      ownership: candidate.ownership,
      ownership_marker: candidate.ownershipMarker,
      marker_verified: markerVerified,
      expected_etag: candidate.expectedEtag ?? null,
      etag_verified: etagVerified,
      body_sha256_verified: bodySha256Verified,
      candidate_verified: true,
      verification: verificationOperation,
      residual_reason: absent
        ? "none"
        : deletion.kind === "error"
          ? "delete-failed"
          : "absence-check-failed",
      delete: operation({ called: true, status: deletion.status, code: deletion.code }),
      absence: operation({ called: true, status: absence.status, code: absence.code }),
      absent,
    });
  }
  return {
    status: results.every(({ absent }) => absent) ? "complete" : "partial",
    keys: results,
  };
}

export function requireCompleteCleanup(result: CleanupResult): CleanupResult {
  if (result.status === "partial") throw new CleanupResidualError(result);
  return result;
}

/** Run the operation and cleanup independently; the operation failure wins if both fail. */
export async function runWithCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<CleanupResult>,
): Promise<Readonly<{ value: T; cleanup: CleanupResult }>> {
  let value: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupResult: CleanupResult | undefined;
  let cleanupError: unknown;
  try {
    cleanupResult = await cleanup();
  } catch (error: unknown) {
    cleanupError = error;
  }
  const cleanupFailure =
    cleanupError ??
    (cleanupResult === undefined
      ? undefined
      : cleanupResult.status === "partial"
        ? new CleanupResidualError(cleanupResult)
        : undefined);

  if (operationFailed) {
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [operationError, cleanupFailure],
        "staging operation failed and cleanup also failed",
      );
    }
    throw operationError;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (value === undefined || cleanupResult === undefined) {
    throw new Error("staging workflow completed without an operation or cleanup result");
  }
  return { value, cleanup: cleanupResult };
}
