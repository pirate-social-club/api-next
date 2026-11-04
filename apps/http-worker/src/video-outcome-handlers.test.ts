import { expect, test } from "bun:test";
import type { VideoOutcomeStore } from "@pirate/application/use-cases/video-outcomes";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import { createHttpWorker } from "./transport.ts";
import { makeVideoOutcomeHandlers } from "./video-outcome-handlers.ts";

test("only a current same-origin CSRF-protected browser user may claim", async () => {
  const calls: string[] = [];
  const store: VideoOutcomeStore = {
    claim: (account) => {
      calls.push(account);
      return Effect.succeed({ submission_id: "video-one", kind: "policy_block", song: null });
    },
  };
  const worker = createHttpWorker({
    config: { corsOrigin: "https://solid.test" },
    handlers: makeVideoOutcomeHandlers(store),
    authorize: async () => {},
    authenticate: async ({ credentials }) => {
      if (credentials.sessionCookie !== "current-session")
        throw new AuthError({ message: "Authentication failed" });
      return { kind: "user", subject: "author-account" };
    },
  });
  const send = (headers: Record<string, string> = {}, body = "{}") =>
    worker.fetch(
      new Request("https://api.test/video-outcomes/claim", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
  const valid = {
    origin: "https://solid.test",
    cookie: "__Host-pirate_session=current-session; __Host-pirate_csrf=csrf",
    "x-csrf-token": "csrf",
  };
  for (const headers of [
    {},
    { authorization: "Bearer machine" },
    { ...valid, origin: "https://evil.test" },
    { ...valid, "x-csrf-token": "wrong" },
    { ...valid, cookie: "__Host-pirate_session=expired; __Host-pirate_csrf=csrf" },
  ]) {
    expect((await send(headers)).status).toBe(401);
  }
  expect(calls).toEqual([]);
  expect((await send(valid, '{"account_id":"other-account"}')).status).toBe(400);
  expect(calls).toEqual([]);
  const response = await send(valid);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    display_permission: true,
    outcome: { kind: "policy_block" },
  });
  expect(calls).toEqual(["author-account"]);
});
