import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError } from "./errors.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));

export const VideoOutcomeV1 = Schema.Struct({
  submission_id: Identifier,
  kind: Schema.Literals(["processing_failure", "policy_block"]),
  song: Schema.NullOr(Schema.Struct({ community_id: Identifier, post_id: Identifier })),
});
export type VideoOutcomeV1 = Schema.Schema.Type<typeof VideoOutcomeV1>;

/** Only this request's permanent claim winner receives display permission. */
export const VideoOutcomeClaimV1 = Schema.Union([
  Schema.Struct({
    object: Schema.Literal("video_outcome_claim"),
    display_permission: Schema.Literal(false),
    outcome: Schema.Null,
  }),
  Schema.Struct({
    object: Schema.Literal("video_outcome_claim"),
    display_permission: Schema.Literal(true),
    outcome: VideoOutcomeV1,
  }),
]);
export type VideoOutcomeClaimV1 = Schema.Schema.Type<typeof VideoOutcomeClaimV1>;

export const ClaimVideoOutcome = endpoint({
  method: "POST",
  path: "/video-outcomes/claim",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    body: Schema.Struct({}).check(
      Schema.makeFilter(
        (value) => Object.keys(value).length === 0 || "Expected an empty claim request",
      ),
    ),
    bodyRequired: false,
  },
  response: VideoOutcomeClaimV1,
  errors: [AuthError, BadRequest, InternalError],
});
