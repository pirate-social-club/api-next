import {
  MediaSealFailure,
  type MediaSealInput,
  type MediaSealInspectInput,
  type MediaSealInspection,
  type MediaSealObjectIdentity,
  type MediaUploadSealer,
} from "@pirate/application/media/submission-sealing";

const CHECKSUM_FIELDS = ["md5", "sha1", "sha256", "sha384", "sha512"] as const;
const OWNER_METADATA_KEY = "media-seal-owner";
const SOURCE_VERSION_METADATA_KEY = "media-seal-source-version";

type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

type SealChecksumFields = Readonly<Partial<Record<(typeof CHECKSUM_FIELDS)[number], ArrayBuffer>>>;

type SealObject = Readonly<{
  key: string;
  version: string;
  etag: string;
  size: number;
  checksums: SealChecksumFields;
  httpMetadata?: Readonly<{ contentType?: string }>;
  customMetadata?: Readonly<Record<string, string>>;
}>;

type SealObjectBody = SealObject & Readonly<{ body: ReadableStream }>;

type SealConditional = Readonly<{ etagMatches?: string }> | Headers;

type SealSourceBucket = Readonly<{
  head: (key: string) => Promise<SealObject | null>;
  get: (
    key: string,
    options: Readonly<{ onlyIf: SealConditional }>,
  ) => Promise<SealObjectBody | SealObject | null>;
}>;

type SealDestinationBucket = Readonly<{
  head: (key: string) => Promise<SealObject | null>;
  put: (
    key: string,
    value: R2PutValue,
    options: Readonly<{
      onlyIf: SealConditional;
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
      sha256?: string;
    }>,
  ) => Promise<SealObject | null>;
}>;

export type MediaSealBuckets = Readonly<{
  readonly ingress: SealSourceBucket;
  readonly immutableOriginals: SealDestinationBucket;
}>;

type SealDigestStream = WritableStream &
  Readonly<{ digest: Promise<ArrayBuffer>; bytesWritten: number | bigint }>;

const digestStream = (algorithm: "SHA-256"): SealDigestStream => {
  const DigestStreamConstructor = (
    crypto as Crypto & {
      readonly DigestStream: new (algorithm: "SHA-256") => SealDigestStream;
    }
  ).DigestStream;
  return new DigestStreamConstructor(algorithm);
};

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function objectIdentity(object: SealObject): MediaSealObjectIdentity {
  const checksums = Object.fromEntries(
    CHECKSUM_FIELDS.flatMap((field) => {
      const checksum = object.checksums[field];
      return checksum === undefined ? [] : [[field, bytesToHex(checksum)] as const];
    }),
  );
  return {
    key: object.key,
    version: object.version,
    etag: object.etag,
    size: object.size,
    contentType: object.httpMetadata?.contentType ?? null,
    ownerMarker: object.customMetadata?.[OWNER_METADATA_KEY] ?? null,
    sourceVersion: object.customMetadata?.[SOURCE_VERSION_METADATA_KEY] ?? null,
    checksums,
  };
}

function identityEqual(left: MediaSealObjectIdentity, right: MediaSealObjectIdentity): boolean {
  return (
    left.key === right.key &&
    left.version === right.version &&
    left.etag === right.etag &&
    left.size === right.size &&
    left.contentType === right.contentType &&
    left.ownerMarker === right.ownerMarker &&
    left.sourceVersion === right.sourceVersion &&
    CHECKSUM_FIELDS.every((field) => left.checksums[field] === right.checksums[field])
  );
}

function hasBody(object: SealObject | SealObjectBody): object is SealObjectBody {
  return "body" in object && object.body instanceof ReadableStream;
}

function destinationMatches(
  written: MediaSealObjectIdentity,
  observed: MediaSealObjectIdentity,
  input: MediaSealInput,
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
    written.contentType === input.expectedContentType &&
    written.ownerMarker === input.ownershipMarker &&
    written.sourceVersion === input.source.version &&
    (storedSha256 === undefined || storedSha256 === canonicalSha256)
  );
}

function sameOperationDestination(
  observed: MediaSealObjectIdentity,
  input: MediaSealInput,
): boolean {
  return (
    observed.key === input.destinationKey &&
    observed.ownerMarker === input.ownershipMarker &&
    observed.sourceVersion === input.source.version
  );
}

function siblingDestinationMatches(
  observed: MediaSealObjectIdentity,
  input: MediaSealInput,
  canonicalSha256: string,
  bytesWritten: number | bigint,
): boolean {
  const sourceSha256 = input.source.checksums.sha256;
  const storedSha256 = observed.checksums.sha256;
  return (
    observed.version.length > 0 &&
    observed.etag.length > 0 &&
    observed.size === input.expectedSizeBytes &&
    BigInt(bytesWritten) === BigInt(observed.size) &&
    observed.contentType === input.expectedContentType &&
    (sourceSha256 === undefined || sourceSha256 === canonicalSha256) &&
    (storedSha256 === undefined
      ? sourceSha256 === undefined
      : storedSha256 === canonicalSha256 &&
        (sourceSha256 === undefined || storedSha256 === sourceSha256))
  );
}

