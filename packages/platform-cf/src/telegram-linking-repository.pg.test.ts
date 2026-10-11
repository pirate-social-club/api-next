import { describe, expect, test } from "bun:test";
import type { TelegramLinkBrowser } from "@pirate/application/telegram-linking";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneTelegramLinkStore } from "./telegram-linking-repository.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("Postgres test URL required");
const suite = connectionString ? describe : describe.skip;
const browser: TelegramLinkBrowser = {
  accountId: "learner",
  sessionHash: "s".repeat(43),
  browserHash: "b".repeat(43),
};
const other: TelegramLinkBrowser = { ...browser, accountId: "other" };
const stateHash = "h".repeat(43);
let sequence = 0;
async function fixture(
  use: (
    store: ReturnType<typeof makeControlPlaneTelegramLinkStore>,
    admin: Client,
  ) => Promise<void>,
) {
  if (!connectionString) throw new Error("Postgres test URL required");
  await withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "telegram_linking_pg_test",
    use: async ({ admin, schema }) => {
      const scoped = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      await admin.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role=replica");
      try {
        await admin.query("INSERT INTO users(user_id) VALUES('learner'),('other')");
        await admin.query(`INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at)
        VALUES('music','Music fixture','active','learner',clock_timestamp(),clock_timestamp())`);
        await admin.query(`INSERT INTO personas(persona_id,account_id,status) VALUES('persona','learner','active'),
        ('second','learner','active'),('foreign','other','active'),('unbound','learner','active'),('inactive','learner','pending_wallet')`);
        await admin.query(`INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source)
        VALUES('persona','learner','music','first_membership'),('second','learner','music','first_membership'),('foreign','other','music','first_membership'),('inactive','learner','music','first_membership')`);
        await admin.query(`INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,created_at,updated_at)
        VALUES('music','song','learner','persona','song','published','public',clock_timestamp(),clock_timestamp())`);
      } finally {
        await admin.query("SET session_replication_role=origin");
      }
      const record = {
        ...emptyTelegramIntegration("music"),
        botEpoch: "epoch",
        botId: "123",
        botUsername: "community_fixture_bot",
        status: "ready",
      };
      await admin.query(
        `INSERT INTO community_telegram_integrations(community_id,record,revision,bot_epoch,webhook_id)
      VALUES('music',$1::jsonb,1,'epoch','hook')`,
        [JSON.stringify(record)],
      );
      await admin.query(
        "INSERT INTO community_telegram_private_chats(community_id,bot_epoch,telegram_user_id) VALUES('music','epoch','321')",
      );
      await use(
        makeControlPlaneTelegramLinkStore(makeDirectPostgresControlPlaneLayer(scoped)),
        admin,
      );
    },
  });
}
async function pending(
  store: ReturnType<typeof makeControlPlaneTelegramLinkStore>,
  owner = browser,
) {
  const suffix = String(++sequence).padStart(4, "0");
  const navigationHash = "n".repeat(39) + suffix;
  const id = "i".repeat(39) + suffix;
  await store.createNavigation({
    referenceHash: navigationHash,
    communityId: "music",
    botId: "123",
    epoch: "epoch",
    telegramUserId: "321",
    postId: "song",
  });
  const result = await store.start({
    id,
    browser: owner,
    navigationHash,
    stateHash,
    secretCiphertext: "encrypted-fixture",
  });
  expect(result.state).toBe("pending");
  return id;
}
async function verified(
  store: ReturnType<typeof makeControlPlaneTelegramLinkStore>,
  owner = browser,
) {
  const id = await pending(store, owner);
  await store.claim(id, owner, stateHash);
  await store.verified(id, owner, "321");
  return id;
}
suite("durable Telegram linking authority", () => {
  test("verification alone creates no association; explicit confirmation is atomic and replayable", () =>
    fixture(async (store, admin) => {
      const id = await verified(store);
      expect((await admin.query("SELECT * FROM telegram_account_associations")).rows).toHaveLength(
        0,
      );
      expect(
        (await admin.query("SELECT secret_ciphertext,state_hash FROM telegram_link_transactions"))
          .rows,
      ).toEqual([{ secret_ciphertext: null, state_hash: null }]);
      const grant = await store.confirm(id, browser, "persona");
      expect(grant).toMatchObject({
        community_id: "music",
        bot_id: "123",
        telegram_user_id: "321",
        persona_id: "persona",
        revision: 1,
      });
      expect(await store.confirm(id, browser, "persona")).toEqual(grant);
      expect(await store.list("learner")).toEqual({ telegram_user_ids: ["321"], grants: [grant] });
      expect(await store.list("other")).toEqual({ telegram_user_ids: [], grants: [] });
      expect(await store.resolveGrant("music", "123", "epoch", "321")).toEqual({
        accountId: "learner",
        personaId: "persona",
        revision: 1,
      });
    }));
  test(
    "wrong account/session/browser/state cannot consume a callback; concurrent claims exchange only once",
    () =>
      fixture(async (store, admin) => {
        const id = await pending(store);
        for (const attacker of [
          other,
          { ...browser, sessionHash: "x".repeat(43) },
          { ...browser, browserHash: "x".repeat(43) },
        ]) {
          await expect(store.findPending(stateHash, attacker)).rejects.toMatchObject({
            reason: "not_found",
          });
          await expect(store.get(id, attacker)).rejects.toBeDefined();
          await expect(store.claim(id, attacker, stateHash)).rejects.toBeDefined();
        }
        expect(await store.findPending(stateHash, browser)).toBe(id);
        await admin.query(
          `INSERT INTO telegram_link_transactions(transaction_id,account_id,session_hash,browser_hash,state_hash,secret_ciphertext,community_id,bot_id,bot_epoch,expected_telegram_user_id,post_id,state)
        SELECT $2,account_id,session_hash,browser_hash,state_hash,secret_ciphertext,community_id,bot_id,bot_epoch,expected_telegram_user_id,post_id,state FROM telegram_link_transactions WHERE transaction_id=$1`,
          [id, "a".repeat(43)],
        );
        await expect(store.findPending(stateHash, browser)).rejects.toMatchObject({
          reason: "not_found",
        });
        await admin.query("DELETE FROM telegram_link_transactions WHERE transaction_id=$1", [
          "a".repeat(43),
        ]);

        await expect(store.findPending("x".repeat(43), browser)).rejects.toMatchObject({
          reason: "not_found",
        });
        await expect(store.claim(id, browser, "x".repeat(43))).rejects.toBeDefined();
        const results = await Promise.allSettled([
          store.claim(id, browser, stateHash),
          store.claim(id, browser, stateHash),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        await expect(store.claim(id, browser, stateHash)).rejects.toBeDefined();
        await expect(store.findPending(stateHash, browser)).rejects.toMatchObject({
          reason: "not_found",
        });
      }),
    20_000,
  );
  test("copied navigation cannot prove a different Telegram user or create an association", () =>
    fixture(async (store, admin) => {
      const id = await pending(store, other);
      await store.claim(id, other, stateHash);
      await expect(store.verified(id, other, "999")).rejects.toBeDefined();
      await store.fail(id, other);
      expect((await store.get(id, other)).state).toBe("failed");
      expect((await admin.query("SELECT * FROM telegram_account_associations")).rows).toHaveLength(
        0,
      );
    }));
  test("explicit persona must be active and bound to the exact community", () =>
    fixture(async (store, admin) => {
      const id = await verified(store);
      for (const persona of ["foreign", "unbound", "missing", "inactive"])
        await expect(store.confirm(id, browser, persona)).rejects.toBeDefined();
      expect((await admin.query("SELECT * FROM telegram_account_associations")).rows).toHaveLength(
        0,
      );
      await store.confirm(id, browser, "persona"); // no membership exists in this fixture
    }));
  test("conflicting accounts cannot steal a proven association, including concurrent confirmations", () =>
    fixture(async (store, admin) => {
      const first = await verified(store);
      const second = await verified(store, other);
      const outcomes = await Promise.allSettled([
        store.confirm(first, browser, "persona"),
        store.confirm(second, other, "foreign"),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.find((r) => r.status === "rejected");
      expect(refused?.status === "rejected" ? refused.reason : null).toMatchObject({
        reason: "identity_conflict",
      });
      expect((await admin.query("SELECT * FROM telegram_account_associations")).rows).toHaveLength(
        1,
      );
      expect(
        (await admin.query("SELECT * FROM telegram_bot_grants WHERE active")).rows,
      ).toHaveLength(1);
    }));
  test("same-bot rotation cancels pending actions and retains consent behind a fresh /start fence", () =>
    fixture(async (store, admin) => {
      const complete = await verified(store);
      await store.confirm(complete, browser, "persona");
      const waiting = await pending(store);
      await admin.query(
        `UPDATE community_telegram_integrations SET record=record||'{"botEpoch":"rotated"}'::jsonb,bot_epoch='rotated' WHERE community_id='music'`,
      );
      expect(
        (
          await admin.query(
            "SELECT state,secret_ciphertext FROM telegram_link_transactions WHERE transaction_id=$1",
            [waiting],
          )
        ).rows,
      ).toEqual([{ state: "cancelled", secret_ciphertext: null }]);
      expect(await store.resolveGrant("music", "123", "epoch", "321")).toBeNull();
      expect(await store.resolveGrant("music", "123", "rotated", "321")).toBeNull();
      await admin.query(
        "INSERT INTO community_telegram_private_chats(community_id,bot_epoch,telegram_user_id) VALUES('music','rotated','321')",
      );
      expect(await store.resolveGrant("music", "123", "rotated", "321")).toMatchObject({
        personaId: "persona",
        revision: 1,
      });
      await admin.query(
        `UPDATE community_telegram_integrations SET record=record||'{"botId":"456","botEpoch":"replacement"}'::jsonb,bot_epoch='replacement' WHERE community_id='music'`,
      );
      expect((await admin.query("SELECT active,revision FROM telegram_bot_grants")).rows).toEqual([
        { active: false, revision: "2" },
      ]);
      expect(await store.resolveGrant("music", "456", "replacement", "321")).toBeNull();
    }));
  test("revocation and unlink fence pending actions and completed-response replay", () =>
    fixture(async (store, admin) => {
      const complete = await verified(store);
      await store.confirm(complete, browser, "persona");
      const waiting = await verified(store);
      await store.revoke(browser, "music", "123");
      await expect(store.confirm(complete, browser, "persona")).rejects.toBeDefined();
      await expect(store.confirm(waiting, browser, "persona")).rejects.toBeDefined();
      expect(await store.resolveGrant("music", "123", "epoch", "321")).toBeNull();
      const fresh = await verified(store);
      expect((await store.confirm(fresh, browser, "second")).revision).toBe(3);
      await store.unlink(browser, "321");
      await expect(store.confirm(fresh, browser, "second")).rejects.toBeDefined();
      expect((await admin.query("SELECT * FROM telegram_account_associations")).rows).toHaveLength(
        0,
      );
      const relink = await verified(store);
      expect((await store.confirm(relink, browser, "persona")).revision).toBe(5);
      await expect(store.confirm(complete, browser, "persona")).rejects.toBeDefined();
    }));
  test("expiry, outstanding limits, readiness and bounded cleanup reject stale authority", () =>
    fixture(async (store, admin) => {
      const first = await pending(store);
      await pending(store);
      await pending(store);
      await expect(pending(store)).rejects.toBeDefined();
      await admin.query(
        "UPDATE telegram_link_transactions SET expires_at=clock_timestamp()-interval '1 second'",
      );
      await expect(store.claim(first, browser, stateHash)).rejects.toBeDefined();
      await admin.query(
        "UPDATE telegram_link_navigation SET expires_at=clock_timestamp()-interval '1 second'",
      );
      await store.cleanup();
      expect((await admin.query("SELECT * FROM telegram_link_transactions")).rows).toHaveLength(0);
      expect((await admin.query("SELECT * FROM telegram_link_navigation")).rows).toHaveLength(0);
    }));
});

suite("Telegram linking lifecycle fences", () => {
  test("new persona confirmation cancels older verification and cannot replay an old revision", () =>
    fixture(async (store) => {
      const older = await verified(store);
      const current = await verified(store);
      await store.confirm(current, browser, "persona");
      await expect(store.confirm(older, browser, "second")).rejects.toBeDefined();
      const fresh = await verified(store);
      expect((await store.confirm(fresh, browser, "second")).revision).toBe(2);
      await expect(store.confirm(current, browser, "persona")).rejects.toBeDefined();
    }));
  test("unlinked Telegram identity needs fresh proof and consent even for a different Pirate account", () =>
    fixture(async (store) => {
      const first = await verified(store);
      await store.confirm(first, browser, "persona");
      await store.unlink(browser, "321");
      const second = await verified(store, other);
      expect((await store.confirm(second, other, "foreign")).revision).toBe(3);
      await expect(store.confirm(first, browser, "persona")).rejects.toBeDefined();
    }));
  test("account deletion clears the association and fences pending consent", () =>
    fixture(async (store, admin) => {
      const first = await verified(store);
      await store.confirm(first, browser, "persona");
      const waiting = await pending(store);
      await admin.query("UPDATE users SET status='deleted' WHERE user_id='learner'");
      expect((await admin.query("SELECT * FROM telegram_account_associations")).rows).toHaveLength(
        0,
      );
      expect(
        (
          await admin.query(
            "SELECT state,secret_ciphertext FROM telegram_link_transactions WHERE transaction_id=$1",
            [waiting],
          )
        ).rows,
      ).toEqual([{ state: "cancelled", secret_ciphertext: null }]);
      expect(await store.resolveGrant("music", "123", "epoch", "321")).toBeNull();
    }));
});
