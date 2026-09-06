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
import { canonicalTextModerationInput, normalizeTextModerationInput } from "@pirate/domain";
import { Data, Effect, Schema } from "effect";
import {
  type CreatePostBody,
  type M2Actor,
  type TextPostCommitOutcome,
  type TextPostModerationInput,
  type TextPostReplayOutcome,
  TextPostRepositoryError,
  type TextPostRepositoryFailure,
  type TextPostStore,
  type TextPostSubmissionDocument,
} from "../../ports.ts";
import {
  evaluateTextModerationV2,
  type TextModerationProviderServiceV1,
} from "../../text-moderation-runtime.ts";
import {
  type PersonaStoreService,
  PersonaUnavailable,
  requireActiveOwnedPersona,
} from "../personas.ts";
import {
  canonicalBodyHash,
  validateHumanDirectActor,
  validateIdentifier,
  validPublicHumanDirectPost,
} from "./common.ts";

export { TextModerationProviderError } from "../../ports.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;
const MAX_POLICY_RETRIES = 3;

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
  readonly textModerationProvider?: TextModerationProviderServiceV1;
  readonly personaStore?: Pick<PersonaStoreService, "findOwned">;
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
  const moderationProvider = services.textModerationProvider;
  const personaStore = services.personaStore;
  if (store === undefined || personaStore === undefined)
    return yield* new TextPostRuntimeUnavailable();
  yield* validateIdentifier(input.communityId, "Invalid community identifier");
  yield* validateHumanDirectActor(input.actor);
  const body = yield* decodeTextPostBody(input.body);
  if (!validPublicHumanDirectPost(body) || body.post_type !== "text")
    return yield* new BadRequest({ message: "Only public human text posts are supported" });
  yield* requireActiveOwnedPersona(
    { accountId: input.actor.userId, personaId: body.persona_id },
    personaStore,
  ).pipe(
    Effect.mapError((error) =>
      error instanceof PersonaUnavailable ? new NotFound({ message: "Persona not found" }) : error,
    ),
  );
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
        personaId: body.persona_id,
        idempotencyKey,
        requestHash,
        surface: "text_post",
      })
      .pipe(Effect.mapError(mapStoreFailure));
    if (replay.kind === "replay") return replay.snapshot;
    if (replay.kind === "conflict") return yield* idempotencyConflict(replay.submissionId);

    yield* store
      .checkAuthority({ communityId: input.communityId, actor: input.actor })
      .pipe(Effect.mapError(mapStoreFailure));

    // The provider is deliberately outside the repository transaction. A
    // stale policy result is discarded by commitTerminal and evaluated again.
    const { evaluation, restrictedEvidence } = yield* evaluateTextModerationV2({
      communityId: input.communityId,
      moderationInput: text.input,
      inputSha256: text.inputSha256,
      store,
      provider: moderationProvider,
      authorDeclaredRating: body.author_declared_rating ?? "general",
    }).pipe(Effect.mapError(mapStoreFailure));
    const commitInput = {
      communityId: input.communityId,
      actor: input.actor,
      personaId: body.persona_id,
      body,
      moderationInput: text.input,
      idempotencyKey,
      requestHash,
      operationId: `operation_${crypto.randomUUID()}`,
      target: { surface: "text_post", communityId: input.communityId },
    } as const;
    const commitEffect = store.commitTerminal({
      ...commitInput,
      evaluation,
      ...(restrictedEvidence === undefined ? {} : { restrictedEvidence }),
    });
    const committed: TextPostCommitOutcome = yield* commitEffect.pipe(
      Effect.mapError(mapStoreFailure),
    );
    if (committed.kind === "created" || committed.kind === "replay") return committed.snapshot;
    if (committed.kind === "conflict") return yield* idempotencyConflict(committed.submissionId);
  }
  return yield* new TextPostPolicyStale({ attempts: MAX_POLICY_RETRIES });
});

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
