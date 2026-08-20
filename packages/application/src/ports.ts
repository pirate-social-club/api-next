import type {
  CastPostVote,
  ClearPostVote,
  CommitCommunityCreationIntent,
  CreateCommentReply,
  CreateCommunityCreationIntent,
  CreatePost,
  FollowCommunity,
  GetCommunityPreview,
  GetJoinEligibility,
  GetPost,
  GetPublicCommunityThreads,
  GetPublicHomeFeed,
  GetPublicProfileByHandle,
  JoinCommunity,
  UnfollowCommunity,
  UpdateCommunityCreationIntent,
} from "@pirate/contracts";
import { Context, Data, type Effect, type Schema } from "effect";

/**
 * Initial service-tag catalog (api-next 000 §7; 001 phase 0 step 4).
 *
 * Tags are interfaces — exactly what phase 0 exists to freeze. Lanes
 * implement these ports (platform-cf in production, testing in tests)
 * without editing this file; post-freeze changes are coordinator-mediated
 * and announced in the workspace register (001 §2). Service shapes are
 * deliberately minimal here: operations sharpen when lanes implement them,
 * via the same mediated rule.
 */

export class Clock extends Context.Service<
  Clock,
  {
    readonly now: Effect.Effect<number>;
  }
>()("Clock") {}

export class IdGen extends Context.Service<
  IdGen,
  {
    readonly next: Effect.Effect<string>;
  }
>()("IdGen") {}

/** Alert vocabulary shared by emitters and the collector (000 §12). */
export type AlertSeverity = "low" | "medium" | "high";

export interface Alert {
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly body: string;
  readonly entity?: string;
}

/** Code never sends; it emits Alert values. Aggregation is downstream. */
export class AlertCollector extends Context.Service<
  AlertCollector,
  {
    readonly emit: (alert: Alert) => Effect.Effect<void>;
  }
>()("AlertCollector") {}

/** Safe outcome states used when a deadline races with driver I/O. */
export type ControlPlaneOutcomeCertainty = "not-started" | "completed" | "aborted" | "unknown";

/** Connection and acquisition failures contain no driver-specific detail. */
export class ControlPlaneAcquireFailed extends Data.TaggedError("ControlPlaneAcquireFailed")<{
  readonly phase: "connection" | "acquisition";
  readonly limitMs: number;
  readonly elapsedMs: number;
}> {}

/** A timed-out operation is only retryable after its outcome is proven safe. */
export class ControlPlaneOperationTimedOut extends Data.TaggedError(
  "ControlPlaneOperationTimedOut",
)<{
  readonly label: string;
  readonly limitMs: number;
  readonly elapsedMs: number;
  readonly outcomeCertainty: ControlPlaneOutcomeCertainty;
}> {}

/** Statement failures expose only safe Postgres classification fields. */
export class ControlPlaneStatementFailed extends Data.TaggedError("ControlPlaneStatementFailed")<{
  readonly label: string;
  readonly sqlState: string | null;
  readonly constraint: string | null;
  readonly outcomeCertainty: ControlPlaneOutcomeCertainty;
}> {}

/** Commit and rollback uncertainty is never an ordinary retryable query error. */
export class ControlPlaneTransactionOutcomeUnknown extends Data.TaggedError(
  "ControlPlaneTransactionOutcomeUnknown",
)<{
  readonly phase: "commit" | "rollback";
  readonly label: string;
  readonly limitMs: number;
  readonly elapsedMs: number;
}> {}

export type ControlPlaneError =
  | ControlPlaneAcquireFailed
  | ControlPlaneOperationTimedOut
  | ControlPlaneStatementFailed
  | ControlPlaneTransactionOutcomeUnknown;

/** A parameterized PostgreSQL statement with safe logging metadata. */
export interface ControlPlaneStatement {
  readonly label: string;
  readonly text: string;
  readonly values: readonly unknown[];
  readonly readonly: boolean;
}

