import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { makeTelegramOidcClient } from "./telegram-oidc.ts";
import type { TelegramOidcFetch } from "./telegram-oidc-http.ts";

const NOW = 1900000000;
const NONCE = "n".repeat(43);
const INPUT = { code: "fixture-code", nonce: NONCE, verifier: "v".repeat(43) };
const CONFIG = {
  clientId: "10000001",
  clientSecret: "fixture-client-secret",
  redirectUri: "https://web.test/telegram/link/callback",
};
const first = await generateKeyPair("RS256");
const second = await generateKeyPair("RS256");
const firstJwk = { ...(await exportJWK(first.publicKey)), kid: "first", alg: "RS256", use: "sig" };
const secondJwk = {
  ...(await exportJWK(second.publicKey)),
  kid: "second",
  alg: "RS256",
  use: "sig",
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://oauth.telegram.org",
    aud: CONFIG.clientId,
    sub: "opaque-subject-not-bot-api-id",
    id: 987654321,
    nonce: NONCE,
    iat: NOW,
    exp: NOW + 3600,
    name: "learner",
    preferred_username: "learner_fixture",
    picture: "https://untrusted-profile.test/image",
    ...overrides,
  };
}

async function signed(overrides: Record<string, unknown> = {}, rotated = false) {
  return new SignJWT(payload(overrides))
    .setProtectedHeader({ alg: "RS256", kid: rotated ? "second" : "first" })
    .sign(rotated ? second.privateKey : first.privateKey);
}

