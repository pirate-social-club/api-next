import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudflareApi,
  managedToken,
  readStoredLogin,
  runProviderClient,
} from "./cloudflare-api.mjs";

const minute = 60_000;
const login = (token: string, expiresAt: number) => ({ token, expiresAt });
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => answer(200, { success: true, result });
const refusal = (status: number, code: number) =>
  answer(status, { success: false, errors: [{ code }] });
const noSleep = async () => undefined;

test("an unexpired login is used without running the provider client", async () => {
  let renewals = 0;
  for (const remaining of [30 * minute, 5 * minute, 30_000]) {
    const token = await managedToken({
      now: () => 0,
      environment: {},
      read: () => login("current", remaining),
      renew: async () => {
        renewals += 1;
      },
      sleep: noSleep,
    });
    expect(token).toBe("current");
  }
  // The provider client renews nothing before expiry, so it is never asked to.
  expect(renewals).toBe(0);
});

test("a login at its expiry is waited out, renewed and checked", async () => {
  let clock = 0;
  let stored = login("old", 10_000);
  const waits: number[] = [];
  const token = await managedToken({
    now: () => clock,
    environment: {},
    read: () => stored,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    // Like the provider client: it renews only once the stored expiry has passed.
    renew: async () => {
      if (clock > stored.expiresAt) stored = login("renewed", clock + 60 * minute);
    },
  });
  expect(token).toBe("renewed");
  expect(waits).toEqual([11_000]);
});

test("a renewal that leaves the same or a short-lived login is refused", async () => {
  for (const after of [login("old", -1), login("new", 2 * minute)]) {
    let stored = login("old", -1);
    await expect(
      managedToken({
        now: () => 0,
        environment: {},
        read: () => stored,
        sleep: noSleep,
        renew: async () => {
          stored = after;
        },
      }),
    ).rejects.toThrow("was not renewed");
  }
});

test("concurrent callers share one renewal", async () => {
  let stored = login("old", -1);
  let renewals = 0;
  const options = {
    now: () => 0,
    environment: {},
    read: () => stored,
    sleep: noSleep,
    renew: async () => {
      renewals += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      stored = login("renewed", 60 * minute);
    },
  };
  expect(await Promise.all([managedToken(options), managedToken(options)])).toEqual([
    "renewed",
    "renewed",
  ]);
  expect(renewals).toBe(1);
});

test("an unexpired login that the provider refused cannot be renewed and says so", async () => {
  let renewals = 0;
  await expect(
    managedToken({
      refused: "current",
      now: () => 0,
      environment: {},
      read: () => login("current", 30 * minute),
      sleep: noSleep,
      renew: async () => {
        renewals += 1;
      },
    }),
  ).rejects.toThrow("refused before its stored expiry and cannot be renewed");
  expect(renewals).toBe(0);
});

test("a refused login is replaced when the store already holds a different one", async () => {
  expect(
    await managedToken({
      refused: "old",
      now: () => 0,
      environment: {},
      read: () => login("stored-by-another-process", 30 * minute),
      sleep: noSleep,
      renew: async () => {
        throw new Error("no renewal is needed");
      },
    }),
  ).toBe("stored-by-another-process");
});

test("an explicit token is used as given, never renewed, and reported when refused", async () => {
  const options = {
    environment: { CLOUDFLARE_API_TOKEN: "explicit" },
    read: () => {
      throw new Error("the stored login must not be read");
    },
    renew: async () => {
      throw new Error("an explicit token is never renewed");
    },
  };
  expect(await managedToken(options)).toBe("explicit");
  await expect(managedToken({ ...options, refused: "explicit" })).rejects.toThrow(
    "explicit token was refused",
  );
});

