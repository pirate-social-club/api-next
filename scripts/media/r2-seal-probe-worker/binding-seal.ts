const CHECKSUM_FIELDS = ["md5", "sha1", "sha256", "sha384", "sha512"] as const;

const OWNER_METADATA_KEY = "media-seal-owner";
const SOURCE_VERSION_METADATA_KEY = "media-seal-source-version";

export type SealUploadResultV1 =
  | {
      outcome: "sealed";
      immutable_ref: string;
      etag: string;
      version: string;
      size_bytes: number;
      canonical_sha256: string;
    }
  | { outcome: "source_missing" }
  | { outcome: "source_precondition_failed" }
  | { outcome: "expectation_mismatch" }
  | { outcome: "destination_conflict" };

export type CleanupEvidence =
  | { outcome: "not_required" }
  | { outcome: "already_missing" }
  | {
      outcome: "deleted";
      identity_verified_before_delete: true;
      delete_condition: "unavailable";
    }
  | { outcome: "retained_identity_mismatch" }
  | { outcome: "retained_head_failed" }
  | {
      outcome: "retained_delete_failed";
      identity_verified_before_delete: true;
      delete_condition: "unavailable";
    }
  | {
      outcome: "retained_after_delete";
      identity_verified_before_delete: true;
      delete_condition: "unavailable";
    };

export type R2SealFailureCode =
  | "source_head_failed"
  | "source_get_failed"
  | "source_stream_failed"
  | "destination_put_uncertain"
  | "destination_head_failed"
  | "destination_verification_failed";

export class R2BindingSealFailure extends Error {
  readonly code: R2SealFailureCode;
  readonly cleanup: CleanupEvidence;

  constructor(code: R2SealFailureCode, cleanup: CleanupEvidence = { outcome: "not_required" }) {
    super(code);
    this.name = "R2BindingSealFailure";
    this.code = code;
    this.cleanup = cleanup;
  }
}

export interface StreamingDigest {
  readonly writable: WritableStream<ArrayBuffer | ArrayBufferView>;
  readonly digest: Promise<ArrayBuffer>;
  readonly bytesWritten: () => number | bigint;
}

export interface SealUploadInput {
  readonly sourceKey: string;
  readonly destinationKey: string;
  readonly immutableRef: string;
  readonly expectedSizeBytes: number;
  readonly expectedContentType: string;
  readonly expectedSha256?: string;
  readonly ownershipMarker: string;
}

export interface R2ObjectIdentity {
  readonly key: string;
  readonly version: string;
  readonly etag: string;
  readonly size: number;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly checksums: R2Checksums;
}

export interface R2BindingSealAttempt {
  readonly result: SealUploadResultV1;
  readonly destinationIdentity?: R2ObjectIdentity;
  readonly cleanup: CleanupEvidence;
}

export interface R2BindingSealDependencies {
  readonly createDigest?: () => StreamingDigest;
}

export interface R2SealBucket {
  readonly head: (key: string) => Promise<R2Object | null>;
  readonly get: (
    key: string,
    options: R2GetOptions & { onlyIf: R2Conditional | Headers },
  ) => Promise<R2Object | R2ObjectBody | null>;
  readonly put: (
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options: R2PutOptions & { onlyIf: R2Conditional | Headers },
  ) => Promise<R2Object | null>;
  readonly delete: (key: string) => Promise<void>;
}

function createCloudflareDigest(): StreamingDigest {
  const stream = new crypto.DigestStream("SHA-256");
  return {
    writable: stream,
    digest: stream.digest,
    bytesWritten: () => stream.bytesWritten,
  };
}

function bytesEqual(left: ArrayBuffer | undefined, right: ArrayBuffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  return a.every((value, index) => value === b[index]);
}

export function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function checksumsEqual(left: R2Checksums, right: R2Checksums): boolean {
  return CHECKSUM_FIELDS.every((field) => bytesEqual(left[field], right[field]));
}

function metadataEqual(
  object: R2ObjectIdentity,
  expectedContentType: string,
  ownershipMarker: string,
  sourceVersion: string,
): boolean {
  return (
    object.httpMetadata?.contentType === expectedContentType &&
    object.customMetadata?.[OWNER_METADATA_KEY] === ownershipMarker &&
    object.customMetadata?.[SOURCE_VERSION_METADATA_KEY] === sourceVersion
  );
}

function identityEqual(left: R2ObjectIdentity, right: R2ObjectIdentity): boolean {
  return (
    left.key === right.key &&
    left.version === right.version &&
    left.etag === right.etag &&
    left.size === right.size &&
    left.httpMetadata?.contentType === right.httpMetadata?.contentType &&
    left.customMetadata?.[OWNER_METADATA_KEY] === right.customMetadata?.[OWNER_METADATA_KEY] &&
    left.customMetadata?.[SOURCE_VERSION_METADATA_KEY] ===
      right.customMetadata?.[SOURCE_VERSION_METADATA_KEY] &&
    checksumsEqual(left.checksums, right.checksums)
  );
}

function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return "body" in object && object.body instanceof ReadableStream;
}

function sourceMatchesExpectation(source: R2ObjectIdentity, input: SealUploadInput): boolean {
  return (
    source.size === input.expectedSizeBytes &&
    source.httpMetadata?.contentType === input.expectedContentType &&
    source.customMetadata?.[OWNER_METADATA_KEY] === input.ownershipMarker
  );
}

function selectedSourceMatchesHead(selected: R2ObjectIdentity, head: R2ObjectIdentity): boolean {
  return identityEqual(selected, head);
}

