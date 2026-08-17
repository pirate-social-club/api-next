import { describe, expect, test } from "bun:test";

import {
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
      JSON.stringify({ code: "not_found", message: "missing", request_id: "req-1" }),
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

    response = new Response(JSON.stringify({ code: "rate_limited", message: "slow down" }), {
      status: 429,
    });
    await expect(client.get_health(undefined)).rejects.toBeInstanceOf(ApiClientUnexpectedError);
  });

  test("exposes the generated verification start retry metadata", async () => {
    const fetchImpl = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            code: "verification_start_in_progress",
            message: "busy",
            retryable: true,
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
      JSON.stringify({ code: "bad_request", message: "invalid handle", request_id: "req-2" }),
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
