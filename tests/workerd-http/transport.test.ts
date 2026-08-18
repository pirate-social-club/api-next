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

  it("serves an installed content mutation and leaves an uninstalled write at 404", async () => {
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

    const uninstalled = await SELF.fetch("https://worker.test/communities/community_1/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_type: "text", idempotency_key: "workerd-key", body: "hello" }),
    });
    expect(uninstalled.status).toBe(404);
    expect(await uninstalled.json()).toMatchObject({ error: { code: "not_found" } });
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
