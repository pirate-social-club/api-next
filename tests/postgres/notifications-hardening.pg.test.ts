import { afterAll, describe, expect, test } from "bun:test";
import { ControlPlaneDb, ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
import { Effect } from "effect";
import { insertActiveCommunityMembershipFixture } from "../../packages/platform-cf/src/community-follow.pg-fixture.ts";
import {
  makeNotificationDeliveryStoreFromDb,
  NOTIFICATION_RECOVERY_FACTS_SQL,
} from "../../packages/platform-cf/src/notification-delivery-repository.ts";
import { withInbox } from "../../packages/platform-cf/src/notifications.pg-fixture.ts";
import { NOTIFICATION_PAGE_SQL } from "../../packages/platform-cf/src/notifications-repository.ts";
import { createActivePersonaFixture } from "../../packages/platform-cf/src/persona-wallet.pg-fixture.ts";
import {
  gate,
  pinnedRuntime,
  seedScaleHistory,
  transactionClient,
} from "./notifications-hardening-fixture.ts";
import { exerciseNotificationRoles } from "./notifications-roles-fixture.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connection)
  throw new Error("Postgres test URL required");
const suite = connection ? describe : describe.skip;
let completed = 0;
afterAll(async () => {
  if (completed !== 6) return;
  const sentinel =
    process.env.CONTROL_PLANE_POSTGRES_NOTIFICATIONS_HARDENING_TEST_SENTINEL ??
    "/tmp/api-next-control-plane-postgres-notifications-hardening-suite-complete";
  await Bun.write(sentinel, "notifications-hardening-postgres-complete\n");
  expect(await Bun.file(sentinel).text()).toBe("notifications-hardening-postgres-complete\n");
});
suite("notification review regressions", () => {
  test("terminal receipts and fact provenance refuse destructive DML while erasure and replay retain history", async () => {
    await withInbox(async (f) => {
      const first = await f.publish("guard-one");
      const second = await f.publish("guard-two");
      await expect(
        f.admin.query("DELETE FROM notification_inbox WHERE source_event_id=$1", [first.eventId]),
      ).rejects.toThrow("erasure");
      const rows = (
        await f.admin.query(
          "SELECT * FROM notification_publication_deliveries ORDER BY source_event_id",
        )
      ).rows;
      const receipt = rows.find((row) => row.source_event_id === first.eventId);
      const other = rows.find((row) => row.source_event_id === second.eventId);
      for (const sql of [
        "UPDATE notification_publication_deliveries SET outcome='suppressed' WHERE source_event_id=$1",
        "UPDATE notification_publication_deliveries SET processed_at=processed_at-interval '1 day' WHERE source_event_id=$1",
        "UPDATE notification_publication_deliveries SET notification_id=NULL WHERE source_event_id=$1",
        "UPDATE notification_publication_deliveries SET source_event_id='replacement' WHERE source_event_id=$1",
        "DELETE FROM notification_publication_deliveries WHERE source_event_id=$1",
      ])
        await expect(f.admin.query(sql, [first.eventId])).rejects.toThrow("immutable");
      for (const field of [
        "outbox_event_id='replacement'",
        "community_id='replacement'",
        "submission_id='replacement'",
        "comment_id='replacement'",
        "event_type='comment_published'",
        "effect_key='replacement'",
        "payload='{}'::jsonb",
        "created_at=created_at-interval '1 day'",
        "published_at=published_at+interval '1 second'",
        "state='pending',published_at=NULL",
        "inbox_delivery_recorded=FALSE",
      ])
        await expect(
          f.admin.query(`UPDATE content_publication_outbox SET ${field} WHERE outbox_event_id=$1`, [
            first.eventId,
          ]),
        ).rejects.toThrow("immutable");
      await expect(
        f.admin.query("DELETE FROM content_publication_outbox WHERE outbox_event_id=$1", [
          first.eventId,
        ]),
      ).rejects.toThrow("immutable");
      await f.admin.query(
        "ALTER TABLE content_publication_outbox DISABLE TRIGGER comment_notification_inbox_publication",
      );
      const missed = await f.publish("guard-missed");
      await f.admin.query(
        "ALTER TABLE content_publication_outbox ENABLE TRIGGER comment_notification_inbox_publication",
      );
      await expect(
        f.admin.query(
          "INSERT INTO notification_publication_deliveries(source_event_id,outcome,notification_id) VALUES ($1,'delivered',$2)",
          [missed.eventId, other?.notification_id],
        ),
      ).rejects.toThrow("provenance");
      await expect(
        f.admin.query(
          "INSERT INTO notification_publication_deliveries(source_event_id,outcome) VALUES ($1,'suppressed')",
          [missed.eventId],
        ),
      ).rejects.toThrow("provenance");
      await expect(
        f.admin.query(
          "UPDATE content_publication_outbox SET inbox_delivery_recorded=TRUE WHERE outbox_event_id=$1",
          [missed.eventId],
        ),
      ).rejects.toThrow("immutable");
      await f.admin.query(
        "UPDATE content_publication_outbox SET state='failed' WHERE outbox_event_id=$1",
        [missed.eventId],
      );
      await f.admin.query(
        "UPDATE content_publication_outbox SET state='published',published_at=now() WHERE outbox_event_id=$1",
        [missed.eventId],
      );
      expect(await f.run(f.store.deliver({ sourceEventId: missed.eventId }))).toEqual({
        processed: true,
        delivered: true,
      });
      await f.admin.query(
        "ALTER TABLE content_publication_outbox DISABLE TRIGGER comment_notification_inbox_publication",
      );
      const repair = await f.publish("guard-valid-receipt-repair");
      await f.admin.query(
        "ALTER TABLE content_publication_outbox ENABLE TRIGGER comment_notification_inbox_publication",
      );
      const allocated = (
        await f.admin.query(
          "INSERT INTO notification_inbox(recipient_user_id,source_event_id) VALUES ('inbox-owner',$1) RETURNING notification_id",
          [repair.eventId],
        )
      ).rows[0];
      await f.admin.query(
        "INSERT INTO notification_publication_deliveries(source_event_id,outcome,notification_id) VALUES ($1,'delivered',$2)",
        [repair.eventId, allocated.notification_id],
      );
      expect(await f.run(f.store.recover())).toMatchObject({ examined: 1, processed: 0 });
      expect(
        (
          await f.admin.query(
            "SELECT inbox_delivery_recorded FROM content_publication_outbox WHERE outbox_event_id=$1",
            [repair.eventId],
          )
        ).rows[0].inbox_delivery_recorded,
      ).toBe(true);
      await f.admin.query("UPDATE users SET status='deleted' WHERE user_id='inbox-owner'");
      const erased = (
        await f.admin.query(
          "SELECT * FROM notification_publication_deliveries WHERE source_event_id=$1",
          [first.eventId],
        )
      ).rows[0];
      expect(erased).toEqual({ ...receipt, notification_id: null });
      expect(await f.run(f.store.deliver({ sourceEventId: first.eventId }))).toEqual({
        processed: false,
        delivered: true,
      });
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM notification_inbox")).rows[0].n,
      ).toBe(0);
    });
    completed++;
  }, 120000);

  test("opposite recipients in distinct locked communities overlap at the real publication hook", async () => {
    await withInbox(async (f) => {
      await f.admin.query(
        "INSERT INTO communities(community_id,display_name,created_by_user_id,created_at,updated_at) VALUES ('other-community','Other fixture','inbox-owner',now(),now())",
      );
      for (const account of ["inbox-author", "inbox-owner"]) {
        await createActivePersonaFixture(f.admin, {
          accountId: account,
          personaId: `other-${account}`,
        });
        await f.admin.query(
          "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES ($1,$2,'other-community','first_membership')",
          [`other-${account}`, account],
        );
        await insertActiveCommunityMembershipFixture(f.admin, {
          communityId: "other-community",
          membershipId: `${account}-other`,
          userId: account,
        });
      }
      await f.admin.query(
        "INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,body,created_at,updated_at) VALUES ('other-community','other-post','inbox-author',$1,'text','published','public','Body',now(),now())",
        ["other-inbox-author"],
      );
      const clients = await Promise.all([transactionClient(f.url), transactionClient(f.url)]);
      const [firstClient, secondClient] = clients;
      if (!firstClient || !secondClient) throw new Error("two transaction clients required");
      const ready = gate();
      let arrivals = 0;
      const hook = async (label: string) => {
        if (label === "text-submission.commit.outbox.comment_notification") {
          if (++arrivals === 2) ready.release();
          await ready.promise;
        }
      };
      try {
        await Promise.all([
          f.submit(
            "cross-a",
            undefined,
            "inbox-author",
            false,
            "inbox-post",
            "inbox-community",
            pinnedRuntime(firstClient, hook),
          ),
          f.submit(
            "cross-b",
            undefined,
            "inbox-owner",
            false,
            "other-post",
            "other-community",
            pinnedRuntime(secondClient, hook),
          ),
        ]);
        expect(arrivals).toBe(2);
        await Promise.all(clients.map((client) => client.query("COMMIT")));
        expect((await f.run(f.store.list({ recipientUserId: "inbox-owner" }))).unread_count).toBe(
          1,
        );
        expect((await f.run(f.store.list({ recipientUserId: "inbox-author" }))).unread_count).toBe(
          1,
        );
      } finally {
        ready.release();
        for (const client of clients) {
          await client.query("ROLLBACK");
          await client.end();
        }
      }
    });
    completed++;
  }, 120000);

  test("publication waiting behind committed erasure cannot resurrect a deleted recipient inbox", async () => {
    await withInbox(async (f) => {
      const deletion = await transactionClient(f.url),
        publication = await transactionClient(f.url);
      const entered = gate();
      try {
        await deletion.query("UPDATE users SET status='deleted' WHERE user_id='inbox-owner'");
        const pid = (await publication.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const pending = f.submit(
          "erase-race",
          undefined,
          "inbox-author",
          false,
          "inbox-post",
          "inbox-community",
          pinnedRuntime(publication, async (label) => {
            if (label === "text-submission.commit.outbox.comment_notification") entered.release();
          }),
        );
        await entered.promise;
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = (
            await f.admin.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])
          ).rows[0].blocked;
          if (!blocked) await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        await deletion.query("COMMIT");
        await pending;
        await publication.query("COMMIT");
        expect(
          (
            await f.admin.query(
              "SELECT outcome,notification_id FROM notification_publication_deliveries",
            )
          ).rows,
        ).toEqual([{ outcome: "suppressed", notification_id: null }]);
        expect(
          (await f.admin.query("SELECT count(*)::int AS n FROM notification_inbox")).rows[0].n,
        ).toBe(0);
      } finally {
        for (const client of [deletion, publication]) {
          await client.query("ROLLBACK");
          await client.end();
        }
      }
    });
    completed++;
  }, 120000);

  test("actual committed delivery survives an injected lost acknowledgement and a restarted recovery", async () => {
    await withInbox(async (f) => {
      await f.admin.query(
        "ALTER TABLE content_publication_outbox DISABLE TRIGGER comment_notification_inbox_publication",
      );
      const source = await f.publish("lost-ack");
      await f.admin.query(
        "ALTER TABLE content_publication_outbox ENABLE TRIGGER comment_notification_inbox_publication",
      );
      const unknown = new ControlPlaneTransactionOutcomeUnknown({
        phase: "commit",
        label: "notifications.deliver",
        limitMs: 1,
        elapsedMs: 1,
      });
      const observed = await f.run(
        Effect.gen(function* () {
          const actual = yield* ControlPlaneDb;
          let lose = true;
          const db: ControlPlaneDb["Service"] = {
            ...actual,
            withTransaction: (use) =>
              Effect.gen(function* () {
                const result = yield* actual.withTransaction(use); // native COMMIT has completed
                if (lose) {
                  lose = false;
                  return yield* unknown;
                }
                return result;
              }),
          };
          return yield* Effect.flip(
            makeNotificationDeliveryStoreFromDb(db).deliver({ sourceEventId: source.eventId }),
          );
        }).pipe(Effect.provide(f.runtime)),
      );
      expect(observed).toBe(unknown);
      const before = (await f.admin.query("SELECT * FROM notification_publication_deliveries"))
        .rows;
      expect(before).toHaveLength(1);
      const item = (await f.run(f.store.list({ recipientUserId: "inbox-owner" }))).items[0];
      if (!item) throw new Error("committed notification required");
      const read = await f.run(
        f.store.read({ recipientUserId: "inbox-owner", notificationId: item.notification_id }),
      );
      expect(await f.run(f.store.recover())).toMatchObject({ examined: 0, processed: 0 });
      expect(await f.run(f.store.deliver({ sourceEventId: source.eventId }))).toEqual({
        processed: false,
        delivered: true,
      });
      expect(
        await f.run(
          f.store.read({ recipientUserId: "inbox-owner", notificationId: item.notification_id }),
        ),
      ).toEqual(read);
      expect(
        (await f.admin.query("SELECT * FROM notification_publication_deliveries")).rows,
      ).toEqual(before);
    });
    completed++;
  }, 120000);

  test("keyset projection and outstanding recovery use indexes over substantial processed/read and inaccessible history", async () => {
    await withInbox(async (f) => {
      await seedScaleHistory(f, 6000);
      await f.admin.query(
        "UPDATE notification_inbox SET read_at=clock_timestamp() WHERE source_event_id NOT IN (SELECT 'scale-event-'||n FROM generate_series(5881,6000) n)",
      );
      await f.admin.query(
        "UPDATE comments SET status='hidden' WHERE comment_id LIKE 'scale-comment-%' AND split_part(comment_id,'-',3)::int%10<>0",
      );
      await f.admin.query(
        "ALTER TABLE content_publication_outbox DISABLE TRIGGER comment_notification_inbox_publication",
      );
      for (let index = 0; index < 60; index++) await f.publish(`scale-missed-${index}`);
      await f.admin.query(
        "UPDATE content_publication_outbox SET state='published',published_at=now() WHERE event_type='comment_notification' AND NOT inbox_delivery_recorded",
      );
      await f.admin.query(
        "ALTER TABLE content_publication_outbox ENABLE TRIGGER comment_notification_inbox_publication",
      );
      await f.admin.query(
        "ANALYZE notification_inbox; ANALYZE notification_publication_deliveries; ANALYZE content_publication_outbox; ANALYZE comments; ANALYZE text_content_submissions",
      );
      const page = (
        await f.admin.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${NOTIFICATION_PAGE_SQL}`, [
          "inbox-owner",
          null,
        ])
      ).rows[0]["QUERY PLAN"];
      const cursor = (
        await f.admin.query(
          "SELECT notification_id FROM notification_inbox WHERE source_event_id='scale-event-3000'",
        )
      ).rows[0].notification_id;
      const continued = (
        await f.admin.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${NOTIFICATION_PAGE_SQL}`, [
          "inbox-owner",
          cursor,
        ])
      ).rows[0]["QUERY PLAN"];
      const recovery = (
        await f.admin.query(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${NOTIFICATION_RECOVERY_FACTS_SQL}`,
        )
      ).rows[0]["QUERY PLAN"];
      const artifact = `.wrangler/adopted-source-agent/review-fixes-query-plans-${crypto.randomUUID()}.json`;
      await Bun.write(
        artifact,
        JSON.stringify(
          {
            history: 6001,
            read: 5881,
            unread: 120,
            recipientUnread: 60,
            readableUnread: 12,
            missed: 60,
            page,
            continued,
            recovery,
          },
          null,
          2,
        ),
      );
      const walk = (node: Record<string, unknown>): Record<string, unknown>[] => [
        node,
        ...((node.Plans as Record<string, unknown>[]) ?? []).flatMap(walk),
      ];
      const pageNodes = walk(page[0].Plan),
        continuedNodes = walk(continued[0].Plan),
        recoveryNodes = walk(recovery[0].Plan);
      expect(
        pageNodes.some((node) =>
          [
            "notification_inbox_recipient_order_idx",
            "notification_inbox_delivery_order_key",
          ].includes(String(node["Index Name"])),
        ),
      ).toBe(true);
      expect(
        pageNodes.some((node) => node["Index Name"] === "notification_inbox_unread_recipient_idx"),
      ).toBe(true);
      expect(
        continuedNodes.some(
          (node) =>
            [
              "notification_inbox_recipient_order_idx",
              "notification_inbox_delivery_order_key",
            ].includes(String(node["Index Name"])) &&
            String(node["Index Cond"]).includes("delivery_order"),
        ),
      ).toBe(true);
      expect(
        pageNodes.find((node) =>
          [
            "notification_inbox_recipient_order_idx",
            "notification_inbox_delivery_order_key",
          ].includes(String(node["Index Name"])),
        )?.["Actual Rows"],
      ).toBeLessThan(300);
      expect(
        recoveryNodes.some(
          (node) =>
            node["Index Name"] === "notification_publication_source_idx" &&
            Number(node["Actual Rows"]) === 50,
        ),
      ).toBe(true);
      expect(pageNodes.find((node) => node["Subplan Name"] === "CTE page")?.["Actual Rows"]).toBe(
        21,
      );
      const result = await f.run(f.store.list({ recipientUserId: "inbox-owner" }));
      expect(result.items).toHaveLength(20);
      expect(result.unread_count).toBe(12);
      // Keep the dirty plans above: MVCC dead partial-index entries can still
      // cause history-sized heap work. Measure normal vacuum maintenance too;
      // LIMIT is never asserted as a bound on index/heap visits.
      await f.admin.query("VACUUM (ANALYZE) notification_inbox,content_publication_outbox");
      const maintainedPage = (
        await f.admin.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${NOTIFICATION_PAGE_SQL}`, [
          "inbox-owner",
          cursor,
        ])
      ).rows[0]["QUERY PLAN"];
      const maintainedRecovery = (
        await f.admin.query(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${NOTIFICATION_RECOVERY_FACTS_SQL}`,
        )
      ).rows[0]["QUERY PLAN"];
      const recoveryIndex = walk(maintainedRecovery[0].Plan).find(
        (node) => node["Index Name"] === "notification_publication_source_idx",
      );
      expect(recoveryIndex?.["Actual Rows"]).toBe(50);
      expect(recoveryIndex?.["Heap Fetches"]).toBe(0);
      await Bun.write(
        artifact,
        JSON.stringify(
          {
            history: 6001,
            read: 5881,
            unread: 120,
            recipientUnread: 60,
            readableUnread: 12,
            missed: 60,
            page,
            continued,
            recovery,
            maintenance: "VACUUM (ANALYZE) of two task-schema tables only",
            maintainedPage,
            maintainedRecovery,
          },
          null,
          2,
        ),
      );
      expect(await f.run(f.store.recover())).toMatchObject({ examined: 50, processed: 50 });
      expect(await f.run(f.store.recover())).toMatchObject({ examined: 10, processed: 10 });
    });
    completed++;
  }, 180000);

  test("real restricted HTTP, Jobs and deletion logins plus forward default ACLs execute their owned paths", async () => {
    await exerciseNotificationRoles();
    completed++;
  }, 120000);
});
