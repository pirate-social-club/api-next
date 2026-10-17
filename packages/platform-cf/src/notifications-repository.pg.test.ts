import { afterAll, describe, expect, test } from "bun:test";
import { makeCommentThreadStore } from "./comment-thread-repository.ts";
import { makeControlPlaneCommunityModerationStore } from "./community-moderation-repository.ts";
import { withInbox } from "./notifications.pg-fixture.ts";
import { makeControlPlaneNotificationStore } from "./notifications-repository.ts";
import { registerVideoNotificationPostgresCases } from "./notifications-video.pg-cases.ts";
import { registerVideoAdmissionMatrixPostgresCases } from "./notifications-video-admission-matrix.pg-cases.ts";
import { registerVideoDeepPostgresCases } from "./notifications-video-deep.pg-cases.ts";
import { registerVideoSnapshotPostgresCases } from "./notifications-video-snapshot.pg-cases.ts";
import { makeControlPlanePublicPostSlugStore } from "./public-post-slug-repository.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connection)
  throw new Error("Postgres test URL required");
const suite = connection ? describe : describe.skip;
let completed = 0;
afterAll(async () => {
  const sentinel =
    process.env.CONTROL_PLANE_POSTGRES_NOTIFICATIONS_TEST_SENTINEL ??
    "/tmp/api-next-control-plane-postgres-notifications-suite-complete";
  if (completed === 35) {
    await Bun.write(sentinel, "notifications-postgres-complete\n");
    expect(await Bun.file(sentinel).text()).toBe("notifications-postgres-complete\n");
    console.info("Notifications PostgreSQL completion sentinel validated");
  }
});

registerVideoNotificationPostgresCases(() => {
  completed++;
});
registerVideoSnapshotPostgresCases(() => {
  completed++;
});
registerVideoAdmissionMatrixPostgresCases(() => {
  completed++;
});
registerVideoDeepPostgresCases(() => {
  completed++;
});

