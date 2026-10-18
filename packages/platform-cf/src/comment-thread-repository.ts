import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  CommentThreadInput,
  CommentThreadPage,
  CommentThreadStore,
} from "@pirate/application/use-cases/content/comment-thread";
import { BadRequest, InternalError, ListPostComments, NotFound } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const unavailable = (cause?: unknown) =>
  new InternalError({ message: "Comments unavailable", cause });
const Result = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available"), document: ListPostComments.response }),
  Schema.Struct({
    kind: Schema.Literals(["post_not_found", "comment_not_found", "invalid_cursor"]),
  }),
]);
export const readCommentThread = Effect.fn("readCommentThread")(
  function* (input: CommentThreadInput) {
    const db = yield* ControlPlaneDb;
    const rows = yield* db.withTransaction((transaction) =>
      transaction.execute<{ result: unknown }>({
        label: "comments.thread.list",
        text: "SELECT list_post_comment_children_v1($1,$2,$3,$4) AS result",
        values: [
          input.viewerUserId,
          input.postId,
          input.parentCommentId ?? null,
          input.cursor ?? null,
        ],
        readonly: true,
      }),
    );
    const result = yield* Schema.decodeUnknownEffect(Result, { onExcessProperty: "error" })(
      rows.rows[0]?.result,
    );
    if (result.kind === "post_not_found") return yield* new NotFound({ message: "Post not found" });
    if (result.kind === "comment_not_found")
      return yield* new NotFound({ message: "Comment not found" });
    if (result.kind === "invalid_cursor")
      return yield* new BadRequest({ message: "Invalid comment cursor" });
    if (result.kind !== "available") return yield* unavailable();
    return result.document;
  },
  Effect.mapError((error) =>
    error instanceof NotFound || error instanceof BadRequest ? error : unavailable(error),
  ),
);

export function makeCommentThreadStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): CommentThreadStore {
  return {
    list: (input): Effect.Effect<CommentThreadPage, BadRequest | NotFound | InternalError> =>
      readCommentThread(input).pipe(
        Effect.provide(runtime),
        Effect.mapError((error) =>
          error instanceof NotFound || error instanceof BadRequest || error instanceof InternalError
            ? error
            : unavailable(error),
        ),
      ),
  };
}
