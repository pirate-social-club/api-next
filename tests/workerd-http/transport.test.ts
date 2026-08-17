/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("real HTTP worker transport", () => {
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
      code: "auth_error",
      request_id: "workerd-request",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://solid.test");
  });

  it("exchanges a seeded identity and uses its minted token for profile", async () => {
    const exchange = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: { type: "jwt_based_auth", jwt: "workerd-proof" } }),
    });

    expect(exchange.status).toBe(200);
    const exchanged = (await exchange.json()) as {
      readonly access_token: string;
      readonly user: { readonly id: string };
      readonly profile: { readonly id: string };
    };
    expect(exchanged).toMatchObject({
      user: { id: "usr_workerd_test" },
      profile: { id: "usr_workerd_test" },
    });

    const profile = await SELF.fetch("https://worker.test/profiles/me", {
      headers: { authorization: `Bearer ${exchanged.access_token}` },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: { type: "jwt_based_auth", jwt: "workerd-proof" } }),
    });
    const { access_token: accessToken } = (await exchange.json()) as {
      readonly access_token: string;
    };

    const clear = await SELF.fetch("https://worker.test/posts/post_1/clear_vote", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ post: "post_1", value: null });
    expect(clear.headers.get("cache-control")).toBe("no-store");

    const uninstalled = await SELF.fetch("https://worker.test/communities/community_1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ post_type: "text", idempotency_key: "workerd-key", body: "hello" }),
    });
    expect(uninstalled.status).toBe(404);
    expect(await uninstalled.json()).toMatchObject({ code: "not_found" });
  });

  it("keeps an advertised but uninstalled route at its documented 404", async () => {
    const response = await SELF.fetch("https://worker.test/users/me");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
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