export interface ControlPlaneResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface ControlPlaneTransaction {
  readonly execute: <Row = unknown>(
    statement: ControlPlaneStatement,
  ) => Effect.Effect<ControlPlaneResult<Row>, ControlPlaneError>;
}

/** Control-plane (Postgres) access; transactions via scoped acquire. */
export class ControlPlaneDb extends Context.Service<
  ControlPlaneDb,
  ControlPlaneTransaction & {
    readonly withTransaction: <A, E, R>(
      use: (transaction: ControlPlaneTransaction) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ControlPlaneError, R>;
  }
>()("ControlPlaneDb") {}

// CommunityShard was removed by the Postgres foundation amendment
// (specs 000/001, 2026-08-16): api-next has a single Postgres per
// environment and no runtime D1 shard access. See the TASKS.md
// "postgres-foundation@f4c69e4 ruling" for the removal sequencing.

/** Operator key custody and signing decisions (money paths only). */
export class OperatorSigner extends Context.Service<
  OperatorSigner,
  {
    readonly sign: (request: unknown) => Effect.Effect<unknown>;
  }
>()("OperatorSigner") {}

/** Per-chain clients resolved by chain id; one tag, no provider if-chains. */
export class ChainClient extends Context.Service<
  ChainClient,
  {
    readonly forChain: (chainId: number) => Effect.Effect<unknown>;
  }
>()("ChainClient") {}

export class TelegramBot extends Context.Service<
  TelegramBot,
  {
    readonly call: (method: string, payload: unknown) => Effect.Effect<unknown>;
  }
>()("TelegramBot") {}

export class MediaStore extends Context.Service<
  MediaStore,
  {
    readonly store: (bytes: Uint8Array) => Effect.Effect<string>;
  }
>()("MediaStore") {}

export class Analytics extends Context.Service<
  Analytics,
  {
    readonly track: (event: string, properties?: unknown) => Effect.Effect<void>;
  }
>()("Analytics") {}

// --- Identity persistence (coordinator amendment 2026-08-16, wave-2
// identity-boundary barrier). Derived from the reviewed platform-cf
// implementation; the frozen physical schema is users(user_id, status,
// account JSONB, created_at) + account_aliases. packages/application is
// coordinator-owned: lanes contribute use-case implementations only via
// reviewed proposals.

export const MAX_CANONICAL_ALIAS_HOPS = 8;

export class IdentityResolutionError extends Data.TaggedError("IdentityResolutionError")<{
  readonly reason: "missing" | "deleted" | "cyclic" | "invalid";
}> {}

export type IdentityUser = {
  readonly userId: string;
  /** Account response data is owned by the application contract layer. */
  readonly account: unknown;
};

export type CanonicalIdentity = {
  readonly sourceUserId: string;
  readonly canonicalUserId: string;
  readonly aliasPath: readonly string[];
};

export class IdentityStore extends Context.Service<
  IdentityStore,
  {
    readonly findUser: (userId: string) => Effect.Effect<IdentityUser | null, ControlPlaneError>;
    readonly resolveCanonical: (input: {
      readonly sourceUserId: string;
    }) => Effect.Effect<CanonicalIdentity, ControlPlaneError | IdentityResolutionError>;
    /** Coordinator-mediated identity writes maintain the public handle index
     * in the same Postgres transaction as the account row. */
    readonly upsertAccount?: (input: {
      readonly userId: string;
      readonly account: unknown;
    }) => Effect.Effect<void, ControlPlaneError | IdentityResolutionError>;
  }
>()("IdentityStore") {}

export type PublicProfileDocument = Schema.Schema.Type<typeof GetPublicProfileByHandle.response>;

export type PublicProfileCommunity = PublicProfileDocument["created_communities"][number];

export type PublicProfileLookup = Readonly<{
  readonly account: unknown;
  readonly canonicalUserId: string;
  readonly handleId: string;
  readonly handleLabelNormalized: string;
  readonly handleLabelDisplay: string;
  readonly handleStatus: "active" | "redirect";
  readonly createdCommunities: readonly PublicProfileCommunity[];
}>;

export type PublicProfileRepositoryReason = "invalid-account" | "invalid-alias";

export class PublicProfileRepositoryError extends Data.TaggedError("PublicProfileRepositoryError")<{
  readonly reason: PublicProfileRepositoryReason;
}> {}

export type PublicProfileRepositoryFailure = PublicProfileRepositoryError | ControlPlaneError;

export interface PublicProfileStoreService {
  readonly getByHandle: (input: {
    readonly labelNormalized: string;
  }) => Effect.Effect<PublicProfileLookup | null, PublicProfileRepositoryFailure>;
}

export class PublicProfileStore extends Context.Service<
  PublicProfileStore,
  PublicProfileStoreService
>()("PublicProfileStore") {}

// --- M2 community and content persistence (coordinator freeze 2026-08-16).
// Runtime persistence is Postgres. Repositories return storage outcomes only;
// application use cases map them into each endpoint's declared wire errors.

export type M2Actor = Readonly<{
  readonly userId: string;
  readonly kind: "user" | "admin" | "agent";
  readonly scopes?: readonly string[];
}>;

export type MembershipStatus = "missing" | "pending" | "member" | "left" | "banned";

export type CommunityPreviewDocument = Schema.Schema.Type<typeof GetCommunityPreview.response>;
export type JoinEligibilityDocument = Schema.Schema.Type<typeof GetJoinEligibility.response>;
export type JoinDocument = Schema.Schema.Type<typeof JoinCommunity.response>;
export type FollowDocument = Schema.Schema.Type<typeof FollowCommunity.response>;
export type UnfollowDocument = Schema.Schema.Type<typeof UnfollowCommunity.response>;

export type CreatePostBody = Schema.Schema.Type<(typeof CreatePost.request)["body"]>;
export type CreateCommentBody = Schema.Schema.Type<(typeof CreateCommentReply.request)["body"]>;
export type VoteBody = Schema.Schema.Type<(typeof CastPostVote.request)["body"]>;
export type ClearVoteBody = Schema.Schema.Type<(typeof ClearPostVote.request)["body"]>;

export type PostDocument = Schema.Schema.Type<typeof CreatePost.response>;
export type LocalizedPostDocument = Schema.Schema.Type<typeof GetPost.response>;
export type CommentDocument = Schema.Schema.Type<typeof CreateCommentReply.response>;
export type VoteDocument = Schema.Schema.Type<typeof CastPostVote.response>;
export type ClearVoteDocument = Schema.Schema.Type<typeof ClearPostVote.response>;
export type HomeFeedQuery = Schema.Schema.Type<(typeof GetPublicHomeFeed.request)["query"]>;
export type HomeFeedDocument = Schema.Schema.Type<typeof GetPublicHomeFeed.response>;
export type PublicCommunityThreadsQuery = Schema.Schema.Type<
  (typeof GetPublicCommunityThreads.request)["query"]
>;
export type PublicCommunityThreadsDocument = Schema.Schema.Type<
  typeof GetPublicCommunityThreads.response
>;

export type CommunityRepositoryOperation =
  | "membership"
  | "preview"
  | "eligibility"
  | "join"
  | "follow"
  | "unfollow";

export type ContentRepositoryOperation =
  | "resolve-post"
  | "resolve-comment"
  | "create-post"
  | "get-post"
  | "create-comment-reply"
  | "cast-vote"
  | "clear-vote";

export type M2RepositoryReason =
  | "not-found"
  | "membership-required"
  | "comments-locked"
  | "idempotency-conflict"
  | "constraint"
  | "invalid-row";

export class CommunityRepositoryError extends Data.TaggedError("CommunityRepositoryError")<{
  readonly operation: CommunityRepositoryOperation;
  readonly reason: M2RepositoryReason;
}> {}

export class ContentRepositoryError extends Data.TaggedError("ContentRepositoryError")<{
  readonly operation: ContentRepositoryOperation;
  readonly reason: M2RepositoryReason;
}> {}

export type CommunityRepositoryFailure = CommunityRepositoryError | ControlPlaneError;
export type ContentRepositoryFailure = ContentRepositoryError | ControlPlaneError;

export type FeedRepositoryOperation = "list-home";

export class FeedRepositoryError extends Data.TaggedError("FeedRepositoryError")<{
  readonly operation: FeedRepositoryOperation;
  readonly reason: "invalid-cursor" | "invalid-row";
}> {}

export type FeedRepositoryFailure = FeedRepositoryError | ControlPlaneError;

export type PostLocation = Readonly<{
  readonly communityId: string;
  readonly postId: string;
}>;

export type CommentLocation = Readonly<{
  readonly communityId: string;
  readonly postId: string;
  readonly commentId: string;
}>;

export interface CommunityStoreService {
  readonly membershipStatus: (input: {
    readonly communityId: string;
    readonly userId: string;
  }) => Effect.Effect<MembershipStatus, CommunityRepositoryFailure>;

  readonly getPreview: (input: {
    readonly communityId: string;
    readonly locale?: string;
    readonly viewerUserId?: string;
  }) => Effect.Effect<CommunityPreviewDocument | null, CommunityRepositoryFailure>;

  readonly getJoinEligibility: (input: {
    readonly communityId: string;
    readonly userId: string;
  }) => Effect.Effect<JoinEligibilityDocument | null, CommunityRepositoryFailure>;

  readonly join: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly body: Schema.Schema.Type<(typeof JoinCommunity.request)["body"]>;
  }) => Effect.Effect<JoinDocument, CommunityRepositoryFailure>;

  readonly follow: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<FollowDocument, CommunityRepositoryFailure>;

  readonly unfollow: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<UnfollowDocument, CommunityRepositoryFailure>;
}

