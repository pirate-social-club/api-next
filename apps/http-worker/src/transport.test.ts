import { describe, expect, it } from "bun:test";
import { Conflict } from "@pirate/contracts";
import { createHttpWorker, type EndpointHandler, withEndpointResult } from "./transport.ts";

const feed = { items: [], top_communities: [], next_cursor: null };
const vote = { post: "post_1", value: 1 as const };

const protectedWorker = (name: string, handler: EndpointHandler, corsOrigin?: string) =>
  createHttpWorker({
    ...(corsOrigin === undefined ? {} : { config: { corsOrigin } }),
    handlers: { [name]: handler },
    authenticate: ({ credentials }) => ({
      kind: "user",
      subject: credentials.authorization,
    }),
    authorize: ({ input }) => {
      if (input.principal === null) throw new Error("principal missing");
    },
  });

describe("contracts-generated HTTP worker", () => {
  it("serves the health contract without a product handler", async () => {
    const response = await createHttpWorker().request("http://worker.test/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("requires an authorizer for an installed protected handler", () => {
    expect(() =>
      createHttpWorker({
        handlers: { GetCurrentUser: () => ({}) },
      }),
    ).toThrow("Protected handlers require an authenticator");
  });

  it("returns 401 with the old envelope before decoding an unauthenticated request", async () => {
    const app = protectedWorker("CastPostVote", () => vote);
    const response = await app.request("http://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-unauth" },
      body: "not-json",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "auth_error",
      request_id: "req-unauth",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects blank credentials before decoding and without invoking authentication", async () => {
    let authenticated = false;
    const app = createHttpWorker({
      handlers: { CastPostVote: () => vote },
      authenticate: () => {
        authenticated = true;
        return { kind: "user", subject: "should-not-run" };
      },
      authorize: () => undefined,
    });
    const response = await app.request("http://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: { authorization: "   ", "content-type": "application/json" },
      body: "not-json",
    });

    expect(response.status).toBe(401);
    expect(authenticated).toBe(false);
    expect(await response.json()).toMatchObject({ code: "auth_error" });
  });

  it("authenticates before decoding: authenticated malformed input is 400", async () => {
    const app = protectedWorker("CastPostVote", () => vote);
    const response = await app.request("http://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: "not-json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "bad_request",
      details: { location: "body" },
    });
  });

  it("decodes query values before an installed public handler runs", async () => {
    const response = await createHttpWorker({
      handlers: { GetPublicHomeFeed: () => feed },
    }).request("http://worker.test/feed/home/public?sort=unsupported");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "bad_request",
      details: { location: "query" },
    });
  });

  it("passes only decoded request data to handlers and authorizers", async () => {
    let received: unknown;
    const app = createHttpWorker({
      handlers: {
        GetPublicHomeFeed: (input) => {
          received = input;
          return feed;
        },
      },
    });

    const response = await app.request("http://worker.test/feed/home/public", {
      headers: { "x-secret": "must-not-cross-boundary" },
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({ body: undefined, params: undefined, query: {}, principal: null });
    expect(JSON.stringify(await response.json())).not.toContain("must-not-cross-boundary");
  });

  it("encodes the response schema and strips an undeclared response field", async () => {
    const response = await createHttpWorker({
      handlers: {
        GetPublicHomeFeed: () => ({ ...feed, leaked: "secret" }),
      },
    }).request("http://worker.test/feed/home/public");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(feed);
  });

  it("rejects a handler status that is not declared by the endpoint", async () => {
    const response = await createHttpWorker({
      handlers: {
        GetPublicHomeFeed: () => withEndpointResult(feed, 299),
      },
    }).request("http://worker.test/feed/home/public");

    expect(response.status).toBe(500);
    const body = (await response.json()) as { request_id?: string; code?: string };
    expect(body).toMatchObject({ code: "internal_error" });
    expect(response.headers.get("x-request-id")).toBe(body.request_id ?? null);
  });

  it("constrains handler failures to the endpoint's declared error union", async () => {
    const response = await createHttpWorker({
      handlers: {
        GetPublicHomeFeed: () => {
          throw new Conflict({ message: "not declared here" });
        },
      },
    }).request("http://worker.test/feed/home/public");

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal_error" });
  });

  it("returns not_found for an uninstalled route instead of undeclared not_implemented", async () => {
    const response = await createHttpWorker().request("http://worker.test/posts/post_1");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("adds configured CORS and no-store to credential-bearing success responses", async () => {
    const response = await protectedWorker(
      "CastPostVote",
      () => vote,
      "https://solid.test",
    ).request("http://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        origin: "https://solid.test",
      },
      body: JSON.stringify({ value: 1 }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
