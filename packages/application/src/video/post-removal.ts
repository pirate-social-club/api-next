import {
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  type VideoPostDeletionReceipt,
} from "@pirate/contracts";
import { Data, Effect } from "effect";

export class VideoPostRemovalFailed extends Data.TaggedError("VideoPostRemovalFailed")<{
  readonly reason: "unpublished" | "store-unavailable";
}> {}

export interface VideoPostRemovalStore {
  readonly removeOwn: (
    input: Readonly<{ accountId: string; postId: string }>,
  ) => Effect.Effect<VideoPostDeletionReceipt | null, VideoPostRemovalFailed>;
}

export const removeOwnVideoPost = Effect.fn("removeOwnVideoPost")(function* (
  input: Readonly<{ accountId: string; postId: string }>,
  store: VideoPostRemovalStore,
) {
  if (
    !input.accountId ||
    !input.postId ||
    input.postId !== input.postId.trim() ||
    input.postId.length > 512 ||
    input.postId.includes("\u0000")
  )
    return yield* new BadRequest({ message: "Invalid video Post" });
  const receipt = yield* store
    .removeOwn(input)
    .pipe(
      Effect.mapError((error) =>
        error.reason === "unpublished"
          ? new Conflict({ message: "This video Post has not been published" })
          : new InternalError({ message: "Video Post deletion could not be confirmed" }),
      ),
    );
  if (receipt === null) return yield* new NotFound({ message: "Video Post not found" });
  return receipt;
});