export class CommunityStore extends Context.Service<CommunityStore, CommunityStoreService>()(
  "CommunityStore",
) {}

// --- Server-owned community creation intents (specs 006/010).

export type CommunityCreationIntentDocument = Schema.Schema.Type<
  typeof CreateCommunityCreationIntent.response
>;
export type CreateCommunityCreationIntentBody = Schema.Schema.Type<
  (typeof CreateCommunityCreationIntent.request)["body"]
>;
export type UpdateCommunityCreationIntentBody = Schema.Schema.Type<
  (typeof UpdateCommunityCreationIntent.request)["body"]
>;
export type CommitCommunityCreationIntentBody = Schema.Schema.Type<
  (typeof CommitCommunityCreationIntent.request)["body"]
>;

export type CommunityCreationRepositoryOperation = "create" | "get" | "update" | "commit";
export type CommunityCreationRepositoryReason =
  | "not-found"
  | "idempotency-conflict"
  | "revision-conflict"
  | "constraint"
  | "invalid-row";

export class CommunityCreationRepositoryError extends Data.TaggedError(
  "CommunityCreationRepositoryError",
)<{
  readonly operation: CommunityCreationRepositoryOperation;
  readonly reason: CommunityCreationRepositoryReason;
}> {}

export type CommunityCreationRepositoryFailure =
  | CommunityCreationRepositoryError
  | ControlPlaneError;

