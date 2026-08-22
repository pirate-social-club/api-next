/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("real HTTP worker transport", () => {
  const browserCookies = (
    response: Response,
  ): { readonly cookie: string; readonly csrf: string } => {
    const setCookie = response.headers.get("set-cookie") ?? "";
    const parts = setCookie
      .split(/, (?=__Host-pirate_)/u)
      .map((value) => value.split(";", 1)[0] ?? "");
    const cookie = parts.join("; ");
    const csrf = parts.find((value) => value.startsWith("__Host-pirate_csrf="))?.split("=", 2)[1];
    if (csrf === undefined) throw new Error("session exchange did not set CSRF cookie");
    return { cookie, csrf };
  };

  it("enforces auth and emits configured transport headers through workerd", async () => {
    const response = await SELF.fetch("https://worker.test/posts/post_1/vote", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://solid.test",
        "x-request-id": "workerd-request",
      },
      body: "not-json",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "auth_error" },
      request_id: "workerd-request",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://solid.test");
  });

  it("exchanges a seeded identity and serves current-user and profile projections", async () => {
    const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "workerd-proof" },
      }),
    });

    expect(exchange.status).toBe(200);
    const exchanged = (await exchange.json()) as {
      readonly user: { readonly id: string };
      readonly profile: { readonly id: string };
    };
    expect(exchanged).toMatchObject({
      user: { id: "usr_workerd_test" },
      profile: { id: "usr_workerd_test" },
    });
    const browser = browserCookies(exchange);

    const currentUser = await SELF.fetch("https://worker.test/users/me", {
      headers: { cookie: browser.cookie },
    });
    expect(currentUser.status).toBe(200);
    expect(await currentUser.json()).toMatchObject({
      id: "usr_workerd_test",
      object: "user",
      primary_wallet_attachment: "wallet_workerd",
    });

    const profile = await SELF.fetch("https://worker.test/profiles/me", {
      headers: { cookie: browser.cookie },
    });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      id: "usr_workerd_test",
      object: "profile",
      primary_wallet_address: "0xworkerd",
    });
  });

  it("serves an installed content mutation and protects author-scoped reads", async () => {
    const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "workerd-proof" },
      }),
    });
    const browser = browserCookies(exchange);

    const clear = await SELF.fetch("https://worker.test/posts/post_1/clear_vote", {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: "https://solid.test",
        "x-csrf-token": browser.csrf,
      },
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ post: "post_1", value: null });
    expect(clear.headers.get("cache-control")).toBe("no-store");

    const unauthenticated = await SELF.fetch(
      "https://worker.test/text-content-submissions/submission_1",
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "auth_error" } });
  });

  it("rejects removed publish_mode at the Workerd HTTP boundary", async () => {
    const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "workerd-proof" },
      }),
    });
    const browser = browserCookies(exchange);
    const response = await SELF.fetch("https://worker.test/communities/community_1/posts", {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        "content-type": "application/json",
        origin: "https://solid.test",
        "x-csrf-token": browser.csrf,
      },
      body: JSON.stringify({
        post_type: "text",
        idempotency_key: "workerd-publish-mode",
        body: "hello",
        publish_mode: "async",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("serves text POST creation and author-scoped GET responses", async () => {
    const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "workerd-proof" },
      }),
    });
    const browser = browserCookies(exchange);
    const headers = {
      cookie: browser.cookie,
      "content-type": "application/json",
      origin: "https://solid.test",
      "x-csrf-token": browser.csrf,
    };
    const created = await SELF.fetch("https://worker.test/communities/community_1/posts", {
      method: "POST",
      headers,
      body: JSON.stringify({ post_type: "text", idempotency_key: "workerd-text", body: "hello" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      submission_id: "submission_workerd",
      status: "manual_review",
      result: { decision: "manual_review", reason_code: "moderation_unavailable" },
    });

    const current = await SELF.fetch(
      "https://worker.test/text-content-submissions/submission_workerd",
      { headers: { cookie: browser.cookie, origin: "https://solid.test" } },
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      submission_id: "submission_workerd",
      status: "manual_review",
    });
  });

  it("drives report and moderation action routes through the real Workerd handler fixture", async () => {
    const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "workerd-proof" },
      }),
    });
    const browser = browserCookies(exchange);
    const headers = {
      cookie: browser.cookie,
      "content-type": "application/json",
      origin: "https://solid.test",
      "x-csrf-token": browser.csrf,
    };

    const report = await SELF.fetch("https://worker.test/comments/comment_workerd/reports", {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotency_key: "workerd-report", reason_code: "spam" }),
    });
    expect(report.status).toBe(201);
    expect(await report.json()).toEqual({
      report_id: "report_workerd",
      case_ref: "case_workerd",
      status: "open",
    });

    const action = await SELF.fetch("https://worker.test/moderation/cases/case_workerd/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotency_key: "workerd-action", action: "hide" }),
    });
    expect(action.status).toBe(200);
    expect(await action.json()).toEqual({
      action_id: "action_workerd",
      case_ref: "case_workerd",
      action: "hide",
      target_status: "hidden",
    });
  });

  it("keeps namespace providers disabled while preserving exact durable replays", async () => {
    const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://solid.test" },
      body: JSON.stringify({
        proof: { type: "privy_access_token", privy_access_token: "workerd-proof" },
      }),
    });
    const browser = browserCookies(exchange);
    const headers = {
      cookie: browser.cookie,
      "content-type": "application/json",
      origin: "https://solid.test",
      "x-csrf-token": browser.csrf,
    };

    const disabledStart = await SELF.fetch(
      "https://worker.test/community-creation-intents/intent-workerd/namespace-ownership/start",
      {
        method: "POST",
        headers,
        body: '{"ceremony_intent_id":"ceremony-workerd","expected_revision":3,"idempotency_key":"fresh-1"}',
      },
    );
    expect(disabledStart.status).toBe(502);
    expect(await disabledStart.json()).toMatchObject({
      error: { code: "provider_unavailable", retryable: false },
    });

    const replayStart = await SELF.fetch(
      "https://worker.test/community-creation-intents/intent-workerd/namespace-ownership/start",
      {
        method: "POST",
        headers,
        body: '{"ceremony_intent_id":"ceremony-workerd","expected_revision":3,"idempotency_key":"replay-1"}',
      },
    );
    expect(replayStart.status).toBe(200);
    expect(await replayStart.json()).toMatchObject({
      creation_intent_id: "intent-workerd",
      ceremony_intent_id: "ceremony-workerd",
      session_id: "namespace-session-replay",
      status: "pending",
      challenge: {
        ownership_source: "hns_parent_chain_txt",
        challenge_name: "jazleeuw",
        challenge_value: "pirate-verification=upstream-workerd",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      replayed: true,
    });

    const disabledPoll = await SELF.fetch(
      "https://worker.test/community-creation-intents/intent-workerd/namespace-ownership/poll",
      {
        method: "POST",
        headers,
        body: '{"ceremony_intent_id":"ceremony-workerd","session_id":"namespace-session-fresh","expected_revision":3,"idempotency_key":"poll-fresh-1","channel":"poll_result"}',
      },
    );
    expect(disabledPoll.status).toBe(502);
    expect(await disabledPoll.json()).toMatchObject({
      error: { code: "provider_unavailable", retryable: false },
    });

    const replayPoll = await SELF.fetch(
      "https://worker.test/community-creation-intents/intent-workerd/namespace-ownership/poll",
      {
        method: "POST",
        headers,
        body: '{"ceremony_intent_id":"ceremony-workerd","session_id":"namespace-session-replay","expected_revision":3,"idempotency_key":"poll-replay-1","channel":"poll_result"}',
      },
    );
    expect(replayPoll.status).toBe(200);
    expect(await replayPoll.json()).toMatchObject({
      ceremony_intent_id: "ceremony-workerd",
      session_id: "namespace-session-replay",
      status: "verified",
      replayed: true,
      result_hash: "d".repeat(64),
    });
  });

  it("requires authentication on the installed current-user route", async () => {
    const response = await SELF.fetch("https://worker.test/users/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "auth_error" } });
  });

  it("serves only the public RS256 verification key", async () => {
    const response = await SELF.fetch("https://worker.test/.well-known/jwks.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly keys: readonly Record<string, unknown>[];
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ alg: "RS256", use: "sig", key_ops: ["verify"] });
    expect(body.keys[0]).not.toHaveProperty("d");
    expect(body.keys[0]).not.toHaveProperty("p");
    expect(body.keys[0]).not.toHaveProperty("q");
  });
});
