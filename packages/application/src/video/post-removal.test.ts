import { expect, test } from "bun:test";
import { BadRequest, Conflict, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import {
  removeOwnVideoPost,
  VideoPostRemovalFailed,
  type VideoPostRemovalStore,
} from "./post-removal.ts";

const input = { accountId: "authenticated-account", postId: "video-post" };
const receipt = {
  object: "video_post_deletion" as const,
  post_id: input.postId,
  community_id: "community",
  status: "deleted" as const,
};

test("the authenticated immutable target reaches the store unchanged on recovery", async () => {
  const calls: unknown[] = [];
  const store: VideoPostRemovalStore = {
    removeOwn: (value) => {
      calls.push(value);
      return Effect.succeed(receipt);
    },
  };
  expect(await Effect.runPromise(removeOwnVideoPost(input, store))).toEqual(receipt);
  expect(await Effect.runPromise(removeOwnVideoPost(input, store))).toEqual(receipt);
  expect(calls).toEqual([input, input]);
});

test("invalid identifiers never dispatch a removal", async () => {
  let calls = 0;
  const store: VideoPostRemovalStore = {
    removeOwn: () => {
      calls++;
      return Effect.succeed(receipt);
    },
  };
  for (const postId of ["", " video-post", "video-post\u0000", "x".repeat(513)])
    await expect(
      Effect.runPromise(removeOwnVideoPost({ ...input, postId }, store)),
    ).rejects.toBeInstanceOf(BadRequest);
  expect(calls).toBe(0);
});

test("unavailable ownership does not disclose another account's Post", async () => {
  await expect(
    Effect.runPromise(removeOwnVideoPost(input, { removeOwn: () => Effect.succeed(null) })),
  ).rejects.toBeInstanceOf(NotFound);
});

test("an uncertain store outcome is not a deletion acknowledgment", async () => {
  await expect(
    Effect.runPromise(
      removeOwnVideoPost(input, {
        removeOwn: () => Effect.fail(new VideoPostRemovalFailed({ reason: "store-unavailable" })),
      }),
    ),
  ).rejects.toBeInstanceOf(InternalError);
  await expect(
    Effect.runPromise(
      removeOwnVideoPost(input, {
        removeOwn: () => Effect.fail(new VideoPostRemovalFailed({ reason: "unpublished" })),
      }),
    ),
  ).rejects.toBeInstanceOf(Conflict);
});
