const CHECKSUM_FIELDS = ["md5", "sha1", "sha256", "sha384", "sha512"] as const;
const OWNER_METADATA_KEY = "media-seal-owner";
const SOURCE_VERSION_METADATA_KEY = "media-seal-source-version";

export type MediaSealResult =
  | Readonly<{
      outcome: "sealed";
      immutable_ref: string;
      etag: string;
      version: string;
      size_bytes: number;
      canonical_sha256: string;
    }>
  | Readonly<{ outcome: "source_missing" }>
  | Readonly<{ outcome: "source_precondition_failed" }>
  | Readonly<{ outcome: "expectation_mismatch" }>
  | Readonly<{ outcome: "destination_conflict" }>;

export type MediaSealObjectIdentity = Readonly<{
  key: string;
  version: string;
  etag: string;
  size: number;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  checksums: R2Checksums;
}>;

export type MediaSealAttempt = Readonly<{
  result: MediaSealResult;
  /**
   * Present when a destination write completed but cannot safely be deleted
   * through the Workers binding. The caller persists this exact identity for
   * separately authorized reconciliation.
   */
  retainedDestination?: MediaSealObjectIdentity;
}>;

export type MediaSealFailureCode =
  | "source_head_failed"
  | "source_get_failed"
  | "source_stream_failed"
  | "destination_put_uncertain"
  | "destination_head_failed"
  | "destination_verification_failed";

export class MediaSealFailure extends Error {
  readonly code: MediaSealFailureCode;
  readonly retainedDestination: MediaSealObjectIdentity | undefined;

  constructor(code: MediaSealFailureCode, retainedDestination?: MediaSealObjectIdentity) {
    super("media seal failed");
    this.name = "MediaSealFailure";
    this.code = code;
    this.retainedDestination = retainedDestination;
  }
}

export type MediaSealInput = Readonly<{
  sourceKey: string;
  destinationKey: string;
  immutableRef: string;
  expectedSizeBytes: number;
  expectedContentType: string;
  expectedSha256?: string;
  ownershipMarker: string;
}>;

export interface MediaSealer {
  readonly seal: (input: MediaSealInput) => Promise<MediaSealAttempt>;
}

type SealBucket = Pick<R2Bucket, "head" | "get" | "put">;

function bytesEqual(left: ArrayBuffer | undefined, right: ArrayBuffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function checksumsEqual(left: R2Checksums, right: R2Checksums): boolean {
  return CHECKSUM_FIELDS.every((field) => bytesEqual(left[field], right[field]));
}

function identityEqual(left: MediaSealObjectIdentity, right: MediaSealObjectIdentity): boolean {
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

function sourceMatches(source: MediaSealObjectIdentity, input: MediaSealInput): boolean {
  return (
    source.size === input.expectedSizeBytes &&
    source.httpMetadata?.contentType === input.expectedContentType
  );
}

function destinationMatches(
  written: MediaSealObjectIdentity,
  observed: MediaSealObjectIdentity,
  input: MediaSealInput,
  sourceVersion: string,
  canonicalSha256: string,
  bytesWritten: number | bigint,
): boolean {
  const storedSha256 = written.checksums.sha256;
  return (
    identityEqual(written, observed) &&
    written.version.length > 0 &&
    written.etag.length > 0 &&
    written.size === input.expectedSizeBytes &&
    BigInt(bytesWritten) === BigInt(written.size) &&
    written.httpMetadata?.contentType === input.expectedContentType &&
    written.customMetadata?.[OWNER_METADATA_KEY] === input.ownershipMarker &&
    written.customMetadata?.[SOURCE_VERSION_METADATA_KEY] === sourceVersion &&
    (storedSha256 === undefined || bytesToHex(storedSha256) === canonicalSha256)
  );
}

export async function sealMediaUpload(
  bucket: SealBucket,
  input: MediaSealInput,
): Promise<MediaSealAttempt> {
  let observed: R2Object | null;
  try {
    observed = await bucket.head(input.sourceKey);
  } catch {
    throw new MediaSealFailure("source_head_failed");
  }
  if (observed === null) return { result: { outcome: "source_missing" } };
  if (!sourceMatches(observed, input)) {
    return { result: { outcome: "expectation_mismatch" } };
  }

  let selected: R2Object | R2ObjectBody | null;
  try {
    selected = await bucket.get(input.sourceKey, { onlyIf: { etagMatches: observed.etag } });
  } catch {
    throw new MediaSealFailure("source_get_failed");
  }
  if (selected === null) return { result: { outcome: "source_missing" } };
  if (!hasBody(selected) || !identityEqual(selected, observed)) {
    return { result: { outcome: "source_precondition_failed" } };
  }

  const digest = new DigestStream("SHA-256");
  const [putBody, digestBody] = selected.body.tee();
  const digestTask = digestBody.pipeTo(digest).then(async () => ({
    sha256: bytesToHex(await digest.digest),
    bytesWritten: digest.bytesWritten,
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
    throw new MediaSealFailure("destination_put_uncertain");
  }
  const written = putSettled.value;
  if (written === null) return { result: { outcome: "destination_conflict" } };
  if (digestSettled.status === "rejected") {
    throw new MediaSealFailure("source_stream_failed", written);
  }
  const { sha256: canonicalSha256, bytesWritten } = digestSettled.value;
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== canonicalSha256) {
    return {
      result: { outcome: "expectation_mismatch" },
      retainedDestination: written,
    };
  }

  let verified: R2Object | null;
  try {
    verified = await bucket.head(input.destinationKey);
  } catch {
    throw new MediaSealFailure("destination_head_failed", written);
  }
  if (
    verified === null ||
    !destinationMatches(written, verified, input, selected.version, canonicalSha256, bytesWritten)
  ) {
    throw new MediaSealFailure("destination_verification_failed", written);
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
  };
}

export function makeR2MediaSealer(bucket: SealBucket): MediaSealer {
  return { seal: (input) => sealMediaUpload(bucket, input) };
}
