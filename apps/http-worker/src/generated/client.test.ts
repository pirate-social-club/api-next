import { describe, expect, test } from "bun:test";

import {
  ApiClientError,
  ApiClientResponseValidationError,
  ApiClientUnexpectedError,
  createPirateApiClient,
} from "./client";

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
});
