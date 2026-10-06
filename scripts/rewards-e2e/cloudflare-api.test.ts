import { expect, test } from "bun:test";
import { cloudflareApi, managedToken } from "./cloudflare-api.mjs";

const minute = 60_000;
const login = (token: string, expiresAt: number) => ({ token, expiresAt });
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => answer(200, { success: true, result });
const refusal = (status: number, code: number) =>
  answer(status, { success: false, errors: [{ code }] });
const noSleep = async () => undefined;

test("a login with plenty of time left is used without a refresh", async () => {
  let refreshes = 0;
  const token = await managedToken({
    now: () => 0,
    environment: {},
    read: () => login("current", 30 * minute),
    refresh: () => {
      refreshes += 1;
    },
  });
  expect(token).toBe("current");
  expect(refreshes).toBe(0);
});

test("a login about to expire is renewed before it is used", async () => {
  let stored = login("old", 5 * minute);
  const token = await managedToken({
    now: () => 0,
    environment: {},
    read: () => stored,
    refresh: () => {
      stored = login("renewed", 60 * minute);
    },
  });
  expect(token).toBe("renewed");
});

test("a refresh that leaves an expired login is refused, never used", async () => {
  await expect(
    managedToken({
      now: () => 10 * minute,
      environment: {},
      read: () => login("stale", 5 * minute),
      refresh: () => undefined,
    }),
  ).rejects.toThrow("managed authentication is unavailable");
});

test("an explicit token is used as given and never refreshed", async () => {
  let refreshes = 0;
  const token = await managedToken({
    environment: { CLOUDFLARE_API_TOKEN: "explicit" },
    read: () => {
      throw new Error("the stored login must not be read");
    },
    refresh: () => {
      refreshes += 1;
    },
  });
  expect(token).toBe("explicit");
  expect(refreshes).toBe(0);
});

test("a login refused mid-run is renewed once and the request repeated", async () => {
  const seen: Array<{ force: boolean }> = [];
  const authorizations: string[] = [];
  const responses = [refusal(401, 10000), ok({ id: "version" })];
  const result = await cloudflareApi(
    "/workers/scripts/example",
    { method: "PATCH", body: "{}" },
    {
      sleep: noSleep,
      token: async ({ force }: { force: boolean }) => {
        seen.push({ force });
        return force ? "renewed" : "expired";
      },
      fetcher: async (_url: string, init: RequestInit) => {
        authorizations.push(new Headers(init.headers).get("authorization") ?? "");
        return responses.shift() as Response;
      },
    },
  );
  expect(result).toEqual({ id: "version" });
  expect(seen).toEqual([{ force: false }, { force: true }]);
  expect(authorizations).toEqual(["Bearer expired", "Bearer renewed"]);
});

test("a second refusal after renewal is reported, not retried again", async () => {
  let calls = 0;
  await expect(
    cloudflareApi(
      "/workers/scripts/example",
      {},
      {
        sleep: noSleep,
        token: async () => "token",
        fetcher: async () => {
          calls += 1;
          return refusal(401, 10000);
        },
      },
    ),
  ).rejects.toThrow("HTTP 401, codes 10000");
  expect(calls).toBe(2);
});

test("a read is repeated through a provider fault and an unanswered request", async () => {
  let calls = 0;
  const result = await cloudflareApi(
    "/workers/scripts/example/deployments",
    {},
    {
      sleep: noSleep,
      token: async () => "token",
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return refusal(503, 7003);
        if (calls === 2) throw new Error("socket closed");
        return ok({ deployments: [] });
      },
    },
  );
  expect(result).toEqual({ deployments: [] });
  expect(calls).toBe(3);
});

test("a read that keeps failing stops after its bounded attempts", async () => {
  let calls = 0;
  await expect(
    cloudflareApi(
      "/workers/scripts/example/deployments",
      {},
      {
        sleep: noSleep,
        token: async () => "token",
        fetcher: async () => {
          calls += 1;
          return refusal(503, 7003);
        },
      },
    ),
  ).rejects.toThrow("HTTP 503");
  expect(calls).toBe(4);
});

test("a write whose answer is lost or faulted is never sent again", async () => {
  for (const fault of ["unanswered", "server"] as const) {
    let calls = 0;
    await expect(
      cloudflareApi(
        "/workers/scripts/example/settings",
        { method: "PATCH", body: "{}" },
        {
          sleep: noSleep,
          token: async () => "token",
          fetcher: async () => {
            calls += 1;
            if (fault === "unanswered") throw new Error("socket closed");
            return refusal(500, 10013);
          },
        },
      ),
    ).rejects.toThrow(fault === "unanswered" ? "unanswered" : "HTTP 500");
    expect(calls).toBe(1);
  }
});

test("a client refusal on a read is reported at once", async () => {
  let calls = 0;
  await expect(
    cloudflareApi(
      "/workers/scripts/missing",
      {},
      {
        sleep: noSleep,
        token: async () => "token",
        fetcher: async () => {
          calls += 1;
          return refusal(404, 10007);
        },
      },
    ),
  ).rejects.toThrow("HTTP 404, codes 10007");
  expect(calls).toBe(1);
});
