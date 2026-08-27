import {
  BadRequest,
  CommentsLocked,
  Conflict,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  NotFound,
  ReplyDepthExceeded,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { CommentReportReasonCode, TextPostRepositoryFailure } from "../../ports.ts";
import { type M2Actor, TextPostRepositoryError, type TextPostStore } from "../../ports.ts";
import { canonicalBodyHash, validateHumanDirectActor, validateIdentifier } from "./common.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;
type CommentReportResponse = Readonly<{
  readonly report_id: string;
  readonly case_ref: string;
  readonly status: "open" | "coalesced";
}>;
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

export type ReportCommentInput = Readonly<{
  readonly commentId: string;
  readonly actor: M2Actor;
  readonly body: unknown;
}>;
const decode = (schema: typeof ReportBody, input: unknown) =>
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
