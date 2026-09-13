import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { TelegramDatabase } from "./telegram-database.ts";
import { makeTelegramDeliveryStore } from "./telegram-delivery-store.ts";
import { makeTelegramInboxStore } from "./telegram-inbox-store.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";
import { makeTelegramStageStore } from "./telegram-stage-store.ts";
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

async function claimInboxRow(
  store: ReturnType<typeof makeControlPlaneTelegramStore>,
  admin: Client,
  inboxId: string,
  updateId: number,
) {
  await admin.query(
    "INSERT INTO community_telegram_inbox(inbox_id,community_id,bot_epoch,update_id,payload) VALUES($1,'telegram-community','epoch',$2,'{}'::jsonb)",
    [inboxId, updateId],
  );
  const item = await store.claimInbox(inboxId);
  if (!item) throw new Error("Missing inbox claim");
  return item;
}

async function reattempt(admin: Client, inboxId: string, attempt: string) {
  await admin.query(
    "UPDATE community_telegram_inbox SET state='processing',attempt=$2,lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE inbox_id=$1",
    [inboxId, attempt],
  );
}

async function schemaClient(admin: Client): Promise<Client> {
  const base = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
  if (!base) throw new Error("Postgres configuration missing");
  const schema = String((await admin.query("SELECT current_schema() AS name")).rows[0]?.name);
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

function deferredGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlocked(
  observer: Client,
  queryText: string,
  blockerPid: number,
  attempts = 40,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = (
      await observer.query(
        "SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE query=$1 AND pg_blocking_pids(pid) @> ARRAY[$2::int]",
        [queryText, blockerPid],
      )
    ).rows;
    if (Number(rows[0]?.blocked) > 0) return true;
    await Bun.sleep(50);
  }
  return false;
}

