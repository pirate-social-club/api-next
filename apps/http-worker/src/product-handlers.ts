import {
  type FollowCommunityInput,
  followCommunity,
} from "@pirate/application/use-cases/community/follow-community";
import { getCommunityPreview } from "@pirate/application/use-cases/community/get-community-preview";
import { getJoinEligibility } from "@pirate/application/use-cases/community/get-join-eligibility";
import { joinCommunity } from "@pirate/application/use-cases/community/join-community";
import {
  type UnfollowCommunityInput,
  unfollowCommunity,
} from "@pirate/application/use-cases/community/unfollow-community";
import {
  type CastPostVoteInput,
  castPostVote,
} from "@pirate/application/use-cases/content/cast-post-vote";
import {
  type ClearPostVoteInput,
  clearPostVote,
} from "@pirate/application/use-cases/content/clear-post-vote";
import {
  type ModerateCaseActionInput,
  moderateCaseAction,
  type ReportCommentInput,
  reportComment,
} from "@pirate/application/use-cases/content/comment-moderation";
import {
  type CreateCommentReplyInput,
  createCommentReply,
} from "@pirate/application/use-cases/content/comments-replies";
import {
  type CreatePostInput,
  createPost,
} from "@pirate/application/use-cases/content/create-post";
import { getPost } from "@pirate/application/use-cases/content/get-post";
import { getTextContentSubmission } from "@pirate/application/use-cases/content/text-post";
import {
  type CurrentUserServices,
  getCurrentUser,
} from "@pirate/application/use-cases/current-user";
import { getHomeFeed, getPublicHomeFeed } from "@pirate/application/use-cases/feed/home-feed";
import { AuthError, type JoinCommunity } from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";

type CommunityServices = Parameters<typeof getCommunityPreview>[1];
type FeedServices = Parameters<typeof getHomeFeed>[1];
type CommunityStoreService = CommunityServices["communityStore"];
type FeedStoreService = FeedServices["feedStore"];
type ContentServices = Parameters<typeof getPost>[1];
type ContentStoreService = ContentServices["contentStore"];
type TextPostStoreService = ContentServices["textPostStore"];
type TextModerationService = ContentServices["textModeration"];
type PersonaStoreService = ContentServices["personaStore"];
type CommunityActor = Parameters<typeof joinCommunity>[0]["actor"];
type HomeFeedQuery = Parameters<typeof getHomeFeed>[0]["query"];

export interface ProductHandlerServices {
  readonly communityStore: CommunityStoreService;
  readonly contentStore: ContentStoreService;
  readonly textPostStore?: TextPostStoreService;
  readonly textModeration?: TextModerationService;
  readonly personaStore?: PersonaStoreService;
  readonly feedStore: FeedStoreService;
  readonly identityStore?: CurrentUserServices["identityStore"];
}

export type ProductHandlers = Readonly<{
  readonly GetCurrentUser: EndpointHandler;
  readonly GetCommunityPreview: EndpointHandler;
  readonly GetJoinEligibility: EndpointHandler;
  readonly JoinCommunity: EndpointHandler;
  readonly FollowCommunity: EndpointHandler;
  readonly UnfollowCommunity: EndpointHandler;
  readonly CreatePost: EndpointHandler;
  readonly CreateComment: EndpointHandler;
  readonly CreateCommentReply: EndpointHandler;
  readonly ReportComment: EndpointHandler;
  readonly ModerateCaseAction: EndpointHandler;
  readonly GetTextContentSubmission: EndpointHandler;
  readonly GetPost: EndpointHandler;
  readonly CastPostVote: EndpointHandler;
  readonly ClearPostVote: EndpointHandler;
  readonly GetPublicHomeFeed: EndpointHandler;
  readonly GetHomeFeed: EndpointHandler;
}>;

type CommunityPath = Readonly<{ readonly communityId: string }>;
type PostPath = Readonly<{ readonly postId: string }>;
type SubmissionPath = Readonly<{ readonly submissionId: string }>;
type CommentPath = Readonly<{ readonly commentId: string }>;
type CasePath = Readonly<{ readonly caseRef: string }>;
type LocaleQuery = Readonly<{ readonly locale?: string }>;
type JoinBody = Schema.Schema.Type<(typeof JoinCommunity.request)["body"]>;

const communityPath = (request: DecodedRequest): CommunityPath => request.params as CommunityPath;

const postPath = (request: DecodedRequest): PostPath => request.params as PostPath;

const submissionPath = (request: DecodedRequest): SubmissionPath =>
  request.params as SubmissionPath;

