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

  it("installs the profile route through the generated table", async () => {
    const response = await SELF.fetch("https://worker.test/profiles/me", {
      headers: { authorization: "Bearer workerd-test" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "workerd-test-user",
      object: "profile",
    });
  });

  it("installs session exchange through the generated table", async () => {
    const response = await SELF.fetch("https://worker.test/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: { type: "jwt_based_auth", jwt: "workerd-proof" } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_token: "workerd-session-token",
      user: { id: "workerd-test-user" },
      profile: { id: "workerd-test-user" },
    });
  });

  it("keeps an advertised but uninstalled route at its documented 404", async () => {
    const response = await SELF.fetch("https://worker.test/users/me");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
});
