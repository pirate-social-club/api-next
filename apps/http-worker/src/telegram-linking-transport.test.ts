import { expect, test } from "bun:test";
import { TELEGRAM_IDENTITY_LINK_CONFLICT_REASON } from "@pirate/api-client";
import { TelegramFailure } from "@pirate/application/telegram";
import { TelegramLinkTransaction } from "@pirate/contracts";
import { Schema } from "effect";
import { makeTelegramLinkingHandlers } from "./telegram-linking-handlers.ts";
import { createHttpWorker, type DecodedRequest } from "./transport.ts";

const origin = "https://pirate.test";
const token = "t".repeat(43);
const transaction = Schema.decodeUnknownSync(TelegramLinkTransaction)({
  id: token,
  state: "pending",
  expires_at: "2099-01-01T00:00:00.000Z",
  community_id: "music",
  community_name: "Music",
  bot_id: "123",
  bot_username: "study_fixture_bot",
  post_id: "song",
  telegram_user_id: null,
});
function worker() {
  const seen: DecodedRequest[] = [];
  const app = createHttpWorker({
    config: { corsOrigin: origin },
    authenticate: () => ({ kind: "user", subject: "learner" }),
    authorize: () => {},
    handlers: {
      StartTelegramLink: (request) => {
        seen.push(request);
        return { transaction, authorization_url: "https://oauth.telegram.org/auth" };
      },
    },
  });
  return { app, seen };
}
function request(
  cookie = "__Host-pirate_session=fixture-session; __Host-pirate_csrf=csrf",
  extra: Record<string, string> = {},
) {
  return {
    method: "POST",
    headers: {
      cookie,
      origin,
      "x-csrf-token": "csrf",
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify({ navigation_reference: token }),
  };
}
test("linking requires browser cookie, Origin and CSRF before decoding or handler", async () => {
  const { app, seen } = worker();
  for (const input of [
    request("", { authorization: "Bearer machine" }),
    request("__Host-pirate_session=fixture-session", { "x-csrf-token": "" }),
    request(undefined, { origin: "https://owner.test" }),
    request(undefined, { "x-csrf-token": "wrong" }),
    request(undefined, { authorization: "Bearer machine" }),
  ]) {
    expect((await app.request(`${origin}/telegram/link/transactions`, input)).status).toBe(401);
  }
  expect(seen).toHaveLength(0);
});
test("transport hashes the authenticated session and supplies only the parsed private binding", async () => {
  const { app, seen } = worker();
  const binding = "b".repeat(43);
  const response = await app.request(
    `${origin}/telegram/link/transactions`,
    request(
      `__Host-pirate_session=fixture-session; __Host-pirate_csrf=csrf; __Host-pirate_telegram_link=${binding}`,
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(seen[0]?.principal?.subject).toBe("learner");
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fixture-session")),
  ).toString("base64url");
  expect(seen[0]?.telegramLinkBrowser).toEqual({ sessionHash: hash, binding });
  expect(JSON.stringify(await response.json())).not.toContain("fixture-session");
});
test("duplicate or malformed binding cookies fail instead of selecting one", async () => {
  const { app, seen } = worker();
  for (const suffix of [
    `__Host-pirate_telegram_link=${token}; __Host-pirate_telegram_link=${token}`,
    "__Host-pirate_telegram_link=%ZZ",
    "__Host-pirate_telegram_link=short",
  ]) {
    expect(
      (
        await app.request(
          `${origin}/telegram/link/transactions`,
          request(`__Host-pirate_session=fixture-session; __Host-pirate_csrf=csrf; ${suffix}`),
        )
      ).status,
    ).toBe(401);
  }
  expect(seen).toHaveLength(0);
});
test("registered linking routes remain unavailable with the feature disabled", async () => {
  const app = createHttpWorker({
    config: { corsOrigin: origin },
    authenticate: () => ({ kind: "user", subject: "learner" }),
    authorize: () => {},
    handlers: makeTelegramLinkingHandlers(null),
  });
  expect((await app.request(`${origin}/telegram/link/transactions`, request())).status).toBe(502);
});

test("unknown account/session authority in the JSON body is rejected", async () => {
  const { app, seen } = worker();
  const input = request();
  input.body = JSON.stringify({
    navigation_reference: token,
    accountId: "forged",
    browserHash: "forged",
  });
  expect((await app.request(`${origin}/telegram/link/transactions`, input)).status).toBe(400);
  expect(seen).toHaveLength(0);
});

test("a malformed linking cookie cannot block browser-authenticated revocation", async () => {
  let called = false;
  const app = createHttpWorker({
    config: { corsOrigin: origin },
    authenticate: () => ({ kind: "user", subject: "learner" }),
    authorize: () => {},
    handlers: {
      RevokeTelegramLinkGrant: (request) => {
        called = true;
        expect(request.telegramLinkBrowser?.sessionHash).toHaveLength(43);
        expect(request.telegramLinkBrowser?.binding).toBeUndefined();
        return { revoked: true };
      },
    },
  });
  const input = request(
    "__Host-pirate_session=fixture-session; __Host-pirate_csrf=csrf; __Host-pirate_telegram_link=invalid",
  );
  input.body = JSON.stringify({ community_id: "music", bot_id: "123" });
  expect((await app.request(`${origin}/telegram/link/grants/revoke`, input)).status).toBe(200);
  expect(called).toBe(true);
});

test("actual linking handlers issue an HttpOnly binding and preserve typed provider failures", async () => {
  const { makeTelegramCredentialVault } = await import(
    "@pirate/platform-cf/telegram-credential-vault"
  );
  const { Effect } = await import("effect");
  const { TelegramOidcRejected } = await import("@pirate/application/telegram-oidc");
  const vault = await makeTelegramCredentialVault({
    activeVersion: "fixture",
    keys: { fixture: Buffer.alloc(32, 7).toString("base64url") },
  });
  let observedBrowser: unknown;
  let unavailable = false;
  const services: import("@pirate/application/telegram-linking").TelegramLinkServices = {
    vault,
    oidc: {
      authorize: () =>
        Effect.succeed({
          authorizationUrl: "https://oauth.telegram.org/auth",
          state: "s".repeat(43),
          nonce: "n".repeat(43),
          verifier: "v".repeat(43),
        }),
      prepare: () =>
        unavailable
          ? Effect.fail(new TelegramOidcRejected({ reason: "provider_unavailable" }))
          : Effect.void,
      exchange: () => Effect.succeed({ telegramUserId: "321" }),
    },
    store: {
      list: async () => ({ telegram_user_ids: [], grants: [] }),
      createNavigation: async () => {},
      start: async (input) => {
        observedBrowser = input.browser;
        expect(input.secretCiphertext).not.toContain("v".repeat(43));
        return { ...transaction, id: input.id };
      },
      get: async () => transaction,
      findPending: async () => transaction.id,
      claim: async () => {
        throw new Error("Unavailable keys cannot claim a transaction");
      },
      verified: async () => transaction,
      fail: async () => {},
      confirm: async () => {
        throw new Error("Not used");
      },
      revoke: async () => {},
      unlink: async () => {},
      resolveGrant: async () => null,
      cleanup: async () => {},
    },
  };
  const app = createHttpWorker({
    config: { corsOrigin: origin },
    authenticate: () => ({ kind: "user", subject: "learner" }),
    authorize: () => {},
    handlers: makeTelegramLinkingHandlers(services),
  });
  const response = await app.request(`${origin}/telegram/link/transactions`, request());
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("Secure; HttpOnly; SameSite=Lax");
  expect(cookie).toContain("Max-Age=900");
  const binding = /__Host-pirate_telegram_link=([A-Za-z0-9_-]{43})/u.exec(cookie)?.[1];
  expect(binding).toHaveLength(43);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toContain(binding ?? "missing");
  expect(observedBrowser).toMatchObject({
    accountId: "learner",
    browserHash: await vault.hash(binding ?? "missing"),
  });
  unavailable = true;
  const callback = request(
    `__Host-pirate_session=fixture-session; __Host-pirate_csrf=csrf; __Host-pirate_telegram_link=${binding}`,
  );
  callback.body = JSON.stringify({ state: "s".repeat(43), code: "fixture-code" });
  const failed = await app.request(
    `${origin}/telegram/link/transactions/${token}/verify`,
    callback,
  );
  expect(failed.status).toBe(502);
  expect(JSON.stringify(await failed.json())).not.toContain("fixture-code");
  const missingCookie = request();
  missingCookie.body = JSON.stringify({ state: "s".repeat(43), code: "fixture-code" });
  expect((await app.request(`${origin}/telegram/link/callback/verify`, missingCookie)).status).toBe(
    401,
  );
  unavailable = false;
  Object.assign(services.store, {
    findPending: async (
      _hash: string,
      actual: import("@pirate/application/telegram-linking").TelegramLinkBrowser,
    ) => {
      expect(observedBrowser).toEqual(actual);
      return token;
    },
    claim: async () =>
      vault.seal(
        JSON.stringify({ nonce: "n".repeat(43), verifier: "v".repeat(43) }),
        `telegram-link:${token}`,
      ),
    verified: async () => ({ ...transaction, state: "verified", telegram_user_id: "321" }),
    confirm: async () => {
      throw new TelegramFailure({ reason: "identity_conflict" });
    },
  });
  Object.assign(services.oidc, {
    exchange: () =>
      Effect.succeed({
        telegramUserId: "321",
        display: { name: "Learner fixture", username: "learner_fixture" },
      }),
  });
  const verifiedResponse = await app.request(`${origin}/telegram/link/callback/verify`, callback);
  expect(verifiedResponse.status).toBe(200);
  expect(verifiedResponse.headers.get("cache-control")).toBe("private, no-store");
  const verifiedBody = Schema.decodeUnknownSync(TelegramLinkTransaction)(
    await verifiedResponse.json(),
  );
  expect(verifiedBody.confirmation_display).toEqual({
    name: "Learner fixture",
    username: "learner_fixture",
  });
  expect(JSON.stringify(verifiedBody)).not.toContain("fixture-code");
  expect(JSON.stringify(verifiedBody)).not.toContain("s".repeat(43));
  const confirmation = request(
    `__Host-pirate_session=fixture-session; __Host-pirate_csrf=csrf; __Host-pirate_telegram_link=${binding}`,
  );
  confirmation.body = JSON.stringify({ persona_id: "persona" });
  const refused = await app.request(
    `${origin}/telegram/link/transactions/${token}/confirm`,
    confirmation,
  );
  expect(refused.status).toBe(409);
  const refusal = await refused.json();
  expect(refusal).toMatchObject({
    error: { details: { reason: TELEGRAM_IDENTITY_LINK_CONFLICT_REASON } },
  });
  expect(JSON.stringify(refusal)).not.toContain("other-account");
});
