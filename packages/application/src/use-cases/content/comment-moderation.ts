import {
  BadRequest,
  CommentsLocked,
  Conflict,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  type ModerateCaseAction as ModerateCaseActionContract,
  NotFound,
  ReplyDepthExceeded,
  type ReportComment as ReportCommentContract,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type {
  CommentReportReasonCode,
  ModerationAction,
  TextPostRepositoryFailure,
} from "../../ports.ts";
import { type M2Actor, TextPostRepositoryError, type TextPostStore } from "../../ports.ts";
import { canonicalBodyHash, validateHumanDirectActor, validateIdentifier } from "./common.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;
type CommentReportResponse = Schema.Schema.Type<typeof ReportCommentContract.response>;
type ModerationCaseActionResponse = Schema.Schema.Type<typeof ModerateCaseActionContract.response>;
const ReportBody = Schema.Struct({
  idempotency_key: Schema.String,
  reason_code: Schema.Literals([
    "spam",
    "harassment",
    "hate",
    "sexual_content",
    "graphic_content",
    "misleading",
    "other",
  ]),
});
const ActionBody = Schema.Struct({
  idempotency_key: Schema.String,
  action: Schema.Literals(["approve", "dismiss", "hide", "remove", "restore"]),
});

export type ReportCommentInput = Readonly<{
  readonly commentId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;
export type ModerateCaseActionInput = Readonly<{
  readonly caseRef: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

const decode = (schema: typeof ReportBody | typeof ActionBody, input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, exactParseOptions)(input),
    catch: () => new BadRequest({ message: "Invalid moderation request body" }),
  });

const mapFailure = (failure: TextPostRepositoryFailure, fallbackId: string) => {
  if (!(failure instanceof TextPostRepositoryError))
    return new InternalError({ message: "Moderation operation failed" });
  switch (failure.reason) {
    case "membership-required":
      return new MembershipRequired({ message: "Community membership is required" });
    case "idempotency-conflict":
      return new IdempotencyConflict({
        message: "The idempotency key was already used with a different request",
        details: {
          reason_code: "idempotency_conflict",
          submission_id: failure.submissionId ?? fallbackId,
        },
      });
    case "action-conflict":
      return new Conflict({ message: "Moderation action conflicts with current case state" });
    case "comments-locked":
      return new CommentsLocked({ message: "Comments are locked for this post" });
    case "reply-depth-exceeded":
      return new ReplyDepthExceeded({ message: "Reply depth exceeds the v1 limit" });
    case "constraint":
      return new BadRequest({ message: "Moderation request violates a resource constraint" });
    case "not-found":
      return new NotFound({ message: "Moderation case or comment not found" });
    default:
      return new InternalError({ message: "Moderation operation returned an invalid record" });
  }
};

const mapReportFailure = (
  failure: TextPostRepositoryFailure,
  fallbackId: string,
): BadRequest | Conflict | IdempotencyConflict | InternalError | MembershipRequired | NotFound => {
  if (
    failure instanceof TextPostRepositoryError &&
    (failure.reason === "comments-locked" ||
      failure.reason === "reply-depth-exceeded" ||
      failure.reason === "action-conflict")
  )
    return new InternalError({ message: "Comment report operation returned an invalid state" });
  const mapped = mapFailure(failure, fallbackId);
  if (mapped instanceof CommentsLocked || mapped instanceof ReplyDepthExceeded)
    return new InternalError({ message: "Comment report operation returned an invalid state" });
  return mapped;
};

export const reportComment = Effect.fn("reportComment")(function* (
  input: ReportCommentInput,
  services: { readonly textPostStore?: TextPostStore["Service"] },
): Effect.fn.Return<
  CommentReportResponse,
  BadRequest | Conflict | IdempotencyConflict | InternalError | MembershipRequired | NotFound
> {
  const store = services.textPostStore;
  if (store?.reportComment === undefined)
    return yield* new NotFound({ message: "Comment not found" });
  yield* validateIdentifier(input.commentId, "Invalid comment identifier");
  yield* validateHumanDirectActor(input.actor);
  const body = (yield* decode(ReportBody, input.body)) as Schema.Schema.Type<typeof ReportBody>;
  if (body.idempotency_key.trim() === "")
    return yield* new BadRequest({ message: "An idempotency key is required" });
  const requestHash = yield* canonicalBodyHash({
    endpoint: "POST /comments/:commentId/reports",
    comment_id: input.commentId,
    body,
  });
  const outcome = yield* store
    .reportComment({
      commentId: input.commentId,
      actor: input.actor,
      idempotencyKey: body.idempotency_key,
      reasonCode: body.reason_code as CommentReportReasonCode,
      requestHash,
    })
    .pipe(Effect.mapError((failure) => mapReportFailure(failure, input.commentId)));
  return { report_id: outcome.reportId, case_ref: outcome.caseRef, status: outcome.status };
});

export const moderateCaseAction = Effect.fn("moderateCaseAction")(function* (
  input: ModerateCaseActionInput,
  services: { readonly textPostStore?: TextPostStore["Service"] },
): Effect.fn.Return<
  ModerationCaseActionResponse,
  | BadRequest
  | CommentsLocked
  | Conflict
  | IdempotencyConflict
  | InternalError
  | MembershipRequired
  | NotFound
  | ReplyDepthExceeded
> {
  const store = services.textPostStore;
  if (store?.moderateCaseAction === undefined)
    return yield* new NotFound({ message: "Moderation case not found" });
  yield* validateIdentifier(input.caseRef, "Invalid moderation case identifier");
  yield* validateHumanDirectActor(input.actor);
  const body = (yield* decode(ActionBody, input.body)) as Schema.Schema.Type<typeof ActionBody>;
  if (body.idempotency_key.trim() === "")
    return yield* new BadRequest({ message: "An idempotency key is required" });
  const requestHash = yield* canonicalBodyHash({
    endpoint: "POST /moderation/cases/:caseRef/actions",
    case_ref: input.caseRef,
    body,
  });
  const outcome = yield* store
    .moderateCaseAction({
      caseRef: input.caseRef,
      actor: input.actor,
      idempotencyKey: body.idempotency_key,
      action: body.action as ModerationAction,
      requestHash,
    })
    .pipe(Effect.mapError((failure) => mapFailure(failure, input.caseRef)));
  return {
    action_id: outcome.actionId,
    case_ref: outcome.caseRef,
    action: outcome.action,
    target_status: outcome.targetStatus,
  };
});
