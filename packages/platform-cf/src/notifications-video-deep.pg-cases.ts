/** Real bounded inline-video target source. Parent execution only. */
import { describe, expect, test } from "bun:test";
import { makeCommentThreadStore } from "./comment-thread-repository.ts";
import { withInbox } from "./notifications.pg-fixture.ts";
import {
  admitMatrix,
  community,
  matrixComment,
  matrixHistory,
  prepareMatrixVideo,
  startMatrixActors,
} from "./notifications-video-matrix.pg-fixture.ts";
import { makeControlPlaneVideoDetailStore } from "./video-detail-repository.ts";

export function registerVideoDeepPostgresCases(completed: () => void) {
  const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL ? describe : describe.skip;
  suite("real inline video targets beyond ordinary first pages", () => {
    test("tied visible roots beyond20, depth8/9windows/20items, hidden cursor cross-reader continuation, age placeholders and current denial", async () => {
      await withInbox(async (f) => {
        await startMatrixActors(f);
        const video = await prepareMatrixVideo(f, "deep-target");
        await video.publish();
        await admitMatrix(f);
        const receiptBytes = async () =>
          (
            await f.admin.query(
              "SELECT submission_id,encode(response_snapshot_bytes,'hex') AS bytes,response_snapshot_sha256 FROM text_content_submissions ORDER BY submission_id",
            )
          ).rows;
        const branch: string[] = [];
        const siblings: string[][] = [];
        for (let depth = 0; depth <= 8; depth++) {
          const parent = depth === 0 ? undefined : branch[depth - 1];
          if (depth > 0 && parent === undefined) throw new Error("Prior branch ancestor required");
          const rows: string[] = [];
          for (let index = 0; index < 41; index++)
            rows.push(
              (
                await matrixComment(
                  f,
                  video.postId,
                  `matrix-depth-${depth}-${index}`,
                  parent,
                  depth % 2 ? "inbox-other" : "inbox-author",
                )
              ).comment_id,
            );
          const history = await matrixHistory(f);
          const receipts = await receiptBytes();
          // Arrange an explicit tie only on these new synthetic comment rows.
          // Existing receipts, fact times and delivery outcomes are untouched;
          // all normal publication/identity/rating guards remain enabled.
          expect(
            (
              await f.admin.query(
                "UPDATE comments SET created_at=(SELECT min(created_at) FROM comments WHERE comment_id=ANY($1::text[])) WHERE comment_id=ANY($1::text[])",
                [rows],
              )
            ).rowCount,
          ).toBe(41);
          expect(
            (
              await f.admin.query(
                "SELECT count(DISTINCT created_at)::int AS instants FROM comments WHERE comment_id=ANY($1::text[])",
                [rows],
              )
            ).rows,
          ).toEqual([{ instants: 1 }]);
          expect(await matrixHistory(f)).toEqual(history);
          expect(await receiptBytes()).toEqual(receipts);
          // With all timestamps equal, the actual server row-ID tie break
          // selects the 21st sibling, never an insertion-order assumption.
          const ordered = (
            await f.admin.query<{ comment_id: string }>(
              "SELECT comment_id FROM comments WHERE comment_id=ANY($1::text[]) ORDER BY created_at,comment_id",
              [rows],
            )
          ).rows.map((row) => row.comment_id);
          const selected = ordered[20];
          if (!selected) throw new Error("Beyond-first-page branch required");
          branch.push(selected);
          siblings.push(ordered);
        }
        const target = branch[8];
        const rootId = branch[0];
        const continuationParent = branch[3];
        const ancestorId = branch[4];
        const rootSiblings = siblings[0];
        if (!target || !rootId || !continuationParent || !ancestorId || !rootSiblings)
          throw new Error("Complete depth8 target and sibling groups required");
        const expectedRootFirstCursor = rootSiblings[19];
        const expectedRootNextCursor = rootSiblings[39];
        const rootTail = rootSiblings[40];
        const depth4Tail = siblings[4]?.[40];
        if (!expectedRootFirstCursor || !expectedRootNextCursor || !rootTail || !depth4Tail)
          throw new Error("Complete root and depth4 continuation fixtures required");
        const threads = makeCommentThreadStore(f.runtime);
        const firstRoots = await f.run(
          threads.list({ postId: video.postId, viewerUserId: "inbox-owner" }),
        );
        expect(
          firstRoots.items.map((item) => ("comment_id" in item ? item.comment_id : null)),
        ).toEqual(rootSiblings.slice(0, 20));
        expect(firstRoots.next_cursor).toBe(expectedRootFirstCursor);
        expect(
          firstRoots.items.some((item) => "comment_id" in item && item.comment_id === rootId),
        ).toBe(false);
        const firstRootCursor = firstRoots.next_cursor;
        if (firstRootCursor === null) throw new Error("First visible root page cursor required");
        const secondRoots = await f.run(
          threads.list({
            postId: video.postId,
            viewerUserId: "inbox-owner",
            cursor: firstRootCursor,
          }),
        );
        expect(secondRoots.items[0]).toMatchObject({ comment_id: rootId, depth: 0 });
        expect(secondRoots.items).toHaveLength(20);
        expect(secondRoots.next_cursor).toBe(expectedRootNextCursor);
        await f.admin.query("UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1", [
          siblings[2]?.[21],
        ]);
        const result = await f.run(
          f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: target }),
        );
        if (result.kind !== "available") throw new Error("Owned video branch required");
        expect(result.post_path).toBe(`/post/${video.postId}`);
        expect(result.ancestor_comment_ids).toEqual(branch.slice(0, 8));
        expect(result.windows).toHaveLength(9);
        for (const [depth, window] of result.windows.entries()) {
          const branchId = branch[depth];
          const parentId = depth === 0 ? null : branch[depth - 1];
          const expectedCursor = siblings[depth]?.[39];
          if (!branchId || parentId === undefined || !expectedCursor)
            throw new Error("Positioned branch and continuation cursor required");
          expect(window.items).toHaveLength(20);
          expect(window.branch_comment_id).toBe(branchId);
          expect(window.parent_comment_id).toBe(parentId);
          expect(window.earlier_items_omitted).toBe(true);
          expect(window.items[0]).toMatchObject({ comment_id: branchId, depth });
          expect(window.next_cursor).toBe(expectedCursor);
        }
        expect(result.windows[2]?.items[1]).toEqual({
          kind: "age_locked",
          content_rating: "adult_18",
          next_action: { kind: "verify_minimum_age", minimum_age: 18 },
        });
        // Only AFTER the beyond-visible-first-page assertions, remove earlier
        // roots and require the current eligible-earlier indicator to change.
        await f.admin.query(
          "UPDATE comments SET status='hidden' WHERE comment_id=ANY($1::text[])",
          [rootSiblings.slice(0, 20)],
        );
        const hiddenEarlier = await f.run(
          f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: target }),
        );
        if (hiddenEarlier.kind !== "available") throw new Error("Current branch required");
        expect(hiddenEarlier.windows).toHaveLength(9);
        const rootWindow = result.windows[0];
        const hiddenRootWindow = hiddenEarlier.windows[0];
        if (!rootWindow || !hiddenRootWindow) throw new Error("Positioned root windows required");
        expect(hiddenRootWindow).toEqual({
          ...rootWindow,
          earlier_items_omitted: false,
        });
        const detail = makeControlPlaneVideoDetailStore(f.runtime);
        for (const kind of ["post_id", "alias"] as const)
          expect(
            await f.run(detail.read({ selector: { kind, value: video.postId } })),
          ).toMatchObject({ kind: "result", result: { kind: "content", route: null } });
        const rootCursor = rootWindow.next_cursor;
        if (!rootCursor) throw new Error("Root continuation cursor required");
        await f.admin.query("UPDATE comments SET status='hidden' WHERE comment_id=$1", [
          rootCursor,
        ]);
        const rootContinuation = await f.run(
          threads.list({ postId: video.postId, viewerUserId: "inbox-other", cursor: rootCursor }),
        );
        expect(rootContinuation.items).toHaveLength(1);
        expect(rootContinuation.items[0]).toMatchObject({
          comment_id: rootTail,
          depth: 0,
        });
        expect(rootContinuation.next_cursor).toBeNull();
        expect(
          await f.run(
            threads.list({ postId: video.postId, viewerUserId: "inbox-owner", cursor: rootCursor }),
          ),
        ).toEqual(rootContinuation);
        const cursor = result.windows[4]?.next_cursor;
        if (!cursor) throw new Error("Ordinary continuation cursor required");
        await f.admin.query("UPDATE comments SET status='hidden' WHERE comment_id=$1", [cursor]);
        const continuation = await f.run(
          threads.list({
            postId: video.postId,
            viewerUserId: "inbox-other",
            parentCommentId: continuationParent,
            cursor,
          }),
        );
        expect(continuation.items).toHaveLength(1);
        expect(continuation.items[0]).toMatchObject({ comment_id: depth4Tail, depth: 4 });
        expect(continuation.next_cursor).toBeNull();
        await f.admin.query("UPDATE posts SET visibility='members_only' WHERE post_id=$1", [
          video.postId,
        ]);
        await f.admin.query(
          "UPDATE community_memberships SET status='left',left_at=clock_timestamp() WHERE community_id=$1 AND user_id='inbox-owner'",
          [community],
        );
        await expect(
          f.run(f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: target })),
        ).rejects.toMatchObject({ _tag: "NotFound" });
        await expect(
          f.run(
            threads.list({ postId: video.postId, viewerUserId: "inbox-owner", cursor: rootCursor }),
          ),
        ).rejects.toMatchObject({ _tag: "NotFound" });
        await expect(
          f.run(
            threads.list({
              postId: video.postId,
              viewerUserId: "inbox-owner",
              parentCommentId: continuationParent,
              cursor,
            }),
          ),
        ).rejects.toMatchObject({ _tag: "NotFound" });
        // Same ordinary row cursor is usable by another CURRENT member.
        expect(
          await f.run(
            threads.list({
              postId: video.postId,
              viewerUserId: "inbox-other",
              parentCommentId: continuationParent,
              cursor,
            }),
          ),
        ).toEqual(continuation);
        expect(
          await f.run(
            threads.list({ postId: video.postId, viewerUserId: "inbox-other", cursor: rootCursor }),
          ),
        ).toEqual(rootContinuation);
        for (const kind of ["post_id", "alias"] as const)
          expect(
            await f.run(
              detail.read({ selector: { kind, value: video.postId }, viewerUserId: "inbox-owner" }),
            ),
          ).toEqual({ kind: "not_found" });
        await f.admin.query(
          "UPDATE community_memberships SET status='member',left_at=NULL WHERE community_id=$1 AND user_id='inbox-owner'",
          [community],
        );
        await f.admin.query("UPDATE comments SET status='hidden' WHERE comment_id=$1", [
          ancestorId,
        ]);
        await expect(
          f.run(f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: target })),
        ).rejects.toMatchObject({ _tag: "NotFound" });
        await f.admin.query("UPDATE comments SET status='published' WHERE comment_id=$1", [
          ancestorId,
        ]);
        expect(
          await f.run(f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: target })),
        ).toMatchObject({ kind: "available", target_comment_id: target });
        const before = await receiptBytes();
        const history = await matrixHistory(f);
        // Irreversible ancestor floor is last; never downgrade the cascade.
        await f.admin.query("UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1", [
          ancestorId,
        ]);
        await expect(
          f.run(f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: target })),
        ).rejects.toMatchObject({ _tag: "NotFound" });
        expect(await receiptBytes()).toEqual(before);
        expect(await matrixHistory(f)).toEqual(history);
      });
      completed();
    }, 120000);
  });
}
