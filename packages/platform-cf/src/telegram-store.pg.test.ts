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
      const claims = await Promise.all([
        store.claimDelivery("delivery"),
        store.claimDelivery("delivery"),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const claimed = claims.find((claim) => claim !== null);
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
      if (!retried) throw new Error("Missing retry");
      await store.finishDelivery(retried, { kind: "confirmed", messageId: 9 }, "edit");
      await store.enqueueDelivery({ ...base, desired: null, desiredHash: null });
      const withdrawn = await store.claimDelivery("delivery");
      if (!withdrawn) throw new Error("Missing withdrawal");
      await store.finishDelivery(withdrawn, { kind: "confirmed", messageId: 9 }, "delete");
      expect((await store.listDeliveries("telegram-community")).items[0]?.state).toBe("withdrawn");
    }));
  test("interface choices survive bot rotation, fence reordered writes and stay private", () =>
    fixture(async (store, admin) => {
      let bot = await store.integration("telegram-community");
      const sender = {
        communityId: bot.communityId,
        botId: "123",
        epoch: "epoch",
        telegramUserId: "321",
      };
      const first = await store.acceptUpdate(bot, { update_id: 10, message: {} });
      const second = await store.acceptUpdate(bot, { update_id: 11, message: {} });
      const third = await store.acceptUpdate(bot, { update_id: 12, message: {} });
      for (const [id, minute] of [
        [first, 1],
        [second, 2],
        [third, 3],
      ] as const)
        await admin.query(
          "UPDATE community_telegram_inbox SET created_at=$2::timestamptz WHERE inbox_id=$1",
          [id, `2026-10-05T00:0${minute}:00Z`],
        );
      await store.saveLearnerLanguage(sender, second, "ru", false);
      await store.saveLearnerLanguage(sender, first, "en", true);
      await store.saveLearnerLanguage(sender, second, "ka", false);
      expect((await store.learnerLanguageContext(sender)).preference).toEqual({
        locale: "en",
        explicit: true,
      });
      await store.saveLearnerLanguage(sender, third, "ka", true);
      await store.saveLearnerLanguage(sender, first, "en", true);
      expect((await store.learnerLanguageContext(sender)).preference).toEqual({
        locale: "ka",
        explicit: true,
      });
      expect(
        (await store.learnerLanguageContext({ ...sender, telegramUserId: "654" })).preference,
      ).toBeNull();
      bot = await store.saveIntegration(
        { ...bot, revision: bot.revision + 1, botEpoch: "rotated" },
        bot.revision,
        "rotation",
        "rotation-hash",
        "telegram-owner",
      );
      expect(
        (await store.learnerLanguageContext({ ...sender, epoch: "rotated" })).preference,
      ).toEqual({ locale: "ka", explicit: true });
      await expect(store.saveLearnerLanguage(sender, third, "ru", true)).rejects.toBeDefined();
      await store.saveIntegration(
        { ...bot, revision: bot.revision + 1, botEpoch: "different", botId: "456" },
        bot.revision,
        "replace",
        "replace-hash",
        "telegram-owner",
      );
      expect(
        (await store.learnerLanguageContext({ ...sender, botId: "456", epoch: "different" }))
          .preference,
      ).toBeNull();
    }));

  test("account UI preference is read only through a current bot grant and helper is never written", () =>
    fixture(async (store, admin) => {
      await admin.query("INSERT INTO users(user_id) VALUES('locale-learner')");
      // Locale authority is tested independently of the wallet activation fixture.
      await admin.query("SET session_replication_role=replica");
      await admin.query(
        "INSERT INTO personas(persona_id,account_id,status) VALUES('locale-persona','locale-learner','active')",
      );
      await admin.query("SET session_replication_role=origin");
      await admin.query(
        "INSERT INTO account_language_preferences(account_id,ui_locale,study_helper_language) VALUES('locale-learner','ru','zh-Hans')",
      );
      await admin.query(
        "INSERT INTO telegram_account_associations(telegram_user_id,account_id) VALUES('321','locale-learner')",
      );
      const sender = {
        communityId: "telegram-community",
        botId: "123",
        epoch: "epoch",
        telegramUserId: "321",
      };
      expect((await store.learnerLanguageContext(sender)).accountLocale).toBeNull();
      await admin.query(
        "INSERT INTO telegram_bot_grants(community_id,bot_id,telegram_user_id,account_id,persona_id,revision) VALUES('telegram-community','123','321','locale-learner','locale-persona',1)",
      );
      expect(await store.learnerLanguageContext(sender)).toMatchObject({
        accountLocale: null,
        helperLanguage: null,
      });
      await admin.query(
        "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES('locale-persona','locale-learner','telegram-community','persona_creation')",
      );
      expect(await store.learnerLanguageContext(sender)).toMatchObject({
        accountLocale: "ru",
        helperLanguage: "zh-Hans",
      });
      const message = await store.acceptUpdate(await store.integration(sender.communityId), {
        update_id: 9,
        message: {},
      });
      await store.saveLearnerLanguage(sender, message, "ka", true);
      expect(
        (
          await admin.query(
            "SELECT ui_locale,study_helper_language FROM account_language_preferences WHERE account_id='locale-learner'",
          )
        ).rows,
      ).toEqual([{ ui_locale: "ru", study_helper_language: "zh-Hans" }]);
      await admin.query("UPDATE telegram_bot_grants SET active=FALSE WHERE telegram_user_id='321'");
      expect(await store.learnerLanguageContext(sender)).toMatchObject({
        accountLocale: null,
        helperLanguage: null,
        preference: { locale: "ka", explicit: true },
      });
    }));
});