async function fixture(overrides: Record<string, unknown> = {}) {
  let token = await signed(overrides);
  let keys = [firstJwk];
  let now = NOW * 1000;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: TelegramOidcFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/token"))
      return Response.json({ id_token: token, access_token: "unused-fixture-access-token" });
    return Response.json({ keys });
  };
  return {
    client: makeTelegramOidcClient({ ...CONFIG, nowMs: () => now, fetcher }),
    calls,
    rotate(value: string) {
      token = value;
      keys = [secondJwk];
    },
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

async function failure(client: ReturnType<typeof makeTelegramOidcClient>, input = INPUT) {
  return Effect.runPromise(Effect.flip(client.exchange(input)));
}

describe("Pirate-controlled Telegram OIDC evidence", () => {
  test("creates independent server material and exact S256 authorization", async () => {
    const f = await fixture();
    const one = await Effect.runPromise(f.client.authorize());
    const two = await Effect.runPromise(f.client.authorize());
    expect(
      new Set([one.state, one.nonce, one.verifier, two.state, two.nonce, two.verifier]).size,
    ).toBe(6);
    const url = new URL(one.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("nonce")).toBe(one.nonce);
    expect(url.searchParams.get("state")).toBe(one.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(one.verifier)),
      ).toString("base64url"),
    );
    expect(one.authorizationUrl).not.toContain(one.verifier);
    expect(one.authorizationUrl).not.toContain(CONFIG.clientSecret);
    expect(f.calls).toHaveLength(0);
  });

  test("exchanges once, pins endpoints and retains numeric id only", async () => {
    const f = await fixture();
    expect(await Effect.runPromise(f.client.exchange(INPUT))).toEqual({
      telegramUserId: "987654321",
    });
    expect(f.calls.map((call) => call.url)).toEqual([
      "https://oauth.telegram.org/token",
      "https://oauth.telegram.org/.well-known/jwks.json",
    ]);
    const request = f.calls[0]?.init;
    expect(request?.redirect).toBe("error");
    expect(request?.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${CONFIG.clientId}:${CONFIG.clientSecret}`)}`,
    });
    const body = new URLSearchParams(String(request?.body));
    expect(body.get("code")).toBe(INPUT.code);
    expect(body.get("code_verifier")).toBe(INPUT.verifier);
    expect(body.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  test.each([
    { aud: "20000002" },
    { aud: [CONFIG.clientId, "20000002"] },
    { iss: "https://community-owner.test" },
    { sub: undefined },
    { nonce: "x".repeat(43) },
    { nonce: undefined },
    { id: undefined },
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: "987654321" },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { exp: NOW },
    { iat: NOW + 60 },
    { iat: NOW - 1000 },
  ])("rejects signed identity/claim confusion %j", async (overrides) => {
    const f = await fixture(overrides);
    expect((await failure(f.client)).reason).toBe("invalid_proof");
  });

  test("requires numeric profile id rather than accepting numeric sub", async () => {
    const f = await fixture({ id: undefined, sub: "987654321" });
    expect((await failure(f.client)).reason).toBe("invalid_proof");
  });

  test("rejects a bad signature and never uses token-supplied keys", async () => {
    const token = await new SignJWT(payload())
      .setProtectedHeader({ alg: "RS256", kid: "first", jku: "https://owner.test/jwks" })
      .sign(second.privateKey);
    const calls: string[] = [];
    const client = makeTelegramOidcClient({
      ...CONFIG,
      nowMs: () => NOW * 1000,
      fetcher: async (url) => {
        calls.push(url);
        return Response.json(url.endsWith("/token") ? { id_token: token } : { keys: [firstJwk] });
      },
    });
    expect((await failure(client)).reason).toBe("invalid_proof");
    expect(calls).not.toContain("https://owner.test/jwks");
  });

  test("rejects symmetric algorithms before fetching signing keys", async () => {
    const token = await new SignJWT(payload())
      .setProtectedHeader({ alg: "HS256", kid: "first" })
      .sign(new Uint8Array(32));
    const calls: string[] = [];
    const client = makeTelegramOidcClient({
      ...CONFIG,
      nowMs: () => NOW * 1000,
      fetcher: async (url) => {
        calls.push(url);
        return Response.json({ id_token: token });
      },
    });
    expect((await failure(client)).reason).toBe("invalid_proof");
    expect(calls).toEqual(["https://oauth.telegram.org/token"]);
  });

  test("bounds key refresh while permitting rotation after cooldown", async () => {
    const f = await fixture();
    await Effect.runPromise(f.client.exchange(INPUT));
    f.rotate(await signed({}, true));
    expect((await failure(f.client)).reason).toBe("invalid_proof");
    expect((await failure(f.client)).reason).toBe("invalid_proof");
    expect(f.calls.filter((call) => call.url.endsWith("jwks.json"))).toHaveLength(1);
    f.advance(30);
    expect(await Effect.runPromise(f.client.exchange(INPUT))).toEqual({
      telegramUserId: "987654321",
    });
    expect(f.calls.filter((call) => call.url.endsWith("jwks.json"))).toHaveLength(2);
  });

  test("rejects invalid input without provider I/O", async () => {
    const f = await fixture();
    expect((await failure(f.client, { ...INPUT, verifier: "short" })).reason).toBe("invalid_input");
    expect(f.calls).toHaveLength(0);
  });

  test.each([302, 401, 500])("redacts HTTP %i and never retries a code", async (status) => {
    let calls = 0;
    const client = makeTelegramOidcClient({
      ...CONFIG,
      fetcher: async () => {
        calls += 1;
        return new Response("private provider message", {
          status,
          headers: { location: "https://owner.test/steal" },
        });
      },
    });
    const error = await failure(client);
    expect(error.reason).toBe("provider_unavailable");
    expect(JSON.stringify(error)).not.toContain("private provider message");
    expect(calls).toBe(1);
  });

  test("limits chunked response bytes and cancels the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(20000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = makeTelegramOidcClient({
      ...CONFIG,
      fetcher: async () =>
        new Response(stream, { headers: { "content-type": "application/json" } }),
    });
    expect((await failure(client)).reason).toBe("provider_unavailable");
    expect(cancelled).toBe(true);
  });

  test("aborts a stalled provider request at its deadline", async () => {
    let aborted = false;
    const client = makeTelegramOidcClient({
      ...CONFIG,
      timeoutMs: 25,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("private error"));
          });
        }),
    });
    expect((await failure(client)).reason).toBe("provider_unavailable");
    expect(aborted).toBe(true);
  });

  test("deadline also cancels stalled body consumption and releases its lock", async () => {
    let response: Response | undefined;
    const client = makeTelegramOidcClient({
      ...CONFIG,
      timeoutMs: 25,
      fetcher: async (_url, init) => {
        response = new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener("abort", () =>
                controller.error(new Error("private body error")),
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
        return response;
      },
    });
    expect((await failure(client)).reason).toBe("provider_unavailable");
    expect(response?.body?.locked).toBe(false);
  });

  test("Effect interruption aborts the actual request", async () => {
    let requestSignal: AbortSignal | null | undefined;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = makeTelegramOidcClient({
      ...CONFIG,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal;
          init.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
          started();
        }),
    });
    const controller = new AbortController();
    const running = Effect.runPromiseExit(client.exchange(INPUT), { signal: controller.signal });
    await ready;
    controller.abort();
    expect(Exit.isFailure(await running)).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });

  test("configuration failures never include the configured secret", () => {
    expect(() =>
      makeTelegramOidcClient({ ...CONFIG, redirectUri: "http://web.test/callback" }),
    ).toThrow("Telegram login configuration invalid");
    try {
      makeTelegramOidcClient({ ...CONFIG, timeoutMs: 99999 });
    } catch (error) {
      expect(String(error)).not.toContain(CONFIG.clientSecret);
    }
  });
});
