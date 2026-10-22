import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { makeControlPlaneCommentNavigationStore } from "./comment-navigation-repository.ts";
import { makeCommentThreadStore } from "./comment-thread-repository.ts";
import {
  actor,
  community,
  matrixComment,
  prepareMatrixVideo,
  startMatrixActors,
} from "./notifications-video-matrix.pg-fixture.ts";
import {
  admitVideoOrderingUpgrade,
  readVideoUpgradeFunctions,
  readVideoUpgradeHistory,
  withVideoOrderingUpgrade,
} from "./notifications-video-ordering-upgrade.pg18.fixture.ts";

const target = process.env.CONTROL_PLANE_POSTGRES18_VIDEO_UPGRADE_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES18_VIDEO_UPGRADE_TEST_REQUIRED === "1";
if (required && !target) throw new Error("PostgreSQL18 video upgrade target is required");
const suite = target ? describe : describe.skip;

suite("populated274-to275 video ordering on PostgreSQL18.6", () => {
  test("preserves real publication, notifications and invoker privileges across the one migration", async () => {
    let witness: { beforeLedgerCount: number; afterLedgerCount: number } | undefined;
    await withVideoOrderingUpgrade(async (f) => {
      await startMatrixActors(f);
      const video = await prepareMatrixVideo(f, "pg18-ordering-upgrade");
      await video.publish();
      await admitVideoOrderingUpgrade(f); // isolated synthetic CI admission, never production cutover
      const facts: { comment_id: string; outbox_event_id: string }[] = [];
      for (let index = 0; index < 41; index++)
        facts.push(await matrixComment(f, video.postId, `pg18-root-${index}`));
      const roots = facts.map((fact) => fact.comment_id);
      await f.admin.query(
        `UPDATE comments SET created_at=(
        SELECT min(created_at) FROM comments WHERE comment_id=ANY($1::text[]))
        WHERE comment_id=ANY($1::text[])`,
        [roots],
      );
      const orderedRoots = (
        await f.admin.query<{ comment_id: string }>(
          "SELECT comment_id FROM comments WHERE comment_id=ANY($1::text[]) ORDER BY created_at,comment_id",
          [roots],
        )
      ).rows.map((row) => row.comment_id);
      const rootTarget = orderedRoots[20];
      if (!rootTarget) throw new Error("Beyond-first-page real root required");
      const replies: string[] = [];
      for (let index = 0; index < 41; index++)
        replies.push(
          (await matrixComment(f, video.postId, `pg18-reply-${index}`, rootTarget, "inbox-other"))
            .comment_id,
        );
      await f.admin.query(
        `UPDATE comments SET created_at=(
        SELECT min(created_at) FROM comments WHERE comment_id=ANY($1::text[]))
        WHERE comment_id=ANY($1::text[])`,
        [replies],
      );
      const orderedReplies = (
        await f.admin.query<{ comment_id: string }>(
          "SELECT comment_id FROM comments WHERE comment_id=ANY($1::text[]) ORDER BY created_at,comment_id",
          [replies],
        )
      ).rows.map((row) => row.comment_id);
      const replyTarget = orderedReplies[20];
      if (!replyTarget) throw new Error("Beyond-first-page reply required");
      const textIds: string[] = [];
      for (let index = 0; index < 21; index++)
        textIds.push((await f.publish(`pg18-text-${index}`)).commentId);
      const orderedText = (
        await f.admin.query<{ comment_id: string }>(
          "SELECT comment_id FROM comments WHERE comment_id=ANY($1::text[]) ORDER BY created_at,comment_id",
          [textIds],
        )
      ).rows.map((row) => row.comment_id);
      const rootFact = facts.find((fact) => fact.comment_id === rootTarget);
      if (!rootFact) throw new Error("Original target publication fact required");
      const terminalBefore = (
        await f.admin.query(
          "SELECT outcome,notification_id,processed_at FROM notification_publication_deliveries WHERE source_event_id=$1",
          [rootFact.outbox_event_id],
        )
      ).rows;
      expect(terminalBefore).toHaveLength(1);
      expect(terminalBefore[0]).toMatchObject({ outcome: "delivered" });
      // Normal publication already delivered this fact. Replay must preserve
      // its terminal outcome and cannot process a second notification.
      expect(await f.run(f.store.deliver({ sourceEventId: rootFact.outbox_event_id }))).toEqual({
        processed: false,
        delivered: true,
      });
      expect(
        (
          await f.admin.query(
            "SELECT outcome,notification_id,processed_at FROM notification_publication_deliveries WHERE source_event_id=$1",
            [rootFact.outbox_event_id],
          )
        ).rows,
      ).toEqual(terminalBefore);
      const notification = (
        await f.admin.query<{ notification_id: string }>(
          "SELECT notification_id FROM notification_inbox WHERE source_event_id=$1 AND recipient_user_id=$2",
          [rootFact.outbox_event_id, actor],
        )
      ).rows[0];
      if (!notification) throw new Error("Real preupgrade notification required");
      expect(notification.notification_id).toBe(terminalBefore[0]?.notification_id);
      let cursor: string | undefined;
      let found = false;
      // Six real pages cover every possible recipient among these103 facts.
      for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
        const page = await f.run(
          f.store.list({ recipientUserId: actor, ...(cursor ? { cursor } : {}) }),
        );
        if (page.items.some((item) => item.notification_id === notification.notification_id)) {
          found = true;
          break;
        }
        if (page.next_cursor === null) break;
        cursor = page.next_cursor;
      }
      expect(found).toBe(true);
      await f.run(
        f.store.read({ recipientUserId: actor, notificationId: notification.notification_id }),
      );
      const reader = makeCommentThreadStore(f.readerRuntime);
      const navigation = makeControlPlaneCommentNavigationStore(f.readerRuntime);
      const ids = (page: Awaited<ReturnType<typeof readRoots>>) =>
        page.items.map((item) => ("comment_id" in item ? item.comment_id : null));
      async function readRoots(cursor?: string) {
        return f.run(
          reader.list({
            viewerUserId: "inbox-owner",
            postId: video.postId,
            ...(cursor ? { cursor } : {}),
          }),
        );
      }
      const beforeRoots = await readRoots();
      expect(ids(beforeRoots)).toEqual(orderedRoots.slice(0, 20));
      const beforeFunctions = await readVideoUpgradeFunctions(f);
      expect(beforeFunctions).toHaveLength(2);
      for (const fn of beforeFunctions) {
        expect(fn.security_definer).toBe(false);
        expect(fn.settings).toBeNull();
        expect(fn.runtime_execute).toBe(true);
        expect(fn.runtime_owns).toBe(false);
      }
      const beforeHistory = await readVideoUpgradeHistory(f);
      const beforeLedgerCount = Number(
        (await f.admin.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]?.n,
      );
      expect(beforeLedgerCount).toBe(274);
      await f.upgrade();
      const afterFunctions = await readVideoUpgradeFunctions(f);
      expect(afterFunctions.map(({ body_sha256: _body, ...metadata }) => metadata)).toEqual(
        beforeFunctions.map(({ body_sha256: _body, ...metadata }) => metadata),
      );
      for (const [index, fn] of afterFunctions.entries())
        expect(fn.body_sha256).not.toBe(beforeFunctions[index]?.body_sha256);
      expect(await readVideoUpgradeHistory(f)).toEqual(beforeHistory);
      const descending = [...orderedRoots].reverse();
      const firstPageTail = descending[19];
      if (firstPageTail === undefined)
        throw new Error("Expected first root page boundary required");
      const first = await readRoots();
      expect(ids(first)).toEqual(descending.slice(0, 20));
      expect(first.next_cursor).toBe(firstPageTail);
      if (!first.next_cursor) throw new Error("Second root page required");
      const second = await readRoots(first.next_cursor);
      expect(ids(second)).toEqual(descending.slice(20, 40));
      if (!second.next_cursor) throw new Error("Root tail required");
      const tail = await readRoots(second.next_cursor);
      expect(ids(tail)).toEqual(descending.slice(40));
      expect(tail.next_cursor).toBeNull();
      const replyPage = await f.run(
        reader.list({
          viewerUserId: "inbox-owner",
          postId: video.postId,
          parentCommentId: rootTarget,
        }),
      );
      expect(ids(replyPage)).toEqual(orderedReplies.slice(0, 20));
      if (!replyPage.next_cursor) throw new Error("Reply continuation required");
      const replyNext = await f.run(
        reader.list({
          viewerUserId: "inbox-owner",
          postId: video.postId,
          parentCommentId: rootTarget,
          cursor: replyPage.next_cursor,
        }),
      );
      expect(ids(replyNext)).toEqual(orderedReplies.slice(20, 40));
      expect(
        ids(await f.run(reader.list({ viewerUserId: "inbox-owner", postId: "inbox-post" }))),
      ).toEqual(orderedText.slice(0, 20));
      const resolved = await f.run(
        navigation.resolve({ viewerUserId: "inbox-owner", commentId: replyTarget }),
      );
      if (resolved.kind !== "available") throw new Error("Real video target must resolve");
      expect(resolved.post_path).toBe(`/post/${video.postId}`);
      expect(resolved.ancestor_comment_ids).toEqual([rootTarget]);
      expect(resolved.windows).toHaveLength(2);
      expect(resolved.windows[0]?.items[0]).toMatchObject({ comment_id: rootTarget });
      expect(resolved.windows[0]?.earlier_items_omitted).toBe(true);
      expect(resolved.windows[0]?.next_cursor).toBe(orderedRoots[1]);
      expect(resolved.windows[1]?.items[0]).toMatchObject({ comment_id: replyTarget });
      expect(resolved.windows[1]?.next_cursor).toBe(orderedReplies[39]);
      expect(await readVideoUpgradeHistory(f)).toEqual(beforeHistory);
      const hiddenCursor = first.next_cursor;
      await f.admin.query("UPDATE comments SET status='hidden' WHERE comment_id=$1", [
        hiddenCursor,
      ]);
      expect(ids(await readRoots(hiddenCursor))).toEqual(descending.slice(20, 40));
      await f.admin.query("UPDATE posts SET visibility='members_only' WHERE post_id=$1", [
        video.postId,
      ]);
      await f.admin.query(
        "UPDATE community_memberships SET status='left',left_at=clock_timestamp() WHERE community_id=$1 AND user_id='inbox-owner'",
        [community],
      );
      await expect(readRoots(hiddenCursor)).rejects.toMatchObject({ _tag: "NotFound" });
      await expect(
        f.run(navigation.resolve({ viewerUserId: "inbox-owner", commentId: replyTarget })),
      ).rejects.toMatchObject({ _tag: "NotFound" });
      expect(
        ids(
          await f.run(
            reader.list({
              viewerUserId: "inbox-other",
              postId: video.postId,
              cursor: hiddenCursor,
            }),
          ),
        ),
      ).toEqual(descending.slice(20, 40));
      const afterLedgerCount = Number(
        (await f.admin.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]?.n,
      );
      expect(afterLedgerCount).toBe(275);
      witness = { beforeLedgerCount, afterLedgerCount };
    });
    // Written only after assertions AND maintained schema/role/socket cleanup.
    const sentinel = process.env.CONTROL_PLANE_POSTGRES18_VIDEO_UPGRADE_SENTINEL;
    if (required && !sentinel) throw new Error("PostgreSQL18 completion sentinel is required");
    if (sentinel)
      await writeFile(
        sentinel,
        `${JSON.stringify({
          case_count: 1,
          engine: 180006,
          ...witness,
          cleanup_completed: true,
          status: "passed",
        })}\n`,
        { flag: "wx" },
      );
  }, 180000);
});
