import { LanguageTagV1, SONG_LYRICS_TEXT_MAX_LENGTH } from "@pirate/contracts";
import { Context, type Effect, Schema } from "effect";

/**
 * These contracts are private application boundaries. They deliberately do
 * not contain a provider name, model name, credential, transport payload, or
 * a place where lyrics text can be interpreted as instructions.
 */

export const MEDIA_IDENTIFIER_MAX_BYTES = 256 as const;
export const MEDIA_REVISION_MAX_BYTES = 128 as const;
export const MEDIA_LYRICS_MAX_LENGTH = SONG_LYRICS_TEXT_MAX_LENGTH;
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

const BoundedRevisionIdentifier = boundedText(
  MEDIA_REVISION_MAX_BYTES,
  "Expected a bounded revision identifier without edge whitespace or control characters",
);

const PositiveRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

const PositiveTimeout = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MEDIA_PROVIDER_TIMEOUT_MAX_MS }),
);

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** Canonical language tags accepted by the public song projection. */
export const MediaBcp47LanguageTag = LanguageTagV1;
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

const MediaLyricsIdentityFields = {
  operation_id: BoundedIdentifier,
  audio_revision: PositiveRevision,
  lyrics_revision: PositiveRevision,
  canonical_audio_sha256: Sha256Hex,
};

/** Closed identity for one immutable author-accepted lyrics revision. */
export const MediaLyricsIdentity = Schema.Struct(MediaLyricsIdentityFields);
export type MediaLyricsIdentity = Schema.Schema.Type<typeof MediaLyricsIdentity>;

/** Author-submitted lyrics are the classifier's only hostile-data input. */
export const MediaAcceptedLyrics = Schema.Struct({
  version: Schema.Literal("media-accepted-lyrics-v1"),
  ...MediaLyricsIdentityFields,
  lyrics: Schema.NonEmptyString.check(
    Schema.isMaxLength(MEDIA_LYRICS_MAX_LENGTH),
    Schema.makeFilter((value) =>
      utf8ByteLength(value) <= MEDIA_LYRICS_MAX_LENGTH * 4
        ? undefined
        : "Lyrics exceed their UTF-8 byte ceiling",
    ),
  ),
});
export type MediaAcceptedLyrics = Schema.Schema.Type<typeof MediaAcceptedLyrics>;

const ClassifierProvenance = {
  policy_revision: BoundedRevisionIdentifier,
  prompt_revision: BoundedRevisionIdentifier,
  classifier_revision: BoundedRevisionIdentifier,
  adapter_revision: BoundedRevisionIdentifier,
};

const ClassifierResultIdentity = {
  lyrics_identity: MediaLyricsIdentity,
  attempt_id: BoundedIdentifier,
};

const ClassifierEvidence = Schema.Struct({
  kind: Schema.Literals(["explicitness", "primary_language", "secondary_language"]),
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

/** The classifier receives only the current immutable accepted lyrics revision. */
export const MediaExplicitnessClassifierInput = Schema.Struct({
  version: Schema.Literal("media-explicitness-classifier-input-v1"),
  accepted_lyrics: MediaAcceptedLyrics,
  attempt: MediaProviderAttemptMetadata,
});
export type MediaExplicitnessClassifierInput = Schema.Schema.Type<
  typeof MediaExplicitnessClassifierInput
>;

const MediaExplicitnessClassifiedResult = Schema.Struct({
  version: Schema.Literal("media-explicitness-classifier-result-v1"),
  status: Schema.Literal("classified"),
  explicitness: Schema.Literals(["not_explicit", "explicit", "uncertain"]),
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
    ({ primary_language_bcp47, secondary_language_bcp47, confidence, evidence }) => {
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
      return languagesAreDistinct &&
        secondaryLanguagePresent === secondaryConfidencePresent &&
        evidenceCoversClaimedFields
        ? undefined
        : "Classifier language, explicitness, and evidence claims must agree";
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

export type MediaLanguageExplicitnessClassifierService = MediaExplicitnessClassifierAdapter;

/** Strict boundary decoders reject authority fields instead of silently dropping them. */
export const decodeMediaExplicitnessClassifierInput = (
  input: unknown,
): MediaExplicitnessClassifierInput =>
  Schema.decodeUnknownSync(MediaExplicitnessClassifierInput, { onExcessProperty: "error" })(input);

export const decodeMediaExplicitnessClassifierResult = (
  input: unknown,
): MediaExplicitnessClassifierResult =>
  Schema.decodeUnknownSync(MediaExplicitnessClassifierResult, { onExcessProperty: "error" })(input);

/** The classifier result must remain fenced to the exact accepted lyrics revision. */
export const isMediaClassifierResultBoundToInputs = (
  input: MediaExplicitnessClassifierInput,
  result: MediaExplicitnessClassifierResult,
): boolean => {
  const lyricsIdentity = result.lyrics_identity;
  const lyrics = input.accepted_lyrics;
  const identityMatches =
    result.attempt_id === input.attempt.attempt_id &&
    lyricsIdentity.operation_id === lyrics.operation_id &&
    lyricsIdentity.audio_revision === lyrics.audio_revision &&
    lyricsIdentity.lyrics_revision === lyrics.lyrics_revision &&
    lyricsIdentity.canonical_audio_sha256 === lyrics.canonical_audio_sha256;
  if (!identityMatches || result.status !== "classified") return identityMatches;

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
