import { describe, expect, test } from "bun:test";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";
import { makeControlPlaneTelegramStore } from "./telegram-store.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;

async function fixture(
  use: (store: ReturnType<typeof makeControlPlaneTelegramStore>, admin: Client) => Promise<void>,
) {
  if (!connectionString) throw new Error("Postgres configuration missing");
  await withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "telegram_store_pg_test",
    use: async ({ admin, schema }) => {
      const connection = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query("INSERT INTO users(user_id) VALUES('telegram-owner')");
      await admin.query(
        "INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES('telegram-community','Telegram fixture','active','telegram-owner',clock_timestamp(),clock_timestamp())",
      );
      const store = makeControlPlaneTelegramStore(
        makeDirectPostgresControlPlaneLayer(connection),
        "https://pirate.example.invalid",
      );
      await store.saveIntegration(
        {
          ...emptyTelegramIntegration("telegram-community"),
          botEpoch: "epoch",
          status: "ready",
          botId: "123",
          webhookId: "hook",
        },
        0,
        "connect",
        "hash",
        "telegram-owner",
      );
      await use(store, admin);
    },
  });
}

suite("community Telegram persistence", () => {
  test("channel selection is bound to the initiating Telegram user and owner confirmation", () =>
    fixture(async (store) => {
      await store.createSetup({
        id: "setup",
        communityId: "telegram-community",
        ownerId: "telegram-owner",
        botEpoch: "epoch",
        tokenHash: "setup-hash",
        tokenCiphertext: "sealed",
        commandHash: "command",
        requestId: 123,
        telegramUserId: null,
        privateChatId: null,
        channelId: null,
        channelTitle: null,
        channelUsername: null,
        state: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(await store.bindSetup("setup", "user-a", "user-a")).toBe(true);
      expect(await store.bindSetup("setup", "user-b", "user-b")).toBe(false);
      const selected = {
        communityId: "telegram-community",
        epoch: "epoch",
        requestId: 123,
        userId: "user-b",
        chatId: "user-b",
        channelId: "-100",
        title: "Channel",
        username: null,
      };
      await store.selectSetup(selected);
      expect((await store.setup("telegram-community", "setup"))?.state).toBe("pending");
      await store.selectSetup({ ...selected, userId: "user-a", chatId: "user-a" });
      expect((await store.integration("telegram-community")).channelId).toBeNull();
      const confirmed = await store.confirmSetup(
        "telegram-community",
        "telegram-owner",
        "setup",
        1,
      );
      expect(confirmed.channelId).toBe("-100");
      expect(
        (await store.confirmSetup("telegram-community", "telegram-owner", "setup", 1)).revision,
      ).toBe(2);
    }));

  test("operator resolution replays without scheduling another send", () =>
    fixture(async (store) => {
      await store.enqueueDelivery({
        id: "uncertain",
        communityId: "telegram-community",
        botEpoch: "epoch",
        chatId: "123",
        kind: "reply",
        postId: null,
        state: "pending",
        desired: { kind: "text", text: "fixture", media: null, buttons: [] },
        desiredHash: "payload",
      });
      const claimed = await store.claimDelivery("uncertain");
      if (!claimed) throw new Error("Missing claim");
      await store.finishDelivery(claimed, { kind: "uncertain", code: "timeout" }, "send");
      const command = {
        ownerId: "telegram-owner",
        revision: 1,
        key: "resolution",
        hash: "not-sent",
      };
      await store.resolveDelivery("telegram-community", "uncertain", "not_sent", command);
      const retry = await store.claimDelivery("uncertain");
      if (!retry) throw new Error("Missing retry");
      await store.finishDelivery(retry, { kind: "confirmed", messageId: 8 }, "send");
      await store.resolveDelivery("telegram-community", "uncertain", "not_sent", command);
      expect(await store.claimDelivery("uncertain")).toBeNull();
      expect((await store.listDeliveries("telegram-community")).items[0]?.state).toBe("delivered");
    }));
  test("duplicate webhook IDs are accepted once and completed payloads are erased", () =>
    fixture(async (store, admin) => {
      const integration = await store.integration("telegram-community");
      const ids = await Promise.all([
        store.acceptUpdate(integration, { update_id: 1, message: { text: "fixture" } }),
        store.acceptUpdate(integration, { update_id: 1 }),
      ]);
      expect(ids[0]).toBe(ids[1]);
      const claimed = await store.claimInbox(ids[0] ?? "");
      expect(claimed).not.toBeNull();
      expect(await store.claimInbox(ids[0] ?? "")).toBeNull();
      if (!claimed) throw new Error("Missing claim");
      await store.finishInbox(claimed, null);
      expect(
        (await admin.query("SELECT payload,state FROM community_telegram_inbox")).rows,
      ).toEqual([{ payload: null, state: "completed" }]);
      expect(await store.acceptUpdate(integration, { update_id: 1 })).toBe(ids[0]);
      expect(await store.claimInbox(ids[0] ?? "")).toBeNull();
    }));

  test("concurrent budgets cannot exceed limits when history is disabled", () =>
    fixture(async (store) => {
      const policy = {
        ...(await store.integration("telegram-community")).policy,
        remember_conversations: false,
        user_daily_messages: 2,
        community_daily_messages: 2,
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          store.reserveUsage("telegram-community", "epoch", "user", `message-${index}`, policy, 0),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(2);
    }));

  test("expired delivery claims are uncertain and stale outcomes cannot finalize them", () =>
    fixture(async (store, admin) => {
      await store.enqueueDelivery({
        id: "delivery",
        communityId: "telegram-community",
        botEpoch: "epoch",
        chatId: "123",
        kind: "reply",
        postId: null,
        state: "pending",
        desired: { kind: "text", text: "fixture", media: null, buttons: [] },
        desiredHash: "payload",
      });
      const claimed = await store.claimDelivery("delivery");
      if (!claimed) throw new Error("Missing delivery claim");
      expect(claimed.state).toBe("pending");
      await admin.query(
        "UPDATE community_telegram_deliveries SET lease_expires_at=clock_timestamp()-interval '1 second'",
      );
      expect(await store.claimDelivery("delivery")).toBeNull();
      await store.finishDelivery(claimed, { kind: "confirmed", messageId: 55 }, "send");
      expect((await store.listDeliveries("telegram-community")).items[0]?.state).toBe("uncertain");
    }));

  test("failed edits retain confirmed content and can be claimed again after retry_after", () =>
    fixture(async (store, admin) => {
      const base = {
        id: "delivery",
        communityId: "telegram-community",
        botEpoch: "epoch",
        chatId: "123",
        kind: "reply" as const,
        postId: null,
        state: "pending" as const,
        desired: { kind: "text" as const, text: "old", media: null, buttons: [] },
        desiredHash: "old",
      };
      await store.enqueueDelivery(base);
      const sent = await store.claimDelivery("delivery");
      if (!sent) throw new Error("Missing send");
      await store.finishDelivery(sent, { kind: "confirmed", messageId: 9 }, "send");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "new" },
        desiredHash: "new",
      });
      const edited = await store.claimDelivery("delivery");
      if (!edited) throw new Error("Missing edit");
      await store.finishDelivery(
        edited,
        { kind: "rejected", code: "telegram_429", retryAfter: 60 },
        "edit",
      );
      expect(await store.claimDelivery("delivery")).toBeNull();
      await admin.query(
        "UPDATE community_telegram_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second'",
      );
      const retried = await store.claimDelivery("delivery");
      expect(retried?.confirmedHash).toBe("old");
      expect(retried?.desiredHash).toBe("new");
      expect(retried?.messageId).toBe(9);
    }));
});
