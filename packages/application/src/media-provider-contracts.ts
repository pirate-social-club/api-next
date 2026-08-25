import { Context, type Effect, Schema } from "effect";

/**
 * These contracts are private application boundaries. They deliberately do
 * not contain a provider name, model name, credential, transport payload, or
 * a place where transcript text can be interpreted as instructions.
 */

export const MEDIA_ARTIFACT_REFERENCE_MAX_BYTES = 512 as const;
export const MEDIA_IDENTIFIER_MAX_BYTES = 256 as const;
export const MEDIA_REVISION_MAX_BYTES = 128 as const;
export const MEDIA_TRANSCRIPT_MAX_LENGTH = 200_000 as const;
export const MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH = 4_096 as const;
export const MEDIA_TRANSCRIPT_SEGMENT_MAX_COUNT = 10_000 as const;
export const MEDIA_TRANSCRIPT_MAX_DURATION_MS = 86_400_000 as const;
export const MEDIA_LANGUAGE_EVIDENCE_MAX_COUNT = 4 as const;
export const MEDIA_CLASSIFIER_EVIDENCE_MAX_COUNT = 128 as const;
export const MEDIA_PROVIDER_TIMEOUT_MAX_MS = 120_000 as const;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const boundedText = (maximumBytes: number, description: string) =>
  Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value &&
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
      }) &&
      utf8ByteLength(value) <= maximumBytes
        ? undefined
        : description,
    ),
  );

const BoundedIdentifier = boundedText(
  MEDIA_IDENTIFIER_MAX_BYTES,
  "Expected a bounded identifier without edge whitespace or control characters",
);

const BoundedArtifactReference = boundedText(
  MEDIA_ARTIFACT_REFERENCE_MAX_BYTES,
  "Expected a bounded server artifact reference without edge whitespace or control characters",
);

const BoundedRevisionIdentifier = boundedText(
  MEDIA_REVISION_MAX_BYTES,
  "Expected a bounded revision identifier without edge whitespace or control characters",
);

const PositiveRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

const PositiveTimeout = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MEDIA_PROVIDER_TIMEOUT_MAX_MS }),
);

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** Canonical language tags accepted by the public song projection. */
export const MediaBcp47LanguageTag = Schema.String.check(
  Schema.isMaxLength(35),
  Schema.isPattern(
    /^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$/u,
  ),
);
export type MediaBcp47LanguageTag = Schema.Schema.Type<typeof MediaBcp47LanguageTag>;

const Confidence = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const MediaProviderAttemptMetadata = Schema.Struct({
  version: Schema.Literal("media-provider-attempt-v1"),
  attempt_id: BoundedIdentifier,
  attempt_number: PositiveRevision,
  request_id: BoundedIdentifier,
  timeout_ms: PositiveTimeout,
});

export { MediaProviderAttemptMetadata };
export type MediaProviderAttemptMetadata = Schema.Schema.Type<typeof MediaProviderAttemptMetadata>;

/**
 * Effect interruption is the cancellation mechanism. The signal is passed to
 * an adapter only so an injected transport can observe that interruption;
 * providers never get authority to turn cancellation into a successful fact.
 */
export type MediaProviderCallOptions = Readonly<{
  readonly signal: AbortSignal;
}>;

const MediaProviderFailureCommon = {
  attempt_id: BoundedIdentifier,
};

/**
 * Every adapter failure has one of these literal retryability classes. There
 * is intentionally no arbitrary message or upstream response in this value.
 */
