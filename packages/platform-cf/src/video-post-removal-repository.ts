import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import {
  VideoPostRemovalFailed,
  type VideoPostRemovalStore,
} from "@pirate/application/video/post-removal";
import { Effect, type Layer, Schema } from "effect";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";

const Post = Schema.Struct({
  community_id: Schema.NonEmptyString,
  post_id: Schema.NonEmptyString,
  status: Schema.Literals([
    "draft",
    "processing",
    "published",
    "failed",
    "hidden",
    "removed",
    "deleted",
  ]),
});

export function makeControlPlaneVideoPostRemovalStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): VideoPostRemovalStore {
  return {
    removeOwn: (input) =>
      withRetainedControlPlaneCommandTransaction((tx) =>
        Effect.gen(function* () {
          // Serialize the account first, in the same order as account erasure and
          // other publication writes. Never trust a caller-supplied persona/owner.
          const account = yield* tx.execute({
            label: "video-post-removal.account-lock",
            text: "SELECT user_id FROM users WHERE user_id=$1 AND status='active' FOR UPDATE",
            values: [input.accountId],
            readonly: false,
          });
          if (account.rows.length !== 1) return null;
          const found = yield* tx.execute({
            label: "video-post-removal.post-lock",
            text: `SELECT community_id,post_id,status FROM posts
          WHERE post_id=$1 AND author_user_id=$2 AND post_type='video' FOR UPDATE`,
            values: [input.postId, input.accountId],
            readonly: false,
          });
          if (found.rows.length === 0) return null;
          if (found.rows.length !== 1)
            return yield* new VideoPostRemovalFailed({ reason: "store-unavailable" });
          const post = yield* Effect.try(() => Schema.decodeUnknownSync(Post)(found.rows[0]));
          if (post.status === "draft" || post.status === "processing" || post.status === "failed")
            return yield* new VideoPostRemovalFailed({ reason: "unpublished" });
          if (post.status !== "deleted") {
            const changed = yield* tx.execute({
              label: "video-post-removal.tombstone",
              text: `UPDATE posts SET status='deleted',updated_at=clock_timestamp()
            WHERE community_id=$1 AND post_id=$2 AND author_user_id=$3
              AND post_type='video' AND status=$4 RETURNING post_id`,
              values: [post.community_id, post.post_id, input.accountId, post.status],
              readonly: false,
            });
            if (changed.rows.length !== 1)
              return yield* new VideoPostRemovalFailed({ reason: "store-unavailable" });
          }
          // Repeating the same target also clears a stale projection. The source,
          // publication receipt, Song, private recording and qualifications stay put.
          yield* tx.execute({
            label: "video-post-removal.feed",
            text: "DELETE FROM home_feed_projection WHERE community_id=$1 AND post_id=$2",
            values: [post.community_id, post.post_id],
            readonly: false,
          });
          return {
            object: "video_post_deletion" as const,
            community_id: post.community_id,
            post_id: post.post_id,
            status: "deleted" as const,
          };
        }),
      ).pipe(
        Effect.provide(runtime),
        Effect.mapError((error) =>
          error instanceof VideoPostRemovalFailed
            ? error
            : new VideoPostRemovalFailed({ reason: "store-unavailable" }),
        ),
      ),
  };
}
