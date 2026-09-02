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

/** Public/Solid projection. Account and audit identity never cross this boundary. */
export const PublicSongOwnerPolicyV1 = Schema.Struct({
  object: Schema.Literal("song_owner_policy"),
  community_id: Identifier,
  post_id: Identifier,
  audio_revision: PositiveInteger,
  policy_revision: PositiveInteger,
  third_party_reward_legs: SongOwnerThirdPartyRewardLegPolicyV1,
  pool_leg: SongOwnerPoolLegPolicyV1,
  derivative_video: SongOwnerDerivativeVideoPolicyV1,
  can_post_with_song: Schema.Boolean,
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