export const MediaProviderFailure = Schema.Union([
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("timeout"),
    retryability: Schema.Literal("retryable"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("rate_limited"),
    retryability: Schema.Literal("retryable"),
    retry_after_ms: PositiveTimeout,
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("provider_unavailable"),
    retryability: Schema.Literal("retryable"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("cancelled"),
    retryability: Schema.Literal("cancelled"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("malformed_response"),
    retryability: Schema.Literal("permanent"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("permanent_rejection"),
    retryability: Schema.Literal("permanent"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("unparseable_result"),
    retryability: Schema.Literal("permanent"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("out_of_policy"),
    retryability: Schema.Literal("permanent"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("ambiguous_result"),
    retryability: Schema.Literal("permanent"),
  }),
  Schema.Struct({
    ...MediaProviderFailureCommon,
    _tag: Schema.Literal("exhausted"),
    retryability: Schema.Literal("permanent"),
  }),
]);
export type MediaProviderFailure = Schema.Schema.Type<typeof MediaProviderFailure>;
export type MediaProviderFailureTag = MediaProviderFailure["_tag"];

export const isRetryableMediaProviderFailure = (
  failure: MediaProviderFailure,
): failure is Extract<MediaProviderFailure, { readonly retryability: "retryable" }> =>
  failure.retryability === "retryable";

/** Immutable, server-owned audio identity. It contains a reference, never bytes. */
export const MediaAudioRevision = Schema.Struct({
  version: Schema.Literal("media-audio-revision-v1"),
  operation_id: BoundedIdentifier,
  audio_revision: PositiveRevision,
  analysis_revision: PositiveRevision,
  canonical_audio_sha256: Sha256Hex,
  audio_artifact_ref: BoundedArtifactReference,
});
export type MediaAudioRevision = Schema.Schema.Type<typeof MediaAudioRevision>;

const TranscriptSegment = Schema.Struct({
  start_ms: NonNegativeInteger.check(
    Schema.isBetween({ minimum: 0, maximum: MEDIA_TRANSCRIPT_MAX_DURATION_MS }),
  ),
  end_ms: NonNegativeInteger.check(
    Schema.isBetween({ minimum: 0, maximum: MEDIA_TRANSCRIPT_MAX_DURATION_MS }),
  ),
  text: Schema.NonEmptyString.check(Schema.isMaxLength(MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH)),
}).check(
  Schema.makeFilter(({ start_ms, end_ms }) =>
    end_ms > start_ms ? undefined : "Transcript segments must have positive duration",
  ),
);

export { TranscriptSegment };
export type MediaTranscriptSegment = Schema.Schema.Type<typeof TranscriptSegment>;

const TranscriptSegments = Schema.NonEmptyArray(TranscriptSegment).check(
  Schema.isMaxLength(MEDIA_TRANSCRIPT_SEGMENT_MAX_COUNT),
  Schema.makeFilter((segments) =>
    segments.reduce((length, segment) => length + segment.text.length, 0) <=
    MEDIA_TRANSCRIPT_MAX_LENGTH
      ? undefined
      : "Aggregate transcript segment text exceeds the transcript ceiling",
  ),
  Schema.makeFilter((segments) => {
    for (let index = 1; index < segments.length; index += 1) {
      const previous = segments[index - 1];
      const current = segments[index];
      if (previous === undefined || current === undefined) return "Invalid transcript segments";
      if (current.start_ms < previous.start_ms || current.start_ms < previous.end_ms) {
        return "Transcript segments must be ordered and non-overlapping";
      }
    }
    return undefined;
  }),
);

const MediaTranscriptIdentityFields = {
  operation_id: BoundedIdentifier,
  audio_revision: PositiveRevision,
  analysis_revision: PositiveRevision,
  canonical_audio_sha256: Sha256Hex,
  transcript_artifact_ref: BoundedArtifactReference,
  transcript_sha256: Sha256Hex,
};

/** Closed identity for private transcript evidence and every classifier result. */
export const MediaTranscriptIdentity = Schema.Struct(MediaTranscriptIdentityFields);
export type MediaTranscriptIdentity = Schema.Schema.Type<typeof MediaTranscriptIdentity>;

const MediaLyricsIdentityFields = {
  operation_id: BoundedIdentifier,
  audio_revision: PositiveRevision,
  lyrics_revision: PositiveRevision,
  canonical_audio_sha256: Sha256Hex,
  base_transcript_revision: Schema.NullOr(PositiveRevision),
};

/** Closed identity for one immutable author-accepted lyrics revision. */
export const MediaLyricsIdentity = Schema.Struct(MediaLyricsIdentityFields);
export type MediaLyricsIdentity = Schema.Schema.Type<typeof MediaLyricsIdentity>;

/** Author-reviewed hostile data retained separately from immutable ASR evidence. */
export const MediaAcceptedLyrics = Schema.Struct({
  version: Schema.Literal("media-accepted-lyrics-v1"),
  ...MediaLyricsIdentityFields,
  lyrics: Schema.NonEmptyString.check(
    Schema.isMaxLength(MEDIA_TRANSCRIPT_MAX_LENGTH),
    Schema.makeFilter((value) =>
      utf8ByteLength(value) <= MEDIA_TRANSCRIPT_MAX_LENGTH * 4
        ? undefined
        : "Lyrics exceed their UTF-8 byte ceiling",
    ),
  ),
});
export type MediaAcceptedLyrics = Schema.Schema.Type<typeof MediaAcceptedLyrics>;

/**
 * Private hostile-data evidence. `transcript` and segment text are inert data;
 * this shape has no tool, network, storage, secret, policy, or instruction
 * fields and is never a Workflow payload or public response.
 */
export const MediaTranscriptArtifact = Schema.Struct({
  version: Schema.Literal("media-transcript-artifact-v1"),
  ...MediaTranscriptIdentityFields,
  audio_artifact_ref: BoundedArtifactReference,
  transcript: Schema.NonEmptyString.check(
    Schema.isMaxLength(MEDIA_TRANSCRIPT_MAX_LENGTH),
    Schema.makeFilter((value) =>
      utf8ByteLength(value) <= MEDIA_TRANSCRIPT_MAX_LENGTH * 4
        ? undefined
        : "Transcript exceeds its UTF-8 byte ceiling",
    ),
  ),
  segments: TranscriptSegments,
});
export type MediaTranscriptArtifact = Schema.Schema.Type<typeof MediaTranscriptArtifact>;

const DetectedLanguageEvidence = Schema.Struct({
  language_bcp47: MediaBcp47LanguageTag,
  confidence: Confidence,
});

export { DetectedLanguageEvidence };
export type MediaDetectedLanguageEvidence = Schema.Schema.Type<typeof DetectedLanguageEvidence>;

const DetectedLanguages = Schema.Array(DetectedLanguageEvidence).check(
  Schema.isMaxLength(MEDIA_LANGUAGE_EVIDENCE_MAX_COUNT),
  Schema.makeFilter((languages) => {
    const tags = languages.map(({ language_bcp47 }) => language_bcp47);
    return new Set(tags).size === tags.length
      ? undefined
      : "Detected language evidence must not repeat a language tag";
  }),
);

/** ASR input is an immutable audio revision plus a server-owned reference. */
export const MediaAsrInput = Schema.Struct({
  version: Schema.Literal("media-asr-input-v1"),
  audio: MediaAudioRevision,
  attempt: MediaProviderAttemptMetadata,
});
export type MediaAsrInput = Schema.Schema.Type<typeof MediaAsrInput>;

const MediaAsrTranscriptResult = Schema.Struct({
  version: Schema.Literal("media-asr-result-v1"),
  status: Schema.Literal("transcript"),
  audio: MediaAudioRevision,
  attempt: MediaProviderAttemptMetadata,
  transcript: MediaTranscriptArtifact,
  detected_languages: DetectedLanguages,
  adapter_revision: BoundedRevisionIdentifier,
});

const MediaAsrNoSpeechResult = Schema.Struct({
  version: Schema.Literal("media-asr-result-v1"),
  status: Schema.Literal("no_speech"),
  audio: MediaAudioRevision,
  attempt: MediaProviderAttemptMetadata,
  transcript: Schema.Null,
  detected_languages: DetectedLanguages.check(
    Schema.makeFilter((languages) =>
      languages.length === 0 ? undefined : "No-speech results cannot carry language evidence",
    ),
  ),
  evidence_ref: BoundedArtifactReference,
  adapter_revision: BoundedRevisionIdentifier,
});

/** ASR has only transcript or explicit no-speech success outcomes. */
export const MediaAsrResult = Schema.Union([MediaAsrTranscriptResult, MediaAsrNoSpeechResult]);
export type MediaAsrResult = Schema.Schema.Type<typeof MediaAsrResult>;

const ClassifierProvenance = {
  policy_revision: BoundedRevisionIdentifier,
  prompt_revision: BoundedRevisionIdentifier,
  classifier_revision: BoundedRevisionIdentifier,
  adapter_revision: BoundedRevisionIdentifier,
};

const ClassifierResultIdentity = {
  transcript_identity: MediaTranscriptIdentity,
  lyrics_identity: MediaLyricsIdentity,
  attempt_id: BoundedIdentifier,
};

const ClassifierEvidence = Schema.Struct({
  kind: Schema.Literals(["explicitness", "primary_language", "secondary_language"]),
  source: Schema.Literals(["transcript", "lyrics"]),
  segment_index: NonNegativeInteger.check(
    Schema.isBetween({ minimum: 0, maximum: MEDIA_TRANSCRIPT_SEGMENT_MAX_COUNT - 1 }),
  ),
  confidence: Confidence,
});

export { ClassifierEvidence };
export type MediaClassifierEvidence = Schema.Schema.Type<typeof ClassifierEvidence>;

const ClassifierEvidenceList = Schema.Array(ClassifierEvidence).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MEDIA_CLASSIFIER_EVIDENCE_MAX_COUNT),
);

const ClassifierFailureEvidence = Schema.Array(ClassifierEvidence).check(
  Schema.isMaxLength(MEDIA_CLASSIFIER_EVIDENCE_MAX_COUNT),
);

/** Classifier input keeps immutable ASR evidence and accepted lyrics separate. */
export const MediaExplicitnessClassifierInput = Schema.Struct({
  version: Schema.Literal("media-explicitness-classifier-input-v1"),
  transcript: MediaTranscriptArtifact,
  accepted_lyrics: MediaAcceptedLyrics,
  attempt: MediaProviderAttemptMetadata,
}).check(
  Schema.makeFilter(({ transcript, accepted_lyrics }) =>
    transcript.operation_id === accepted_lyrics.operation_id &&
    transcript.audio_revision === accepted_lyrics.audio_revision &&
    transcript.canonical_audio_sha256 === accepted_lyrics.canonical_audio_sha256 &&
    (accepted_lyrics.base_transcript_revision === null ||
      accepted_lyrics.base_transcript_revision === transcript.analysis_revision)
      ? undefined
      : "Transcript and accepted lyrics must share exact audio lineage",
  ),
);
export type MediaExplicitnessClassifierInput = Schema.Schema.Type<
  typeof MediaExplicitnessClassifierInput
>;

const MediaExplicitnessClassifiedResult = Schema.Struct({
  version: Schema.Literal("media-explicitness-classifier-result-v1"),
  status: Schema.Literal("classified"),
  explicitness: Schema.Literals(["not_explicit", "explicit", "uncertain"]),
  transcript_explicitness: Schema.Literals(["not_explicit", "explicit", "uncertain"]),
  lyrics_explicitness: Schema.Literals(["not_explicit", "explicit", "uncertain"]),
  material_disagreement: Schema.Boolean,
  primary_language_bcp47: MediaBcp47LanguageTag,
  secondary_language_bcp47: Schema.NullOr(MediaBcp47LanguageTag),
  confidence: Schema.Struct({
    explicitness: Confidence,
    primary_language: Confidence,
    secondary_language: Schema.NullOr(Confidence),
  }),
  evidence: ClassifierEvidenceList,
  ...ClassifierResultIdentity,
  ...ClassifierProvenance,
}).check(
  Schema.makeFilter(
    ({
      explicitness,
      transcript_explicitness,
      lyrics_explicitness,
      material_disagreement,
      primary_language_bcp47,
      secondary_language_bcp47,
      confidence,
      evidence,
    }) => {
      const evidenceKinds = new Set(evidence.map(({ kind }) => kind));
      const secondaryLanguagePresent = secondary_language_bcp47 !== null;
      const secondaryConfidencePresent = confidence.secondary_language !== null;
      const languagesAreDistinct =
        !secondaryLanguagePresent || secondary_language_bcp47 !== primary_language_bcp47;
      const evidenceCoversClaimedFields =
        evidenceKinds.has("explicitness") &&
        evidenceKinds.has("primary_language") &&
        (secondaryLanguagePresent
          ? evidenceKinds.has("secondary_language")
          : !evidenceKinds.has("secondary_language"));
      const strongerAudioEvidenceRetained =
        transcript_explicitness !== "explicit" || explicitness === "explicit";
      const disagreementFailsClosed =
        !material_disagreement || explicitness === "explicit" || explicitness === "uncertain";
      const agreementIsTruthful =
        material_disagreement || transcript_explicitness === lyrics_explicitness;
      return languagesAreDistinct &&
        secondaryLanguagePresent === secondaryConfidencePresent &&
        evidenceCoversClaimedFields &&
        strongerAudioEvidenceRetained &&
        disagreementFailsClosed &&
        agreementIsTruthful
        ? undefined
        : "Classifier language, safety, disagreement, and evidence claims must agree";
    },
  ),
);

const MediaExplicitnessFailureResult = Schema.Union([
  Schema.Struct({
    version: Schema.Literal("media-explicitness-classifier-result-v1"),
    status: Schema.Literal("unparseable"),
    evidence: ClassifierFailureEvidence,
    ...ClassifierResultIdentity,
    ...ClassifierProvenance,
  }),
  Schema.Struct({
    version: Schema.Literal("media-explicitness-classifier-result-v1"),
    status: Schema.Literal("out_of_policy"),
    evidence: ClassifierFailureEvidence,
    ...ClassifierResultIdentity,
    ...ClassifierProvenance,
  }),
  Schema.Struct({
    version: Schema.Literal("media-explicitness-classifier-result-v1"),
    status: Schema.Literal("ambiguous"),
    evidence: ClassifierFailureEvidence,
    ...ClassifierResultIdentity,
    ...ClassifierProvenance,
  }),
  Schema.Struct({
    version: Schema.Literal("media-explicitness-classifier-result-v1"),
    status: Schema.Literal("exhausted"),
    evidence: ClassifierFailureEvidence,
    ...ClassifierResultIdentity,
    ...ClassifierProvenance,
  }),
]);

/**
 * Failure members are deliberately separate. In particular, exhausted is
 * not interchangeable with malformed output, policy rejection, or ambiguity.
 */
export const MediaExplicitnessClassifierResult = Schema.Union([
  MediaExplicitnessClassifiedResult,
  ...MediaExplicitnessFailureResult.members,
]);
export type MediaExplicitnessClassifierResult = Schema.Schema.Type<
  typeof MediaExplicitnessClassifierResult
>;

export interface MediaAsrAdapter {
  readonly recognize: (
    input: MediaAsrInput,
    options: MediaProviderCallOptions,
  ) => Effect.Effect<MediaAsrResult, MediaProviderFailure>;
}

/** Effect service tag for the provider-neutral ASR port. */
export class MediaAsr extends Context.Service<MediaAsr, MediaAsrAdapter>()(
  "@pirate/application/media-provider-contracts/MediaAsr",
) {}

export interface MediaExplicitnessClassifierAdapter {
  readonly classify: (
    input: MediaExplicitnessClassifierInput,
    options: MediaProviderCallOptions,
  ) => Effect.Effect<MediaExplicitnessClassifierResult, MediaProviderFailure>;
}

/** Effect service tag for the provider-neutral explicitness/language port. */
export class MediaExplicitnessClassifier extends Context.Service<
  MediaExplicitnessClassifier,
  MediaExplicitnessClassifierAdapter
>()("@pirate/application/media-provider-contracts/MediaExplicitnessClassifier") {}

export type MediaSpeechRecognitionService = MediaAsrAdapter;
export type MediaLanguageExplicitnessClassifierService = MediaExplicitnessClassifierAdapter;

/** Strict boundary decoders reject authority fields instead of silently dropping them. */
export const decodeMediaAsrInput = (input: unknown): MediaAsrInput =>
  Schema.decodeUnknownSync(MediaAsrInput, { onExcessProperty: "error" })(input);

export const decodeMediaAsrResult = (input: unknown): MediaAsrResult =>
  Schema.decodeUnknownSync(MediaAsrResult, { onExcessProperty: "error" })(input);

export const decodeMediaExplicitnessClassifierInput = (
  input: unknown,
): MediaExplicitnessClassifierInput =>
  Schema.decodeUnknownSync(MediaExplicitnessClassifierInput, { onExcessProperty: "error" })(input);

export const decodeMediaExplicitnessClassifierResult = (
  input: unknown,
): MediaExplicitnessClassifierResult =>
  Schema.decodeUnknownSync(MediaExplicitnessClassifierResult, { onExcessProperty: "error" })(input);

/** Cross-object check kept at the private adapter boundary, not in a public schema. */
export const isMediaClassifierResultBoundToTranscript = (
  input: MediaExplicitnessClassifierInput,
  result: MediaExplicitnessClassifierResult,
): boolean => {
  const identity = result.transcript_identity;
  const lyricsIdentity = result.lyrics_identity;
  const transcript = input.transcript;
  const lyrics = input.accepted_lyrics;
  const identityMatches =
    result.attempt_id === input.attempt.attempt_id &&
    identity.operation_id === transcript.operation_id &&
    identity.audio_revision === transcript.audio_revision &&
    identity.analysis_revision === transcript.analysis_revision &&
    identity.canonical_audio_sha256 === transcript.canonical_audio_sha256 &&
    identity.transcript_artifact_ref === transcript.transcript_artifact_ref &&
    identity.transcript_sha256 === transcript.transcript_sha256 &&
    lyricsIdentity.operation_id === lyrics.operation_id &&
    lyricsIdentity.audio_revision === lyrics.audio_revision &&
    lyricsIdentity.lyrics_revision === lyrics.lyrics_revision &&
    lyricsIdentity.canonical_audio_sha256 === lyrics.canonical_audio_sha256 &&
    lyricsIdentity.base_transcript_revision === lyrics.base_transcript_revision;
  const evidenceIndexesInBounds = result.evidence.every(({ source, segment_index }) =>
    source === "lyrics" ? segment_index === 0 : segment_index < transcript.segments.length,
  );
  if (!identityMatches || !evidenceIndexesInBounds || result.status !== "classified") {
    return identityMatches && evidenceIndexesInBounds;
  }

  const evidenceKinds = new Set(result.evidence.map(({ kind }) => kind));
  const evidenceCoversClaimedFields =
    evidenceKinds.has("explicitness") &&
    evidenceKinds.has("primary_language") &&
    (result.secondary_language_bcp47 === null
      ? !evidenceKinds.has("secondary_language")
      : evidenceKinds.has("secondary_language"));
  return (
    result.secondary_language_bcp47 !== result.primary_language_bcp47 &&
    (result.secondary_language_bcp47 === null) ===
      (result.confidence.secondary_language === null) &&
    evidenceCoversClaimedFields
  );
};

export const isMediaClassifierResultBoundToInputs = isMediaClassifierResultBoundToTranscript;

/** The processor must not accept evidence for a different immutable audio revision. */
export const isMediaAsrResultBoundToInput = (
  input: MediaAsrInput,
  result: MediaAsrResult,
): boolean =>
  result.audio.operation_id === input.audio.operation_id &&
  result.audio.audio_revision === input.audio.audio_revision &&
  result.audio.analysis_revision === input.audio.analysis_revision &&
  result.audio.canonical_audio_sha256 === input.audio.canonical_audio_sha256 &&
  result.audio.audio_artifact_ref === input.audio.audio_artifact_ref &&
  result.attempt.attempt_id === input.attempt.attempt_id &&
  (result.status === "no_speech" ||
    (result.transcript.operation_id === input.audio.operation_id &&
      result.transcript.audio_revision === input.audio.audio_revision &&
      result.transcript.analysis_revision === input.audio.analysis_revision &&
      result.transcript.canonical_audio_sha256 === input.audio.canonical_audio_sha256 &&
      result.transcript.audio_artifact_ref === input.audio.audio_artifact_ref));
