/** Registered by the maintained Notifications partition; UNRUN by writer. */
import { describe, expect, test } from "bun:test";
import { makeControlPlaneCommentNavigationStore } from "./comment-navigation-repository.ts";
import { withInbox } from "./notifications.pg-fixture.ts";
import { prepareNotificationSongVideo } from "./notifications-song-video.pg-fixture.ts";
import {
  actor,
  bindMatrixReaders,
  community,
  matrixClient,
  matrixComment,
  prepareMatrixVideo,
  startMatrixActors,
} from "./notifications-video-matrix.pg-fixture.ts";
import {
  matrixSnapshotRuntime,
  waitForMatrixSnapshots,
} from "./notifications-video-race.pg-fixture.ts";
import { makeControlPlaneVideoDetailStore } from "./video-detail-repository.ts";

const VIDEO_SNAPSHOT_CASES = [
  "hold",
  "membership",
  "tuple-refusal",
  "author-erasure",
  "viewer-erasure",
  "post-age",
  "reference-age",
  "target-age",
  "ancestor-age",
  "age-and-hidden",
] as const;

export function registerVideoSnapshotPostgresCases(completed: () => void) {
  const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL ? describe : describe.skip;
  suite("video one-statement snapshot/current authorization", () => {
    for (const change of VIDEO_SNAPSHOT_CASES)
      test(`${change}: primary, exact alias and resolver share pre-change snapshot; fresh reads enforce committed state`, async () => {
        await withInbox(async (f) => {
          let postId: string;
          let submissionId: string;
          let songPostId: string | undefined;
          if (change === "reference-age") {
            const video = await prepareNotificationSongVideo(f, false);
            await bindMatrixReaders(f);
            await video.publish();
            postId = video.postId;
            songPostId = video.songPostId;
            submissionId = "media-submission-video-publication";
          } else {
            await startMatrixActors(f);
            const video = await prepareMatrixVideo(f, change, change === "hold");
            await video.publish();
            postId = video.postId;
            submissionId = video.submissionId;
          }
          if (change === "membership")
            await f.admin.query("UPDATE posts SET visibility='members_only' WHERE post_id=$1", [
              postId,
            ]);
          const root = await matrixComment(f, postId, `snapshot-root-${change}`);
          const target = await matrixComment(
            f,
            postId,
            `snapshot-target-${change}`,
            root.comment_id,
            "inbox-other",
          );
          const receipts = async () =>
            (
              await f.admin.query(`SELECT
            (SELECT jsonb_agg(jsonb_build_object('id',submission_id,'bytes',encode(response_snapshot_bytes,'hex'),'sha',response_snapshot_sha256) ORDER BY submission_id) FROM media_post_submissions) AS media,
            (SELECT jsonb_agg(jsonb_build_object('id',submission_id,'bytes',encode(response_snapshot_bytes,'hex'),'sha',response_snapshot_sha256) ORDER BY submission_id) FROM text_content_submissions) AS text,
            (SELECT jsonb_agg(to_jsonb(fact) ORDER BY outbox_event_id) FROM content_publication_outbox fact) AS facts,
            (SELECT jsonb_agg(to_jsonb(d) ORDER BY source_event_id) FROM notification_publication_deliveries d) AS deliveries`)
            ).rows;
          const history = await receipts();
          const clients: Awaited<ReturnType<typeof matrixClient>>[] = [];
          const pendingReads: Promise<{ ok: boolean; error?: unknown }>[] = [];
          let originalError: unknown;
          let failed = false;
          const cleanupFailures: unknown[] = [];
          try {
            const locker = await matrixClient(f.url);
            clients.push(locker);
            const writer = await matrixClient(f.url);
            clients.push(writer);
            const key = BigInt(
              `0x${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
            ).toString();
            const gates = [
              matrixSnapshotRuntime(f.url, key),
              matrixSnapshotRuntime(f.url, key),
              matrixSnapshotRuntime(f.url, key),
            ] as const;
            await locker.query("BEGIN");
            await locker.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
            const settle = <A>(promise: Promise<A>) =>
              promise.then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            const pending = [
              settle(
                f.run(
                  makeControlPlaneVideoDetailStore(gates[0].runtime).read({
                    selector: { kind: "post_id", value: postId },
                    viewerUserId: "inbox-owner",
                  }),
                ),
              ),
              settle(
                f.run(
                  makeControlPlaneVideoDetailStore(gates[1].runtime).read({
                    selector: { kind: "alias", value: postId },
                    viewerUserId: "inbox-owner",
                  }),
                ),
              ),
              settle(
                f.run(
                  makeControlPlaneCommentNavigationStore(gates[2].runtime).resolve({
                    viewerUserId: "inbox-owner",
                    commentId: target.comment_id,
                  }),
                ),
              ),
            ] as const;
            pendingReads.push(...pending);
            const pids = await Promise.all(gates.map((gate) => gate.backend));
            expect(new Set(pids).size).toBe(3);
            await waitForMatrixSnapshots(f.admin, pids);
            await writer.query("BEGIN");
            if (change === "tuple-refusal") {
              await expect(
                writer.query(
                  "UPDATE media_publication_projections SET creation_revision=creation_revision+1 WHERE post_id=$1",
                  [postId],
                ),
              ).rejects.toThrow("immutable");
              await writer.query("ROLLBACK");
            } else {
              switch (change) {
                case "hold":
                  // Current hold row only; no new event, decision or receipt.
                  expect(
                    (
                      await writer.query(
                        "UPDATE media_video_review_holds SET status='blocked',action_id='matrix-current-block',evidence_ref='matrix-current-evidence' WHERE submission_id=$1 AND hold_kind='safety' AND status='approved' RETURNING submission_id",
                        [submissionId],
                      )
                    ).rowCount,
                  ).toBe(1);
                  break;
                case "membership":
                  await writer.query(
                    "UPDATE community_memberships SET status='left',left_at=clock_timestamp() WHERE community_id=$1 AND user_id='inbox-owner'",
                    [community],
                  );
                  break;
                case "author-erasure":
                  await writer.query("UPDATE users SET status='deleted' WHERE user_id=$1", [actor]);
                  break;
                case "viewer-erasure":
                  await writer.query(
                    "UPDATE users SET status='deleted' WHERE user_id='inbox-owner'",
                  );
                  break;
                case "post-age":
                  await writer.query(
                    "UPDATE posts SET content_rating='adult_18' WHERE post_id=$1",
                    [postId],
                  );
                  break;
                case "reference-age":
                  await writer.query(
                    "UPDATE posts SET content_rating='adult_18' WHERE post_id=$1",
                    [songPostId],
                  );
                  break;
                case "target-age":
                  await writer.query(
                    "UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1",
                    [target.comment_id],
                  );
                  break;
                case "ancestor-age":
                  await writer.query(
                    "UPDATE comments SET content_rating='adult_18' WHERE comment_id=$1",
                    [root.comment_id],
                  );
                  break;
                case "age-and-hidden":
                  await writer.query(
                    "UPDATE posts SET content_rating='adult_18',status='hidden' WHERE post_id=$1",
                    [postId],
                  );
                  break;
              }
              await writer.query("COMMIT");
            }
            await locker.query("COMMIT");
            const [primary, alias, navigation] = await Promise.all(pending);
            if (!primary?.ok || !alias?.ok || !navigation?.ok)
              throw new Error("Pre-change snapshot read failed", {
                cause: [primary, alias, navigation],
              });
            expect(primary.value).toMatchObject({
              kind: "result",
              result: { kind: "content", post_id: postId, route: null },
            });
            expect(alias.value).toEqual(primary.value);
            expect(navigation.value).toMatchObject({
              kind: "available",
              post_id: postId,
              target_comment_id: target.comment_id,
              ancestor_comment_ids: [root.comment_id],
            });
            expect(gates.map((gate) => gate.statements())).toEqual([1, 1, 1]);
            const detail = makeControlPlaneVideoDetailStore(f.runtime);
            for (const kind of ["post_id", "alias"] as const) {
              const fresh = await f.run(
                detail.read({ selector: { kind, value: postId }, viewerUserId: "inbox-owner" }),
              );
              if (["post-age", "reference-age"].includes(change))
                expect(fresh).toMatchObject({ kind: "result", result: { kind: "age_locked" } });
              else if (["target-age", "ancestor-age", "tuple-refusal"].includes(change))
                expect(fresh).toEqual(primary.value);
              else if (change === "author-erasure") {
                expect(primary.value).toMatchObject({
                  result: { content: { post: { author_persona: expect.anything() } } },
                });
                expect(fresh).toMatchObject({
                  kind: "result",
                  result: {
                    kind: "content",
                    content: {
                      post: { author_persona: null },
                      video: { soundtrack: { origin_author_persona_id: null } },
                    },
                  },
                });
              } else expect(fresh).toEqual({ kind: "not_found" });
            }
            const freshNavigation = f.run(
              f.navigation.resolve({ viewerUserId: "inbox-owner", commentId: target.comment_id }),
            );
            if (change === "target-age")
              expect(await freshNavigation).toEqual({
                kind: "age_locked",
                content_rating: "adult_18",
                next_action: { kind: "verify_minimum_age", minimum_age: 18 },
              });
            else if (["author-erasure", "tuple-refusal"].includes(change))
              expect(await freshNavigation).toMatchObject({
                kind: "available",
                target_comment_id: target.comment_id,
              });
            else await expect(freshNavigation).rejects.toMatchObject({ _tag: "NotFound" });
            expect(await receipts()).toEqual(history);
          } catch (error) {
            originalError = error;
            failed = true;
          } finally {
            const cleanup = await Promise.allSettled(
              clients.map((client) => client.query("ROLLBACK")),
            );
            const reads = await Promise.all(pendingReads);
            const closes = await Promise.allSettled(clients.map(async (client) => client.end()));
            cleanupFailures.push(
              ...[...cleanup, ...closes]
                .filter((row) => row.status === "rejected")
                .map((row) => row.reason),
            );
            for (const row of reads) if (!row.ok) cleanupFailures.push(row.error);
          }
          if (failed || cleanupFailures.length)
            throw new AggregateError(
              [...(failed ? [originalError] : []), ...cleanupFailures],
              "Snapshot/read/cleanup failure",
            );
        });
        completed();
      }, 120000);
  });
}
