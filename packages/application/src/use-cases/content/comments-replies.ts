import {
  BadRequest,
  CommentsLocked,
  Conflict,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  NotFound,
  PersonaIdV1,
  ReplyDepthExceeded,
  type TextModerationEvaluation,
} from "@pirate/contracts";
import {
  canonicalTextModerationInput,
  normalizeTextModerationInput,
  publicTextPublicationResult,
  textModerationEvaluationInvariant,
} from "@pirate/domain";
import { Data, Effect, Schema } from "effect";
import {
  type M2Actor,
  type TextPostCommitOutcome,
  type TextPostModerationEvaluation,
  type TextPostModerationInput,
  type TextPostReplayOutcome,
  TextPostRepositoryError,
  type TextPostRepositoryFailure,
  type TextPostSubmissionDocument,
  type TextSubmissionTarget,
} from "../../ports.ts";
import {
  evaluateTextModerationV2,
  type RestrictedTextModerationEvidenceV1,
} from "../../text-moderation-runtime.ts";
import { PersonaUnavailable, requireActiveOwnedPersona } from "../personas.ts";
import { canonicalBodyHash, validateHumanDirectActor, validateIdentifier } from "./common.ts";
import type { TextPostServices } from "./text-post.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;
const MAX_POLICY_RETRIES = 3;
const CommentReplyBody = Schema.Struct({
  idempotency_key: Schema.String,
  persona_id: PersonaIdV1,
  body: Schema.String,
  author_declared_rating: Schema.optional(Schema.Literals(["general", "adult_18"])),
});

