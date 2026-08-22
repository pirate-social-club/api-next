import {
  BadRequest,
  CommentsLocked,
  CreatePost,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  NotFound,
  ReplyDepthExceeded,
} from "@pirate/contracts";
import {
  canonicalTextModerationInput,
  normalizeTextModerationInput,
  publicTextPublicationResult,
  textModerationEvaluationInvariant,
} from "@pirate/domain";
import { Data, Effect, Schema } from "effect";
import {
  type CreatePostBody,
  type M2Actor,
  type TextModeration,
  type TextModerationProviderError,
  type TextPostCommitOutcome,
  type TextPostModerationEvaluation,
  type TextPostModerationInput,
  type TextPostReplayOutcome,
  TextPostRepositoryError,
  type TextPostRepositoryFailure,
  type TextPostStore,
  type TextPostSubmissionDocument,
} from "../../ports.ts";
import {
  canonicalBodyHash,
  validateHumanDirectActor,
  validateIdentifier,
  validPublicHumanDirectPost,
} from "./common.ts";

export {
  type TextModeration,
  TextModerationProviderError,
  type TextPostModerationEvaluation,
} from "../../ports.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;
const MAX_POLICY_RETRIES = 3;

const hasUnsupportedTextMetadata = (body: CreatePostBody): boolean => {
  const disallowed = [
    "agent_id",
    "agent_action_proof",
    "anonymous_scope",
    "disclosed_qualifier_ids",
    "parent_post_id",
    "label_id",
    "caption",
    "link_url",
    "media_refs",
    "creator_relation",
    "promotion_disclosure",
    "asset_id",
    "file_upload",
    "song_artifact_bundle",
    "song_mode",
    "rights_basis",
    "upstream_asset_refs",
    "license_preset",
    "commercial_rev_share_pct",
    "royalty_allocations",
    "lyrics",
    "source_post",
    "source_community",
    "crosspost_source",
    "event",
    "listing_draft",
    "age_gate_policy",
    "access_mode",
    "translation_policy",
  ];
  return disallowed.some((key) => {
    const value = (body as Record<string, unknown>)[key];
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
  });
};

export class TextPostPolicyStale extends Data.TaggedError("TextPostPolicyStale")<{
  readonly attempts: number;
}> {}

export class TextPostRuntimeUnavailable extends Data.TaggedError("TextPostRuntimeUnavailable") {}

export type TextPostCreateInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

export type TextPostServices = Readonly<{
  readonly textPostStore?: TextPostStore["Service"];
  readonly textModeration?: TextModeration["Service"];
}>;

export type GetTextContentSubmissionInput = Readonly<{
  readonly submissionId: string;
  readonly actor: M2Actor;
}>;

const idempotencyConflict = (submissionId: string): IdempotencyConflict =>
  new IdempotencyConflict({
    message: "The idempotency key was already used with a different request",
    details: { reason_code: "idempotency_conflict", submission_id: submissionId },
  });

function mapStoreFailure(failure: TextPostRepositoryFailure) {
  if (!(failure instanceof TextPostRepositoryError))
    return new InternalError({ message: "Text submission operation failed" });
  switch (failure.reason) {
    case "membership-required":
      return new MembershipRequired({ message: "Community membership is required" });
    case "comments-locked":
      return new CommentsLocked({ message: "Comments are locked for this post" });
    case "reply-depth-exceeded":
      return new ReplyDepthExceeded({ message: "Reply depth exceeds the v1 limit" });
    case "not-found":
      return new NotFound({ message: "Text submission not found" });
    case "constraint":
      return new BadRequest({ message: "Text submission violates a resource constraint" });
    case "invalid-row":
      return new InternalError({ message: "Text submission operation returned an invalid record" });
    case "idempotency-conflict":
      return new IdempotencyConflict({
        message: "The idempotency key was already used with a different request",
        details: {
          reason_code: "idempotency_conflict",
          submission_id: failure.submissionId ?? "unknown",
        },
      });
    case "action-conflict":
      return new InternalError({ message: "Text submission action conflict" });
    default:
      return new InternalError({ message: "Text submission operation failed" });
  }
}

const providerReason = (
  reason: TextModerationProviderError["reason"],
): "provider_unavailable" | "provider_timeout" | "provider_invalid" =>
  reason === "unavailable"
    ? "provider_unavailable"
    : reason === "timeout"
      ? "provider_timeout"
      : "provider_invalid";

const fallbackEvaluation = (
  input: TextPostModerationInput,
  inputSha256: string,
  reason: TextModerationProviderError["reason"] | "invalid-evaluation",
): TextPostModerationEvaluation => ({
  version: "text-moderation-v1",
  surface: input.surface,
  decision: "manual_review",
  reason_codes: [providerReason(reason === "invalid-evaluation" ? "invalid" : reason)],
  // A provider failure did not evaluate a policy revision. The terminal
  // repository binds it to the current revision inside its commit tx.
  policy_revision: "",
  policy_hash: "",
  input_sha256: inputSha256,
  evidence_ref: null,
});

const safeEvaluation = (
  evaluation: TextPostModerationEvaluation,
  input: TextPostModerationInput,
  inputSha256: string,
): TextPostModerationEvaluation => {
  const valid =
    textModerationEvaluationInvariant(evaluation) === null &&
    evaluation.surface === input.surface &&
    evaluation.input_sha256 === inputSha256 &&
    publicTextPublicationResult(evaluation) !== null;
  return valid ? evaluation : fallbackEvaluation(input, inputSha256, "invalid-evaluation");
};

