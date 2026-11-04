import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  startTelegramLink,
  type TelegramLinkBrowser,
  type TelegramLinkServices,
  verifyTelegramLink,
  verifyTelegramLinkCallback,
} from "./telegram-linking.ts";
import { TelegramOidcRejected } from "./telegram-oidc.ts";

const browser: TelegramLinkBrowser = {
  accountId: "learner",
  sessionHash: "s".repeat(43),
  browserHash: "b".repeat(43),
};
const transaction = {
  id: "i".repeat(43),
  state: "pending" as const,
  expires_at: "2099-01-01T00:00:00.000Z",
  community_id: "music",
  community_name: "Music",
  bot_id: "123",
  bot_username: "study_fixture_bot",
  post_id: "song",
  telegram_user_id: null,
};
function fixture() {
  const calls: string[] = [];
  const services: TelegramLinkServices = {
    oidc: {
      prepare: () =>
        Effect.sync(() => {
          calls.push("prepare");
        }),
      authorize: () =>
        Effect.succeed({
          authorizationUrl: "https://oauth.telegram.org/auth",
          state: "s".repeat(43),
          nonce: "n".repeat(43),
          verifier: "v".repeat(43),
        }),
      exchange: () =>
        Effect.sync(() => {
          calls.push("exchange");
          return { telegramUserId: "321" };
        }),
    },
    vault: {
      token: () => transaction.id,
      hash: async () => "h".repeat(43),
      seal: async () => "encrypted-fixture",
      open: async () => JSON.stringify({ nonce: "n".repeat(43), verifier: "v".repeat(43) }),
    },
    store: {
      list: async () => ({ telegram_user_ids: [], grants: [] }),
      createNavigation: async () => {},
      start: async (input) => {
        expect(input.browser).toEqual(browser);
        expect(input.secretCiphertext).toBe("encrypted-fixture");
        return transaction;
      },
      get: async () => {
        calls.push("get");
        return transaction;
      },
      findPending: async () => transaction.id,
      claim: async () => {
        calls.push("claim");
        return "encrypted-fixture";
      },
      verified: async () => {
        calls.push("verified");
        return { ...transaction, state: "verified", telegram_user_id: "321" };
      },
      fail: async () => {
        calls.push("failed");
      },
      confirm: async () => {
        throw new Error("No consent in verification");
      },
      revoke: async () => {},
      unlink: async () => {},
      resolveGrant: async () => null,
      cleanup: async () => {},
    },
  };
  return { services, calls };
}
test("start returns no verifier/nonce/browser binding and does not create consent", async () => {
  const { services } = fixture();
  const result = await startTelegramLink(services, browser, "r".repeat(43));
  expect(result).toEqual({ transaction, authorization_url: "https://oauth.telegram.org/auth" });
  expect(JSON.stringify(result)).not.toContain("encrypted-fixture");
});
test("verification prepares keys before claiming and exchanging exactly once", async () => {
  const { services, calls } = fixture();
  await verifyTelegramLink(services, browser, transaction.id, "s".repeat(43), "code");
  expect(calls).toEqual(["get", "prepare", "claim", "exchange", "verified"]);
});
test("preflight failure preserves pending transaction and authorization code", async () => {
  const { services, calls } = fixture();
  const unavailable = {
    ...services,
    oidc: {
      ...services.oidc,
      prepare: () => Effect.fail(new TelegramOidcRejected({ reason: "provider_unavailable" })),
    },
  };
  await expect(
    verifyTelegramLink(unavailable, browser, transaction.id, "s".repeat(43), "code"),
  ).rejects.toMatchObject({ reason: "provider_unavailable" });
  expect(calls).toEqual(["get"]);
});
test("failed exchange purges transaction material rather than retrying the code", async () => {
  const { services, calls } = fixture();
  const invalid = {
    ...services,
    oidc: {
      ...services.oidc,
      exchange: () => Effect.fail(new TelegramOidcRejected({ reason: "invalid_proof" })),
    },
  };
  await expect(
    verifyTelegramLink(invalid, browser, transaction.id, "s".repeat(43), "code"),
  ).rejects.toMatchObject({ reason: "invalid_proof" });
  expect(calls).toEqual(["get", "prepare", "claim", "failed"]);
});

test("state callback discovers attempt in the same browser before provider traffic", async () => {
  const { services, calls } = fixture();
  Object.assign(services.store, {
    findPending: async (hash: string, actual: TelegramLinkBrowser) => {
      expect(hash).toBe("h".repeat(43));
      expect(actual).toEqual(browser);
      calls.push("lookup");
      return transaction.id;
    },
  });
  await verifyTelegramLinkCallback(services, browser, "s".repeat(43), "code");
  expect(calls).toEqual(["lookup", "get", "prepare", "claim", "exchange", "verified"]);
});
test("unknown state or refreshed session does not consume provider code", async () => {
  const { services, calls } = fixture();
  Object.assign(services.store, {
    findPending: async () => {
      throw Error("callback unavailable");
    },
  });
  await expect(
    verifyTelegramLinkCallback(
      services,
      { ...browser, sessionHash: "x".repeat(43) },
      "s".repeat(43),
      "code",
    ),
  ).rejects.toThrow("callback unavailable");
  expect(calls).toEqual([]);
});
test("verified profile display is transient and never passed to storage", async () => {
  const { services } = fixture();
  Object.assign(services.oidc, {
    exchange: () =>
      Effect.succeed({
        telegramUserId: "321",
        display: { name: "Learner fixture", username: "learner_fixture" },
      }),
  });
  const result = await verifyTelegramLink(
    services,
    browser,
    transaction.id,
    "s".repeat(43),
    "code",
  );
  expect(result.confirmation_display).toEqual({
    name: "Learner fixture",
    username: "learner_fixture",
  });
  expect(await services.store.get(transaction.id, browser)).not.toHaveProperty(
    "confirmation_display",
  );
});
