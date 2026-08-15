import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  GateUnsatisfied,
  MembershipRequired,
  RateLimited,
} from "./errors.ts";

/**
 * v1 product-slice endpoint contracts (api-next 000 §13): session exchange
 * and auth -> profile -> community discovery and membership -> posts,
 * comments, votes -> home feed (public and authenticated). Payments,
 * rewards, bookings, verification, Telegram, karaoke/dance, and HNS/EFP
 * stay on the old API and are NOT declared here.
 *
 * Wire compatibility (000 open decision 3): the session-exchange request
 * mirrors the old OpenAPI shape exactly (proof union, nullable optional
 * fields). Deeply nested response payloads (user, profile, feed items) are
 * declared as opaque for now — the Solid client consumes them but their
 * full field surfaces await the byte-compat review before being frozen.
 * Requests are fully typed from day one; responses are tightened per
 * domain as each milestone migrates.
 */

// --- session exchange and auth -------------------------------------------

const AuthProof = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("privy_access_token"),
    privy_access_token: Schema.String,
    privy_identity_token: Schema.optional(Schema.NullOr(Schema.String)),
    wallet_address: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("jwt_based_auth"),
    jwt: Schema.String,
  }),
]);

export const SessionExchange = endpoint({
  method: "POST",
  path: "/auth/session/exchange",
  auth: Auth.public(),
  request: Schema.Struct({ proof: AuthProof }),
  response: Schema.Struct({
    access_token: Schema.String,
    user: Schema.Unknown,
    profile: Schema.Unknown,
    onboarding: Schema.Unknown,
    wallet_attachments: Schema.Array(Schema.Unknown),
  }),
  errors: [AuthError, BadRequest, RateLimited],
});

// --- profile --------------------------------------------------------------

export const GetMe = endpoint({
  method: "GET",
  path: "/me",
  auth: Auth.user(),
  response: Schema.Struct({
    user: Schema.Unknown,
    profile: Schema.Unknown,
  }),
  errors: [AuthError],
});

// --- community discovery and membership ------------------------------------

export const GetCommunityPreview = endpoint({
  method: "GET",
  path: "/communities/:communityId/preview",
  auth: Auth.user({ optionalUser: true }),
  response: Schema.Struct({
    community: Schema.Unknown,
    membership: Schema.NullOr(Schema.Unknown),
  }),
  errors: [AuthError, BadRequest],
});

export const GetJoinEligibility = endpoint({
  method: "GET",
  path: "/communities/:communityId/join-eligibility",
  auth: Auth.user(),
  response: Schema.Struct({
    eligible: Schema.Boolean,
    reasons: Schema.Array(Schema.String),
  }),
  errors: [AuthError, MembershipRequired],
});

export const JoinCommunity = endpoint({
  method: "POST",
  path: "/communities/:communityId/join",
  auth: Auth.userOrAdmin(),
  response: Schema.Struct({ membership: Schema.Unknown }),
  errors: [AuthError, MembershipRequired, GateUnsatisfied, Conflict, RateLimited],
});

export const FollowCommunity = endpoint({
  method: "POST",
  path: "/communities/:communityId/follow",
  auth: Auth.user(),
  response: Schema.Struct({ following: Schema.Boolean }),
  errors: [AuthError, MembershipRequired, RateLimited],
});

export const UnfollowCommunity = endpoint({
  method: "POST",
  path: "/communities/:communityId/unfollow",
  auth: Auth.user(),
  response: Schema.Struct({ following: Schema.Boolean }),
  errors: [AuthError, RateLimited],
});

// --- posts, comments, votes -------------------------------------------------

export const CreatePost = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts",
  auth: Auth.agentDelegated("posts"),
  request: Schema.Struct({
    body: Schema.String,
    // Media attachment descriptors are typed when the media slice migrates.
    attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  response: Schema.Struct({ post: Schema.Unknown }),
  errors: [AuthError, BadRequest, MembershipRequired, GateUnsatisfied, RateLimited],
});

export const GetPost = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId",
  auth: Auth.user({ optionalUser: true }),
  response: Schema.Struct({ post: Schema.Unknown }),
  errors: [BadRequest, MembershipRequired],
});

export const CastPostVote = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/vote",
  auth: Auth.userOrAdmin({ altcha: "vote" }),
  request: Schema.Struct({
    value: Schema.Literals([-1, 1]),
    altcha: Schema.optional(Schema.String),
  }),
  response: Schema.Struct({ value: Schema.Literals([-1, 0, 1]) }),
  errors: [BadRequest, GateUnsatisfied, RateLimited, MembershipRequired],
});

export const ClearPostVote = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/clear_vote",
  auth: Auth.userOrAdmin({ altcha: "vote" }),
  response: Schema.Struct({ value: Schema.Literals([-1, 0, 1]) }),
  errors: [BadRequest, GateUnsatisfied, RateLimited, MembershipRequired],
});

export const CreateCommentReply = endpoint({
  method: "POST",
  path: "/communities/:communityId/comments/:commentId/replies",
  auth: Auth.agentDelegated("comments"),
  request: Schema.Struct({ body: Schema.String }),
  response: Schema.Struct({ comment: Schema.Unknown }),
  errors: [AuthError, BadRequest, MembershipRequired, GateUnsatisfied, RateLimited],
});

// --- home feed ---------------------------------------------------------------

const FeedResponse = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const GetPublicHomeFeed = endpoint({
  method: "GET",
  path: "/feed/home/public",
  auth: Auth.public(),
  response: FeedResponse,
  errors: [BadRequest],
});

export const GetHomeFeed = endpoint({
  method: "GET",
  path: "/feed/home",
  auth: Auth.user(),
  response: FeedResponse,
  errors: [AuthError, BadRequest],
});
