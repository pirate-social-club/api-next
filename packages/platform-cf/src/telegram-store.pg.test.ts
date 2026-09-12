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

function publication() {
  return {
    id: "publication",
    communityId: "telegram-community",
    botEpoch: "epoch",
    chatId: "-100",
    kind: "publication" as const,
    postId: "telegram-post",
    state: "pending" as const,
    desired: { kind: "text" as const, text: "Original", media: null, buttons: [] },
    desiredHash: "original",
  };
}

async function publicationFixture(
  use: (store: ReturnType<typeof makeControlPlaneTelegramStore>, admin: Client) => Promise<void>,
) {
  return fixture(async (store, admin) => {
    await admin.query(
      "INSERT INTO posts (community_id,post_id,post_type,status,visibility,title,author_declared_rating,content_rating,created_at,updated_at) VALUES ('telegram-community','telegram-post','text','published','public','Fixture','general','general',clock_timestamp(),clock_timestamp())",
    );
    await use(store, admin);
  });
}

const recoveryCommand = {
  ownerId: "telegram-owner",
  revision: 1,
  key: "recover-publication",
  hash: "recovery",
};

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

  for (const withdrawal of [false, true]) {
    test(
      withdrawal
        ? "withdrawal remains claimable after ten successful revisions"
        : "a new edit remains claimable after ten successful revisions",
      () =>
        publicationFixture(async (store) => {
          const base = publication();
          for (let revision = 0; revision < 10; revision++) {
            await store.enqueueDelivery({
              ...base,
              desired: { ...base.desired, text: `Revision ${revision}` },
              desiredHash: `revision-${revision}`,
            });
            const claimed = await store.claimDelivery(base.id);
            if (!claimed) throw new Error("Missing successful revision claim");
            await store.finishDelivery(
              claimed,
              { kind: "confirmed", messageId: 42 },
              revision === 0 ? "send" : "edit",
            );
          }
          await store.enqueueDelivery({
            ...base,
            desired: withdrawal ? null : { ...base.desired, text: "Next revision" },
            desiredHash: withdrawal ? null : "next",
          });
          const claimed = await store.claimDelivery(base.id);
          expect(claimed).not.toBeNull();
          if (!claimed) throw new Error("Successful history exhausted future attempts");
          await store.finishDelivery(
            claimed,
            { kind: "confirmed", messageId: 42 },
            withdrawal ? "delete" : "edit",
          );
          const result = (await store.listDeliveries(base.communityId)).items[0];
          expect(result?.state).toBe(withdrawal ? "withdrawn" : "delivered");
          expect(result?.attempt_count).toBe(0);
        }),
    );
  }

  for (const resolution of ["confirmed", "not_sent"] as const) {
    test(`uncertain withdrawal can be resolved as ${resolution}`, () =>
      publicationFixture(async (store, admin) => {
        const base = publication();
        await store.enqueueDelivery(base);
        const sent = await store.claimDelivery(base.id);
        if (!sent) throw new Error("Missing send");
        await store.finishDelivery(sent, { kind: "confirmed", messageId: 42 }, "send");
        await store.enqueueDelivery({ ...base, desired: null, desiredHash: null });
        const deletion = await store.claimDelivery(base.id);
        if (!deletion) throw new Error("Missing deletion");
        await store.finishDelivery(
          deletion,
          { kind: "uncertain", code: "acknowledgement_unavailable" },
          "delete",
        );
        const result = await store.resolveDelivery(
          base.communityId,
          base.id,
          resolution,
          recoveryCommand,
        );
        expect(result.state).toBe("withdrawn");
        expect(
          (
            await admin.query(
              "SELECT message_id,confirmed,confirmed_hash FROM community_telegram_deliveries WHERE delivery_id=$1",
              [base.id],
            )
          ).rows[0],
        ).toEqual({ message_id: null, confirmed: null, confirmed_hash: null });
        expect(
          await store.resolveDelivery(base.communityId, base.id, resolution, recoveryCommand),
        ).toEqual(result);
        await store.finishDelivery(deletion, { kind: "confirmed", messageId: 42 }, "edit");
        expect(await store.claimDelivery(base.id)).toBeNull();
        expect((await store.listDeliveries(base.communityId)).items[0]?.state).toBe("withdrawn");
      }));
  }

  for (const withdrawal of [false, true]) {
    test(
      withdrawal
        ? "a cancelled failed edit permits a newer withdrawal"
        : "a cancelled failed send permits a newer revision",
      () =>
        publicationFixture(async (store) => {
          const base = publication();
          await store.enqueueDelivery(base);
          const sent = await store.claimDelivery(base.id);
          if (!sent) throw new Error("Missing send");
          if (withdrawal) {
            await store.finishDelivery(sent, { kind: "confirmed", messageId: 42 }, "send");
            await store.enqueueDelivery({
              ...base,
              desired: { ...base.desired, text: "Failed edit" },
              desiredHash: "failed-edit",
            });
          }
          const failed = withdrawal ? await store.claimDelivery(base.id) : sent;
          if (!failed) throw new Error("Missing failed operation");
          await store.finishDelivery(
            failed,
            { kind: "rejected", code: "telegram_400", retryAfter: null },
            withdrawal ? "edit" : "send",
          );
          await store.resolveDelivery(base.communityId, base.id, "cancel", recoveryCommand);
          const cancelled = { ...base, desired: failed.desired, desiredHash: failed.desiredHash };
          await store.enqueueDelivery(cancelled);
          expect((await store.listDeliveries(base.communityId)).items[0]?.state).toBe("cancelled");
          await store.enqueueDelivery({
            ...base,
            desired: withdrawal ? null : { ...base.desired, text: "New revision" },
            desiredHash: withdrawal ? null : "new",
          });
          expect((await store.listDeliveries(base.communityId)).items[0]?.state).toBe("pending");
          const resumed = await store.claimDelivery(base.id);
          expect(resumed).not.toBeNull();
          expect(resumed?.messageId).toBe(withdrawal ? 42 : null);
          expect(resumed?.desiredHash).toBe(withdrawal ? null : "new");
        }),
    );
  }

  test("same-revision failures retain their retry limit while a new revision gets a budget", () =>
    publicationFixture(async (store, admin) => {
      const base = publication();
      await store.enqueueDelivery(base);
      for (let attempt = 0; attempt < 10; attempt++) {
        const claimed = await store.claimDelivery(base.id);
        if (!claimed) throw new Error("Missing retry within budget");
        await store.finishDelivery(
          claimed,
          { kind: "rejected", code: "telegram_429", retryAfter: 1 },
          "send",
        );
        await admin.query(
          "UPDATE community_telegram_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1",
          [base.id],
        );
        await store.enqueueDelivery(base);
      }
      expect(await store.claimDelivery(base.id)).toBeNull();
      expect((await store.listDeliveries(base.communityId)).items[0]?.state).toBe("failed");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "New revision" },
        desiredHash: "new",
      });
      const next = await store.claimDelivery(base.id);
      expect(next?.attemptCount).toBe(1);
    }));

  test("previously stranded pending rows can proceed or reach operator recovery", () =>
    publicationFixture(async (store, admin) => {
      const base = publication();
      await store.enqueueDelivery(base);
      await admin.query(
        "UPDATE community_telegram_deliveries SET attempt_count=10 WHERE delivery_id=$1",
        [base.id],
      );
      const recovered = await store.claimDelivery(base.id);
      expect(recovered?.attemptCount).toBe(1);
      if (!recovered) throw new Error("Old lifetime counter still strands pending work");
      await store.finishDelivery(recovered, { kind: "confirmed", messageId: 42 }, "send");
      await store.enqueueDelivery({ ...base, desired: null, desiredHash: null });
      await admin.query(
        "UPDATE community_telegram_deliveries SET attempt_count=10,last_error='telegram_429' WHERE delivery_id=$1",
        [base.id],
      );
      expect(await store.claimDelivery(base.id)).toBeNull();
      expect((await store.listDeliveries(base.communityId)).items[0]?.state).toBe("failed");
      expect(
        (await store.resolveDelivery(base.communityId, base.id, "not_sent", recoveryCommand)).state,
      ).toBe("withdrawn");
    }));

  test("private delivery cancellation remains terminal for newer payloads", () =>
    fixture(async (store) => {
      for (const kind of ["reply", "voice", "setup"] as const) {
        const base = { ...publication(), id: kind, kind, postId: null };
        await store.enqueueDelivery(base);
        const claimed = await store.claimDelivery(base.id);
        if (!claimed) throw new Error("Missing private claim");
        await store.finishDelivery(
          claimed,
          { kind: "rejected", code: "telegram_400", retryAfter: null },
          "send",
        );
        await store.resolveDelivery(base.communityId, base.id, "cancel", {
          ...recoveryCommand,
          key: kind,
        });
        await store.enqueueDelivery({
          ...base,
          desired: { ...base.desired, text: "New private payload" },
          desiredHash: "new",
        });
        expect(await store.claimDelivery(base.id)).toBeNull();
      }
      expect(
        (await store.listDeliveries("telegram-community")).items.every(
          (row) => row.state === "cancelled",
        ),
      ).toBe(true);
    }));

  test("a newer revision arriving during sending is preserved for the next operation", () =>
    publicationFixture(async (store, admin) => {
      const base = publication();
      await store.enqueueDelivery(base);
      const claimed = await store.claimDelivery(base.id);
      if (!claimed) throw new Error("Missing send");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "New revision" },
        desiredHash: "new",
      });
      expect(
        (
          await admin.query(
            "SELECT state,desired_hash,intended_hash FROM community_telegram_deliveries WHERE delivery_id=$1",
            [base.id],
          )
        ).rows[0],
      ).toEqual({ state: "sending", desired_hash: "new", intended_hash: "original" });
      await store.finishDelivery(claimed, { kind: "confirmed", messageId: 42 }, "send");
      const next = await store.claimDelivery(base.id);
      expect(next?.desiredHash).toBe("new");
      expect(next?.messageId).toBe(42);
    }));

  test("a newer revision arriving during uncertain review follows the pinned outcome", () =>
    publicationFixture(async (store, admin) => {
      const base = publication();
      await store.enqueueDelivery(base);
      const sent = await store.claimDelivery(base.id);
      if (!sent) throw new Error("Missing send");
      await store.finishDelivery(sent, { kind: "confirmed", messageId: 42 }, "send");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "Running" },
        desiredHash: "running",
      });
      const edit = await store.claimDelivery(base.id);
      if (!edit) throw new Error("Missing edit");
      await store.finishDelivery(edit, { kind: "uncertain", code: "timeout" }, "edit");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "Newest" },
        desiredHash: "newest",
      });
      expect(
        (
          await admin.query(
            "SELECT state,desired_hash,intended_hash FROM community_telegram_deliveries WHERE delivery_id=$1",
            [base.id],
          )
        ).rows[0],
      ).toEqual({ state: "uncertain", desired_hash: "newest", intended_hash: "running" });
      const resolved = await store.resolveDelivery(
        base.communityId,
        base.id,
        "confirmed",
        { ...recoveryCommand, key: "confirm-pinned" },
        42,
      );
      expect(resolved.state).toBe("pending");
      const row = (
        await admin.query(
          "SELECT confirmed_hash,intended_hash,message_id FROM community_telegram_deliveries WHERE delivery_id=$1",
          [base.id],
        )
      ).rows[0];
      expect(row).toEqual({ confirmed_hash: "running", intended_hash: null, message_id: "42" });
      const next = await store.claimDelivery(base.id);
      expect(next?.desiredHash).toBe("newest");
      expect(next?.confirmedHash).toBe("running");
      expect(next?.messageId).toBe(42);
    }));

  test("confirmed absence during uncertain review releases the newest revision", () =>
    publicationFixture(async (store) => {
      const base = publication();
      await store.enqueueDelivery(base);
      const claimed = await store.claimDelivery(base.id);
      if (!claimed) throw new Error("Missing send");
      await store.finishDelivery(claimed, { kind: "uncertain", code: "timeout" }, "send");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "Newest" },
        desiredHash: "newest",
      });
      await store.resolveDelivery(base.communityId, base.id, "not_sent", {
        ...recoveryCommand,
        key: "absent-pinned",
      });
      const next = await store.claimDelivery(base.id);
      expect(next?.desiredHash).toBe("newest");
      expect(next?.confirmedHash).toBeNull();
      expect(next?.messageId).toBeNull();
    }));

  test("private deliveries still refuse newer payloads while sending", () =>
    fixture(async (store, admin) => {
      const base = { ...publication(), id: "reply", kind: "reply" as const, postId: null };
      await store.enqueueDelivery(base);
      const claimed = await store.claimDelivery(base.id);
      if (!claimed) throw new Error("Missing private claim");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "Newer private payload" },
        desiredHash: "newer",
      });
      expect(
        (
          await admin.query(
            "SELECT state,desired_hash FROM community_telegram_deliveries WHERE delivery_id=$1",
            [base.id],
          )
        ).rows[0],
      ).toEqual({ state: "sending", desired_hash: "original" });
    }));

  test("confirming absence clears an old copy before republishing the desired revision", () =>
    publicationFixture(async (store, admin) => {
      const base = publication();
      await store.enqueueDelivery(base);
      const sent = await store.claimDelivery(base.id);
      if (!sent) throw new Error("Missing send");
      await store.finishDelivery(sent, { kind: "confirmed", messageId: 42 }, "send");
      await store.enqueueDelivery({
        ...base,
        desired: { ...base.desired, text: "Updated" },
        desiredHash: "updated",
      });
      const edit = await store.claimDelivery(base.id);
      if (!edit) throw new Error("Missing edit");
      await store.finishDelivery(edit, { kind: "uncertain", code: "timeout" }, "edit");
      await store.resolveDelivery(base.communityId, base.id, "not_sent", recoveryCommand);
      const next = await store.claimDelivery(base.id);
      expect(next?.messageId).toBeNull();
      expect(next?.confirmedHash).toBeNull();
      expect(next?.desiredHash).toBe("updated");
      expect(
        (
          await admin.query(
            "SELECT confirmed FROM community_telegram_deliveries WHERE delivery_id=$1",
            [base.id],
          )
        ).rows[0]?.confirmed,
      ).toBeNull();
    }));
});