function clientDatabase(
  client: Client,
  gate: { fragment: string; release: Promise<void>; entered: () => void },
): TelegramDatabase {
  const run = async (sql: string, parameters: readonly unknown[] = []) =>
    (await client.query(sql, [...parameters])).rows;
  return {
    query: run,
    transaction: async <T>(operation: (query: typeof run) => Promise<T>): Promise<T> => {
      await client.query("BEGIN");
      const query = async (sql: string, parameters: readonly unknown[] = []) => {
        const rows = await run(sql, parameters);
        if (sql.includes(gate.fragment)) {
          gate.entered();
          await gate.release;
        }
        return rows;
      };
      try {
        const result = await operation(query);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  } as unknown as TelegramDatabase;
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
    fixture(async (store, admin) => {
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
      expect(
        (
          await admin.query(
            "SELECT state FROM community_telegram_deliveries WHERE delivery_id='uncertain'",
          )
        ).rows[0],
      ).toEqual({ state: "delivered" });
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
      expect(
        (
          await admin.query(
            "SELECT state FROM community_telegram_deliveries WHERE delivery_id='delivery'",
          )
        ).rows[0],
      ).toEqual({ state: "uncertain" });
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
      expect(
        (
          await admin.query(
            "SELECT state FROM community_telegram_deliveries WHERE delivery_id='delivery'",
          )
        ).rows[0],
      ).toEqual({ state: "withdrawn" });
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
    fixture(async (store, admin) => {
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
        (
          await admin.query(
            "SELECT state,count(*)::int AS count FROM community_telegram_deliveries WHERE kind<>'publication' GROUP BY state",
          )
        ).rows,
      ).toEqual([{ state: "cancelled", count: 3 }]);
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

  test("a provider stage reuses a confirmed result and never re-issues an unresolved attempt", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "stage-inbox-a", 11);
      const transcription = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "stage-inbox-a",
        stage: "transcription" as const,
        requestHash: "request-a",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(transcription)).toEqual({ kind: "issued" });
      await store.completeProviderStage({ ...transcription, result: "Transcript" });
      await reattempt(admin, "stage-inbox-a", "attempt-b");
      expect(await store.beginProviderStage({ ...transcription, attempt: "attempt-b" })).toEqual({
        kind: "completed",
        result: "Transcript",
      });
      const completion = { ...transcription, stage: "completion" as const };
      expect(await store.beginProviderStage({ ...completion, attempt: "attempt-b" })).toEqual({
        kind: "issued",
      });
      await reattempt(admin, "stage-inbox-a", "attempt-c");
      expect(await store.beginProviderStage({ ...completion, attempt: "attempt-c" })).toEqual({
        kind: "uncertain",
      });
      await store.completeProviderStage({ ...completion, attempt: "attempt-b", result: "Answer" });
      expect(await store.beginProviderStage({ ...completion, attempt: "attempt-c" })).toEqual({
        kind: "uncertain",
      });
    }));

  test("a definite provider stage failure is re-issued for a later attempt", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "stage-inbox-b", 12);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "stage-inbox-b",
        stage: "completion" as const,
        requestHash: "request-b",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      await store.failProviderStage({ ...input, error: "rate_limited" });
      await reattempt(admin, "stage-inbox-b", "attempt-b");
      expect(await store.beginProviderStage({ ...input, attempt: "attempt-b" })).toEqual({
        kind: "issued",
      });
      await store.completeProviderStage({ ...input, attempt: "attempt-b", result: "Answer" });
      await reattempt(admin, "stage-inbox-b", "attempt-c");
      expect(await store.beginProviderStage({ ...input, attempt: "attempt-c" })).toEqual({
        kind: "completed",
        result: "Answer",
      });
    }));

  test("cleanup retains a stale provider stage while its inbox item can still replay", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "stage-inbox-c", 13);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "stage-inbox-c",
        stage: "transcription" as const,
        requestHash: "request-c",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      await admin.query(
        "UPDATE community_telegram_provider_stages SET issued_at=clock_timestamp()-interval '25 hours' WHERE inbox_id='stage-inbox-c'",
      );
      await store.cleanup();
      expect(await store.beginProviderStage(input)).toEqual({ kind: "uncertain" });
      expect(
        (
          await admin.query(
            "SELECT state FROM community_telegram_inbox WHERE inbox_id='stage-inbox-c'",
          )
        ).rows[0],
      ).toEqual({ state: "processing" });
    }));

  test("cleanup removes a stale provider stage once its inbox item is terminal", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "stage-inbox-d", 14);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "stage-inbox-d",
        stage: "completion" as const,
        requestHash: "request-d",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      await admin.query(
        "UPDATE community_telegram_inbox SET state='failed',payload=NULL WHERE inbox_id='stage-inbox-d'",
      );
      await admin.query(
        "UPDATE community_telegram_provider_stages SET issued_at=clock_timestamp()-interval '25 hours' WHERE inbox_id='stage-inbox-d'",
      );
      await store.cleanup();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS rows FROM community_telegram_provider_stages WHERE inbox_id='stage-inbox-d'",
          )
        ).rows[0],
      ).toEqual({ rows: 0 });
    }));

  test("cleanup releases a stale provider stage when it terminalizes the inbox item", () =>
    fixture(async (store, admin) => {
      await admin.query(
        "INSERT INTO community_telegram_inbox(inbox_id,community_id,bot_epoch,update_id,payload,created_at) VALUES('stage-inbox-e','telegram-community','epoch',15,'{}'::jsonb,clock_timestamp()-interval '25 hours')",
      );
      const claimed = await store.claimInbox("stage-inbox-e");
      if (!claimed) throw new Error("Missing claim");
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "stage-inbox-e",
        stage: "transcription" as const,
        requestHash: "request-e",
        attempt: claimed.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      await admin.query(
        "UPDATE community_telegram_provider_stages SET issued_at=clock_timestamp()-interval '25 hours' WHERE inbox_id='stage-inbox-e'",
      );
      await store.cleanup();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS rows FROM community_telegram_provider_stages WHERE inbox_id='stage-inbox-e'",
          )
        ).rows[0],
      ).toEqual({ rows: 0 });
      expect(
        (
          await admin.query(
            "SELECT state,payload FROM community_telegram_inbox WHERE inbox_id='stage-inbox-e'",
          )
        ).rows[0],
      ).toEqual({ state: "failed", payload: null });
    }));

  test("channel selection binds once and refuses a stale repeat", () =>
    fixture(async (store, admin) => {
      await store.createSetup({
        tokenCiphertext: "sealed-token",
        commandHash: "command-hash",
        id: "setup-once",
        communityId: "telegram-community",
        ownerId: "telegram-owner",
        botEpoch: "epoch",
        tokenHash: "token-hash-once",
        requestId: 4242,
        telegramUserId: null,
        privateChatId: null,
        channelId: null,
        channelTitle: null,
        channelUsername: null,
        state: "pending",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      expect(await store.bindSetup("setup-once", "7", "7")).toBe(true);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        requestId: 4242,
        userId: "7",
        chatId: "7",
        channelId: "-100",
        title: "Fixture channel",
        username: null,
      };
      expect(await store.selectSetup(input)).toBe(true);
      expect(await store.selectSetup({ ...input, channelId: "-200", title: "Other" })).toBe(false);
      const record = (
        await admin.query(
          "SELECT record FROM community_telegram_setups WHERE setup_id='setup-once'",
        )
      ).rows[0]?.record as { channelId: string };
      expect(record.channelId).toBe("-100");
    }));

  test("channel membership records and clears readiness for the configured channel", () =>
    fixture(async (store, admin) => {
      await admin.query(
        "UPDATE community_telegram_integrations SET record=record || '{\"channelId\":\"-100\"}'::jsonb WHERE community_id='telegram-community'",
      );
      await store.channelMembership(
        "telegram-community",
        "epoch",
        "-100",
        "channel_membership_lost",
      );
      expect((await store.integration("telegram-community")).lastError).toBe(
        "channel_membership_lost",
      );
      await store.channelMembership(
        "telegram-community",
        "epoch",
        "-999",
        "channel_membership_lost",
      );
      expect((await store.integration("telegram-community")).lastError).toBe(
        "channel_membership_lost",
      );
      await store.channelMembership("telegram-community", "epoch", "-100", null);
      expect((await store.integration("telegram-community")).lastError).toBeNull();
    }));

  test("command admission reserves once and enforces separate limits", () =>
    fixture(async (store, admin) => {
      const limits = { user: 2, community: 10 };
      expect(
        await store.admitCommand("telegram-community", "epoch", "user-1", "command:a", limits),
      ).toBe(true);
      expect(
        await store.admitCommand("telegram-community", "epoch", "user-1", "command:a", limits),
      ).toBe(true);
      expect(
        await store.admitCommand("telegram-community", "epoch", "user-1", "command:b", limits),
      ).toBe(true);
      expect(
        await store.admitCommand("telegram-community", "epoch", "user-1", "command:c", limits),
      ).toBe(false);
      expect(
        (
          await admin.query(
            "SELECT subject,commands FROM community_telegram_usage ORDER BY subject",
          )
        ).rows,
      ).toEqual([
        { subject: "community", commands: 2 },
        { subject: "user:user-1", commands: 2 },
      ]);
    }));

  test("concurrent command admissions stop at the limit", () =>
    fixture(async (store, admin) => {
      const limits = { user: 3, community: 20 };
      const results = await Promise.all(
        ["a", "b", "c", "d", "e"].map((key) =>
          store.admitCommand("telegram-community", "epoch", "user-1", `command:${key}`, limits),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(
        (
          await admin.query(
            "SELECT commands FROM community_telegram_usage WHERE subject='user:user-1'",
          )
        ).rows[0],
      ).toEqual({ commands: 3 });
    }));

  test("deferred inbox items keep their attempt budget", () =>
    fixture(async (store, admin) => {
      await admin.query(
        "INSERT INTO community_telegram_inbox(inbox_id,community_id,bot_epoch,update_id,payload) VALUES('paced-inbox','telegram-community','epoch',21,'{}'::jsonb)",
      );
      const claimed = await store.claimInbox("paced-inbox");
      if (!claimed) throw new Error("Missing claim");
      await store.deferInbox(claimed, 60, "chat_paced");
      expect(await store.claimInbox("paced-inbox")).toBeNull();
      expect(
        (
          await admin.query(
            "SELECT state,attempts FROM community_telegram_inbox WHERE inbox_id='paced-inbox'",
          )
        ).rows[0],
      ).toEqual({ state: "pending", attempts: 0 });
      await admin.query(
        "UPDATE community_telegram_inbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE inbox_id='paced-inbox'",
      );
      expect(await store.claimInbox("paced-inbox")).not.toBeNull();
    }));

  test("chat leases serialize and pace consecutive claims", () =>
    fixture(async (store, admin) => {
      const first = await store.claimChat("telegram-community", "epoch", "7", 1);
      if (!first) throw new Error("Missing lease");
      expect(await store.claimChat("telegram-community", "epoch", "7", 1)).toBeNull();
      await store.releaseChat("telegram-community", "epoch", "7", first);
      expect(await store.claimChat("telegram-community", "epoch", "7", 1)).toBeNull();
      await admin.query(
        "UPDATE community_telegram_chat_leases SET next_allowed_at=clock_timestamp()-interval '1 second' WHERE chat_id='7'",
      );
      expect(await store.claimChat("telegram-community", "epoch", "7", 1)).not.toBeNull();
    }));

  test("a Telegram retry-after delays the next delivery attempt", () =>
    publicationFixture(async (store, admin) => {
      const base = publication();
      await store.enqueueDelivery(base);
      const claimed = await store.claimDelivery(base.id);
      if (!claimed) throw new Error("Missing claim");
      await store.finishDelivery(
        claimed,
        { kind: "rejected", code: "telegram_429", retryAfter: 30 },
        "send",
      );
      expect(await store.claimDelivery(base.id)).toBeNull();
      await admin.query(
        "UPDATE community_telegram_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1",
        [base.id],
      );
      expect(await store.claimDelivery(base.id)).not.toBeNull();
    }));

  test("an inbox claim is live only for its attempt, payload and bot epoch", () =>
    fixture(async (store, admin) => {
      await admin.query(
        "INSERT INTO community_telegram_inbox(inbox_id,community_id,bot_epoch,update_id,payload) VALUES('live-inbox','telegram-community','epoch',31,'{}'::jsonb)",
      );
      const item = await store.claimInbox("live-inbox");
      if (!item) throw new Error("Missing claim");
      expect(await store.inboxLive(item)).toBe(true);
      await admin.query(
        "UPDATE community_telegram_inbox SET state='failed',payload=NULL WHERE inbox_id='live-inbox'",
      );
      expect(await store.inboxLive(item)).toBe(false);
      await admin.query(
        "UPDATE community_telegram_inbox SET state='processing',payload='{}'::jsonb WHERE inbox_id='live-inbox'",
      );
      await admin.query(
        "UPDATE community_telegram_integrations SET bot_epoch='replacement' WHERE community_id='telegram-community'",
      );
      expect(await store.inboxLive(item)).toBe(false);
    }));

  test("an expired chat-lease holder cannot release a newer holder's lease", () =>
    fixture(async (store, admin) => {
      const first = await store.claimChat("telegram-community", "epoch", "7", 1);
      if (!first) throw new Error("Missing first lease");
      await admin.query(
        "UPDATE community_telegram_chat_leases SET lease_expires_at=clock_timestamp()-interval '1 second',next_allowed_at=clock_timestamp()-interval '1 second' WHERE chat_id='7'",
      );
      const second = await store.claimChat("telegram-community", "epoch", "7", 1);
      if (!second) throw new Error("Missing second lease");
      expect(second).not.toBe(first);
      await store.releaseChat("telegram-community", "epoch", "7", first);
      expect(
        (
          await admin.query(
            "SELECT lease_token FROM community_telegram_chat_leases WHERE chat_id='7'",
          )
        ).rows[0],
      ).toEqual({ lease_token: second });
      await store.releaseChat("telegram-community", "epoch", "7", second);
      expect(
        (
          await admin.query(
            "SELECT lease_token FROM community_telegram_chat_leases WHERE chat_id='7'",
          )
        ).rows[0],
      ).toEqual({ lease_token: null });
    }));

  test("persistence commits before cleanup invalidates and cleanup waits on its locks", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "race-inbox-a", 41);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "race-inbox-a",
        stage: "completion" as const,
        requestHash: "race-a",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      const second = await schemaClient(admin);
      const observer = await schemaClient(admin);
      try {
        const secondPid = Number(
          (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
        );
        const gate = deferredGate();
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gated = makeTelegramStageStore(
          clientDatabase(second, {
            fragment: "state='processing'",
            release: gate.promise,
            entered,
          }),
        );
        const persistence = gated.completeProviderStage({ ...input, result: "Answer" });
        await enteredPromise;
        const cleanupText =
          "UPDATE community_telegram_inbox SET state='failed',payload=NULL WHERE inbox_id='race-inbox-a'";
        const cleanup = admin.query(cleanupText);
        expect(await waitForBlocked(observer, cleanupText, secondPid)).toBe(true);
        gate.resolve();
        await persistence;
        await cleanup;
      } finally {
        await observer.end();
        await second.end();
      }
      expect(
        (
          await admin.query(
            "SELECT state,result FROM community_telegram_provider_stages WHERE inbox_id='race-inbox-a'",
          )
        ).rows[0],
      ).toEqual({ state: "completed", result: "Answer" });
      expect(
        (
          await admin.query(
            "SELECT state,payload FROM community_telegram_inbox WHERE inbox_id='race-inbox-a'",
          )
        ).rows[0],
      ).toEqual({ state: "failed", payload: null });
    }));

  test("cleanup that commits first is observed and refuses the persistence", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "race-inbox-b", 42);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "race-inbox-b",
        stage: "completion" as const,
        requestHash: "race-b",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      const second = await schemaClient(admin);
      try {
        await second.query("BEGIN");
        await second.query(
          "UPDATE community_telegram_inbox SET state='failed',payload=NULL WHERE inbox_id='race-inbox-b'",
        );
        const persistence = store.completeProviderStage({ ...input, result: "Answer" });
        expect(
          await Promise.race([
            persistence.then(() => "persisted"),
            Bun.sleep(200).then(() => "timer"),
          ]),
        ).toBe("timer");
        await second.query("COMMIT");
        await persistence;
      } finally {
        await second.end();
      }
      expect(
        (
          await admin.query(
            "SELECT state FROM community_telegram_provider_stages WHERE inbox_id='race-inbox-b'",
          )
        ).rows[0],
      ).toEqual({ state: "issued" });
    }));

  test("persistence commits before rotation and rotation waits on the epoch lock", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "race-inbox-c", 43);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "race-inbox-c",
        stage: "completion" as const,
        requestHash: "race-c",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      const second = await schemaClient(admin);
      const observer = await schemaClient(admin);
      try {
        const secondPid = Number(
          (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
        );
        const gate = deferredGate();
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gated = makeTelegramStageStore(
          clientDatabase(second, {
            fragment: "state='processing'",
            release: gate.promise,
            entered,
          }),
        );
        const persistence = gated.completeProviderStage({ ...input, result: "Answer" });
        await enteredPromise;
        const rotationText =
          "UPDATE community_telegram_integrations SET bot_epoch='replacement' WHERE community_id='telegram-community'";
        const rotation = admin.query(rotationText);
        expect(await waitForBlocked(observer, rotationText, secondPid)).toBe(true);
        gate.resolve();
        await persistence;
        await rotation;
      } finally {
        await observer.end();
        await second.end();
      }
      expect(
        (
          await admin.query(
            "SELECT state,result FROM community_telegram_provider_stages WHERE inbox_id='race-inbox-c'",
          )
        ).rows[0],
      ).toEqual({ state: "completed", result: "Answer" });
      expect(
        (
          await admin.query(
            "SELECT bot_epoch FROM community_telegram_integrations WHERE community_id='telegram-community'",
          )
        ).rows[0],
      ).toEqual({ bot_epoch: "replacement" });
    }));

  test("rotation that commits first is observed and refuses the persistence", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "race-inbox-d", 44);
      const input = {
        communityId: "telegram-community",
        epoch: "epoch",
        inboxId: "race-inbox-d",
        stage: "completion" as const,
        requestHash: "race-d",
        attempt: item.attempt,
      };
      expect(await store.beginProviderStage(input)).toEqual({ kind: "issued" });
      const second = await schemaClient(admin);
      try {
        await second.query("BEGIN");
        await second.query(
          "UPDATE community_telegram_integrations SET bot_epoch='replacement' WHERE community_id='telegram-community'",
        );
        const persistence = store.completeProviderStage({ ...input, result: "Answer" });
        expect(
          await Promise.race([
            persistence.then(() => "persisted"),
            Bun.sleep(200).then(() => "timer"),
          ]),
        ).toBe("timer");
        await second.query("COMMIT");
        await persistence;
      } finally {
        await second.end();
      }
      expect(
        (
          await admin.query(
            "SELECT state FROM community_telegram_provider_stages WHERE inbox_id='race-inbox-d'",
          )
        ).rows[0],
      ).toEqual({ state: "issued" });
    }));

  test("a reply is refused when the inbox claim was invalidated", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "race-reply", 45);
      await admin.query(
        "UPDATE community_telegram_inbox SET state='failed',payload=NULL WHERE inbox_id='race-reply'",
      );
      const second = await schemaClient(admin);
      try {
        const deliveries = makeTelegramDeliveryStore(
          clientDatabase(second, {
            fragment: "unused-fragment",
            release: Promise.resolve(),
            entered: () => {},
          }),
        );
        await deliveries.enqueueInboxReply(
          {
            id: "race-reply-delivery",
            communityId: "telegram-community",
            botEpoch: "epoch",
            chatId: "7",
            kind: "reply",
            postId: null,
            state: "pending",
            desired: { kind: "text", text: "Hello", media: null, buttons: [] },
            desiredHash: "hello",
          },
          {
            communityId: "telegram-community",
            epoch: "epoch",
            inboxId: "race-reply",
            attempt: item.attempt,
          },
        );
      } finally {
        await second.end();
      }
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS rows FROM community_telegram_deliveries WHERE delivery_id='race-reply-delivery'",
          )
        ).rows[0],
      ).toEqual({ rows: 0 });
    }));

  test("a conversation write is refused when the inbox claim was invalidated", () =>
    fixture(async (store, admin) => {
      const item = await claimInboxRow(store, admin, "race-conversation", 46);
      await admin.query(
        "UPDATE community_telegram_inbox SET state='failed',payload=NULL WHERE inbox_id='race-conversation'",
      );
      const second = await schemaClient(admin);
      try {
        const inbox = makeTelegramInboxStore(
          clientDatabase(second, {
            fragment: "unused-fragment",
            release: Promise.resolve(),
            entered: () => {},
          }),
        );
        await inbox.saveConversation(
          "telegram-community",
          "7",
          "race-conversation",
          "Prompt",
          "Answer",
          {
            communityId: "telegram-community",
            epoch: "epoch",
            inboxId: "race-conversation",
            attempt: item.attempt,
          },
        );
      } finally {
        await second.end();
      }
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS rows FROM community_telegram_conversations WHERE input_id='race-conversation'",
          )
        ).rows[0],
      ).toEqual({ rows: 0 });
    }));

  test("operator recovery lists only publications newest first", () =>
    fixture(async (store, admin) => {
      await admin.query(
        `INSERT INTO community_telegram_deliveries(delivery_id,community_id,bot_epoch,chat_id,kind,post_id,desired,desired_hash,created_at) VALUES
        ('rec-old','telegram-community','epoch','-100','publication',NULL,'{"kind":"text","text":"old","media":null,"buttons":[]}'::jsonb,'old',clock_timestamp()-interval '3 hours'),
        ('rec-new','telegram-community','epoch','-100','publication',NULL,'{"kind":"text","text":"new","media":null,"buttons":[]}'::jsonb,'new',clock_timestamp()-interval '1 hour'),
        ('rec-private','telegram-community','epoch','7','reply',NULL,'{"kind":"text","text":"private","media":null,"buttons":[]}'::jsonb,'private',clock_timestamp())`,
      );
      const page = await store.listDeliveries("telegram-community");
      expect(page.items.map((item) => item.id)).toEqual(["rec-new", "rec-old"]);
      expect(page.next_cursor).toBeNull();
    }));

  test("operator recovery paginates stably when timestamps tie", () =>
    fixture(async (store, admin) => {
      const values: string[] = [];
      for (let index = 0; index < 55; index += 1) {
        values.push(
          `('tied-${String(index).padStart(2, "0")}','telegram-community','epoch','-100','publication',NULL,'{"kind":"text","text":"tied","media":null,"buttons":[]}'::jsonb,'tied','2026-09-12 00:00:00+00'::timestamptz)`,
        );
      }
      await admin.query(
        `INSERT INTO community_telegram_deliveries(delivery_id,community_id,bot_epoch,chat_id,kind,post_id,desired,desired_hash,created_at) VALUES ${values.join(",")}`,
      );
      const first = await store.listDeliveries("telegram-community");
      expect(first.items).toHaveLength(50);
      if (first.next_cursor === null) throw new Error("Missing recovery cursor");
      const second = await store.listDeliveries("telegram-community", first.next_cursor);
      expect(second.items).toHaveLength(5);
      const ids = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(55);
      expect(first.items[0]?.id).toBe("tied-54");
    }));

  test("an invalid recovery cursor is refused", () =>
    fixture(async (store) => {
      await expect(
        store.listDeliveries("telegram-community", "not-a-cursor"),
      ).rejects.toMatchObject({ reason: "invalid" });
    }));
});
