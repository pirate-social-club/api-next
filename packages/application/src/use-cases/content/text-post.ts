import {
  BadRequest,
  CreatePost,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  NotFound,
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
  type TextPostFinalizeOutcome,
  type TextPostModerationEvaluation,
  type TextPostModerationInput,
  type TextPostReplayOutcome,
  TextPostRepositoryError,
  type TextPostRepositoryFailure,
  type TextPostReservation,
  type TextPostReserveOutcome,
  type TextPostStore,
  type TextPostSubmissionDocument,
} from "../../ports.ts";
import {
  canonicalBodyHash,
  validateHumanDirectActor,
  validateIdentifier,
  validPublicHumanDirectPost,
} from "./common.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;
const MAX_POLICY_RETRIES = 3;

/** A bounded failure is useful to schedulers while remaining provider-neutral. */
export class TextPostPolicyStale extends Data.TaggedError("TextPostPolicyStale")<{
  readonly attempts: number;
}> {}

export class TextPostRuntimeUnavailable extends Data.TaggedError("TextPostRuntimeUnavailable") {}

export type TextPostCreateInput = Readonly<{
  readonly communityId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

export type TextPostCreateResult = Readonly<{
  readonly snapshot: TextPostSubmissionDocument;
  readonly replayed: boolean;
}>;

/**
 * The short runtime seam deliberately names both concepts. `store` and
 * `moderation` are the focused names used by new callers; the aliases let the
 * coordinator wire the corresponding Context services without adapters.
 */
export type TextPostServices = Readonly<{
  readonly store?: TextPostStore["Service"];
  readonly textStore?: TextPostStore["Service"];
  readonly moderation?: TextModeration["Service"];
  readonly textPostStore?: TextPostStore["Service"];
  readonly textModeration?: TextModeration["Service"];
}>;

export type GetTextContentSubmissionInput = Readonly<{
  readonly submissionId: string;
  readonly actor: M2Actor;
}>;

function runtimeServices(services: TextPostServices): Readonly<{
  readonly store: TextPostStore["Service"];
  readonly moderation: TextModeration["Service"];
}> | null {
  const store = services.store ?? services.textPostStore ?? services.textStore;
  const moderation = services.moderation ?? services.textModeration;
  return store === undefined || moderation === undefined ? null : { store, moderation };
}

function storeService(services: TextPostServices): TextPostStore["Service"] | null {
  return services.store ?? services.textPostStore ?? services.textStore ?? null;
}

function idempotencyConflict(submissionId: string): IdempotencyConflict {
  return new IdempotencyConflict({
    message: "The idempotency key was already used with a different request",
    details: { reason_code: "idempotency_conflict", submission_id: submissionId },
  });
}

function mapStoreFailure(failure: TextPostRepositoryFailure) {
  if (!(failure instanceof TextPostRepositoryError)) {
    return new InternalError({ message: "Text submission operation failed" });
  }
  switch (failure.reason) {
    case "membership-required":
      return new MembershipRequired({ message: "Community membership is required" });
    case "not-found":
      return new NotFound({ message: "Text submission not found" });
    case "constraint":
      return new BadRequest({ message: "Text submission violates a resource constraint" });
    case "invalid-row":
      return new InternalError({ message: "Text submission operation returned an invalid record" });
  }
}

function providerReason(
  reason: TextModerationProviderError["reason"],
): "provider_unavailable" | "provider_timeout" | "provider_invalid" {
  switch (reason) {
    case "unavailable":
      return "provider_unavailable";
    case "timeout":
      return "provider_timeout";
    case "invalid":
      return "provider_invalid";
  }
}

function fallbackEvaluation(
  reservation: TextPostReservation,
  input: TextPostModerationInput,
  reason: TextModerationProviderError["reason"] | "invalid-evaluation",
  inputSha256 = reservation.inputSha256,
): TextPostModerationEvaluation {
  return {
    version: "text-moderation-v1",
    surface: input.surface,
    decision: "manual_review",
    reason_codes: [providerReason(reason === "invalid-evaluation" ? "invalid" : reason)],
    policy_revision: reservation.policyRevision,
    policy_hash: reservation.policyHash,
    input_sha256: inputSha256,
    evidence_ref: null,
  };
}

function safeEvaluation(
  evaluation: TextPostModerationEvaluation,
  reservation: TextPostReservation,
  input: TextPostModerationInput,
  expectedInputSha256: string,
): TextPostModerationEvaluation {
  const valid =
    textModerationEvaluationInvariant(evaluation) === null &&
    evaluation.surface === input.surface &&
    evaluation.policy_revision === reservation.policyRevision &&
    evaluation.policy_hash === reservation.policyHash &&
    evaluation.input_sha256 === expectedInputSha256 &&
    publicTextPublicationResult(evaluation) !== null;
  return valid
    ? evaluation
    : fallbackEvaluation(reservation, input, "invalid-evaluation", expectedInputSha256);
}

function normalizeTextInput(
  body: CreatePostBody,
): Effect.Effect<Readonly<{ input: TextPostModerationInput; inputSha256: string }>, BadRequest> {
  const normalized = normalizeTextModerationInput({
    surface: "text_post",
    title: body.title ?? null,
    body: body.body ?? null,
  });
  if (normalized.kind === "rejected") {
    return Effect.fail(new BadRequest({ message: "Text content must not be empty or invalid" }));
  }
  const canonical = canonicalTextModerationInput(normalized.input);
  if (canonical.kind === "rejected") {
    return Effect.fail(new BadRequest({ message: "Text content is not canonical" }));
  }
  return Effect.succeed({ input: normalized.input, inputSha256: canonical.sha256 });
}

function decodeTextPostBody(input: unknown): Effect.Effect<CreatePostBody, BadRequest> {
  return Effect.try({
    try: () =>
      Schema.decodeUnknownSync(
        // CreatePost's request is a union; strict decoding is required before
        // any replay lookup so unsupported metadata cannot affect a hash.
        CreatePost.request.body,
        exactParseOptions,
      )(input) as CreatePostBody,
    catch: () => new BadRequest({ message: "Invalid request body" }),
  });
}

/**
 * Creates one moderated text submission. Every provider call is made after a
 * replay lookup and reservation, and every finalize call is a separate store
 * operation; a store implementation must keep its transactions within those
 * calls and never span the provider effect.
 */
export const createTextPost = Effect.fn("createTextPost")(function* (
  input: TextPostCreateInput,
  services: TextPostServices,
): Effect.fn.Return<
  TextPostCreateResult,
  | BadRequest
  | MembershipRequired
  | NotFound
  | InternalError
  | IdempotencyConflict
  | TextPostPolicyStale
  | TextPostRuntimeUnavailable
> {
  const runtime = runtimeServices(services);
  if (runtime === null) return yield* new TextPostRuntimeUnavailable();
  yield* validateIdentifier(input.communityId, "Invalid community identifier");
  yield* validateHumanDirectActor(input.actor);

  const body = yield* decodeTextPostBody(input.body);
  if (!validPublicHumanDirectPost(body) || body.post_type !== "text") {
    return yield* new BadRequest({ message: "Only public human text posts are supported" });
  }
  const text = yield* normalizeTextInput(body);
  const requestHash = yield* canonicalBodyHash({
    community_id: input.communityId,
    body,
  });
  const idempotencyKey = body.idempotency_key;
  if (idempotencyKey.trim().length === 0) {
    return yield* new BadRequest({ message: "An idempotency key is required" });
  }

  for (let attempt = 0; attempt < MAX_POLICY_RETRIES; attempt += 1) {
    // This lookup is intentionally repeated after a stale policy result. It
    // keeps every provider invocation behind the exact replay gate.
    const replay: TextPostReplayOutcome = yield* runtime.store
      .replay({
        communityId: input.communityId,
        actor: input.actor,
        idempotencyKey,
        requestHash,
      })
      .pipe(Effect.mapError(mapStoreFailure));
    if (replay.kind === "replay") return { snapshot: replay.snapshot, replayed: true };
    if (replay.kind === "conflict") return yield* idempotencyConflict(replay.submissionId);

    const reserved: TextPostReserveOutcome = yield* runtime.store
      .reserve({
        communityId: input.communityId,
        actor: input.actor,
        body,
        moderationInput: text.input,
        idempotencyKey,
        requestHash,
      })
      .pipe(Effect.mapError(mapStoreFailure));
    if (reserved.kind === "replay") return { snapshot: reserved.snapshot, replayed: true };
    if (reserved.kind === "conflict") return yield* idempotencyConflict(reserved.submissionId);

    const reservation = reserved.reservation;
    if (reservation.inputSha256 !== text.inputSha256) {
      return yield* new InternalError({ message: "Text submission input binding failed" });
    }
    const evaluation: TextPostModerationEvaluation = yield* runtime.moderation
      .evaluate(text.input)
      .pipe(
        Effect.map((result) => safeEvaluation(result, reservation, text.input, text.inputSha256)),
        Effect.catchTag("TextModerationProviderError", (failure) =>
          Effect.succeed(fallbackEvaluation(reservation, text.input, failure.reason)),
        ),
        Effect.catchDefect(() =>
          Effect.succeed(fallbackEvaluation(reservation, text.input, "invalid-evaluation")),
        ),
      );

    const finalized: TextPostFinalizeOutcome = yield* runtime.store
      .finalize({ reservation, body, evaluation })
      .pipe(Effect.mapError(mapStoreFailure));
    if (finalized.kind === "created") return { snapshot: finalized.snapshot, replayed: false };
    if (finalized.kind === "replay") return { snapshot: finalized.snapshot, replayed: true };
    if (finalized.kind === "conflict") return yield* idempotencyConflict(finalized.submissionId);
    // A policy change invalidates only this provider result. The next loop
    // acquires the current policy and calls the provider again.
  }

  return yield* new TextPostPolicyStale({ attempts: MAX_POLICY_RETRIES });
});

/** Stable spelling for callers that distinguish the command from its route. */
export const createModeratedTextPost = createTextPost;

export const getTextContentSubmission = Effect.fn("getTextContentSubmission")(function* (
  input: GetTextContentSubmissionInput,
  services: TextPostServices,
): Effect.fn.Return<
  TextPostSubmissionDocument,
  BadRequest | NotFound | InternalError | TextPostRuntimeUnavailable | MembershipRequired
> {
  const store = storeService(services);
  if (store === null) return yield* new TextPostRuntimeUnavailable();
  yield* validateIdentifier(input.submissionId, "Invalid submission identifier");
  yield* validateHumanDirectActor(input.actor);
  const submission = yield* store
    .getForAuthor({ submissionId: input.submissionId, actor: input.actor })
    .pipe(Effect.mapError(mapStoreFailure));
  if (submission === null) return yield* new NotFound({ message: "Text submission not found" });
  return submission;
});

/** Contract-route spelling retained as a direct application entry point. */
export const getAuthorTextContentSubmission = getTextContentSubmission;
