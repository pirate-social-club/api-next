export const MEDIA_AUDIO_MAX_SIZE_BYTES = 64 * 1024 * 1024;

export const mediaIngressObjectKey = (reservationId: string): string =>
  `reservations/${reservationId}/source`;

export const mediaImmutableObjectKey = (operationId: string): string =>
  `immutable/${operationId}/audio/1`;

export const mediaImmutableRef = (operationId: string): string =>
  `media://immutable/${operationId}/audio/1`;

export type MediaSealChecksumName = "md5" | "sha1" | "sha256" | "sha384" | "sha512";

export type MediaSealObjectIdentity = Readonly<{
  key: string;
  version: string;
  etag: string;
  size: number;
  contentType: string | null;
  ownerMarker: string | null;
  sourceVersion: string | null;
  checksums: Readonly<Partial<Record<MediaSealChecksumName, string>>>;
}>;

export type MediaSealInspection =
  | Readonly<{ outcome: "ready"; source: MediaSealObjectIdentity }>
  | Readonly<{ outcome: "source_missing" }>
  | Readonly<{ outcome: "expectation_mismatch" }>;

export type MediaSealResult =
  | Readonly<{
      outcome: "sealed";
      immutable_ref: string;
      destination_ref: string;
      etag: string;
      version: string;
      size_bytes: number;
      canonical_sha256: string;
    }>
  | Readonly<{ outcome: "source_precondition_failed" }>
  | Readonly<{ outcome: "expectation_mismatch" }>
  | Readonly<{ outcome: "destination_conflict" }>;

export type MediaSealAttempt = Readonly<{
  result: MediaSealResult;
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

export type MediaSealInspectInput = Readonly<{
  sourceKey: string;
  expectedSizeBytes: number;
  expectedContentType: string;
}>;

export type MediaSealInput = Readonly<{
  source: MediaSealObjectIdentity;
  destinationKey: string;
  immutableRef: string;
  expectedSizeBytes: number;
  expectedContentType: string;
  expectedSha256?: string;
  ownershipMarker: string;
}>;

export interface MediaUploadSealer {
  readonly inspect: (input: MediaSealInspectInput) => Promise<MediaSealInspection>;
  readonly seal: (input: MediaSealInput) => Promise<MediaSealAttempt>;
}

const evidencePart = (value: string): string => encodeURIComponent(value);

/**
 * Compact inline reconciliation evidence for the exact destination target.
 * The returned identity is retained; no key-only delete is attempted here.
 */
export function mediaRetainedDestinationEvidence(identity: MediaSealObjectIdentity): string {
  const evidence = [
    "r2-retained-v1",
    evidencePart(identity.key),
    evidencePart(identity.version),
    evidencePart(identity.etag),
    String(identity.size),
  ].join(":");
  if (evidence.length > 512)
    throw new MediaSealFailure("destination_verification_failed", identity);
  return evidence;
}
