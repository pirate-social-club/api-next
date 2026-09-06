import { Schema } from "effect";

const Bounded = Schema.String.check(Schema.isMaxLength(2048));
export const VideoRecognitionEvidenceSchema = Schema.Struct({
  variant: Schema.Literals(["primary", "alternate"]),
  requestId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  sampleSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  outcome: Schema.Literals([
    "retained_reference_match",
    "no_match",
    "inconclusive_fingerprint",
    "retryable_failure",
    "permanent_provider_rejection",
    "malformed_or_unsupported_response",
    "unavailable",
  ]),
  adapterRevision: Schema.optional(Bounded),
  reason: Schema.optional(Bounded),
  match: Schema.optional(
    Schema.Struct({
      provider: Schema.Literal("acrcloud"),
      providerMatchId: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
      matchKind: Schema.Literals(["music", "custom"]),
      title: Schema.NullOr(Bounded),
      artists: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
        Schema.isMaxLength(20),
      ),
      score: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type VideoRecognitionEvidence = typeof VideoRecognitionEvidenceSchema.Type;
