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
type TextPostStoreV2Service = ContentServices["textPostStoreV2"];
type TextModerationProviderService = ContentServices["textModerationProvider"];
type PersonaStoreService = ContentServices["personaStore"];
type CommunityActor = Parameters<typeof joinCommunity>[0]["actor"];
type HomeFeedQuery = Parameters<typeof getHomeFeed>[0]["query"];

export interface ProductHandlerServices {
  readonly communityStore: CommunityStoreService;
  readonly contentStore: ContentStoreService;
  readonly textPostStore?: TextPostStoreService;
  readonly textModeration?: TextModerationService;
  readonly textPostStoreV2?: TextPostStoreV2Service;
  readonly textModerationProvider?: TextModerationProviderService;
  readonly personaStore?: PersonaStoreService;
  readonly feedStore: FeedStoreService;
  readonly identityStore?: CurrentUserServices["identityStore"];
  readonly moderationStore?: CommunityModerationStoreService;
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
  readonly ReportPost: EndpointHandler;
  readonly ModerateCaseAction: EndpointHandler;
  readonly GetCommunityModerationCapabilities: EndpointHandler;
  readonly ListCommunityModerationCases: EndpointHandler;
  readonly GetCommunityModerationCase: EndpointHandler;
  readonly GetCommunityModerationPolicy: EndpointHandler;
  readonly UpdateCommunityModerationPolicy: EndpointHandler;
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

const createCommentInputFrom = (request: DecodedRequest): CreateCommentReplyInput => {
  const { postId } = postPath(request);
  return {
    surface: "comment",
    targetId: postId,
    actor: communityActor(request.principal),
    body: request.body,
  };
};

const createReplyInputFrom = (request: DecodedRequest): CreateCommentReplyInput => {
  const { commentId } = commentPath(request);
  return {
    surface: "reply",
    targetId: commentId,
    actor: communityActor(request.principal),
    body: request.body,
  };
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
      ...(services.textPostStoreV2 === undefined
        ? {}
        : { textPostStoreV2: services.textPostStoreV2 }),
      ...(services.textModerationProvider === undefined
        ? {}
        : { textModerationProvider: services.textModerationProvider }),
      ...(services.personaStore === undefined ? {} : { personaStore: services.personaStore }),
    }),
  );

const createCommentHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    createCommentReply(createCommentInputFrom(request), {
      ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
      ...(services.textModeration === undefined ? {} : { textModeration: services.textModeration }),
      ...(services.textPostStoreV2 === undefined
        ? {}
        : { textPostStoreV2: services.textPostStoreV2 }),
      ...(services.textModerationProvider === undefined
        ? {}
        : { textModerationProvider: services.textModerationProvider }),
      ...(services.personaStore === undefined ? {} : { personaStore: services.personaStore }),
    }),
  );

const createReplyHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    createCommentReply(createReplyInputFrom(request), {
      ...(services.textPostStore === undefined ? {} : { textPostStore: services.textPostStore }),
      ...(services.textModeration === undefined ? {} : { textModeration: services.textModeration }),
      ...(services.textPostStoreV2 === undefined
        ? {}
        : { textPostStoreV2: services.textPostStoreV2 }),
      ...(services.textModerationProvider === undefined
        ? {}
        : { textModerationProvider: services.textModerationProvider }),
      ...(services.personaStore === undefined ? {} : { personaStore: services.personaStore }),
    }),
  );

type ReportBody = Readonly<{
  readonly idempotency_key: string;
  readonly reason_code: Parameters<
    CommunityModerationStoreService["reportTarget"]
  >[0]["reasonCode"];
}>;
type ActionBody = Readonly<{
  readonly version: "moderation-case-action-v2";
  readonly idempotency_key: string;
  readonly expected_case_revision: number;
  readonly action: Parameters<CommunityModerationStoreService["actOnCase"]>[0]["action"];
}>;

const moderationStoreFrom = (services: ProductHandlerServices): CommunityModerationStoreService => {
  if (services.moderationStore === undefined) {
    throw new Error("Community moderation store is not configured");
  }
  return services.moderationStore;
};

const reportHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
  targetType: "post" | "comment",
) => {
  const targetId =
    targetType === "post" ? postPath(request).postId : commentPath(request).commentId;
  const body = request.body as ReportBody;
  const requestHash = await Effect.runPromise(
    canonicalBodyHash({
      endpoint: `POST /${targetType}s/:${targetType}Id/reports`,
      [`${targetType}_id`]: targetId,
      body,
    }),
  );
  return Effect.runPromise(
    reportCommunityContent(
      {
        targetType,
        targetId,
        actor: communityActor(request.principal),
        idempotencyKey: body.idempotency_key,
        reasonCode: body.reason_code,
        requestHash,
      },
      { moderationStore: moderationStoreFrom(services) },
    ),
  );
};

const moderateCaseActionHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
) => {
  const { caseRef } = casePath(request);
  const body = request.body as ActionBody;
  const requestHash = await Effect.runPromise(
    canonicalBodyHash({
      endpoint: "POST /moderation/cases/:caseRef/actions",
      case_ref: caseRef,
      body,
    }),
  );
  return Effect.runPromise(
    moderateCommunityCase(
      {
        caseRef,
        actor: communityActor(request.principal),
        idempotencyKey: body.idempotency_key,
        expectedCaseRevision: body.expected_case_revision,
        action: body.action,
        requestHash,
      },
      { moderationStore: moderationStoreFrom(services) },
    ),
  );
};

const moderationCapabilitiesHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
) =>
  Effect.runPromise(
    getCommunityModerationCapabilities(
      { communityId: communityPath(request).communityId, actor: communityActor(request.principal) },
      { moderationStore: moderationStoreFrom(services) },
    ),
  );

const moderationCaseListHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
) =>
  Effect.runPromise(
    listCommunityModerationCases(
      {
        communityId: communityPath(request).communityId,
        actor: communityActor(request.principal),
        view: (request.query as { readonly view: "open" | "hidden" }).view,
      },
      { moderationStore: moderationStoreFrom(services) },
    ),
  );

const moderationCaseDetailHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
) =>
  Effect.runPromise(
    getCommunityModerationCase(
      {
        communityId: communityPath(request).communityId,
        caseRef: casePath(request).caseRef,
        actor: communityActor(request.principal),
      },
      { moderationStore: moderationStoreFrom(services) },
    ),
  );

const moderationPolicyHandler = async (request: DecodedRequest, services: ProductHandlerServices) =>
  Effect.runPromise(
    getCommunityModerationPolicy(
      { communityId: communityPath(request).communityId, actor: communityActor(request.principal) },
      { moderationStore: moderationStoreFrom(services) },
    ),
  );

const updateModerationPolicyHandler = async (
  request: DecodedRequest,
  services: ProductHandlerServices,
) =>
  Effect.runPromise(
    updateCommunityModerationPolicy(
      {
        communityId: communityPath(request).communityId,
        actor: communityActor(request.principal),
        update: request.body as Parameters<
          CommunityModerationStoreService["updatePolicy"]
        >[0]["update"],
      },
      { moderationStore: moderationStoreFrom(services) },
    ),
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
  ReportComment: (request) => reportHandler(request, services, "comment"),
  ReportPost: (request) => reportHandler(request, services, "post"),
  ModerateCaseAction: (request) => moderateCaseActionHandler(request, services),
  GetCommunityModerationCapabilities: (request) => moderationCapabilitiesHandler(request, services),
  ListCommunityModerationCases: (request) => moderationCaseListHandler(request, services),
  GetCommunityModerationCase: (request) => moderationCaseDetailHandler(request, services),
  GetCommunityModerationPolicy: (request) => moderationPolicyHandler(request, services),
  UpdateCommunityModerationPolicy: (request) => updateModerationPolicyHandler(request, services),
  GetTextContentSubmission: (request) => getTextContentSubmissionHandler(request, services),
  GetPost: (request) => post(request, services),
  CastPostVote: (request) => castPostVoteHandler(request, services),
  ClearPostVote: (request) => clearPostVoteHandler(request, services),
  GetPublicHomeFeed: (request) => publicHomeFeed(request, services),
  GetHomeFeed: (request) => homeFeed(request, services),
});

import {
  type CommunityModerationStoreService,
  canonicalBodyHash,
  getCommunityModerationCapabilities,
  getCommunityModerationCase,
  getCommunityModerationPolicy,
  listCommunityModerationCases,
  moderateCommunityCase,
  reportCommunityContent,
  updateCommunityModerationPolicy,
} from "@pirate/application/use-cases/content/community-moderation-runtime";
