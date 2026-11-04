// INTERNAL immutable producer generation. No frozen guest/wire/client change.
export type LearnerAudioUploadCapture = Readonly<{
  uploadAttemptId: string;
  sourceOwnerId: string;
  artifactId: string;
  sourceKind: "study" | "karaoke";
  attemptRef: string;
  commandRef: string;
  reservationRef: string;
  capturedRevision: number;
  objectRef: string;
  contentDigest: string | null;
  contentType: string;
  byteSize: number | null;
  durationMs: number | null;
}>;