function sealedAttempt(
  identity: MediaSealObjectIdentity,
  input: MediaSealInput,
  canonicalSha256: string,
): Awaited<ReturnType<MediaUploadSealer["seal"]>> {
  return {
    result: {
      outcome: "sealed",
      immutable_ref: input.immutableRef,
      destination_ref: `r2://${input.destinationKey}`,
      etag: identity.etag,
      version: identity.version,
      size_bytes: identity.size,
      canonical_sha256: canonicalSha256,
    },
  };
}

export async function inspectMediaUpload(
  ingress: SealSourceBucket,
  input: MediaSealInspectInput,
): Promise<MediaSealInspection> {
  let observed: SealObject | null;
  try {
    observed = await ingress.head(input.sourceKey);
  } catch {
    throw new MediaSealFailure("source_head_failed");
  }
  if (observed === null) return { outcome: "source_missing" };
  const source = objectIdentity(observed);
  if (source.size !== input.expectedSizeBytes || source.contentType !== input.expectedContentType) {
    return { outcome: "expectation_mismatch" };
  }
  return { outcome: "ready", source };
}

export async function sealMediaUpload(
  buckets: MediaSealBuckets,
  input: MediaSealInput,
): Promise<Awaited<ReturnType<MediaUploadSealer["seal"]>>> {
  let selected: SealObject | SealObjectBody | null;
  try {
    selected = await buckets.ingress.get(input.source.key, {
      onlyIf: { etagMatches: input.source.etag },
    });
  } catch {
    throw new MediaSealFailure("source_get_failed");
  }
  if (
    selected === null ||
    !hasBody(selected) ||
    !identityEqual(objectIdentity(selected), input.source)
  ) {
    return { result: { outcome: "source_precondition_failed" } };
  }

  const digest = digestStream("SHA-256");
  const [putBody, digestBody] = selected.body.tee();
  const digestTask = digestBody.pipeTo(digest).then(async () => ({
    sha256: bytesToHex(await digest.digest),
    bytesWritten: digest.bytesWritten,
  }));
  const putTask = buckets.immutableOriginals.put(input.destinationKey, putBody, {
    onlyIf: new Headers({ "if-none-match": "*" }),
    httpMetadata: { contentType: input.expectedContentType },
    customMetadata: {
      [OWNER_METADATA_KEY]: input.ownershipMarker,
      [SOURCE_VERSION_METADATA_KEY]: input.source.version,
    },
    ...(input.source.checksums.sha256 === undefined
      ? {}
      : { sha256: input.source.checksums.sha256 }),
  });
  const [putSettled, digestSettled] = await Promise.allSettled([putTask, digestTask]);
  if (putSettled.status === "rejected") {
    throw new MediaSealFailure("destination_put_uncertain");
  }
  const writtenObject = putSettled.value;
  if (writtenObject === null) {
    if (!putBody.locked) await putBody.cancel().catch(() => undefined);
    let occupiedObject: SealObject | null;
    try {
      occupiedObject = await buckets.immutableOriginals.head(input.destinationKey);
    } catch {
      throw new MediaSealFailure("sibling_convergence_unavailable");
    }
    if (occupiedObject === null) {
      throw new MediaSealFailure("sibling_convergence_unavailable");
    }
    const occupied = objectIdentity(occupiedObject);
    if (!sameOperationDestination(occupied, input)) {
      return {
        result: { outcome: "destination_conflict" },
        retainedDestination: occupied,
      };
    }
    if (digestSettled.status === "rejected") {
      throw new MediaSealFailure("sibling_convergence_unavailable", occupied);
    }
    const { sha256: canonicalSha256, bytesWritten } = digestSettled.value;
    if (!siblingDestinationMatches(occupied, input, canonicalSha256, bytesWritten)) {
      throw new MediaSealFailure("destination_verification_failed", occupied);
    }
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== canonicalSha256) {
      return {
        result: { outcome: "expectation_mismatch" },
        retainedDestination: occupied,
      };
    }
    return sealedAttempt(occupied, input, canonicalSha256);
  }
  const written = objectIdentity(writtenObject);
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

  let verifiedObject: SealObject | null;
  try {
    verifiedObject = await buckets.immutableOriginals.head(input.destinationKey);
  } catch {
    throw new MediaSealFailure("destination_head_failed", written);
  }
  if (
    verifiedObject === null ||
    !destinationMatches(
      written,
      objectIdentity(verifiedObject),
      input,
      canonicalSha256,
      bytesWritten,
    )
  ) {
    throw new MediaSealFailure("destination_verification_failed", written);
  }
  return sealedAttempt(written, input, canonicalSha256);
}

export function makeR2MediaSealer(buckets: MediaSealBuckets): MediaUploadSealer {
  return {
    inspect: (input) => inspectMediaUpload(buckets.ingress, input),
    seal: (input) => sealMediaUpload(buckets, input),
  };
}
