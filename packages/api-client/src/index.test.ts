import { describe, expect, test } from "bun:test";

import {
  ApiClientProtocolError,
  ApiClientResponseValidationError,
  ApiClientUnexpectedError,
  createPirateApiClient,
} from "./index.ts";

describe("generated api client", () => {
  test("validates successful responses instead of returning unchecked JSON", async () => {
    let response = new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    const fetchImpl = Object.assign(async () => response, { preconnect: fetch.preconnect });
    const client = createPirateApiClient("https://api.example", fetchImpl);

    await expect(client.get_health(undefined)).resolves.toEqual({ status: "ok" });

    response = new Response(JSON.stringify({ status: "not-ok" }), { status: 200 });
    await expect(client.get_health(undefined)).rejects.toBeInstanceOf(
      ApiClientResponseValidationError,
    );
  });

  test("preserves declared errors and distinguishes undeclared wire errors", async () => {
    let response = new Response(
      JSON.stringify({
        error: { code: "not_found", message: "missing", retryable: false },
        request_id: "req-1",
      }),
      { status: 404 },
    );
    const fetchImpl = Object.assign(async () => response, { preconnect: fetch.preconnect });
    const client = createPirateApiClient("https://api.example", fetchImpl);

    await expect(client.get_postsPostId({ path: { postId: "post-1" } })).rejects.toMatchObject({
      _tag: "ApiClientError",
      code: "not_found",
      status: 404,
      declaredName: "NotFound",
      requestId: "req-1",
    });

    response = new Response(
      JSON.stringify({ error: { code: "rate_limited", message: "slow down", retryable: true } }),
      {
        status: 429,
      },
    );
    await expect(client.get_health(undefined)).rejects.toBeInstanceOf(ApiClientUnexpectedError);

    response = new Response(
      JSON.stringify({
        error: { code: "conflict", message: "retry", retryable: true },
      }),
      { status: 409 },
    );
    await expect(
      client.post_moneyCommunityPurchaseFundingOperationRefObservations({
        path: { operationRef: "operation-1" },
        body: { transaction_hash: "hash-1" },
      }),
    ).rejects.toMatchObject({ declaredName: "RetryableConflict", retryable: true });
  });

  test("exposes the generated verification start retry metadata", async () => {
    const fetchImpl = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "verification_start_in_progress", message: "busy", retryable: true },
          }),
          { status: 409, headers: { "Retry-After": "5" } },
        ),
      { preconnect: fetch.preconnect },
    );
    const client = createPirateApiClient("https://api.example", fetchImpl);
    await expect(
      client.post_verificationSessions({ body: { intent_id: "intent-1", provider_id: "test" } }),
    ).rejects.toMatchObject({
      code: "verification_start_in_progress",
      declaredName: "VerificationStartInProgress",
      retryAfterSeconds: 5,
    });
  });

  test("round-trips text CreatePost and current-state submission responses", async () => {
    const submission = {
      submission_id: "sub_1",
      href: "/text-content-submissions/sub_1",
      surface: "text_post",
      status: "published",
      result: { decision: "allow", reason_code: null },
      published_resource: { kind: "post", post_id: "post_1", href: "/posts/post_1" },
      review_ref: null,
      created_at: "2026-08-21T12:00:00.000Z",
      updated_at: "2026-08-21T12:00:00.000Z",
    } as const;
    const responses = [201, 200].map(
      (status) => () => new Response(JSON.stringify(submission), { status }),
    );
    const fetchImpl = Object.assign(
      async () => {
        const next = responses.shift();
        if (next === undefined) throw new Error("unexpected request");
        return next();
      },
      { preconnect: fetch.preconnect },
    );
    const client = createPirateApiClient("https://api.example", fetchImpl);

    await expect(
      client.post_communitiesCommunityIdPosts({
        path: { communityId: "community_1" },
        body: { post_type: "text", idempotency_key: "key_1", body: "hello" },
      }),
    ).resolves.toEqual(submission);
    await expect(
      client.get_textContentSubmissionsSubmissionId({ path: { submissionId: "sub_1" } }),
    ).resolves.toEqual(submission);
  });

  test("preserves typed idempotency conflict details and request ids", async () => {
    const fetchImpl = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "conflict",
              message: "The idempotency key belongs to another submission",
              retryable: false,
              details: { reason_code: "idempotency_conflict", submission_id: "sub_1" },
            },
            request_id: "req_1",
          }),
          { status: 409 },
        ),
      { preconnect: fetch.preconnect },
    );
    const client = createPirateApiClient("https://api.example", fetchImpl);

    await expect(
      client.post_communitiesCommunityIdPosts({
        path: { communityId: "community_1" },
        body: { post_type: "text", idempotency_key: "key_1", body: "hello" },
      }),
    ).rejects.toMatchObject({
      declaredName: "IdempotencyConflict",
      code: "conflict",
      retryable: false,
      requestId: "req_1",
      details: { reason_code: "idempotency_conflict", submission_id: "sub_1" },
    });
  });

  test("rejects an idempotency conflict envelope with malformed declared details", async () => {
    const fetchImpl = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "conflict",
              message: "The idempotency key belongs to another submission",
              retryable: false,
              details: { reason_code: "idempotency_conflict" },
            },
          }),
          { status: 409 },
        ),
      { preconnect: fetch.preconnect },
    );
    const client = createPirateApiClient("https://api.example", fetchImpl);

    await expect(
      client.post_communitiesCommunityIdPosts({
        path: { communityId: "community_1" },
        body: { post_type: "text", idempotency_key: "key_1", body: "hello" },
      }),
    ).rejects.toBeInstanceOf(ApiClientProtocolError);
  });

  test("forwards default and per-call authentication headers and cancellation", async () => {
    const calls: Array<{ headers: Headers; signal: AbortSignal | null | undefined }> = [];
    const fetchImpl = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        calls.push({ headers: new Headers(init?.headers), signal: init?.signal });
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      },
      { preconnect: fetch.preconnect },
    );
    const defaultController = new AbortController();
    const requestController = new AbortController();
    const client = createPirateApiClient("https://api.example", {
      fetchImpl,
      headers: { authorization: "Bearer default" },
      signal: defaultController.signal,
    });

    await client.get_health(undefined, {
      headers: { "x-request": "request-value", authorization: "Bearer request" },
      signal: requestController.signal,
    });

    expect(calls[0]?.headers.get("authorization")).toBe("Bearer request");
    expect(calls[0]?.headers.get("x-request")).toBe("request-value");
    expect(calls[0]?.signal).toBe(requestController.signal);
  });

  test("serializes namespace start input as the ratified exact JSON body", async () => {
    let request: { readonly url: string; readonly init: RequestInit | undefined } | undefined;
    const fetchImpl = Object.assign(
      async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        request = { url: String(input), init };
        return new Response(
          JSON.stringify({
            creation_intent_id: "intent-1",
            ceremony_intent_id: "ceremony-1",
            generation: 1,
            session_id: "session-1",
            channel: "poll_result",
            status: "pending",
            expires_at: "2026-08-21T00:00:00.000Z",
            challenge: {
              ownership_source: "hns_parent_chain_txt",
              challenge_name: "jazleeuw",
              challenge_value: "pirate-verification=upstream-1",
              expires_at: "2026-08-21T00:00:00.000Z",
            },
            replayed: false,
          }),
          { status: 201 },
        );
      },
      { preconnect: fetch.preconnect },
    );
    const client = createPirateApiClient("https://api.example", fetchImpl);

    await client.post_communityCreationIntentsIntentIdNamespaceOwnershipStart({
      path: { intentId: "intent-1" },
      body: {
        idempotency_key: "start-1",
        ceremony_intent_id: "ceremony-1",
        expected_revision: 1,
      },
    });

    expect(request?.url).toBe(
      "https://api.example/community-creation-intents/intent-1/namespace-ownership/start",
    );
    expect(new Headers(request?.init?.headers).get("content-type")).toBe("application/json");
    expect(request?.init?.body).toBe(
      '{"ceremony_intent_id":"ceremony-1","expected_revision":1,"idempotency_key":"start-1"}',
    );

    const invalidInput = {
      path: { intentId: "intent-1" },
      body: {
        ceremony_intent_id: "ceremony-1",
        expected_revision: 1,
        idempotency_key: "start-1",
        extra: true,
      },
    } as Parameters<typeof client.post_communityCreationIntentsIntentIdNamespaceOwnershipStart>[0];
    await expect(
      client.post_communityCreationIntentsIntentIdNamespaceOwnershipStart(invalidInput),
    ).rejects.toBeInstanceOf(ApiClientProtocolError);
  });

  test("treats declared 422 and 503 poll outcomes as successful typed responses", async () => {
    let status = 422;
    const fetchImpl = Object.assign(
      async () =>
        new Response(
          JSON.stringify(
            status === 422
              ? {
                  ceremony_intent_id: "ceremony-1",
                  session_id: "session-1",
                  revision: 1,
                  status: "rejected",
                  replayed: false,
                  result_hash: "a".repeat(64),
                  retry_after_seconds: null,
                }
              : {
                  ceremony_intent_id: "ceremony-1",
                  session_id: "session-1",
                  revision: 1,
                  status: "unavailable",
                  replayed: false,
                  result_hash: null,
                  retry_after_seconds: 5,
                },
          ),
          { status },
        ),
      { preconnect: fetch.preconnect },
    );
    const client = createPirateApiClient("https://api.example", fetchImpl);
    const input = {
      path: { intentId: "intent-1" },
      body: {
        ceremony_intent_id: "ceremony-1",
        session_id: "session-1",
        expected_revision: 1,
        idempotency_key: "poll-1",
        channel: "poll_result" as const,
      },
    };
    await expect(
      client.post_communityCreationIntentsIntentIdNamespaceOwnershipPoll(input),
    ).resolves.toMatchObject({ status: "rejected" });
    status = 503;
    await expect(
      client.post_communityCreationIntentsIntentIdNamespaceOwnershipPoll(input),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  test("validates the public-profile response and preserves its declared errors", async () => {
    let response = new Response(
      JSON.stringify({
        profile: {
          id: "usr_public",
          object: "profile",
          display_name: "Public Captain",
          avatar_ref: null,
          avatar_source: "none",
          cover_ref: null,
          cover_source: "none",
          bio: null,
          bio_source: "none",
          preferred_locale: "en",
          global_handle: {
            id: "gh_public",
            object: "global_handle",
            label: "captainpublic.pirate",
            status: "active",
          },
          created: 1_700_000_000,
        },
        requested_handle_label: "captainpublic.pirate",
        resolved_handle_label: "captainpublic.pirate",
        is_canonical: true,
        created_communities: [],
      }),
      { status: 200 },
    );
    const fetchImpl = Object.assign(async () => response, { preconnect: fetch.preconnect });
    const client = createPirateApiClient("https://api.example", fetchImpl);

    await expect(
      client.get_publicProfilesHandle({ path: { handle: "captainpublic" } }),
    ).resolves.toMatchObject({ requested_handle_label: "captainpublic.pirate" });

    response = new Response(
      JSON.stringify({
        error: { code: "bad_request", message: "invalid handle", retryable: false },
        request_id: "req-2",
      }),
      { status: 400 },
    );
    await expect(
      client.get_publicProfilesHandle({ path: { handle: "captain.eth" } }),
    ).rejects.toMatchObject({
      _tag: "ApiClientError",
      code: "bad_request",
      status: 400,
      declaredName: "BadRequest",
      requestId: "req-2",
    });
  });
});
