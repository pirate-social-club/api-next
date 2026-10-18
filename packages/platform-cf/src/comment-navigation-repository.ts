import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { postSlugCanonicalPath } from "@pirate/application/post-slug";
import type { CommentNavigationStore } from "@pirate/application/use-cases/comment-navigation";
import {
  InternalError,
  NotFound,
  ResolveCommentNavigationV1,
  videoPostDetailPath,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

export function makeControlPlaneCommentNavigationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): CommentNavigationStore {
  return {
    resolve: Effect.fn("CommentNavigationStore.resolve")(
      function* (input: { viewerUserId: string; commentId: string }) {
        const db = yield* ControlPlaneDb;
        const rows = yield* db.withTransaction((tx) =>
          tx.execute<Record<string, unknown>>({
            label: "comments.navigation.resolve",
            text: "SELECT resolve_comment_navigation_v1($1,$2) AS result",
            values: [input.viewerUserId, input.commentId],
            readonly: true,
          }),
        );
        if (rows.rows[0]?.result === null)
          return yield* new NotFound({ message: "Comment not found" });
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            post_type: Schema.Literals(["text", "song", "video"]),
            post_id: Schema.String,
            post_slug: Schema.NullOr(Schema.String),
            document: Schema.Record(Schema.String, Schema.Unknown),
          }),
        )(rows.rows[0]?.result);
        const path =
          result.post_type === "video"
            ? videoPostDetailPath(result.post_id)
            : result.post_slug === null
              ? null
              : postSlugCanonicalPath(result.post_slug);
        if (path === null) return yield* new NotFound({ message: "Comment not found" });
        if (result.document.kind === "available" && result.document.post_id !== result.post_id)
          return yield* new InternalError({
            message: "Comment navigation unavailable",
            cause: new Error("Navigation destination identity mismatch"),
          });
        return yield* Schema.decodeUnknownEffect(ResolveCommentNavigationV1.response, {
          onExcessProperty: "error",
        })(
          result.document.kind === "available"
            ? { ...result.document, post_path: path }
            : result.document,
        );
      },
      Effect.provide(runtime),
      Effect.mapError((error) =>
        error instanceof NotFound
          ? error
          : new InternalError({ message: "Comment navigation unavailable", cause: error }),
      ),
    ),
  };
}
