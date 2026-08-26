import type {
  CastPostVote,
  ClearPostVote,
  CommitCommunityCreationIntent,
  PostDocument as ContractPostDocument,
  TextContentSubmissionV1 as ContractTextContentSubmissionV1,
  TextModerationEvaluationV1 as ContractTextModerationEvaluationV1,
  TextModerationInputV1 as ContractTextModerationInputV1,
  CreateCommunityCreationIntent,
  CreatePost,
  FollowCommunity,
  GetCanonicalCommunityRoute,
  GetCommunityCreationIntent,
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
import type { StudyItemSourceSetV1 } from "./study-item-source.ts";

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

/**
 * Closed browser-upload signing boundary for the physically separate media
 * ingress bucket. The implementation owns the bucket and S3 endpoint; callers
 * can select neither.
 */
export const MEDIA_INGRESS_UPLOAD_METHOD = "PUT" as const;
export const MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS = 900 as const;
export const MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER = "content-type" as const;

export type MediaIngressUploadPresignRequest = Readonly<{
  readonly serverOwnedObjectKey: string;
  readonly method: typeof MEDIA_INGRESS_UPLOAD_METHOD;
  readonly requiredSignedHeaders: readonly [
    Readonly<{
      readonly name: typeof MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER;
      readonly value: string;
    }>,
  ];
  readonly expiresInSeconds: typeof MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS;
}>;

export type MediaIngressUploadPresignResult = Readonly<{
  readonly url: string;
  readonly requiredHeaders: readonly [
    Readonly<{
      readonly name: typeof MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER;
      readonly value: string;
    }>,
  ];
  readonly expiresAt: string;
}>;

export class MediaIngressUploadPresignFailed extends Data.TaggedError(
  "MediaIngressUploadPresignFailed",
)<{
  readonly reason: "invalid-target" | "unavailable" | "invalid-response";
}> {}

export const mediaIngressUploadPresignRequest = (input: {
  readonly serverOwnedObjectKey: string;
  readonly contentType: string;
}): MediaIngressUploadPresignRequest => ({
  serverOwnedObjectKey: input.serverOwnedObjectKey,
  method: MEDIA_INGRESS_UPLOAD_METHOD,
  requiredSignedHeaders: [
    {
      name: MEDIA_INGRESS_UPLOAD_CONTENT_TYPE_HEADER,
      value: input.contentType,
    },
  ],
  expiresInSeconds: MEDIA_INGRESS_UPLOAD_EXPIRY_SECONDS,
});

export class MediaIngressUploadPresigner extends Context.Service<
  MediaIngressUploadPresigner,
  {
    readonly presign: (
      request: MediaIngressUploadPresignRequest,
    ) => Effect.Effect<MediaIngressUploadPresignResult, MediaIngressUploadPresignFailed>;
  }
>()("MediaIngressUploadPresigner") {}

export const DATA_REGISTRATION_SIGNING_PORT_VERSION = "data-registration-signing-v1" as const;

export type DataRegistrationSigningRequest = Readonly<{
  version: typeof DATA_REGISTRATION_SIGNING_PORT_VERSION;
  registrationOperationId: string;
  submissionAttemptId: string;
  signingIntentId: string;
  chainId: bigint;
  signerNamespace: string;
  signerAddress: string;
  targetAddress: string;
  methodSelector: string;
  calldata: Uint8Array;
  calldataHash: string;
  signingDeadline: string;
  nonce: bigint;
  valueWei: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;

export type DataRegistrationSigningResult = Readonly<{
  signedTransaction: Uint8Array;
  signedTransactionHash: string;
}>;

export class DataRegistrationSigningFailed extends Data.TaggedError(
  "DataRegistrationSigningFailed",
)<{
  readonly reason: "unavailable" | "rejected" | "invalid-result";
}> {}

/** Signs one PostgreSQL-authorized DATA transaction and never broadcasts it. */
export class DataRegistrationTransactionSigner extends Context.Service<
  DataRegistrationTransactionSigner,
  {
    readonly sign: (
      request: DataRegistrationSigningRequest,
    ) => Effect.Effect<DataRegistrationSigningResult, DataRegistrationSigningFailed>;
  }
>()("DataRegistrationTransactionSigner") {}

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

export type StudyItemSourceRequest = Readonly<{
  communityId: string;
  postId: string;
  audioRevision: number;
  lyricsRevision: number;
}>;

export class StudyItemSourceError extends Data.TaggedError("StudyItemSourceError")<{
  readonly reason: "unavailable" | "invalid-source";
}> {}

export interface StudyItemSourceService {
  readonly getForAcceptedSongRevision: (
    input: StudyItemSourceRequest,
  ) => Effect.Effect<StudyItemSourceSetV1, StudyItemSourceError>;
}

/** Server-only source; callers project prompts explicitly before any browser wire. */
export class StudyItemSource extends Context.Service<StudyItemSource, StudyItemSourceService>()(
  "StudyItemSource",
) {}

/**
 * Synchronous safety evaluation. Provider adapters implement this port
 * without exposing their protocol or response payload to the application.
 */
export class TextModerationProviderError extends Data.TaggedError("TextModerationProviderError")<{
  readonly reason: "unavailable" | "timeout" | "invalid";
}> {}

export class TextModeration extends Context.Service<
  TextModeration,
  {
    readonly evaluate: (
      input: ContractTextModerationInputV1,
    ) => Effect.Effect<ContractTextModerationEvaluationV1, TextModerationProviderError>;
  }
>()("TextModeration") {}

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
  readonly personaId: string;
  readonly displayName: string | null;
  readonly avatarRef: string | null;
  readonly coverRef: string | null;
  readonly bio: string | null;
  readonly preferredLocale: string | null;
  readonly createdAt: string;
  readonly handleId: string;
  readonly resolvedHandleLabelDisplay: string;
  readonly handleLabelNormalized: string;
  readonly handleLabelDisplay: string;
  readonly handleStatus: "active" | "redirect";
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
export type CanonicalCommunityRouteDocument = Schema.Schema.Type<
  typeof GetCanonicalCommunityRoute.response
>;
export type JoinEligibilityDocument = Schema.Schema.Type<typeof GetJoinEligibility.response>;
export type JoinDocument = Schema.Schema.Type<typeof JoinCommunity.response>;
export type FollowDocument = Schema.Schema.Type<typeof FollowCommunity.response>;
export type UnfollowDocument = Schema.Schema.Type<typeof UnfollowCommunity.response>;

export type CanonicalCommunityRouteRepositoryOperation = "resolve-canonical-route";
export type CanonicalCommunityRouteRepositoryReason = "invalid-path" | "invalid-row";

export class CanonicalCommunityRouteRepositoryError extends Data.TaggedError(
  "CanonicalCommunityRouteRepositoryError",
)<{
  readonly operation: CanonicalCommunityRouteRepositoryOperation;
  readonly reason: CanonicalCommunityRouteRepositoryReason;
}> {}

export type CanonicalCommunityRouteRepositoryFailure =
  | CanonicalCommunityRouteRepositoryError
  | ControlPlaneError;

export interface CanonicalCommunityRouteStoreService {
  readonly resolveCanonicalRoute: (input: {
    readonly path_segment: string;
  }) => Effect.Effect<
    CanonicalCommunityRouteDocument | null,
    CanonicalCommunityRouteRepositoryFailure
  >;
}

export class CanonicalCommunityRouteStore extends Context.Service<
  CanonicalCommunityRouteStore,
  CanonicalCommunityRouteStoreService
>()("CanonicalCommunityRouteStore") {}

export type CreatePostBody = Schema.Schema.Type<(typeof CreatePost.request)["body"]>;
export type VoteBody = Schema.Schema.Type<(typeof CastPostVote.request)["body"]>;
export type ClearVoteBody = Schema.Schema.Type<(typeof ClearPostVote.request)["body"]>;

/**
 * Text-post persistence is intentionally a separate seam from the pre-moderation M2
 * content repository. It owns the submission ledger, policy fence, and the
 * immutable creation snapshot; it never asks the application to infer a
 * replay from a Post row.
 */
export type TextPostSubmissionDocument = ContractTextContentSubmissionV1;
export type TextPostModerationInput = ContractTextModerationInputV1;
export type TextPostModerationEvaluation = ContractTextModerationEvaluationV1;
export type TextSubmissionSurface = ContractTextModerationInputV1["surface"];
export type TextSubmissionBody =
  | CreatePostBody
  | Readonly<{
      readonly idempotency_key: string;
      readonly persona_id: string;
      readonly body: string;
    }>;

export type TextSubmissionTarget =
  | Readonly<{ readonly surface: "text_post"; readonly communityId: string }>
  | Readonly<{
      readonly surface: "comment";
      readonly communityId: string;
      readonly postId: string;
    }>
  | Readonly<{
      readonly surface: "reply";
      readonly communityId: string;
      readonly postId: string;
      readonly parentCommentId: string;
    }>;

export type TextCommentTargetResolution =
  | Readonly<{
      readonly kind: "ready";
      readonly communityId: string;
      readonly postId: string;
      readonly parentCommentId: string | null;
      readonly parentDepth: number;
    }>
  | Readonly<{ readonly kind: "not-found" }>
  | Readonly<{ readonly kind: "closed" }>
  | Readonly<{ readonly kind: "depth-exceeded"; readonly depth: number }>;

export type CommentReportReasonCode =
  | "spam"
  | "harassment"
  | "hate"
  | "sexual_content"
  | "graphic_content"
  | "misleading"
  | "other";

export type CommentReportOutcome = Readonly<{
  readonly reportId: string;
  readonly caseRef: string;
  readonly status: "open" | "coalesced";
}>;

export type ModerationAction = "approve" | "dismiss" | "hide" | "remove" | "restore";
export type ModerationTargetStatus = "held" | "published" | "hidden" | "removed";
export type ModerationActionOutcome = Readonly<{
  readonly actionId: string;
  readonly caseRef: string;
  readonly action: ModerationAction;
  readonly targetStatus: ModerationTargetStatus;
}>;

export type TextPostReplayOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "replay"; readonly snapshot: TextPostSubmissionDocument }
  | { readonly kind: "conflict"; readonly submissionId: string };

export type TextPostCommitOutcome =
  | { readonly kind: "created"; readonly snapshot: TextPostSubmissionDocument }
  | { readonly kind: "replay"; readonly snapshot: TextPostSubmissionDocument }
  | { readonly kind: "conflict"; readonly submissionId: string }
  | {
      readonly kind: "policy-stale";
      readonly policyRevision: string;
      readonly policyHash: string;
    };

export type TextPostRepositoryOperation =
  | "authority"
  | "replay"
  | "commit"
  | "get"
  | "resolve-target"
  | "report"
  | "action";
export type TextPostRepositoryReason =
  | "not-found"
  | "membership-required"
  | "comments-locked"
  | "reply-depth-exceeded"
  | "idempotency-conflict"
  | "action-conflict"
  | "constraint"
  | "invalid-row";

export class TextPostRepositoryError extends Data.TaggedError("TextPostRepositoryError")<{
  readonly operation: TextPostRepositoryOperation;
  readonly reason: TextPostRepositoryReason;
  readonly submissionId?: string;
}> {}

export type TextPostRepositoryFailure = TextPostRepositoryError | ControlPlaneError;

export interface TextPostStoreService {
  /** Read-only authority preflight used before sending text to moderation. */
  readonly checkAuthority: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<void, TextPostRepositoryFailure>;

  /** Exact same-key/same-hash replay lookup. Must precede moderation. */
  readonly replay: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly personaId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly surface?: TextSubmissionSurface;
  }) => Effect.Effect<TextPostReplayOutcome, TextPostRepositoryFailure>;

  /**
   * Commit one terminal result. The provider has already run outside this
   * transaction; this operation rechecks every authority and writes the
   * submission plus any public/review effects atomically.
   */
  readonly commitTerminal: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly personaId: string;
    readonly body: TextSubmissionBody;
    readonly moderationInput: TextPostModerationInput;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly operationId: string;
    readonly evaluation: TextPostModerationEvaluation;
    readonly target?: TextSubmissionTarget;
  }) => Effect.Effect<TextPostCommitOutcome, TextPostRepositoryFailure>;

  /** Read-only preflight for comment/reply target and depth checks. */
  readonly resolveCommentTarget?: (input: {
    readonly surface: "comment" | "reply";
    readonly targetId: string;
  }) => Effect.Effect<TextCommentTargetResolution, TextPostRepositoryFailure>;

  readonly reportComment?: (input: {
    readonly commentId: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly reasonCode: CommentReportReasonCode;
    readonly requestHash: string;
  }) => Effect.Effect<CommentReportOutcome, TextPostRepositoryFailure>;

  readonly moderateCaseAction?: (input: {
    readonly caseRef: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly action: ModerationAction;
    readonly requestHash: string;
  }) => Effect.Effect<ModerationActionOutcome, TextPostRepositoryFailure>;

  /** Author-scoped current submission state, distinct from immutable replay. */
  readonly getForAuthor: (input: {
    readonly submissionId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<TextPostSubmissionDocument | null, TextPostRepositoryFailure>;
}

export class TextPostStore extends Context.Service<TextPostStore, TextPostStoreService>()(
  "TextPostStore",
) {}

/**
 * The content repository still returns the internal post read model.  It is
 * deliberately not derived from CreatePost.response: Order 4 changes that
 * public command response to TextContentSubmissionV1 while Order 5 owns the
 * runtime moderation/ledger mapping.
 */
export type PostDocument = ContractPostDocument;
export type LocalizedPostDocument = Schema.Schema.Type<typeof GetPost.response>;
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
  readonly actionId?: string;
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
  typeof GetCommunityCreationIntent.response
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

  /** Cheap authority check before a vote write; the write transaction rechecks it. */
  readonly checkVoteAuthority: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<void, ContentRepositoryFailure>;

  readonly replayCastPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) => Effect.Effect<VoteDocument | null, ContentRepositoryFailure>;

  readonly replayClearPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) => Effect.Effect<ClearVoteDocument | null, ContentRepositoryFailure>;

  readonly castPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: VoteBody;
    readonly requestHash: string;
  }) => Effect.Effect<VoteDocument, ContentRepositoryFailure>;

  readonly clearPostVote: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly actor: M2Actor;
    readonly body: ClearVoteBody;
    readonly requestHash: string;
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