const commentPath = (request: DecodedRequest): CommentPath => request.params as CommentPath;

const casePath = (request: DecodedRequest): CasePath => request.params as CasePath;

const localeQuery = (request: DecodedRequest): LocaleQuery => (request.query ?? {}) as LocaleQuery;

const feedQuery = (request: DecodedRequest): HomeFeedQuery =>
  (request.query ?? {}) as HomeFeedQuery;

const authorizationFailure = (): AuthError => new AuthError({ message: "Authorization failed" });

const currentUser = async (request: DecodedRequest, services: ProductHandlerServices) => {
  const actor = communityActor(request.principal);
  if (services.identityStore === undefined) {
    throw new Error("Current user identity store is not configured");
  }
  return Effect.runPromise(
    getCurrentUser({ userId: actor.userId }, { identityStore: services.identityStore }),
  );
};

/**
 * Community operations are always attributed to a human user. The transport
 * authorizer normally enforces this policy, but the adapter repeats the
 * check so direct handler composition cannot accidentally widen it to device
 * or agent principals.
 */
const communityActor = (principal: Principal | null): CommunityActor => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw authorizationFailure();
  }
  return {
    userId: principal.subject,
    kind: principal.kind,
    ...(principal.scopes === undefined ? {} : { scopes: principal.scopes }),
  };
};

const optionalCommunityViewer = (principal: Principal | null): string | undefined =>
  principal === null ? undefined : communityActor(principal).userId;

export const followCommunityInputFrom = (request: DecodedRequest): FollowCommunityInput => {
  const { communityId } = communityPath(request);
  const actor = communityActor(request.principal);
  const body = request.body as FollowCommunityInput["body"];
  return body === undefined ? { communityId, actor } : { communityId, actor, body };
};

export const unfollowCommunityInputFrom = (request: DecodedRequest): UnfollowCommunityInput => {
  const { communityId } = communityPath(request);
  const actor = communityActor(request.principal);
  const body = request.body as UnfollowCommunityInput["body"];
  return body === undefined ? { communityId, actor } : { communityId, actor, body };
};

export const createPostInputFrom = (request: DecodedRequest): CreatePostInput => {
  const { communityId } = communityPath(request);
  return {
    communityId,
    actor: communityActor(request.principal),
    body: request.body,
  };
};

export const createCommentInputFrom = (request: DecodedRequest): CreateCommentReplyInput => {
  const { postId } = postPath(request);
  return {
    surface: "comment",
    targetId: postId,
    actor: communityActor(request.principal),
    body: request.body,
  };
};

export const createReplyInputFrom = (request: DecodedRequest): CreateCommentReplyInput => {
  const { commentId } = commentPath(request);
  return {
    surface: "reply",
    targetId: commentId,
    actor: communityActor(request.principal),
    body: request.body,
  };
};

export const reportCommentInputFrom = (request: DecodedRequest): ReportCommentInput => {
  const { commentId } = commentPath(request);
  return { commentId, actor: communityActor(request.principal), body: request.body };
};

export const moderateCaseActionInputFrom = (request: DecodedRequest): ModerateCaseActionInput => {
  const { caseRef } = casePath(request);
  return { caseRef, actor: communityActor(request.principal), body: request.body };
};

export const castPostVoteInputFrom = (request: DecodedRequest): CastPostVoteInput => {
  const { postId } = postPath(request);
  return {
    postId,
    actor: communityActor(request.principal),
    body: request.body,
  };
};

export const clearPostVoteInputFrom = (request: DecodedRequest): ClearPostVoteInput => {
  const { postId } = postPath(request);
  return {
    postId,
    actor: communityActor(request.principal),
    body: request.body,
  };
};

const communityPreview = async (request: DecodedRequest, services: ProductHandlerServices) => {
  const { communityId } = communityPath(request);
  const { locale } = localeQuery(request);
  const viewerUserId = optionalCommunityViewer(request.principal);
  return Effect.runPromise(
    getCommunityPreview(
      {
        communityId,
        ...(locale === undefined ? {} : { locale }),
        ...(viewerUserId === undefined ? {} : { viewerUserId }),
      },
      { communityStore: services.communityStore },
    ),
  );
};

const join = async (request: DecodedRequest, services: ProductHandlerServices) => {
  const { communityId } = communityPath(request);
  const actor = communityActor(request.principal);
  const body = (request.body ?? {}) as JoinBody;
  return Effect.runPromise(
    joinCommunity({ communityId, actor, body }, { communityStore: services.communityStore }),
  );
};