export async function cleanupExactObject(
  bucket: Pick<R2SealBucket, "head" | "delete">,
  expected: R2ObjectIdentity,
): Promise<CleanupEvidence> {
  // Proof-runner cleanup only. The binding cannot make the identity check and
  // delete atomic because its delete method accepts no ETag or version fence.
  let current: R2Object | null;
  try {
    current = await bucket.head(expected.key);
  } catch {
    return { outcome: "retained_head_failed" };
  }
  if (current === null) return { outcome: "already_missing" };
  if (!identityEqual(current, expected)) {
    return { outcome: "retained_identity_mismatch" };
  }
  try {
    await bucket.delete(expected.key);
  } catch {
    return {
      outcome: "retained_delete_failed",
      identity_verified_before_delete: true,
      delete_condition: "unavailable",
    };
  }
  try {
    const residual = await bucket.head(expected.key);
    return residual === null
      ? {
          outcome: "deleted",
          identity_verified_before_delete: true,
          delete_condition: "unavailable",
        }
      : {
          outcome: "retained_after_delete",
          identity_verified_before_delete: true,
          delete_condition: "unavailable",
        };
  } catch {
    return { outcome: "retained_head_failed" };
  }
}

function destinationVerified(
  written: R2ObjectIdentity,
  head: R2ObjectIdentity,
  input: SealUploadInput,
  sourceVersion: string,
  canonicalSha256: string,
  bytesWritten: number | bigint,
): boolean {
  const storedSha256 = written.checksums.sha256;
  return (
    identityEqual(written, head) &&
    written.version.length > 0 &&
    written.etag.length > 0 &&
    metadataEqual(written, input.expectedContentType, input.ownershipMarker, sourceVersion) &&
    written.size === input.expectedSizeBytes &&
    BigInt(bytesWritten) === BigInt(written.size) &&
    (storedSha256 === undefined || bytesToHex(storedSha256) === canonicalSha256)
  );
}

export async function sealR2Upload(
  bucket: R2SealBucket,
  input: SealUploadInput,
  dependencies: R2BindingSealDependencies = {},
): Promise<R2BindingSealAttempt> {
  let observed: R2Object | null;
  try {
    observed = await bucket.head(input.sourceKey);
  } catch {
    throw new R2BindingSealFailure("source_head_failed");
  }
  if (observed === null) {
    return { result: { outcome: "source_missing" }, cleanup: { outcome: "not_required" } };
  }
  if (!sourceMatchesExpectation(observed, input)) {
    return { result: { outcome: "expectation_mismatch" }, cleanup: { outcome: "not_required" } };
  }

  let selected: R2Object | R2ObjectBody | null;
  try {
    selected = await bucket.get(input.sourceKey, { onlyIf: { etagMatches: observed.etag } });
  } catch {
    throw new R2BindingSealFailure("source_get_failed");
  }
  if (selected === null) {
    return { result: { outcome: "source_missing" }, cleanup: { outcome: "not_required" } };
  }
  if (!hasBody(selected) || !selectedSourceMatchesHead(selected, observed)) {
    return {
      result: { outcome: "source_precondition_failed" },
      cleanup: { outcome: "not_required" },
    };
  }

  const digest = (dependencies.createDigest ?? createCloudflareDigest)();
  const [putBody, digestBody] = selected.body.tee();
  const digestTask = digestBody.pipeTo(digest.writable).then(async () => ({
    sha256: bytesToHex(await digest.digest),
    bytesWritten: digest.bytesWritten(),
  }));
  const putTask = bucket.put(input.destinationKey, putBody, {
    onlyIf: new Headers({ "if-none-match": "*" }),
    httpMetadata: { contentType: input.expectedContentType },
    customMetadata: {
      [OWNER_METADATA_KEY]: input.ownershipMarker,
      [SOURCE_VERSION_METADATA_KEY]: selected.version,
    },
    ...(selected.checksums.sha256 === undefined ? {} : { sha256: selected.checksums.sha256 }),
  });
  const [putSettled, digestSettled] = await Promise.allSettled([putTask, digestTask]);

  if (putSettled.status === "rejected") {
    throw new R2BindingSealFailure("destination_put_uncertain");
  }
  const written = putSettled.value;
  if (written === null) {
    return { result: { outcome: "destination_conflict" }, cleanup: { outcome: "not_required" } };
  }
  if (digestSettled.status === "rejected") {
    const cleanup = await cleanupExactObject(bucket, written);
    throw new R2BindingSealFailure("source_stream_failed", cleanup);
  }

  const { sha256: canonicalSha256, bytesWritten } = digestSettled.value;
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== canonicalSha256) {
    const cleanup = await cleanupExactObject(bucket, written);
    return { result: { outcome: "expectation_mismatch" }, cleanup };
  }

  let verified: R2Object | null;
  try {
    verified = await bucket.head(input.destinationKey);
  } catch {
    const cleanup = await cleanupExactObject(bucket, written);
    throw new R2BindingSealFailure("destination_head_failed", cleanup);
  }
  if (
    verified === null ||
    !destinationVerified(written, verified, input, selected.version, canonicalSha256, bytesWritten)
  ) {
    const cleanup = await cleanupExactObject(bucket, written);
    throw new R2BindingSealFailure("destination_verification_failed", cleanup);
  }

  return {
    result: {
      outcome: "sealed",
      immutable_ref: input.immutableRef,
      etag: written.etag,
      version: written.version,
      size_bytes: written.size,
      canonical_sha256: canonicalSha256,
    },
    destinationIdentity: written,
    cleanup: { outcome: "not_required" },
  };
}
