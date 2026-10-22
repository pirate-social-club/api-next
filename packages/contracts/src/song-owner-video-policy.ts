import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "./errors.ts";
import { PersonaIdV1 } from "./personas.ts";

const Identifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) =>
    value === value.trim() &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
      ? undefined
      : "Expected a bounded canonical identifier",
  ),
);

const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

export const SongOwnerThirdPartyRewardLegPolicyV1 = Schema.Literals(["allowed", "owner_only"]);
export type SongOwnerThirdPartyRewardLegPolicyV1 = Schema.Schema.Type<
  typeof SongOwnerThirdPartyRewardLegPolicyV1
>;

export const SongOwnerPoolLegPolicyV1 = Schema.Literals(["allowed", "declined"]);
export type SongOwnerPoolLegPolicyV1 = Schema.Schema.Type<typeof SongOwnerPoolLegPolicyV1>;

export const SongOwnerDerivativeVideoPolicyV1 = Schema.Literals([
  "allowed",
  "owner_only",
  "blocked",
]);
export type SongOwnerDerivativeVideoPolicyV1 = Schema.Schema.Type<
  typeof SongOwnerDerivativeVideoPolicyV1
>;

const SongOwnerPolicyPath = Schema.Struct({
  communityId: Identifier,
  postId: Identifier,
});

const SongOwnerPersonaQuery = Schema.Struct({ persona_id: PersonaIdV1 });

/** The full private projection used by owner-management clients. */
export const SongOwnerPolicyManagementV1 = Schema.Struct({
  object: Schema.Literal("song_owner_policy"),
  community_id: Identifier,
  post_id: Identifier,
  audio_revision: PositiveInteger,
  owner_account_id: Identifier,
  policy_revision: PositiveInteger,
  third_party_reward_legs: SongOwnerThirdPartyRewardLegPolicyV1,
  pool_leg: SongOwnerPoolLegPolicyV1,
  derivative_video: SongOwnerDerivativeVideoPolicyV1,
  policy_hash: Sha256Hex,
  effective_at: CanonicalInstant,
});
export type SongOwnerPolicyManagementV1 = Schema.Schema.Type<typeof SongOwnerPolicyManagementV1>;

/**
 * Public/Solid projection. Only the presentation and preflight fields Spec 013
 * acceptance case 10 names: the effective derivative-video policy, its
 * revision, and the capability boolean. Account and audit identity, the
 * owner's reward posture, and the song audio revision never cross this
 * boundary. Video readiness is advisory for the current audio revision;
 * reservation rechecks it before granting upload authority.
 */
export const PublicSongOwnerPolicyV1 = Schema.Struct({
  object: Schema.Literal("song_owner_policy"),
  community_id: Identifier,
  post_id: Identifier,
  policy_revision: PositiveInteger,
  derivative_video: SongOwnerDerivativeVideoPolicyV1,
  can_post_with_song: Schema.Boolean,
  video_ready: Schema.Boolean,
});
export type PublicSongOwnerPolicyV1 = Schema.Schema.Type<typeof PublicSongOwnerPolicyV1>;

export const UpdateSongOwnerPolicyV1 = Schema.Struct({
  persona_id: PersonaIdV1,
  expected_policy_revision: PositiveInteger,
  third_party_reward_legs: SongOwnerThirdPartyRewardLegPolicyV1,
  pool_leg: SongOwnerPoolLegPolicyV1,
  derivative_video: SongOwnerDerivativeVideoPolicyV1,
});
export type UpdateSongOwnerPolicyV1 = Schema.Schema.Type<typeof UpdateSongOwnerPolicyV1>;

export const GetSongOwnerPolicy = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/owner-policy",
  auth: Auth.user(),
  request: { path: SongOwnerPolicyPath, query: SongOwnerPersonaQuery },
  response: SongOwnerPolicyManagementV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const UpdateSongOwnerPolicy = endpoint({
  method: "PATCH",
  path: "/communities/:communityId/posts/:postId/owner-policy",
  auth: Auth.user(),
  request: { path: SongOwnerPolicyPath, body: UpdateSongOwnerPolicyV1 },
  response: SongOwnerPolicyManagementV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, NotFound, InternalError],
});

export const GetPublicSongOwnerPolicy = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/owner-policy/public",
  auth: Auth.user({ optionalUser: true }),
  request: {
    path: SongOwnerPolicyPath,
    query: Schema.Struct({ persona_id: Schema.optional(PersonaIdV1) }),
  },
  response: PublicSongOwnerPolicyV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

