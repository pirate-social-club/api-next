import { expect, test } from "bun:test";
import type { VideoPostRemovalStore } from "@pirate/application/use-cases/video-post-removal";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { createHttpWorker, type DecodedRequest } from "./transport.ts";
import { makeVideoPostRemovalHandler } from "./video-post-removal-handler.ts";

test("the handler uses the session subject and returns a private deletion receipt", async () => {
  const calls: unknown[] = [];
  const store: VideoPostRemovalStore = {
    removeOwn: (input) => {
      calls.push(input);
      return Effect.succeed({
        object: "video_post_deletion",
        community_id: "community",
        post_id: input.postId,
        status: "deleted",
      });
    },
  };
  const request: DecodedRequest = {
    principal: { kind: "user", subject: "authenticated-account" },
    params: { postId: "video-post" },
    query: {},
    body: { account_id: "forged-account" },
  };
  const result = await makeVideoPostRemovalHandler(store)(request);
  expect(calls).toEqual([{ accountId: "authenticated-account", postId: "video-post" }]);
  expect(result).toMatchObject({
    status: 200,
    body: {
      object: "video_post_deletion",
      community_id: "community",
      post_id: "video-post",
      status: "deleted",
    },
    responseHeaders: { "cache-control": "private, no-store" },
  });
});

test("a signed-out request cannot reach the removal store", async () => {
  let calls = 0;
  const store: VideoPostRemovalStore = {
    removeOwn: () => {
      calls++;
      return Effect.succeed(null);
    },
  };
  await expect(
    makeVideoPostRemovalHandler(store)({
      principal: null,
      params: { postId: "video-post" },
      query: {},
      body: undefined,
    }),
  ).rejects.toBeInstanceOf(AuthError);
  expect(calls).toBe(0);
});

test("DELETE requires a browser session, same Origin and matching CSRF before removal", async () => {
  let calls = 0;
  const app = createHttpWorker({
    config: { corsOrigin: "https://solid.test" },
    handlers: {
      DeleteVideoPost: makeVideoPostRemovalHandler({
        removeOwn: ({ postId, accountId }) => {
          calls++;
          expect(accountId).toBe("author_account");
          return Effect.succeed({
            object: "video_post_deletion",
            community_id: "community",
            post_id: postId,
            status: "deleted",
          });
        },
      }),
    },
    authenticate: () => ({ kind: "user", subject: "author_account" }),
    authorize: () => undefined,
  });
  const cookie = "__Host-pirate_session=session; __Host-pirate_csrf=csrf";
  const allowed = { cookie, origin: "https://solid.test", "x-csrf-token": "csrf" };
  for (const headers of [
    {},
    { authorization: "Bearer machine" },
    { cookie, origin: "https://solid.test" },
    { ...allowed, origin: "https://foreign.test" },
    { ...allowed, "x-csrf-token": "wrong" },
  ]) {
    const response = await app.request("https://worker.test/posts/video-post/video", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  }
  const response = await app.request("https://worker.test/posts/video-post/video", {
    method: "DELETE",
    headers: allowed,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(calls).toBe(1);
});