export type CreateCommunityCreationIntentResult = Readonly<{
  readonly document: CommunityCreationIntentDocument;
  readonly outcome: "fresh" | "replayed";
}>;

export type CommitCommunityCreationIntentResult = Readonly<{
  readonly document: CommunityCreationIntentDocument;
  readonly outcome: "fresh_created" | "fresh_not_created" | "replayed";
}>;

export interface CommunityCreationStoreService {
  readonly create: (input: {
    readonly actor: M2Actor;
    readonly body: CreateCommunityCreationIntentBody;
    readonly requestHash: string;
  }) => Effect.Effect<CreateCommunityCreationIntentResult, CommunityCreationRepositoryFailure>;

  readonly get: (input: {
    readonly intentId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<CommunityCreationIntentDocument | null, CommunityCreationRepositoryFailure>;

  readonly update: (input: {
    readonly intentId: string;
    readonly actor: M2Actor;
    readonly body: UpdateCommunityCreationIntentBody;
    readonly requestHash: string;
  }) => Effect.Effect<CommunityCreationIntentDocument, CommunityCreationRepositoryFailure>;

  readonly commit: (input: {
    readonly intentId: string;
    readonly actor: M2Actor;
    readonly body: CommitCommunityCreationIntentBody;
    readonly requestHash: string;
  }) => Effect.Effect<CommitCommunityCreationIntentResult, CommunityCreationRepositoryFailure>;
}

export class CommunityCreationStore extends Context.Service<
  CommunityCreationStore,
  CommunityCreationStoreService
>()("CommunityCreationStore") {}

export interface ContentStoreService {
  /** Resolve the globally unique public post ID before scoped access. */
  readonly resolvePost: (input: {
    readonly postId: string;
  }) => Effect.Effect<PostLocation | null, ContentRepositoryFailure>;

  /** Resolve the globally unique public comment ID before scoped access. */
  readonly resolveComment: (input: {
    readonly commentId: string;
  }) => Effect.Effect<CommentLocation | null, ContentRepositoryFailure>;

  readonly createPost: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly body: CreatePostBody;
    readonly idempotencyBodyHash: string;
  }) => Effect.Effect<PostDocument, ContentRepositoryFailure>;