const eligibility = async (request: DecodedRequest, services: ProductHandlerServices) => {
  const { communityId } = communityPath(request);
  const actor = communityActor(request.principal);
  return Effect.runPromise(
    getJoinEligibility(
      { communityId, userId: actor.userId },
      { communityStore: services.communityStore },
    ),
  );
};

const follow = async (request: DecodedRequest, services: ProductHandlerServices) => {
  return Effect.runPromise(
    followCommunity(followCommunityInputFrom(request), {
      communityStore: services.communityStore,
    }),
  );
};

const unfollow = async (request: DecodedRequest, services: ProductHandlerServices) => {
  return Effect.runPromise(
    unfollowCommunity(unfollowCommunityInputFrom(request), {
      communityStore: services.communityStore,
    }),
  );
};

const post = async (request: DecodedRequest, services: ProductHandlerServices) => {
  const { postId } = postPath(request);
  const { locale } = localeQuery(request);
  const viewer = communityActor(request.principal);
  return Effect.runPromise(
    getPost(
      {
        postId,
        viewer,
        ...(locale === undefined ? {} : { locale }),
      },
      { contentStore: services.contentStore },
    ),
  );
};

const createPostHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    createPost(createPostInputFrom(request), {
      contentStore: services.contentStore,
      ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
      ...(services.textModeration === undefined ? {} : { textModeration: services.textModeration }),
      ...(services.personaStore === undefined ? {} : { personaStore: services.personaStore }),
    }),
  );

const createCommentHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    createCommentReply(createCommentInputFrom(request), {
      ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
      ...(services.textModeration === undefined ? {} : { textModeration: services.textModeration }),
      ...(services.personaStore === undefined ? {} : { personaStore: services.personaStore }),
    }),
  );

const createReplyHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    createCommentReply(createReplyInputFrom(request), {
      ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
      ...(services.textModeration === undefined ? {} : { textModeration: services.textModeration }),
      ...(services.personaStore === undefined ? {} : { personaStore: services.personaStore }),
    }),
  );

const reportCommentHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    reportComment(reportCommentInputFrom(request), {
      ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
    }),
  );

const moderateCaseActionHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
) =>
  Effect.runPromise(
    moderateCaseAction(moderateCaseActionInputFrom(request), {
      ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
    }),
  );

const getTextContentSubmissionHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
) => {
  const { submissionId } = submissionPath(request);
  return Effect.runPromise(
    getTextContentSubmission(
      { submissionId, actor: communityActor(request.principal) },
      services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore },
    ),
  );
};

const castPostVoteHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    castPostVote(castPostVoteInputFrom(request), { contentStore: services.contentStore }),
  );

const clearPostVoteHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    clearPostVote(clearPostVoteInputFrom(request), { contentStore: services.contentStore }),
  );

const publicHomeFeed = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(getPublicHomeFeed(feedQuery(request), { feedStore: services.feedStore }));

const homeFeed = async (request: DecodedRequest, services: ProductHandlerServices) => {
  const query = feedQuery(request);
  const viewerUserId = optionalCommunityViewer(request.principal);
  return Effect.runPromise(
    getHomeFeed(viewerUserId === undefined ? { query } : { query, viewerUserId }, {
      feedStore: services.feedStore,
    }),
  );
};

export const makeProductHandlers = (services: ProductHandlerServices): ProductHandlers => ({
  GetCurrentUser: (request) => currentUser(request, services),
  GetCommunityPreview: (request) => communityPreview(request, services),
  GetJoinEligibility: (request) => eligibility(request, services),
  JoinCommunity: (request) => join(request, services),
  FollowCommunity: (request) => follow(request, services),
  UnfollowCommunity: (request) => unfollow(request, services),
  CreatePost: (request) => createPostHandler(request, services),
  CreateComment: (request) => createCommentHandler(request, services),
  CreateCommentReply: (request) => createReplyHandler(request, services),
  ReportComment: (request) => reportCommentHandler(request, services),
  ModerateCaseAction: (request) => moderateCaseActionHandler(request, services),
  GetTextContentSubmission: (request) => getTextContentSubmissionHandler(request, services),
  GetPost: (request) => post(request, services),
  CastPostVote: (request) => castPostVoteHandler(request, services),
  ClearPostVote: (request) => clearPostVoteHandler(request, services),
  GetPublicHomeFeed: (request) => publicHomeFeed(request, services),
  GetHomeFeed: (request) => homeFeed(request, services),
});
