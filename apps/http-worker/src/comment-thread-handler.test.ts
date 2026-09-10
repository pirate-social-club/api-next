import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeCommentThreadHandler } from "./comment-thread-handler.ts";
import { makeSongPlaybackHandler } from "./song-playback-handler.ts";
import type { DecodedRequest } from "./transport.ts";

const request: DecodedRequest = {
  principal: { kind: "user", subject: "reader" },
  params: { postId: "post" },
  query: { parent_comment_id: "parent", cursor: "cursor" },
  body: undefined,
  edgeClientIp: "198.51.100.1",
};
test("comment handler binds the principal and page arguments and prevents cache reuse", async () => {
  const handler = makeCommentThreadHandler({
    list: (input) => {
      expect(input).toEqual({
        postId: "post",
        viewerUserId: "reader",
        parentCommentId: "parent",
        cursor: "cursor",
      });
      return Effect.succeed({ items: [], next_cursor: null });
    },
  });
  const result = await handler(request);
  expect(result).toMatchObject({ status: 200, body: { items: [], next_cursor: null } });
  await expect(handler({ ...request, principal: null })).rejects.toThrow("Authentication required");
});
test("song handler grants privately and cannot trust a caller's forwarding header", async () => {
  const handler = makeSongPlaybackHandler({
    nowMs: Effect.succeed(1000000),
    authorize: () => Effect.succeed({ immutableRef: "media://immutable/song/audio" }),
    limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
    sign: () => Effect.succeed("https://audio.example.test/signed"),
  });
  const result = await handler(request);
  expect(new Headers(result.responseHeaders).get("cache-control")).toBe("private, no-store");
  const { edgeClientIp: _, ...withoutEdge } = request;
  await expect(
    handler({ ...withoutEdge, headers: { "x-forwarded-for": "198.51.100.1" } }),
  ).rejects.toThrow("Song playback unavailable");
  await expect(
    handler({ ...request, principal: { kind: "agent", subject: "agent" } }),
  ).rejects.toThrow("Authorization failed");
});
