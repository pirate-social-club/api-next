import { expect, test } from "bun:test";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeSongLibraryHandlers } from "./song-library-handlers.ts";
import type { DecodedRequest } from "./transport.ts";
import { createHttpWorker } from "./transport.ts";

test("library reads use the authenticated subject and reject anonymous callers", async () => {
  const observed: unknown[] = [];
  const handlers = makeSongLibraryHandlers({
    list: (input) => {
      observed.push(input);
      return Effect.succeed([]);
    },
    trending: () => Effect.succeed([]),
  });
  const request: DecodedRequest = {
    body: undefined,
    params: { personaId: "harbor" },
    query: { accountId: "foreign" },
    principal: { kind: "user", subject: "owner" },
  };
  await handlers.ListPersonaSongs(request);
  expect(observed).toEqual([{ accountId: "owner", personaId: "harbor", cursor: null }]);
  await expect(handlers.ListPersonaSongs({ ...request, principal: null })).rejects.toMatchObject({
    _tag: "AuthError",
  });
  expect(observed).toHaveLength(1);
  expect(await handlers.GetTrendingSongs({ ...request, principal: null })).toEqual({
    songs: [],
    window_days: 7,
  });
});

test("generated routes enforce authentication and mark library responses private", async () => {
  const handlers = makeSongLibraryHandlers({
    list: () => Effect.succeed([]),
    trending: () => Effect.succeed([]),
  });
  const app = createHttpWorker({
    handlers,
    authenticate: ({ credentials }) => {
      if (credentials.sessionCookie !== "session")
        throw new AuthError({ message: "Authentication required" });
      return { kind: "user", subject: "owner" };
    },
    authorize: () => {},
  });
  expect((await app.request("https://worker.test/personas/harbor/songs")).status).toBe(401);
  const response = await app.request("https://worker.test/personas/harbor/songs", {
    headers: { cookie: "__Host-pirate_session=session" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ songs: [], next_cursor: null });
  // Anonymous trending must not be cached, so a moderation hide or a re-rating
  // disappears on the next request, as with the other public feed reads.
  const trending = await app.request("https://worker.test/songs/trending");
  expect(trending.status).toBe(200);
  expect(trending.headers.get("cache-control")).toContain("no-store");
});
