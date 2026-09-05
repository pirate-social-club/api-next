import { Schema } from "effect";
import type { VideoSubmissionState } from "../../../domain/src/video-submission.ts";

const Text = Schema.NonEmptyString.check(
  Schema.makeFilter((s) =>
    s === s.trim() && s.length <= 2048 ? undefined : "Expected bounded canonical text",
  ),
);
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Ref = Text.check(
  Schema.isPattern(/^media:\/\/derived\/[A-Za-z0-9_./:-]+$/u),
  Schema.makeFilter((s) => (s.split("/").includes("..") ? "Invalid artifact path" : undefined)),
);
const Rating = Schema.Literals(["general", "adult_18"]);
const Safety = Schema.Literals(["allow", "review_required", "blocked"]);
const Verification = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["no_match", "inconclusive"]),
    evidenceRef: Text,
    adapterRevision: Text,
  }),
  Schema.Struct({
    status: Schema.Literal("known_self_owned_recording"),
    identifiedAssetId: Text,
    ownerEvidenceRef: Text,
    evidenceRef: Text,
    adapterRevision: Text,
  }),
  Schema.Struct({
    status: Schema.Literal("known_recording"),
    evidenceRef: Text,
    adapterRevision: Text,
    identified: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("external"), providerRef: Text }),
      Schema.Struct({
        kind: Schema.Literal("pirate_song"),
        assetId: Text,
        referenceableSongPostId: Schema.NullOr(Text),
        ownerRelation: Schema.Literals(["same_account", "different_account", "indeterminate"]),
      }),
    ]),
  }),
]);
const Frame = Schema.Struct({
  role: Schema.Literals(["poster", "first", "midpoint"]),
  requestedTimestampMs: Schema.NullOr(Timestamp),
  timestampMs: Timestamp,
  sha256: Digest,
  artifactRef: Ref,
});
const schemas = {
  probe: Schema.Struct({
    evidenceRef: Text,
    ingestPolicyRevision: Positive,
    durationMs: Positive,
    width: Positive,
    height: Positive,
    frameRateMillihertz: Positive,
    videoCodec: Schema.Literals(["h264", "hevc"]),
    audioCodec: Schema.Literal("aac"),
    hasAudio: Schema.Literal(true),
  }),
  audio: Schema.Struct({
    artifactRef: Ref,
    canonicalSha256: Digest,
    sourceSha256: Digest,
    videoRevision: Positive,
    mediaType: Schema.Literal("audio/mp4"),
    policyRevision: Text,
    adapterRevision: Text,
  }),
  frames: Schema.Struct({
    evidenceRef: Text,
    adapterRevision: Text,
    sourceSha256: Digest,
    videoRevision: Positive,
    posterPolicyRevision: Positive,
    frames: Schema.Tuple([Frame, Frame, Frame]),
  }),
  recognition: Schema.Union([
    Schema.Struct({ verification: Verification, evidenceRef: Text, adapterRevision: Text }),
    Schema.Struct({
      verification: Schema.Null,
      exhaustion: Schema.Literals(["acr_exhausted", "acr_skipped"]),
      evidenceRef: Text,
      adapterRevision: Text,
    }),
  ]),
  safety: Schema.Struct({
    requestId: Text,
    evidenceRef: Text,
    minorSafetyEvidenceRef: Schema.NullOr(Text),
    mediaSafety: Safety,
    captionSafety: Schema.Literals(["not_applicable", "allow", "review_required", "blocked"]),
    automatedRating: Rating,
    policyRevision: Text,
    adapterRevision: Text,
  }),
};
const Artifact = Schema.Struct({
  artifactRef: Ref,
  canonicalSha256: Digest,
  sizeBytes: Positive,
  contentType: Schema.Literals(["audio/mp4", "image/jpeg"]),
});
const Envelope = Schema.Struct({
  stage: Schema.Literals(["probe", "audio", "frames", "recognition", "safety"]),
  adapterRevision: Text,
  snapshot: Schema.Unknown,
  artifacts: Schema.Array(Artifact),
});
export type VideoStage = keyof typeof schemas;
export type VideoStageFact = {
  [S in VideoStage]: Readonly<{
    stage: S;
    adapterRevision: string;
    snapshot: (typeof schemas)[S]["Type"];
    artifacts: readonly (typeof Artifact.Type)[];
  }>;
}[VideoStage];
export type VideoStageFactIdentity = Readonly<{
  submissionId: string;
  videoRevision: number;
  creationRevision: number;
}>;
export interface VideoStageFactStore {
  readonly read: (identity: VideoStageFactIdentity) => Promise<readonly VideoStageFact[]>;
  readonly write: (
    input: Readonly<{
      submission: VideoSubmissionState;
      observedEventSequence: number;
      fact: VideoStageFact;
    }>,
  ) => Promise<VideoStageFact>;
}

/** Closed per-stage snapshots; artifact receipts are sealed-object metadata, not provider assertions. */
export function validateVideoStageFact(input: unknown): VideoStageFact {
  const envelope = Schema.decodeUnknownSync(Envelope, { onExcessProperty: "error" })(input);
  const snapshot = Schema.decodeUnknownSync(schemas[envelope.stage], { onExcessProperty: "error" })(
    envelope.snapshot,
  );
  const fact = { ...envelope, snapshot } as VideoStageFact;
  if (JSON.stringify(fact).length > 200000) throw new Error("video stage fact exceeds bound");
  if (
    fact.artifacts.some(
      (a) => a.sizeBytes > (a.contentType === "audio/mp4" ? 8 * 1024 * 1024 : 512 * 1024),
    )
  )
    throw new Error("video stage artifact exceeds policy bound");
  if ("adapterRevision" in fact.snapshot && fact.snapshot.adapterRevision !== fact.adapterRevision)
    throw new Error("video stage adapter binding rejected");
  const expected =
    fact.stage === "audio"
      ? [
          {
            artifactRef: fact.snapshot.artifactRef,
            digest: fact.snapshot.canonicalSha256,
            contentType: "audio/mp4",
          },
        ]
      : fact.stage === "frames"
        ? fact.snapshot.frames.map((frame) => ({
            artifactRef: frame.artifactRef,
            digest: frame.sha256,
            contentType: "image/jpeg",
          }))
        : [];
  if (fact.stage === "frames" && new Set(fact.snapshot.frames.map((f) => f.role)).size !== 3)
    throw new Error("video stage frame roles rejected");
  if (
    fact.artifacts.length !== expected.length ||
    new Set(fact.artifacts.map((a) => a.artifactRef)).size !== expected.length ||
    expected.some(
      (e) =>
        !fact.artifacts.some(
          (a) =>
            a.artifactRef === e.artifactRef &&
            a.canonicalSha256 === e.digest &&
            a.contentType === e.contentType,
        ),
    )
  )
    throw new Error("video stage artifact binding rejected");
  return fact;
}

export async function verifyVideoStageArtifacts(
  fact: VideoStageFact,
  head: (artifactRef: string) => Promise<Readonly<{
    canonicalSha256: string;
    sizeBytes: number;
    contentType: string;
  }> | null>,
): Promise<void> {
  const validated = validateVideoStageFact(fact);
  for (const artifact of validated.artifacts) {
    const actual = await head(artifact.artifactRef);
    if (
      actual === null ||
      actual.canonicalSha256 !== artifact.canonicalSha256 ||
      actual.sizeBytes !== artifact.sizeBytes ||
      actual.contentType !== artifact.contentType
    )
      throw new Error("video sealed stage artifact identity rejected");
  }
}