function normalizeTextInput(
  body: CreatePostBody,
): Effect.Effect<
  Readonly<{ readonly input: TextPostModerationInput; readonly inputSha256: string }>,
  BadRequest
> {
  const normalized = normalizeTextModerationInput({
    surface: "text_post",
    title: body.title ?? null,
    body: body.body ?? null,
  });
  if (normalized.kind === "rejected")
    return Effect.fail(new BadRequest({ message: "Text content must not be empty or invalid" }));
  const canonical = canonicalTextModerationInput(normalized.input);
  if (canonical.kind === "rejected")
    return Effect.fail(new BadRequest({ message: "Text content is not canonical" }));
  return Effect.succeed({ input: normalized.input, inputSha256: canonical.sha256 });
}

const decodeTextPostBody = (input: unknown): Effect.Effect<CreatePostBody, BadRequest> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(CreatePost.request.body, exactParseOptions)(input) as CreatePostBody,
    catch: () => new BadRequest({ message: "Invalid request body" }),
  });

export const createTextPost = Effect.fn("createTextPost")(function* (
  input: TextPostCreateInput,
  services: TextPostServices,
): Effect.fn.Return<
  TextPostSubmissionDocument,
  | BadRequest
  | CommentsLocked
  | IdempotencyConflict
  | MembershipRequired
  | NotFound
  | ReplyDepthExceeded
  | InternalError
  | TextPostPolicyStale
  | TextPostRuntimeUnavailable
> {
  const store = services.textPostStore;
  const moderation = services.textModeration;
  if (store === undefined || moderation === undefined)
    return yield* new TextPostRuntimeUnavailable();
  yield* validateIdentifier(input.communityId, "Invalid community identifier");
  yield* validateHumanDirectActor(input.actor);
  const body = yield* decodeTextPostBody(input.body);
  if (
    !validPublicHumanDirectPost(body) ||
    hasUnsupportedTextMetadata(body) ||
    body.post_type !== "text"
  )
    return yield* new BadRequest({ message: "Only public human text posts are supported" });
  const text = yield* normalizeTextInput(body);
  const requestHash = yield* canonicalBodyHash({
    community_id: input.communityId,
    body,
  });
  const idempotencyKey = body.idempotency_key;
  if (idempotencyKey.trim().length === 0)
    return yield* new BadRequest({ message: "An idempotency key is required" });

  for (let attempt = 0; attempt < MAX_POLICY_RETRIES; attempt += 1) {
    const replay: TextPostReplayOutcome = yield* store
      .replay({
        communityId: input.communityId,
        actor: input.actor,
        idempotencyKey,
        requestHash,
        surface: "text_post",
      })
      .pipe(Effect.mapError(mapStoreFailure));
    if (replay.kind === "replay") return replay.snapshot;
    if (replay.kind === "conflict") return yield* idempotencyConflict(replay.submissionId);

    // The provider is deliberately outside the repository transaction. A
    // stale policy result is discarded by commitTerminal and evaluated again.
    const evaluation = yield* moderation.evaluate(text.input).pipe(
      Effect.map((result) => safeEvaluation(result, text.input, text.inputSha256)),
      Effect.catchTag("TextModerationProviderError", (failure) =>
        Effect.succeed(fallbackEvaluation(text.input, text.inputSha256, failure.reason)),
      ),
      Effect.catchDefect(() =>
        Effect.succeed(fallbackEvaluation(text.input, text.inputSha256, "invalid-evaluation")),
      ),
    );
    const committed: TextPostCommitOutcome = yield* store
      .commitTerminal({
        communityId: input.communityId,
        actor: input.actor,
        body,
        moderationInput: text.input,
        idempotencyKey,
        requestHash,
        operationId: `operation_${crypto.randomUUID()}`,
        evaluation,
        target: { surface: "text_post", communityId: input.communityId },
      })
      .pipe(Effect.mapError(mapStoreFailure));
    if (committed.kind === "created" || committed.kind === "replay") return committed.snapshot;
    if (committed.kind === "conflict") return yield* idempotencyConflict(committed.submissionId);
  }
  return yield* new TextPostPolicyStale({ attempts: MAX_POLICY_RETRIES });
});

export const createModeratedTextPost = createTextPost;

export const getTextContentSubmission = Effect.fn("getTextContentSubmission")(function* (
  input: GetTextContentSubmissionInput,
  services: TextPostServices,
): Effect.fn.Return<
  TextPostSubmissionDocument,
  | BadRequest
  | CommentsLocked
  | IdempotencyConflict
  | NotFound
  | ReplyDepthExceeded
  | InternalError
  | TextPostRuntimeUnavailable
  | MembershipRequired
> {
  const store = services.textPostStore;
  if (store === undefined) return yield* new TextPostRuntimeUnavailable();
  yield* validateIdentifier(input.submissionId, "Invalid submission identifier");
  yield* validateHumanDirectActor(input.actor);
  const submission = yield* store
    .getForAuthor({ submissionId: input.submissionId, actor: input.actor })
    .pipe(Effect.mapError(mapStoreFailure));
  if (submission === null) return yield* new NotFound({ message: "Text submission not found" });
  return submission;
});

export const getAuthorTextContentSubmission = getTextContentSubmission;
