import { expect, test } from "bun:test";
import { createPirateApiClient } from "@pirate/api-client";
import { AuthError, InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeCommentNavigationHandler } from "./comment-navigation-handler.ts";
import { createHttpWorker } from "./transport.ts";

test("generated navigation boundary requires a session, binds the viewer to the session, is no-store and performs no read-state write", async () => {
  let calls = 0;
  const age = {
    kind: "age_locked" as const,
    content_rating: "adult_18" as const,
    next_action: { kind: "verify_minimum_age" as const, minimum_age: 18 as const },
  };
  const handler = makeCommentNavigationHandler({
    resolve: (input) => {
      expect(input).toEqual({ viewerUserId: "viewer", commentId: "target" });
      calls++;
      return Effect.succeed(age);
    },
  });
  const worker = createHttpWorker({
    config: { corsOrigin: "https://solid.test" },
    authenticate: ({ credentials }) => ({
      kind: "user",
      subject: credentials.sessionCookie ?? "none",
    }),
    authorize: ({ input }) => {
      if (input.principal?.kind !== "user")
        throw new AuthError({ message: "Authentication required" });
    },
    handlers: { ResolveCommentNavigationV1: handler },
  });
  const url = "https://worker.test/comments/target/location";
  expect((await worker.request(url)).status).toBe(401);
  const headers = { cookie: "__Host-pirate_session=viewer" };
  expect((await worker.request(`${url}?recipient_user_id=other`, { headers })).status).toBe(200);
  expect(calls).toBe(1);
  const response = await worker.request(url, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(age);
  expect(calls).toBe(2);
  const fetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) =>
      worker.request(input instanceof Request ? input.url : String(input), init),
    { preconnect: fetch.preconnect },
  );
  const client = createPirateApiClient("https://worker.test", { fetchImpl });
  expect(
    await client.get_commentsCommentIdLocation({ path: { commentId: "target" } }, { headers }),
  ).toEqual(age);
  expect(calls).toBe(3);
});
test("HTTP wire output redacts an internal cause", async () => {
  const worker = createHttpWorker({
    config: { corsOrigin: "https://solid.test" },
    authenticate: () => ({ kind: "user", subject: "viewer" }),
    authorize: () => undefined,
    handlers: {
      ResolveCommentNavigationV1: makeCommentNavigationHandler({
        resolve: () =>
          Effect.fail(
            new InternalError({
              message: "Comment navigation unavailable",
              cause: new Error("private-sql-details"),
            }),
          ),
      }),
    },
  });
  const response = await worker.request("https://worker.test/comments/target/location", {
    headers: { cookie: "__Host-pirate_session=viewer" },
  });
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain("private-sql-details");
});
