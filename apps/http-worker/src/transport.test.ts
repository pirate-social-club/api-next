import { describe, expect, it } from "bun:test";
import type { SessionExchangeServices } from "@pirate/application/use-cases/session-exchange";
import {
  Auth,
  AuthError,
  BadRequest,
  Conflict,
  endpoint,
  VerificationStartInProgress,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import {
  createHttpWorker,
  type DecodedRequest,
  decodeInput,
  type EndpointHandler,
  withEndpointResult,
} from "./transport.ts";

const feed = { items: [], top_communities: [], next_cursor: null };
const vote = { post: "post_1", value: 1 as const };
const clearedVote = { post: "post_1", value: null };
const post = {
  id: "post_1",
  object: "post" as const,
  community: "community_1",
  authorship_mode: "human_direct" as const,
  identity_mode: "public" as const,
  post_type: "text" as const,
  status: "processing" as const,
  visibility: "public" as const,
  analysis_state: "pending" as const,
  content_safety_state: "pending" as const,
  age_gate_policy: "none" as const,
  created: 1_700_000_000,
};
const comment = {
  id: "comment_1",
  object: "comment" as const,
  community: "community_1",
  thread_root_post: "post_1",
  parent_comment: "comment_parent",
  author_user: "user_1",
  authorship_mode: "human_direct" as const,
  identity_mode: "public" as const,
  anonymous_scope: null,
  anonymous_label: null,
  body: "reply",
  status: "published" as const,
  depth: 1,
  direct_reply_count: 0,
  descendant_count: 0,
  upvote_count: 0,
  downvote_count: 0,
  score: 0,
  content_hash: null,
  swarm_body_ref: null,
  idempotency_key: "reply-key",
  created: 1_700_000_000,
};

const sessionServices: SessionExchangeServices = {
  proofVerifier: {
    verifyPrivy: () => Effect.succeed({ sourceUserId: "source-user", classification: "user" }),
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
      subject: credentials.authorization ?? credentials.sessionCookie ?? "",
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
    const response = await createHttpWorker({
      config: { corsOrigin: "https://solid.test" },
      sessionExchange: sessionServices,
    }).request("http://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "privy-proof" },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: "canonical-user" } });
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-pirate_session=token-for-canonical-user; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=3600",
    );
    expect(response.headers.get("set-cookie")).not.toContain("access_token");
  });

  it("requires exact Origin for browser session exchange", async () => {
    const app = createHttpWorker({
      config: { corsOrigin: "https://solid.test" },
      sessionExchange: sessionServices,
    });
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "privy-proof" },
      }),
    } as const;
    expect((await app.request("https://worker.test/auth/session/exchange", request)).status).toBe(
      401,
    );
    expect(
      (
        await app.request("https://worker.test/auth/session/exchange", {
          ...request,
          headers: { ...request.headers, origin: "https://evil.test" },
        })
      ).status,
    ).toBe(401);
  });

  it("requires exact Origin and double-submit CSRF for cookie-authenticated writes", async () => {
    const app = createHttpWorker({
      config: { corsOrigin: "https://solid.test" },
      sessionExchange: sessionServices,
      handlers: { ClearPostVote: () => clearedVote },
      authenticate: ({ credentials }) => ({
        kind: "user",
        subject: credentials.sessionCookie ?? "",
      }),
      authorize: ({ input }) => {
        if (input.principal === null) throw new AuthError({ message: "Authentication required" });
      },
    });
    const exchange = await app.request("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "privy-proof" },
      }),
    });
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    const cookie = setCookie
      .split(/, (?=__Host-pirate_)/u)
      .map((part) => part.split(";", 1)[0] ?? "")
      .join("; ");
    const csrf = cookie.match(/__Host-pirate_csrf=([^;]+)/u)?.[1];
    expect(csrf).toBeTruthy();

    const missingCsrf = await app.request("https://worker.test/posts/post_1/clear_vote", {
      method: "POST",
      headers: { cookie, origin: "https://solid.test" },
    });
    expect(missingCsrf.status).toBe(401);

    const wrongOrigin = await app.request("https://worker.test/posts/post_1/clear_vote", {
      method: "POST",
      headers: { cookie, origin: "https://evil.test", "x-csrf-token": csrf as string },
    });
    expect(wrongOrigin.status).toBe(401);

    const allowed = await app.request("https://worker.test/posts/post_1/clear_vote", {
      method: "POST",
      headers: { cookie, origin: "https://solid.test", "x-csrf-token": csrf as string },
    });
    expect(allowed.status).toBe(200);
  });

  it("clears the host-only session and CSRF cookies exactly on logout", async () => {
    const app = createHttpWorker({ config: { corsOrigin: "https://solid.test" } });
    const wrongOrigin = await app.request("https://worker.test/auth/session/logout", {
      method: "POST",
      headers: {
        cookie: "__Host-pirate_session=token; __Host-pirate_csrf=csrf",
        origin: "https://evil.test",
        "x-csrf-token": "csrf",
      },
    });
    expect(wrongOrigin.status).toBe(401);
    const response = await app.request("https://worker.test/auth/session/logout", {
      method: "POST",
      headers: {
        cookie: "__Host-pirate_session=token; __Host-pirate_csrf=csrf",
        origin: "https://solid.test",
        "x-csrf-token": "csrf",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-pirate_session=;");
    expect(setCookie).toContain("__Host-pirate_csrf=;");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).not.toContain("Domain=");
  });

  it("rejects duplicate session or CSRF cookies instead of choosing one", async () => {
    const app = createHttpWorker({
      handlers: { GetCurrentUser: () => ({}) },
      authenticate: ({ credentials }) => ({
        kind: "user",
        subject: credentials.sessionCookie ?? "",
      }),
      authorize: () => undefined,
    });
    const duplicateSession = await app.request("http://worker.test/users/me", {
      headers: { cookie: "__Host-pirate_session=one; __Host-pirate_session=two" },
    });
    expect(duplicateSession.status).toBe(401);
    const duplicateCsrf = await app.request("http://worker.test/users/me", {
      headers: {
        cookie: "__Host-pirate_session=one; __Host-pirate_csrf=a; __Host-pirate_csrf=b",
      },
    });
    expect(duplicateCsrf.status).toBe(401);

    const mixedCredentials = await app.request("http://worker.test/users/me", {
      headers: {
        authorization: "Bearer machine-token",
        cookie: "__Host-pirate_session=one",
      },
    });
    expect(mixedCredentials.status).toBe(401);

    const emptySession = await app.request("http://worker.test/users/me", {
      headers: { cookie: "__Host-pirate_session=; __Host-pirate_csrf=csrf" },
    });
    expect(emptySession.status).toBe(401);
    const malformedSession = await app.request("http://worker.test/users/me", {
      headers: { cookie: "__Host-pirate_session=%ZZ; __Host-pirate_csrf=csrf" },
    });
    expect(malformedSession.status).toBe(401);
  });

  it("returns the declared redacted internal error for an adapter defect", async () => {
    const response = await createHttpWorker({
      config: { corsOrigin: "https://solid.test" },
      sessionExchange: {
        ...sessionServices,
        tokenMinter: {
          mint: () => Effect.fail(new Error("private key and bearer token")),
        },
      },
    }).request("http://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "privy-proof" },
      }),
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

  it("preserves raw-text body Unicode and whitespace and exposes only declared headers", async () => {
    const rawBody = "\r\n  Mērs 🏴‍☠️  \n\t";
    const callback = endpoint({
      method: "POST",
      path: "/test/raw",
      auth: Auth.public(),
      request: {
        headers: Schema.Struct({ "x-signature": Schema.String }),
        body: Schema.String,
        bodyEncoding: "raw-text",
      },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    let decoded: DecodedRequest | undefined;
    const app = new Hono();
    app.post("/test/raw", async (context) => {
      decoded = await decodeInput(callback, context as never, null);
      return new Response("ok");
    });

    const response = await app.request("http://worker.test/test/raw", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-signature": "sig-value",
        "x-undeclared": "must-not-cross-boundary",
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    expect(decoded).toEqual({
      body: rawBody,
      headers: { "x-signature": "sig-value" },
      params: undefined,
      query: undefined,
      principal: null,
    });
  });

  it("rejects a raw-text request with a missing required header", async () => {
    const callback = endpoint({
      method: "POST",
      path: "/test/raw-required-header",
      auth: Auth.public(),
      request: {
        headers: Schema.Struct({ "x-signature": Schema.String }),
        body: Schema.String,
        bodyEncoding: "raw-text",
      },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    let failure: unknown;
    const app = new Hono();
    app.post("/test/raw-required-header", async (context) => {
      try {
        await decodeInput(callback, context as never, null);
      } catch (error) {
        failure = error;
      }
      return new Response("failed");
    });

    const response = await app.request("http://worker.test/test/raw-required-header", {
      method: "POST",
      body: "payload",
    });

    expect(response.status).toBe(200);
    expect(failure).toBeInstanceOf(BadRequest);
    expect(failure).toMatchObject({ details: { location: "headers" } });
  });

  it("rejects an oversized streamed body before schema decoding", async () => {
    const callback = endpoint({
      method: "POST",
      path: "/test/raw-bounded",
      auth: Auth.public(),
      request: { body: Schema.String, bodyEncoding: "raw-text" },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    let failure: unknown;
    const app = new Hono();
    app.post("/test/raw-bounded", async (context) => {
      try {
        await decodeInput(callback, context as never, null);
      } catch (error) {
        failure = error;
      }
      return new Response("failed");
    });

    const response = await app.request("http://worker.test/test/raw-bounded", {
      method: "POST",
      body: "x".repeat(1_048_577),
    });

    expect(response.status).toBe(200);
    expect(failure).toBeInstanceOf(BadRequest);
    expect(failure).toMatchObject({ details: { location: "body" } });
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

    const cookieResponse = await app.request("http://worker.test/feed/home/public", {
      headers: { cookie: "unrelated=viewer-state" },
    });
    expect(cookieResponse.status).toBe(200);
    expect(cookieResponse.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps public profile bodies viewer-invariant and disables bearer caching", async () => {
    const publicProfile = {
      profile: {
        id: "usr_public",
        object: "profile" as const,
        display_name: "Public Captain",
        avatar_ref: null,
        avatar_source: "none" as const,
        cover_ref: null,
        cover_source: "none" as const,
        bio: null,
        bio_source: "none" as const,
        preferred_locale: "en",
        global_handle: {
          id: "gh_public",
          object: "global_handle" as const,
          label: "captainpublic.pirate",
          status: "active" as const,
        },
        created: 1_700_000_000,
      },
      requested_handle_label: "captainpublic.pirate",
      resolved_handle_label: "captainpublic.pirate",
      is_canonical: true,
      created_communities: [],
    };
    const app = createHttpWorker({
      handlers: { GetPublicProfileByHandle: () => publicProfile },
    });
    const anonymous = await app.request("http://worker.test/public-profiles/captainpublic");
    const bearer = await app.request("http://worker.test/public-profiles/@CAPTAINPUBLIC.pirate", {
      headers: { authorization: "Bearer ignored" },
    });
    expect(anonymous.status).toBe(200);
    expect(bearer.status).toBe(200);
    expect(await anonymous.json()).toEqual(await bearer.json());
    expect(anonymous.headers.get("cache-control")).toBe("public, max-age=3600, must-revalidate");
    expect(bearer.headers.get("cache-control")).toBe("no-store");
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
        subject: credentials.authorization ?? credentials.sessionCookie ?? "",
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
    for (const [path, method] of [
      ["/posts/post_1", "GET"],
      ["/communities/community_1/posts", "POST"],
      ["/comments/comment_1/replies", "POST"],
      ["/posts/post_1/vote", "POST"],
      ["/posts/post_1/clear_vote", "POST"],
    ] as const) {
      const response = await createHttpWorker().request(`http://worker.test${path}`, { method });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "not_found" });
    }
  });

  it("validates installed content mutation responses through the normal route schemas", async () => {
    const app = createHttpWorker({
      handlers: {
        CreatePost: () => withEndpointResult(post, 201),
        CreateCommentReply: () => withEndpointResult(comment, 201),
        CastPostVote: () => vote,
        ClearPostVote: () => clearedVote,
      },
      authenticate: () => ({ kind: "user", subject: "user_1" }),
      authorize: () => undefined,
    });
    const auth = { authorization: "Bearer test", "content-type": "application/json" };
    const postResponse = await app.request("http://worker.test/communities/community_1/posts", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ post_type: "text", idempotency_key: "post-key", body: "hello" }),
    });
    const replyResponse = await app.request("http://worker.test/comments/comment_1/replies", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ body: "reply", idempotency_key: "reply-key" }),
    });
    const voteResponse = await app.request("http://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ value: 1 }),
    });
    const clearResponse = await app.request("http://worker.test/posts/post_1/clear_vote", {
      method: "POST",
      headers: auth,
    });

    expect(postResponse.status).toBe(201);
    expect(await postResponse.json()).toEqual(post);
    expect(replyResponse.status).toBe(201);
    expect(await replyResponse.json()).toEqual(comment);
    expect(voteResponse.status).toBe(200);
    expect(await voteResponse.json()).toEqual(vote);
    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toEqual(clearedVote);
  });

  it("passes a declared idempotency conflict through the normal redacted error envelope", async () => {
    const app = createHttpWorker({
      handlers: {
        CreatePost: () => {
          throw new Conflict({ message: "Idempotency key was already used" });
        },
      },
      authenticate: () => ({ kind: "user", subject: "user_1" }),
      authorize: () => undefined,
    });
    const response = await app.request("http://worker.test/communities/community_1/posts", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ post_type: "text", idempotency_key: "same-key", body: "hello" }),
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "conflict" });
    expect(JSON.stringify(body)).not.toContain("same-key");
  });

  it("distinguishes retryable verification starts from terminal 409 conflicts on the wire", async () => {
    const inProgressResponse = await createHttpWorker({
      handlers: {
        StartVerificationSession: () => {
          throw new VerificationStartInProgress({
            message: "start is already in progress",
            retry_after_seconds: 4,
          });
        },
      },
      authenticate: () => ({ kind: "user", subject: "user_1" }),
      authorize: () => undefined,
    }).request("http://worker.test/verification/sessions", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ intent_id: "intent-1", provider_id: "provider-1" }),
    });
    expect(inProgressResponse.status).toBe(409);
    expect(inProgressResponse.headers.get("retry-after")).toBe("4");
    expect(await inProgressResponse.json()).toMatchObject({
      code: "verification_start_in_progress",
      retryable: true,
    });

    const conflictResponse = await createHttpWorker({
      handlers: {
        StartVerificationSession: () => {
          throw new Conflict({ message: "verification request drifted" });
        },
      },
      authenticate: () => ({ kind: "user", subject: "user_1" }),
      authorize: () => undefined,
    }).request("http://worker.test/verification/sessions", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ intent_id: "intent-1", provider_id: "provider-1" }),
    });
    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.headers.get("retry-after")).toBeNull();
    expect(await conflictResponse.json()).toMatchObject({
      code: "conflict",
      retryable: false,
    });
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
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
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