test("the provider client runs as an awaited child and timers keep firing meanwhile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rewards-provider-client-"));
  try {
    const client = join(directory, "client");
    writeFileSync(client, "#!/bin/sh\nsleep 0.3\nexit 0\n");
    chmodSync(client, 0o755);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    const status = await runProviderClient({ wrangler: client });
    clearInterval(timer);
    expect(status).toBe(0);
    // A blocking child would have allowed none of these.
    expect(ticks).toBeGreaterThan(5);
    expect(await runProviderClient({ wrangler: join(directory, "absent") })).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The installed provider client against synthetic credentials. It reaches the
// provider, so it runs only when asked: REWARDS_E2E_REAL_PROVIDER_CLIENT=1.
const realClient = process.env.REWARDS_E2E_REAL_PROVIDER_CLIENT === "1" ? test : test.skip;
realClient(
  "the installed provider client leaves an unexpired stored login untouched",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "rewards-provider-home-"));
    try {
      const config = join(home, ".wrangler", "config");
      mkdirSync(config, { recursive: true });
      const path = join(config, "default.toml");
      const expiry = new Date(Date.now() + 5 * minute).toISOString();
      writeFileSync(
        path,
        `oauth_token = "synthetic-access"\nexpiration_time = "${expiry}"\nrefresh_token = "synthetic-refresh"\nscopes = [ "account:read" ]\n`,
      );
      const before = readFileSync(path, "utf8");
      await runProviderClient({
        environment: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, CI: "1" },
      });
      // Five minutes from expiry and still not renewed: early renewal cannot be requested.
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readStoredLogin(path)).toEqual({
        token: "synthetic-access",
        expiresAt: Date.parse(expiry),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  90_000,
);
realClient(
  "the installed provider client attempts renewal once the stored expiry has passed",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "rewards-provider-home-"));
    try {
      const config = join(home, ".wrangler", "config");
      mkdirSync(config, { recursive: true });
      const path = join(config, "default.toml");
      const expiry = new Date(Date.now() - minute).toISOString();
      writeFileSync(
        path,
        `oauth_token = "synthetic-access"\nexpiration_time = "${expiry}"\nrefresh_token = "synthetic-refresh"\nscopes = [ "account:read" ]\n`,
      );
      // The synthetic refresh token is refused by the provider, so nothing usable
      // is stored and the postcondition check, not the exit status, reports it.
      await expect(
        managedToken({
          environment: {},
          read: () => readStoredLogin(path),
          renew: () =>
            runProviderClient({
              environment: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, CI: "1" },
            }),
        }),
      ).rejects.toThrow(/was not renewed|authentication is unavailable/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  90_000,
);

test("a login refused mid-run is replaced once and the request repeated", async () => {
  const asked: Array<string | undefined> = [];
  const authorizations: string[] = [];
  const responses = [refusal(401, 10000), ok({ id: "version" })];
  const result = await cloudflareApi(
    "/workers/scripts/example",
    { method: "PATCH", body: "{}" },
    {
      sleep: noSleep,
      token: async ({ refused }: { refused?: string }) => {
        asked.push(refused);
        return refused === undefined ? "expired" : "renewed";
      },
      fetcher: async (_url: string, init: RequestInit) => {
        authorizations.push(new Headers(init.headers).get("authorization") ?? "");
        return responses.shift() as Response;
      },
    },
  );
  expect(result).toEqual({ id: "version" });
  expect(asked).toEqual([undefined, "expired"]);
  expect(authorizations).toEqual(["Bearer expired", "Bearer renewed"]);
});

test("a refusal, then a provider fault, then success asks for a new login only once", async () => {
  const asked: Array<string | undefined> = [];
  const responses = [refusal(401, 10000), refusal(503, 7003), ok({ ok: true })];
  const result = await cloudflareApi(
    "/workers/scripts/example/deployments",
    {},
    {
      sleep: noSleep,
      token: async ({ refused }: { refused?: string }) => {
        asked.push(refused);
        return refused === undefined && asked.length === 1 ? "first" : "second";
      },
      fetcher: async () => responses.shift() as Response,
    },
  );
  expect(result).toEqual({ ok: true });
  // The refused token is named once, on the attempt right after the refusal.
  expect(asked).toEqual([undefined, "first", undefined]);
});

test("an unexpired login refused by the provider ends the request with that reason", async () => {
  let calls = 0;
  await expect(
    cloudflareApi(
      "/workers/scripts/example",
      {},
      {
        sleep: noSleep,
        token: (options: { refused?: string }) =>
          managedToken({
            ...options,
            now: () => 0,
            environment: {},
            read: () => login("current", 30 * minute),
            sleep: noSleep,
            renew: async () => undefined,
          }),
        fetcher: async () => {
          calls += 1;
          return refusal(401, 10000);
        },
      },
    ),
  ).rejects.toThrow("refused before its stored expiry and cannot be renewed");
  expect(calls).toBe(1);
});

test("a second refusal after a new login is reported, not retried again", async () => {
  let calls = 0;
  await expect(
    cloudflareApi(
      "/workers/scripts/example",
      {},
      {
        sleep: noSleep,
        token: async () => `token-${calls}`,
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