export type CreateCommentReplyInput = Readonly<{
  readonly surface: "comment" | "reply";
  readonly targetId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

export class CommentsRepliesPolicyStale extends Data.TaggedError("CommentsRepliesPolicyStale")<{
  readonly attempts: number;
}> {}

export class CommentsRepliesRuntimeUnavailable extends Data.TaggedError(
  "CommentsRepliesRuntimeUnavailable",
) {}

const idempotencyConflict = (submissionId: string): IdempotencyConflict =>
  new IdempotencyConflict({
    message: "The idempotency key was already used with a different request",
    details: { reason_code: "idempotency_conflict", submission_id: submissionId },
  });

const mapStoreFailure = (failure: TextPostRepositoryFailure) => {
  if (!(failure instanceof TextPostRepositoryError))
    return new InternalError({ message: "Text submission operation failed" });
  switch (failure.reason) {
    case "membership-required":
      return new MembershipRequired({ message: "Community membership is required" });
    case "not-found":
      return new NotFound({ message: "Comment target not found" });
    case "comments-locked":
      return new CommentsLocked({ message: "Comments are locked for this post" });
    case "reply-depth-exceeded":
      return new ReplyDepthExceeded({ message: "Reply depth exceeds the v1 limit" });
    case "constraint":
      return new BadRequest({ message: "Comment request violates a resource constraint" });
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
      return new Conflict({ message: "Moderation action conflicts with current case state" });
    default:
      return new InternalError({ message: "Text submission operation failed" });
  }
};

const providerReason = (
  reason: "unavailable" | "timeout" | "invalid",
): "provider_unavailable" | "provider_timeout" | "provider_invalid" =>
  reason === "unavailable"
    ? "provider_unavailable"
    : reason === "timeout"
      ? "provider_timeout"
      : "provider_invalid";

const fallbackEvaluation = (
  input: TextPostModerationInput,
  inputSha256: string,
  reason: "unavailable" | "timeout" | "invalid" | "invalid-evaluation",
): TextPostModerationEvaluation => ({
  version: "text-moderation-v1",
  surface: input.surface,
  decision: "manual_review",
  reason_codes: [providerReason(reason === "invalid-evaluation" ? "invalid" : reason)],
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

const decodeBody = (
  input: unknown,
): Effect.Effect<Schema.Schema.Type<typeof CommentReplyBody>, BadRequest> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(CommentReplyBody, exactParseOptions)(input),
    catch: () => new BadRequest({ message: "Invalid comment request body" }),
  });

const requestHashValue = (input: {
  readonly surface: "comment" | "reply";
  readonly communityId: string;
  readonly postId: string;
  readonly parentCommentId?: string;
  readonly body: Schema.Schema.Type<typeof CommentReplyBody>;
}) => ({
  endpoint: input.surface,
  community_id: input.communityId,
  post_id: input.postId,
  ...(input.parentCommentId === undefined ? {} : { parent_comment_id: input.parentCommentId }),
  body: input.body,
});

export const createCommentReply = Effect.fn("createCommentReply")(function* (
  input: CreateCommentReplyInput,
  services: TextPostServices,
): Effect.fn.Return<
  TextPostSubmissionDocument,
  | BadRequest
  | CommentsLocked
  | Conflict
  | IdempotencyConflict
  | InternalError
  | MembershipRequired
  | NotFound
  | ReplyDepthExceeded
  | CommentsRepliesPolicyStale
  | CommentsRepliesRuntimeUnavailable
> {
  const store = services.textPostStoreV2 ?? services.textPostStore;
  const moderation = services.textModeration;
  const moderationProvider = services.textModerationProvider;
  const personaStore = services.personaStore;
  if (
    store?.resolveCommentTarget === undefined ||
    (moderation === undefined &&
      (moderationProvider === undefined || services.textPostStoreV2 === undefined)) ||
    personaStore === undefined
  )
    return yield* new CommentsRepliesRuntimeUnavailable();
  yield* validateIdentifier(input.targetId, "Invalid comment target identifier");
  yield* validateHumanDirectActor(input.actor);
  const body = yield* decodeBody(input.body);
  if (body.idempotency_key.trim() === "")
    return yield* new BadRequest({ message: "An idempotency key is required" });
  if (body.body.trim() === "")
    return yield* new BadRequest({ message: "Comment body must not be empty" });
  yield* requireActiveOwnedPersona(
    { accountId: input.actor.userId, personaId: body.persona_id },
    personaStore,
  ).pipe(
    Effect.mapError((error) =>
      error instanceof PersonaUnavailable ? new NotFound({ message: "Persona not found" }) : error,
    ),
  );

  const target = yield* store
    .resolveCommentTarget({
      surface: input.surface,
      targetId: input.targetId,
    })
    .pipe(Effect.mapError(mapStoreFailure));
  if (target.kind === "not-found")
    return yield* new NotFound({ message: "Comment target not found" });
  if (target.kind === "closed")
    return yield* new CommentsLocked({ message: "Comments are locked for this post" });
  if (target.kind === "depth-exceeded")
    return yield* new ReplyDepthExceeded({ message: "Reply depth exceeds the v1 limit" });

  const normalized = normalizeTextModerationInput({
    surface: input.surface,
    title: null,
    body: body.body,
  });
  if (normalized.kind === "rejected")
    return yield* new BadRequest({ message: "Comment text must not be empty or invalid" });
  const canonical = canonicalTextModerationInput(normalized.input);
  if (canonical.kind === "rejected")
    return yield* new BadRequest({ message: "Comment text is not canonical" });
  const requestHash = yield* canonicalBodyHash(
    requestHashValue({
      surface: input.surface,
      communityId: target.communityId,
      postId: target.postId,
      ...(target.parentCommentId === null ? {} : { parentCommentId: target.parentCommentId }),
      body,
    }),
  );

  for (let attempt = 0; attempt < MAX_POLICY_RETRIES; attempt += 1) {
    const replay: TextPostReplayOutcome = yield* store
      .replay({
        communityId: target.communityId,
        actor: input.actor,
        personaId: body.persona_id,
        idempotencyKey: body.idempotency_key,
        requestHash,
        surface: input.surface,
      })
      .pipe(Effect.mapError(mapStoreFailure));
    if (replay.kind === "replay") return replay.snapshot;
    if (replay.kind === "conflict") return yield* idempotencyConflict(replay.submissionId);

    yield* store
      .checkAuthority({ communityId: target.communityId, actor: input.actor })
      .pipe(Effect.mapError(mapStoreFailure));

    let evaluation: TextModerationEvaluation;
    let restrictedEvidence: RestrictedTextModerationEvidenceV1 | undefined;
    if (moderationProvider !== undefined && services.textPostStoreV2 !== undefined) {
      const evaluated = yield* evaluateTextModerationV2({
        communityId: target.communityId,
        moderationInput: normalized.input,
        inputSha256: canonical.sha256,
        store: services.textPostStoreV2,
        provider: moderationProvider,
        authorDeclaredRating: body.author_declared_rating ?? "general",
      }).pipe(Effect.mapError(mapStoreFailure));
      evaluation = evaluated.evaluation;
      restrictedEvidence = evaluated.restrictedEvidence;
    } else {
      const legacyModeration = moderation as NonNullable<TextPostServices["textModeration"]>;
      evaluation = yield* legacyModeration.evaluate(normalized.input).pipe(
        Effect.map((result) => safeEvaluation(result, normalized.input, canonical.sha256)),
        Effect.catchTag("TextModerationProviderError", (failure) =>
          Effect.succeed(fallbackEvaluation(normalized.input, canonical.sha256, failure.reason)),
        ),
        Effect.catchDefect(() =>
          Effect.succeed(
            fallbackEvaluation(normalized.input, canonical.sha256, "invalid-evaluation"),
          ),
        ),
      );
    }
    const commitTarget: TextSubmissionTarget =
      input.surface === "comment"
        ? { surface: "comment", communityId: target.communityId, postId: target.postId }
        : {
            surface: "reply",
            communityId: target.communityId,
            postId: target.postId,
            parentCommentId: target.parentCommentId as string,
          };
    const commitInput = {
      communityId: target.communityId,
      actor: input.actor,
      personaId: body.persona_id,
      body,
      moderationInput: normalized.input,
      idempotencyKey: body.idempotency_key,
      requestHash,
      operationId: `operation_${crypto.randomUUID()}`,
      target: commitTarget,
    } as const;
    const commitEffect =
      services.textPostStoreV2 !== undefined
        ? services.textPostStoreV2.commitTerminal({
            ...commitInput,
            evaluation,
            ...(restrictedEvidence === undefined ? {} : { restrictedEvidence }),
          })
        : (services.textPostStore as NonNullable<TextPostServices["textPostStore"]>).commitTerminal(
            {
              ...commitInput,
              evaluation: evaluation as TextPostModerationEvaluation,
            },
          );
    const committed: TextPostCommitOutcome = yield* commitEffect.pipe(
      Effect.mapError(mapStoreFailure),
    );
    if (committed.kind === "created" || committed.kind === "replay") return committed.snapshot;
    if (committed.kind === "conflict") return yield* idempotencyConflict(committed.submissionId);
  }
  return yield* new CommentsRepliesPolicyStale({ attempts: MAX_POLICY_RETRIES });
});