  readonly getPost: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly viewerUserId: string;
    readonly locale?: string;
  }) => Effect.Effect<LocalizedPostDocument | null, ContentRepositoryFailure>;

  readonly createCommentReply: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly parentCommentId: string;
    readonly actor: M2Actor;
    readonly body: CreateCommentBody;
    readonly idempotencyBodyHash?: string;
  }) => Effect.Effect<CommentDocument, ContentRepositoryFailure>;

  readonly castPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: VoteBody;
  }) => Effect.Effect<VoteDocument, ContentRepositoryFailure>;

  readonly clearPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: ClearVoteBody;
  }) => Effect.Effect<ClearVoteDocument, ContentRepositoryFailure>;
}

export class ContentStore extends Context.Service<ContentStore, ContentStoreService>()(
  "ContentStore",
) {}

export interface FeedStoreService {
  readonly listHome: (input: {
    readonly query: HomeFeedQuery;
    readonly viewerUserId?: string;
  }) => Effect.Effect<HomeFeedDocument, FeedRepositoryFailure>;
}

export class FeedStore extends Context.Service<FeedStore, FeedStoreService>()("FeedStore") {}

export type PublicCommunityThreadsRepositoryOperation = "list-public-community-threads";

export class PublicCommunityThreadsRepositoryError extends Data.TaggedError(
  "PublicCommunityThreadsRepositoryError",
)<{
  readonly operation: PublicCommunityThreadsRepositoryOperation;
  readonly reason: "invalid-community-ref" | "invalid-cursor" | "invalid-row";
}> {}

export type PublicCommunityThreadsRepositoryFailure =
  | PublicCommunityThreadsRepositoryError
  | ControlPlaneError;

export interface PublicCommunityThreadsStoreService {
  readonly listPublicCommunityThreads: (input: {
    readonly communityRef: string;
    /** One exact legacy slug candidate, or null when only exact-ID lookup is safe. */
    readonly slugCandidate: string | null;
    readonly query: PublicCommunityThreadsQuery;
  }) => Effect.Effect<
    PublicCommunityThreadsDocument | null,
    PublicCommunityThreadsRepositoryFailure
  >;
}

export class PublicCommunityThreadsStore extends Context.Service<
  PublicCommunityThreadsStore,
  PublicCommunityThreadsStoreService
>()("PublicCommunityThreadsStore") {}