suite("persisted recipient-private inbox", () => {
  for (const publication of ["ordinary", "owner-approved"] as const) {
    test(`${publication} video comments publish facts but current Notifications omit unsupported destinations and preserve history`, async () => {
      await withInbox(async (fixture) => {
        const { admin, publish, submit, run, store, navigation, runtime, personas } = fixture;
        const moderation = makeControlPlaneCommunityModerationStore(runtime);
        const publishComment = async (key: string, post: string, parent?: string) => {
          const actor = parent ? "inbox-other" : "inbox-author";
          if (publication === "ordinary") return publish(key, parent, actor, post);
          const held = await submit(key, parent, actor, true, post);
          if (held.kind !== "created" || !held.snapshot.review_ref)
            throw new Error("held comment required");
          expect(held.snapshot.status).toBe("manual_review");
          const receipt = (
            await admin.query(
              "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions WHERE submission_id=$1",
              [held.snapshot.submission_id],
            )
          ).rows;
          const action = {
            caseRef: held.snapshot.review_ref,
            actor: { kind: "user" as const, userId: "inbox-author" },
            idempotencyKey: `approve-${key}`,
            requestHash: "8".repeat(64),
            expectedCaseRevision: 1,
            action: "approve_as_general" as const,
          };
          const approved = await run(moderation.actOnCase(action));
          expect(await run(moderation.actOnCase(action))).toEqual(approved);
          expect(
            (
              await admin.query(
                "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions WHERE submission_id=$1",
                [held.snapshot.submission_id],
              )
            ).rows,
          ).toEqual(receipt);
          const facts = await admin.query(
            "SELECT outbox_event_id,comment_id FROM content_publication_outbox WHERE submission_id=$1 AND event_type='comment_notification'",
            [held.snapshot.submission_id],
          );
          expect(facts.rows).toHaveLength(1);
          return {
            eventId: facts.rows[0].outbox_event_id as string,
            commentId: facts.rows[0].comment_id as string,
          };
        };
        for (const type of ["text", "song", "video"]) {
          await admin.query(
            `INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,body,created_at,updated_at)
             VALUES ('inbox-community',$1,'inbox-owner',$2,$3,'published','public','Owned parent',now(),now())`,
            [`${type}-post`, personas["inbox-owner"], type === "video" ? "text" : type],
          );
          await admin.query(
            "INSERT INTO post_slug_aliases(post_id,slug,slug_policy_version) VALUES ($1,$1,'post-slug-v1')",
            [`${type}-post`],
          );
        }
        // A genuinely delivered supported target becomes currently unsupported.
        // No receipt/guard bypass or fabricated delivered outcome seeds history.
        const oldRoot = await publishComment("historical-root", "video-post");
        const oldReply = await publishComment("historical-reply", "video-post", oldRoot.commentId);
        const historical = (
          await admin.query(
            "SELECT notification_id,recipient_user_id,source_event_id FROM notification_inbox ORDER BY delivery_order",
          )
        ).rows;
        expect(historical).toHaveLength(2);
        const oldRootNotification = historical.find(
          (row) => row.source_event_id === oldRoot.eventId,
        );
        if (!oldRootNotification) throw new Error("historical delivery required");
        await run(
          store.read({
            recipientUserId: "inbox-owner",
            notificationId: oldRootNotification.notification_id,
          }),
        );
        const snapshot = async () =>
          (
            await admin.query(
              `SELECT to_jsonb(fact)::text AS fact,to_jsonb(delivery)::text AS delivery,
              to_jsonb(inbox)::text AS inbox,encode(submission.response_snapshot_bytes,'hex') AS receipt
             FROM content_publication_outbox fact
             JOIN notification_publication_deliveries delivery ON delivery.source_event_id=fact.outbox_event_id
             LEFT JOIN notification_inbox inbox ON inbox.source_event_id=fact.outbox_event_id
             JOIN text_content_submissions submission USING(community_id,submission_id)
             WHERE fact.outbox_event_id=ANY($1::text[]) ORDER BY fact.outbox_event_id`,
              [[oldRoot.eventId, oldReply.eventId]],
            )
          ).rows;
        const before = await snapshot();
        await admin.query("UPDATE posts SET post_type='video' WHERE post_id='video-post'");
        const currentVideoRoot = await publishComment("video-root", "video-post");
        const currentVideoReply = await publishComment(
          "video-reply",
          "video-post",
          currentVideoRoot.commentId,
        );
        for (const source of [currentVideoRoot, currentVideoReply]) {
          expect(
            (
              await admin.query(
                "SELECT outcome,notification_id FROM notification_publication_deliveries WHERE source_event_id=$1",
                [source.eventId],
              )
            ).rows,
          ).toEqual([{ outcome: "suppressed", notification_id: null }]);
          expect(await run(store.deliver({ sourceEventId: source.eventId }))).toEqual({
            processed: false,
            delivered: false,
          });
          expect(
            (
              await admin.query(
                "SELECT notification_id FROM notification_inbox WHERE source_event_id=$1",
                [source.eventId],
              )
            ).rows,
          ).toEqual([]);
          await expect(
            admin.query(
              "INSERT INTO notification_inbox(recipient_user_id,source_event_id) VALUES ($1,$2)",
              [source === currentVideoRoot ? "inbox-owner" : "inbox-author", source.eventId],
            ),
          ).rejects.toThrow("authorized persisted comment notification recipient required");
        }
        const controls: Awaited<ReturnType<typeof publishComment>>[] = [];
        for (const type of ["text", "song"]) {
          const root = await publishComment(`${type}-root`, `${type}-post`);
          const reply = await publishComment(`${type}-reply`, `${type}-post`, root.commentId);
          for (const source of [root, reply]) {
            expect(
              await run(
                navigation.resolve({ viewerUserId: "inbox-owner", commentId: source.commentId }),
              ),
            ).toMatchObject({
              kind: "available",
              post_path: `/posts/${type}-post`,
              target_comment_id: source.commentId,
            });
            expect(await run(store.deliver({ sourceEventId: source.eventId }))).toEqual({
              processed: false,
              delivered: true,
            });
          }
          controls.push(root, reply);
        }
        for (const recipient of ["inbox-owner", "inbox-author"]) {
          const page = await run(store.list({ recipientUserId: recipient }));
          expect(page.items).toHaveLength(2);
          expect(page.unread_count).toBe(2);
          expect(
            page.items.every((item) =>
              controls.some((source) => source.commentId === item.target.comment_id),
            ),
          ).toBe(true);
          for (const item of page.items)
            expect(
              await run(
                store.read({ recipientUserId: recipient, notificationId: item.notification_id }),
              ),
            ).toMatchObject({ notification_id: item.notification_id });
          expect((await run(store.list({ recipientUserId: recipient }))).unread_count).toBe(0);
        }
        for (const source of [oldRoot, oldReply, currentVideoRoot, currentVideoReply])
          await expect(
            run(navigation.resolve({ viewerUserId: "inbox-owner", commentId: source.commentId })),
          ).rejects.toThrow("Comment not found");
        for (const row of historical)
          await expect(
            run(
              store.read({
                recipientUserId: row.recipient_user_id,
                notificationId: row.notification_id,
              }),
            ),
          ).rejects.toThrow("Notification not found");
        for (const source of [oldRoot, oldReply])
          expect(await run(store.deliver({ sourceEventId: source.eventId }))).toEqual({
            processed: false,
            delivered: true,
          });
        expect(await run(store.recover())).toMatchObject({ examined: 0 });
        expect(await snapshot()).toEqual(before);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS count FROM comments WHERE post_id='video-post' AND status='published'",
            )
          ).rows[0].count,
        ).toBe(4);
        // Current omission is reversible. Existing outcomes are not recomputed:
        // historical deliveries return; newly suppressed facts stay suppressed.
        await admin.query("UPDATE posts SET post_type='text' WHERE post_id='video-post'");
        expect((await run(store.list({ recipientUserId: "inbox-owner" }))).items).toHaveLength(3);
        expect((await run(store.list({ recipientUserId: "inbox-owner" }))).unread_count).toBe(0);
        expect((await run(store.list({ recipientUserId: "inbox-author" }))).unread_count).toBe(1);
        expect(await snapshot()).toEqual(before);
        for (const source of [currentVideoRoot, currentVideoReply])
          expect(await run(store.deliver({ sourceEventId: source.eventId }))).toEqual({
            processed: false,
            delivered: false,
          });
      });
      completed++;
    }, 120000);
  }

  test("opposite-recipient concurrent publications commit without upgrading actor account foreign-key locks", async () => {
    await withInbox(async ({ admin, publish, run, store, personas }) => {
      await admin.query(
        `INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,body,created_at,updated_at)
        VALUES ('inbox-community','second-post','inbox-author',$1,'text','published','public','Body',now(),now())`,
        [personas["inbox-author"]],
      );
      await Promise.all([
        publish("cross-owner", undefined, "inbox-author"),
        publish("cross-author", undefined, "inbox-owner", "second-post"),
      ]);
      expect((await run(store.list({ recipientUserId: "inbox-owner" }))).unread_count).toBe(1);
      expect((await run(store.list({ recipientUserId: "inbox-author" }))).unread_count).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM notification_publication_deliveries WHERE outcome='delivered'",
          )
        ).rows[0].count,
      ).toBe(2);
    });
    completed++;
  }, 120000);
  test("publication derives only the post or immediate parent recipient and suppresses self/inaccessible/inactive recipients", async () => {
    await withInbox(async ({ admin, store, run, publish }) => {
      const root = await publish("root");
      await publish("direct-reply", root.commentId, "inbox-other");
      expect((await run(store.list({ recipientUserId: "inbox-owner" }))).items).toHaveLength(1);
      expect((await run(store.list({ recipientUserId: "inbox-author" }))).items).toHaveLength(1);
      expect((await run(store.list({ recipientUserId: "inbox-other" }))).items).toEqual([]);
      await publish("self", undefined, "inbox-owner");
      await publish("self-reply", root.commentId);
      await admin.query("UPDATE posts SET visibility='members_only' WHERE post_id='inbox-post'");
      await admin.query(
        "UPDATE community_memberships SET status='left' WHERE user_id='inbox-owner'",
      );
      const denied = await publish("no-access");
      await admin.query("UPDATE posts SET visibility='public' WHERE post_id='inbox-post'");
      expect((await run(store.list({ recipientUserId: "inbox-owner" }))).items).toHaveLength(1);
      expect(
        (
          await admin.query(
            "SELECT outcome FROM notification_publication_deliveries WHERE source_event_id=$1",
            [denied.eventId],
          )
        ).rows[0].outcome,
      ).toBe("suppressed");
      await admin.query("UPDATE users SET status='deleted' WHERE user_id='inbox-owner'");
      const inactive = await publish("inactive");
      expect(
        (
          await admin.query(
            "SELECT outcome FROM notification_publication_deliveries WHERE source_event_id=$1",
            [inactive.eventId],
          )
        ).rows[0].outcome,
      ).toBe("suppressed");
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM notification_publication_deliveries",
          )
        ).rows[0].count,
      ).toBe(6);
    });
    completed++;
  }, 120000);

  test("restart recovery finds pending and previously acknowledged missed facts, bounded and concurrent without duplicates", async () => {
    await withInbox(async ({ admin, store, run, publish, runtime }) => {
      // This disables only this new lane's hook in its disposable schema to
      // model a pre-migration missed fact. Existing guards remain enabled.
      await admin.query(
        "ALTER TABLE content_publication_outbox DISABLE TRIGGER comment_notification_inbox_publication",
      );
      const first = await publish("missed-pending");
      const second = await publish("missed-acknowledged");
      for (let index = 0; index < 50; index++) await publish(`missed-${index}`);
      await admin.query(
        "UPDATE content_publication_outbox SET state='published',published_at=now() WHERE outbox_event_id=$1",
        [second.eventId],
      );
      await admin.query(
        "ALTER TABLE content_publication_outbox ENABLE TRIGGER comment_notification_inbox_publication",
      );
      expect((await run(store.list({ recipientUserId: "inbox-owner" }))).items).toEqual([]);
      expect(await run(store.recover())).toMatchObject({
        examined: 50,
        processed: 50,
        delivered: 50,
      });
      const restarted = makeControlPlaneNotificationStore(runtime);
      const results = await Promise.all([run(store.recover()), run(restarted.recover())]);
      expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(2);
      expect((await run(restarted.list({ recipientUserId: "inbox-owner" }))).unread_count).toBe(52);
      expect(await run(restarted.recover())).toEqual({
        examined: 0,
        processed: 0,
        delivered: 0,
        suppressed: 0,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM notification_publication_deliveries WHERE source_event_id=ANY($1::text[])",
            [[first.eventId, second.eventId]],
          )
        ).rows[0].count,
      ).toBe(2);
      expect(
        (
          await admin.query(
            "SELECT bool_and(state='published') AS acknowledged FROM content_publication_outbox WHERE event_type='comment_notification'",
          )
        ).rows[0].acknowledged,
      ).toBe(true);
    });
    completed++;
  }, 120000);

  test("failure after inbox allocation rolls back publication, fact, ledger and receipt before same-key retry", async () => {
    await withInbox(async ({ admin, store, run, publish }) => {
      await admin.query(`CREATE FUNCTION fail_notification_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected delivery failure'; END $$;
        CREATE TRIGGER reject_delivery_test BEFORE INSERT ON notification_publication_deliveries FOR EACH ROW EXECUTE FUNCTION fail_notification_test()`);
      await expect(publish("atomic-retry")).rejects.toThrow();
      for (const table of [
        "comments",
        "text_content_submissions",
        "content_publication_outbox",
        "notification_inbox",
        "notification_publication_deliveries",
      ])
        expect(
          (await admin.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
        ).toBe(0);
      await admin.query("DROP TRIGGER reject_delivery_test ON notification_publication_deliveries");
      const source = await publish("atomic-retry");
      const before = (
        await admin.query(
          "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions",
        )
      ).rows;
      expect(await publish("atomic-retry")).toEqual(source);
      expect((await run(store.list({ recipientUserId: "inbox-owner" }))).items).toHaveLength(1);
      expect(
        (
          await admin.query(
            "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions",
          )
        ).rows,
      ).toEqual(before);
    });
    completed++;
  }, 120000);

  test("real held comment and reply owner approval emit only the existing publication fact once, retaining replay bytes", async () => {
    await withInbox(async ({ admin, run, publish, submit, runtime, store }) => {
      const root = await publish("moderated-parent");
      const moderation = makeControlPlaneCommunityModerationStore(runtime);
      for (const parent of [undefined, root.commentId]) {
        const held = await submit(parent ? "held-reply" : "held-root", parent, "inbox-other", true);
        if (held.kind !== "created" || !held.snapshot.review_ref)
          throw new Error("held source required");
        expect(held.snapshot.status).toBe("manual_review");
        const before = (
          await admin.query(
            "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions WHERE submission_id=$1",
            [held.snapshot.submission_id],
          )
        ).rows;
        const action = {
          caseRef: held.snapshot.review_ref,
          actor: { kind: "user" as const, userId: "inbox-author" },
          idempotencyKey: `approve-${held.snapshot.submission_id}`,
          requestHash: "7".repeat(64),
          expectedCaseRevision: 1,
          action: "approve_as_general" as const,
        };
        const first = await run(moderation.actOnCase(action));
        expect(await run(moderation.actOnCase(action))).toEqual(first);
        const facts = await admin.query(
          "SELECT event_type,state FROM content_publication_outbox WHERE submission_id=$1",
          [held.snapshot.submission_id],
        );
        expect(facts.rows).toEqual([{ event_type: "comment_notification", state: "published" }]);
        expect(
          (
            await admin.query(
              "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions WHERE submission_id=$1",
              [held.snapshot.submission_id],
            )
          ).rows,
        ).toEqual(before);
      }
      expect((await run(store.list({ recipientUserId: "inbox-owner" }))).items).toHaveLength(2);
      expect((await run(store.list({ recipientUserId: "inbox-author" }))).items).toHaveLength(1);
      expect(await run(store.recover())).toMatchObject({ examined: 0 });
    });
    completed++;
  }, 120000);

  test("depth-eight lookup positions nine bounded sibling windows and ordinary hidden-anchor continuation across readers", async () => {
    await withInbox(async ({ admin, run, navigation, seedComment, runtime }) => {
      const branch = Array.from({ length: 9 }, (_, depth) => `nav-${depth}-020`);
      const rootId = branch[0];
      const parentId = branch[7];
      const targetId = branch[8];
      if (!rootId || !parentId || !targetId)
        throw new Error("Complete depth-eight branch required");
      for (let depth = 0; depth < 9; depth++)
        for (let index = 0; index < 45; index++)
          await seedComment(
            `nav-${depth}-${String(index).padStart(3, "0")}`,
            branch[depth - 1] ?? null,
            depth,
          );
      await admin.query(
        "UPDATE comments SET status='hidden' WHERE comment_id='nav-1-000' OR comment_id >= 'nav-0-000' AND comment_id < 'nav-0-020' OR comment_id >= 'nav-1-002' AND comment_id < 'nav-1-020'",
      );
      await admin.query(
        "UPDATE comments SET content_rating='adult_18' WHERE comment_id IN ('nav-0-021','nav-1-001')",
      );
      const result = await run(
        navigation.resolve({ viewerUserId: "inbox-owner", commentId: targetId }),
      );
      if (result.kind !== "available") throw new Error("available branch required");
      expect(result.post_path).toBe("/posts/inbox-post");
      expect(result.ancestor_comment_ids).toEqual(branch.slice(0, 8));
      expect(result.windows).toHaveLength(9);
      result.windows.forEach((window, depth) => {
        const branchId = branch[depth];
        const ancestorId = depth === 0 ? null : branch[depth - 1];
        if (!branchId || ancestorId === undefined) throw new Error("Positioned branch required");
        expect(window.branch_comment_id).toBe(branchId);
        expect(window.parent_comment_id).toBe(ancestorId);
        expect(window.items).toHaveLength(20);
        expect(window.earlier_items_omitted).toBe(depth > 0);
        expect(window.next_cursor).toBe(`nav-${depth}-039`);
        expect(window.items[0]).toMatchObject({ comment_id: branchId, depth });
      });
      expect(result.windows[0]?.items[1]).toEqual({
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      });
      await admin.query("UPDATE comments SET status='hidden' WHERE comment_id='nav-0-039'");
      await seedComment("nav-0-999", null, 0);
      const threads = makeCommentThreadStore(runtime);
      const continuation = await run(
        threads.list({ viewerUserId: "inbox-other", postId: "inbox-post", cursor: "nav-0-039" }),
      );
      expect(continuation.items).toHaveLength(6);
      expect(continuation.next_cursor).toBeNull();
      expect(continuation.items[0]).toMatchObject({ comment_id: "nav-0-040" });
      await expect(
        run(
          threads.list({
            viewerUserId: "inbox-owner",
            postId: "inbox-post",
            parentCommentId: rootId,
            cursor: "nav-0-039",
          }),
        ),
      ).rejects.toThrow("Invalid comment cursor");
      await admin.query("UPDATE comments SET status='removed' WHERE comment_id=$1", [branch[4]]);
      await expect(
        run(navigation.resolve({ viewerUserId: "inbox-owner", commentId: targetId })),
      ).rejects.toThrow("Comment not found");
      await expect(
        run(
          threads.list({
            viewerUserId: "inbox-owner",
            postId: "inbox-post",
            parentCommentId: parentId,
          }),
        ),
      ).rejects.toThrow("Comment not found");
    });
    completed++;
  }, 120000);

  test("navigation rechecks membership, target/ancestor age, moderation and lifecycle without reading or rewriting receipts", async () => {
    await withInbox(async ({ admin, run, navigation, publish, store, runtime }) => {
      const root = await publish("navigate-parent");
      const reply = await publish("navigate-reply", root.commentId, "inbox-other");
      const resolve = () =>
        run(navigation.resolve({ viewerUserId: "inbox-author", commentId: reply.commentId }));
      const bytes = (
        await admin.query(
          "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions ORDER BY submission_id",
        )
      ).rows;
      expect(await resolve()).toMatchObject({
        kind: "available",
        target_comment_id: reply.commentId,
      });
      expect((await run(store.list({ recipientUserId: "inbox-author" }))).unread_count).toBe(1);
      await admin.query("UPDATE posts SET visibility='members_only' WHERE post_id='inbox-post'");
      expect(await resolve()).toMatchObject({ kind: "available", post_path: "/posts/inbox-post" });
      expect(
        await run(
          makeControlPlanePublicPostSlugStore(runtime).getCanonicalRouteByPostId({
            postId: "inbox-post",
            viewerUserId: "inbox-author",
          }),
        ),
      ).toMatchObject({ canonicalPath: null, viewer: { canRead: true } });
      await admin.query(
        "UPDATE community_memberships SET status='left' WHERE user_id='inbox-author'",
      );
      await expect(resolve()).rejects.toThrow("Comment not found");
      await admin.query(
        "UPDATE community_memberships SET status='member' WHERE user_id='inbox-author'",
      );
      await admin.query("UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1", [
        reply.commentId,
      ]);
      expect(await resolve()).toEqual({
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      });
      await admin.query("UPDATE comments SET status='hidden' WHERE comment_id=$1", [
        reply.commentId,
      ]);
      await expect(resolve()).rejects.toThrow("Comment not found");
      await admin.query("UPDATE comments SET status='published' WHERE comment_id=$1", [
        reply.commentId,
      ]);
      await admin.query("UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1", [
        root.commentId,
      ]);
      await expect(resolve()).rejects.toThrow("Comment not found");
      await admin.query("UPDATE posts SET content_rating='adult_18' WHERE post_id='inbox-post'");
      await expect(resolve()).rejects.toThrow("Comment not found");
      await admin.query("UPDATE users SET status='deleted' WHERE user_id='inbox-author'");
      await expect(resolve()).rejects.toThrow("Comment not found");
      expect(
        (
          await admin.query(
            "SELECT encode(response_snapshot_bytes,'hex') AS bytes FROM text_content_submissions ORDER BY submission_id",
          )
        ).rows,
      ).toEqual(bytes);
    });
    completed++;
  }, 120000);

  test("malformed/deep/cyclic/foreign ancestry and missing/unsupported destinations are redacted, retained erased-author content stays anonymous", async () => {
    await withInbox(async ({ admin, run, navigation, seedComment, personas, runtime }) => {
      const resolve = (commentId: string) =>
        run(navigation.resolve({ viewerUserId: "inbox-owner", commentId }));
      await expect(seedComment("missing-parent", "not-present", 1)).rejects.toThrow();
      await seedComment("bad-depth", null, 1);
      await seedComment("valid-root", null, 0);
      await seedComment("bad-child", "valid-root", 8);
      await seedComment("too-deep", null, 9);
      await seedComment("cycle-a", null, 0);
      await seedComment("cycle-b", "cycle-a", 1);
      await admin.query(
        "UPDATE comments SET parent_comment_id='cycle-b' WHERE comment_id='cycle-a'",
      );
      for (const id of ["missing", "bad-depth", "bad-child", "too-deep", "cycle-a", "cycle-b"])
        await expect(resolve(id)).rejects.toThrow("Comment not found");
      await admin.query(
        `INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,body,created_at,updated_at)
        VALUES ('inbox-community','no-alias','inbox-author',$1,'text','published','public','Body',now(),now()),
        ('inbox-community','unsupported','inbox-author',$1,'video','published','public','Body',now(),now())`,
        [personas["inbox-author"]],
      );
      await admin.query(
        "INSERT INTO post_slug_aliases(post_id,slug,slug_policy_version) VALUES ('unsupported','unsupported','post-slug-v1')",
      );
      await seedComment("no-alias-comment", null, 0, "no-alias");
      await seedComment("unsupported-comment", null, 0, "unsupported");
      await seedComment("foreign-child", "valid-root", 1, "no-alias");
      for (const id of ["no-alias-comment", "unsupported-comment", "foreign-child"])
        await expect(resolve(id)).rejects.toThrow("Comment not found");
      await admin.query("UPDATE users SET status='deleted' WHERE user_id='inbox-author'");
      const retained = await resolve("valid-root");
      expect(retained).toMatchObject({
        kind: "available",
        windows: [
          { items: [{ comment_id: "valid-root", body: "valid-root", author_persona: null }] },
        ],
      });
      const threads = makeCommentThreadStore(runtime);
      expect(
        await run(
          threads.list({
            viewerUserId: "inbox-owner",
            postId: "inbox-post",
            parentCommentId: "valid-root",
          }),
        ),
      ).toMatchObject({ items: [{ comment_id: "bad-child", author_persona: null }] });
      await expect(
        run(
          threads.list({
            viewerUserId: "inbox-owner",
            postId: "inbox-post",
            parentCommentId: "bad-child",
          }),
        ),
      ).rejects.toThrow("Comment not found");
      await expect(
        run(threads.list({ viewerUserId: "inbox-author", postId: "inbox-post" })),
      ).rejects.toThrow("Post not found");
    });
    completed++;
  }, 120000);
  test("concurrent source retries deduplicate and read replay retains the first timestamp across connections", async () => {
    await withInbox(async ({ admin, store, run, publish }) => {
      const source = await publish("dedup");
      const deliveries = await Promise.all(
        Array.from({ length: 4 }, () => run(store.deliver({ sourceEventId: source.eventId }))),
      );
      expect(deliveries.every((value) => !value.processed && value.delivered)).toBe(true);
      await expect(
        admin.query(
          "INSERT INTO notification_inbox(recipient_user_id,source_event_id) VALUES ('inbox-other',$1)",
          [source.eventId],
        ),
      ).rejects.toThrow("authorized persisted comment notification recipient required");
      const first = await run(store.list({ recipientUserId: "inbox-owner" }));
      expect(first.items).toHaveLength(1);
      expect(first.unread_count).toBe(1);
      const notificationId = first.items[0]?.notification_id;
      if (!notificationId) throw new Error("missing delivery");
      const read = await Promise.all(
        Array.from({ length: 4 }, () =>
          run(store.read({ recipientUserId: "inbox-owner", notificationId })),
        ),
      );
      expect(new Set(read.map((value) => value.read_at)).size).toBe(1);
      await run(store.deliver({ sourceEventId: source.eventId }));
      expect((await run(store.list({ recipientUserId: "inbox-owner" }))).unread_count).toBe(0);
      expect(
        Number((await admin.query("SELECT count(*) FROM notification_inbox")).rows[0].count),
      ).toBe(1);
      await expect(
        admin.query("UPDATE notification_inbox SET read_at=NULL WHERE notification_id=$1", [
          notificationId,
        ]),
      ).rejects.toThrow("immutable");
      await expect(
        admin.query(
          "UPDATE notification_inbox SET recipient_user_id='inbox-other' WHERE notification_id=$1",
          [notificationId],
        ),
      ).rejects.toThrow("immutable");
      expect((await run(store.list({ recipientUserId: "inbox-other" }))).unread_count).toBe(0);
      await expect(run(store.deliver({ sourceEventId: "missing" }))).rejects.toThrow();
      const unrelated = (
        await admin.query(
          "SELECT outbox_event_id FROM content_publication_outbox WHERE event_type='comment_cache_invalidation' LIMIT 1",
        )
      ).rows[0].outbox_event_id as string;
      await expect(run(store.deliver({ sourceEventId: unrelated }))).rejects.toThrow();
    });
    completed++;
  }, 120000);

  test("bounded keyset pages neither duplicate nor skip old deliveries after new arrival, read or hidden anchor", async () => {
    await withInbox(async ({ admin, store, run, publish }) => {
      for (let i = 0; i < 23; i++) {
        const source = await publish(`page-${i}`);
        await run(store.deliver({ sourceEventId: source.eventId }));
      }
      const page = await run(store.list({ recipientUserId: "inbox-owner" }));
      expect(page.items).toHaveLength(20);
      expect(page.unread_count).toBe(23);
      if (!page.next_cursor) throw new Error("missing cursor");
      await run(store.read({ recipientUserId: "inbox-owner", notificationId: page.next_cursor }));
      await admin.query("UPDATE comments SET status='hidden' WHERE comment_id=$1", [
        page.items[19]?.target.comment_id,
      ]);
      const late = await publish("late");
      await run(store.deliver({ sourceEventId: late.eventId }));
      const next = await run(
        store.list({ recipientUserId: "inbox-owner", cursor: page.next_cursor }),
      );
      expect(next.items).toHaveLength(3);
      expect(next.next_cursor).toBeNull();
      expect(
        next.items.every(
          (item) => !page.items.some((first) => first.notification_id === item.notification_id),
        ),
      ).toBe(true);
      await expect(
        run(store.list({ recipientUserId: "inbox-other", cursor: page.next_cursor })),
      ).rejects.toThrow("Invalid notification cursor");
      await expect(
        run(store.list({ recipientUserId: "inbox-owner", cursor: "bad" })),
      ).rejects.toThrow("Invalid notification cursor");
    });
    completed++;
  }, 120000);

  test("list/count/read share current membership, age, moderation, ancestry and lifecycle privacy", async () => {
    await withInbox(async ({ admin, store, run, publish }) => {
      const parent = await publish("parent");
      const reply = await publish("reply", parent.commentId, "inbox-other");
      const delivery = (await run(store.list({ recipientUserId: "inbox-author" }))).items[0];
      if (!delivery) throw new Error("missing reply delivery");
      const list = () => run(store.list({ recipientUserId: "inbox-author" }));
      const read = (recipientUserId = "inbox-author") =>
        run(store.read({ recipientUserId, notificationId: delivery.notification_id }));
      expect((await list()).items[0]?.kind).toBe("reply_published");
      expect((await run(store.list({ recipientUserId: "inbox-other" }))).items).toEqual([]);
      await expect(read("inbox-other")).rejects.toThrow("Notification not found");
      await expect(
        run(store.read({ recipientUserId: "inbox-other", notificationId: crypto.randomUUID() })),
      ).rejects.toThrow("Notification not found");
      const denied = async () => {
        expect(await list()).toMatchObject({ items: [], unread_count: 0 });
        await expect(read()).rejects.toThrow("Notification not found");
      };
      await admin.query("UPDATE posts SET visibility='members_only' WHERE post_id='inbox-post'");
      await admin.query(
        "UPDATE community_memberships SET status='left' WHERE membership_id='inbox-author-member'",
      );
      await denied();
      await admin.query(
        "UPDATE community_memberships SET status='member' WHERE membership_id='inbox-author-member'",
      );
      expect((await list()).unread_count).toBe(1);
      await admin.query(
        "UPDATE community_memberships SET status='left' WHERE membership_id='inbox-author-member'",
      );
      await denied();
      await admin.query("UPDATE posts SET visibility='public' WHERE post_id='inbox-post'");
      for (const status of ["hidden", "removed"]) {
        await admin.query("UPDATE comments SET status=$1 WHERE comment_id=$2", [
          status,
          parent.commentId,
        ]);
        await denied();
        await admin.query("UPDATE comments SET status='published' WHERE comment_id=$1", [
          parent.commentId,
        ]);
      }
      await admin.query("UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1", [
        parent.commentId,
      ]);
      await denied();
      await admin.query("UPDATE users SET status='deleted' WHERE user_id='inbox-author'");
      expect(
        Number(
          (
            await admin.query(
              "SELECT count(*) FROM notification_inbox WHERE recipient_user_id='inbox-author'",
            )
          ).rows[0].count,
        ),
      ).toBe(0);
      expect(await run(store.deliver({ sourceEventId: reply.eventId }))).toEqual({
        processed: false,
        delivered: true,
      });
      expect(
        (
          await admin.query(
            "SELECT response_snapshot_sha256=encode(sha256(response_snapshot_bytes),'hex') AS intact FROM text_content_submissions",
          )
        ).rows.every((row) => row.intact),
      ).toBe(true);
    });
    completed++;
  }, 120000);
});
