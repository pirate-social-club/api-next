import { describe, expect, it } from "bun:test";
import type { SessionExchangeServices } from "@pirate/application/use-cases/session-exchange";
import { Conflict } from "@pirate/contracts";
import { Effect } from "effect";
import { createHttpWorker, type EndpointHandler, withEndpointResult } from "./transport.ts";

const feed = { items: [], top_communities: [], next_cursor: null };
const vote = { post: "post_1", value: 1 as const };

const sessionServices: SessionExchangeServices = {
  proofVerifier: {
    verifyPrivy: () => Effect.succeed({ sourceUserId: "source-user", classification: "user" }),
    verifyJwt: () => Effect.succeed({ sourceUserId: "source-user", classification: "user" }),
  },
  identityStore: {
    resolve: () =>
      Effect.succeed({
        canonicalUserId: "canonical-user",
        user: {
          id: "canonical-user",
          object: "user",
          verification_state: "unverified",
          verification_capabilities: {
            unique_human: { state: "unverified" },
            age_over_18: { state: "unverified" },
            minimum_age: { state: "unverified" },
            nationality: { state: "unverified" },
            gender: { state: "unverified" },
            wallet_score: { state: "unverified" },
          },
          created: 1_700_000_000,
        },
        profile: {
          id: "canonical-user",
          object: "profile",
          global_handle: {
            id: "handle-1",
            object: "global_handle",
            label: "captain",
            tier: "generated",
            status: "active",
            issuance_source: "generated_signup",
            issued_at: 1_700_000_000,
          },
          created: 1_700_000_000,
        },
        onboarding: {
          generated_handle_assigned: true,
          cleanup_rename_available: false,
          unique_human_verification_status: "not_started",
          namespace_verification_status: "not_started",
          community_creation_ready: false,
          missing_requirements: [],
          reddit_verification_status: "not_started",
          reddit_import_status: "not_started",
        },
        wallet_attachments: [],
      }),
  },
  tokenMinter: {
    mint: ({ subject }) => Effect.succeed(`token-for-${subject}`),
  },
};

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
    expect((await response.json()) as { status: string }).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("installs session exchange through the generated route binding", async () => {
    const response = await createHttpWorker({ sessionExchange: sessionServices }).request(
      "http://worker.test/auth/session/exchange",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof: { type: "jwt_based_auth", jwt: "upstream-jwt" } }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ access_token: "token-for-canonical-user" });
  });

  it("returns the declared redacted internal error for an adapter defect", async () => {
    const response = await createHttpWorker({
      sessionExchange: {
        ...sessionServices,
        tokenMinter: {
          mint: () => Effect.fail(new Error("private key and bearer token")),
        },
      },
    }).request("http://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: { type: "jwt_based_auth", jwt: "upstream-jwt" } }),
    });

    const body = (await response.json()) as { code?: string; message?: string };
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ code: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("private key and bearer token");
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

  it("ignores credentials on public routes while disabling shared caching", async () => {
    let authenticated = false;
    const app = createHttpWorker({
      handlers: { GetPublicHomeFeed: () => feed },
      authenticate: () => {
        authenticated = true;
        throw new Error("public credentials must not be verified");
      },
    });

    const response = await app.request("http://worker.test/feed/home/public", {
      headers: { authorization: "Bearer invalid" },
    });

    expect(response.status).toBe(200);
    expect(authenticated).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("skips authorization only for a signed-out optional-user request", async () => {
    const principals: Array<string | null> = [];
    const authorizedSubjects: string[] = [];
    const app = createHttpWorker({
      handlers: {
        GetHomeFeed: (input) => {
          principals.push(input.principal?.subject ?? null);
          return feed;
        },
      },
      authenticate: ({ credentials }) => ({
        kind: "user",
        subject: credentials.authorization,
      }),
      authorize: ({ input }) => {
        if (input.principal === null) throw new Error("signed-out request reached authorization");
        authorizedSubjects.push(input.principal.subject);
      },
    });

    const signedOut = await app.request("http://worker.test/feed/home");
    const signedIn = await app.request("http://worker.test/feed/home", {
      headers: { authorization: "Bearer test" },
    });

    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    expect(signedIn.status).toBe(200);
    expect(principals).toEqual([null, "Bearer test"]);
    expect(authorizedSubjects).toEqual(["Bearer test"]);
  });

  it("encodes the response schema and strips an undeclared response field", async () => {
    const response = await createHttpWorker({
      handlers: {
        GetPublicHomeFeed: () => ({ ...feed, leaked: "secret" }),
      },
    }).request("http://worker.test/feed/home/public");

    expect(response.status).toBe(200);
    expect((await response.json()) as typeof feed).toEqual(feed);
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

  it("constrains authentication and authorization failures to the declared union", async () => {
    const authenticationFailure = createHttpWorker({
      handlers: { CastPostVote: () => vote },
      authenticate: () => {
        throw new Conflict({ message: "not declared for voting" });
      },
      authorize: () => undefined,
    });
    const authenticationResponse = await authenticationFailure.request(
      "http://worker.test/posts/post_1/vote",
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      },
    );

    const authorizationFailure = createHttpWorker({
      handlers: { CastPostVote: () => vote },
      authenticate: () => ({ kind: "user", subject: "user_1" }),
      authorize: () => {
        throw new Conflict({ message: "not declared for voting" });
      },
    });
    const authorizationResponse = await authorizationFailure.request(
      "http://worker.test/posts/post_1/vote",
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      },
    );

    expect(authenticationResponse.status).toBe(500);
    expect(await authenticationResponse.json()).toMatchObject({ code: "internal_error" });
    expect(authorizationResponse.status).toBe(500);
    expect(await authorizationResponse.json()).toMatchObject({ code: "internal_error" });
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

  it("allows each trimmed origin in a comma-separated CORS configuration", async () => {
    const worker = protectedWorker(
      "CastPostVote",
      () => vote,
      "https://pirate.app, https://pirate.sc",
    );

    for (const origin of ["https://pirate.app", "https://pirate.sc"]) {
      const response = await worker.request("http://worker.test/posts/post_1/vote", {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({ value: 1 }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("vary")).toContain("Origin");
    }
  });

  it("does not allow an origin absent from the CORS configuration", async () => {
    const response = await protectedWorker(
      "CastPostVote",
      () => vote,
      "https://pirate.app, https://pirate.sc",
    ).request("http://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        origin: "https://staging.pirate.sc",
      },
      body: JSON.stringify({ value: 1 }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