/** Unregistered V2 command. Reward/pool permission is never caller controlled. */
export const UpdateSongOwnerDerivativeVideoPolicyV2 = Schema.Struct({
  persona_id: PersonaIdV1,
  expected_derivative_policy_revision: PositiveInteger,
  derivative_video: SongOwnerDerivativeVideoPolicyV1,
});
export type UpdateSongOwnerDerivativeVideoPolicyV2 = Schema.Schema.Type<
  typeof UpdateSongOwnerDerivativeVideoPolicyV2
>;
export const decodeUpdateSongOwnerDerivativeVideoPolicyV2 = Schema.decodeUnknownSync(
  UpdateSongOwnerDerivativeVideoPolicyV2,
  { onExcessProperty: "error" },
);

const openSongFundingPolicyFieldsV2 = {
  version: Schema.Literal("open-song-funding-policy-v2"),
  community_id: Identifier,
  post_id: Identifier,
  audio_revision: PositiveInteger,
  funding_policy_revision: PositiveInteger,
  open_funding_rule_hash: Sha256Hex,
  third_party_reward_legs: Schema.Literal("allowed"),
  pool_leg: Schema.Literal("allowed"),
};

/** Required authority inputs, not an inferred rule or an owner permission. */
export const OpenSongFundingPolicyPreimageV2 = Schema.Struct(openSongFundingPolicyFieldsV2);
export type OpenSongFundingPolicyPreimageV2 = Schema.Schema.Type<
  typeof OpenSongFundingPolicyPreimageV2
>;

/** Read-only evidence. Shape validation does not prove admission or the digest. */
export const OpenSongFundingPolicyV2 = Schema.Struct({
  ...openSongFundingPolicyFieldsV2,
  funding_policy_hash: Sha256Hex,
});
export type OpenSongFundingPolicyV2 = Schema.Schema.Type<typeof OpenSongFundingPolicyV2>;
export const decodeOpenSongFundingPolicyV2 = Schema.decodeUnknownSync(OpenSongFundingPolicyV2, {
  onExcessProperty: "error",
});

const songOwnerDerivativePolicyFieldsV2 = {
  version: Schema.Literal("song-owner-derivative-video-policy-v2"),
  community_id: Identifier,
  post_id: Identifier,
  audio_revision: PositiveInteger,
  owner_account_id: Identifier,
  derivative_policy_revision: PositiveInteger,
  derivative_video: SongOwnerDerivativeVideoPolicyV1,
};
export const SongOwnerDerivativeVideoPolicyPreimageV2 = Schema.Struct(
  songOwnerDerivativePolicyFieldsV2,
);
export type SongOwnerDerivativeVideoPolicyPreimageV2 = Schema.Schema.Type<
  typeof SongOwnerDerivativeVideoPolicyPreimageV2
>;

export const SongOwnerDerivativeVideoPolicyRevisionV2 = Schema.Struct({
  ...songOwnerDerivativePolicyFieldsV2,
  derivative_policy_hash: Sha256Hex,
});
export type SongOwnerDerivativeVideoPolicyRevisionV2 = Schema.Schema.Type<
  typeof SongOwnerDerivativeVideoPolicyRevisionV2
>;
export const decodeSongOwnerDerivativeVideoPolicyRevisionV2 = Schema.decodeUnknownSync(
  SongOwnerDerivativeVideoPolicyRevisionV2,
  { onExcessProperty: "error" },
);

/** V5 L8 canonical UTF-8 input text for a future SHA256 implementation.
 * No output hash is an input. Revision is required provenance metadata; the
 * accepted funding identity tuple binds the rule hash, not derivative edits.
 */
export function openSongFundingPolicyPreimageV2(input: unknown): string {
  const value = Schema.decodeUnknownSync(OpenSongFundingPolicyPreimageV2, {
    onExcessProperty: "error",
  })(input);
  return JSON.stringify([
    "pirate.open-song-funding-policy.v2",
    [
      value.community_id,
      value.post_id,
      value.audio_revision,
      value.open_funding_rule_hash,
      value.third_party_reward_legs,
      value.pool_leg,
    ],
  ]);
}

/** Independent derivative identity; never a substitute for a V1 policy hash.
 * Only canonical input text is produced here, not a computed/authenticated hash.
 */
export function songOwnerDerivativeVideoPolicyPreimageV2(input: unknown): string {
  const value = Schema.decodeUnknownSync(SongOwnerDerivativeVideoPolicyPreimageV2, {
    onExcessProperty: "error",
  })(input);
  return JSON.stringify([
    "pirate.song-owner-derivative-video-policy.v2",
    [
      value.community_id,
      value.post_id,
      value.audio_revision,
      value.owner_account_id,
      value.derivative_policy_revision,
      value.derivative_video,
    ],
  ]);
}
