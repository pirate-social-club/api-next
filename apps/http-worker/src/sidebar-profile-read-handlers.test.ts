import { expect, test } from "bun:test";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeCommunityNavigationHandlers } from "./community-navigation-handlers.ts";
import { makeProfileActivityHandler } from "./profile-activity-handler.ts";
import { createHttpWorker } from "./transport.ts";

test("generated discovery is public, moderation is account-scoped and responses are uncached", async () => {
  const subjects: string[] = [];
  const handlers = makeCommunityNavigationHandlers({
    popular: () => Effect.succeed([]),
    moderated: (subject) => {
      subjects.push(subject);
      return Effect.succeed([]);
    },
  });
  const app = createHttpWorker({
    handlers,
    authenticate: ({ credentials }) => {
      if (credentials.sessionCookie !== "fixture")
        throw new AuthError({ message: "Authentication required" });
      return { kind: "user", subject: "owner" };
    },
    authorize: () => {},
  });
  const publicList = await app.request("https://worker.test/public/communities/popular?limit=5");
  expect(publicList.status).toBe(200);
  expect(publicList.headers.get("cache-control")).toContain("no-store");
  expect(await publicList.json()).toMatchObject({ ranked_by: "members", items: [] });
  expect((await app.request("https://worker.test/users/me/moderation-communities")).status).toBe(
    401,
  );
  const moderated = await app.request("https://worker.test/users/me/moderation-communities", {
    headers: { cookie: "__Host-pirate_session=fixture" },
  });
  expect(moderated.status).toBe(200);
  expect(subjects).toEqual(["owner"]);
  expect(moderated.headers.get("cache-control")).toBe("private, no-store");
  expect(
    (await app.request("https://worker.test/public/communities/popular?limit=101")).status,
  ).toBe(400);
});
test("public profile activity receives only the resolved viewer and cannot cache private projections", async () => {
  const calls: unknown[] = [];
  const handler = makeProfileActivityHandler(
    {
      list: (input) => {
        calls.push(input);
        return Effect.succeed([]);
      },
    },
    { getPost: () => Effect.succeed(null) },
  );
  const app = createHttpWorker({
    handlers: { GetPublicProfileActivity: handler },
    authenticate: ({ credentials }) => {
      if (credentials.sessionCookie !== "fixture")
        throw new AuthError({ message: "Authentication required" });
      return { kind: "user", subject: "viewer" };
    },
    authorize: () => {},
  });
  const anon = await app.request(
    "https://worker.test/public/personas/persona/activity?surface=comments",
  );
  expect(anon.status).toBe(200);
  expect(anon.headers.get("cache-control")).toContain("no-store");
  const member = await app.request(
    "https://worker.test/public/personas/persona/activity?surface=posts",
    { headers: { cookie: "__Host-pirate_session=fixture" } },
  );
  expect(member.status).toBe(200);
  expect(member.headers.get("cache-control")).toContain("no-store");
  expect(calls).toEqual([
    { personaId: "persona", surface: "comments", cursor: null },
    { personaId: "persona", surface: "posts", cursor: null, viewerId: "viewer" },
  ]);
});
