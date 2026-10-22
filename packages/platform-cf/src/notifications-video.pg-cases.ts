/** Maintained 20-case sentinel. Parent's predecessor run was 15pass/5fail;
 * repaired successor is UNRUN. Real PG/ACL execution remains parent-held. */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { videoPublicationPostId } from "../../application/src/video/publication-identity.ts";
import {
  attachVideoDecision,
  decideOriginalAudioVideo,
  publishOriginalVideo,
} from "../../domain/src/video-submission.ts";
import { makeCommentThreadStore } from "./comment-thread-repository.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { makeControlPlaneCommunityModerationStore } from "./community-moderation-repository.ts";
import { withInbox } from "./notifications.pg-fixture.ts";
import { prepareNotificationSongVideo } from "./notifications-song-video.pg-fixture.ts";
import { proveNotificationsVideoPrivateAcl } from "./notifications-video-acl.pg-fixture.ts";
import {
  runVideoAdmissionFixture,
  seedNotificationsVideoActors,
} from "./notifications-video-proof.pg-fixture.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import { makeControlPlaneVideoDetailStore } from "./video-detail-repository.ts";
import {
  actor,
  community,
  finalizedFixture,
  operationId,
  responseBytes,
  responseSha256,
  submissionId,
  trustedAnalysis,
} from "./video-publication.pg-fixture.ts";

type Fixture = Parameters<Parameters<typeof withInbox>[0]>[0];
async function prepare(f: Fixture, approval: boolean) {
  await seedNotificationsVideoActors(f.admin);
  await createActivePersonaFixture(f.admin, {
    accountId: "inbox-author",
    personaId: "inbox-video-commenter",
  });
  await f.admin.query(
    "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES('inbox-video-commenter','inbox-author',$1,'persona_creation')",
    [community],
  );
  await insertActiveCommunityMembershipFixture(f.admin, {
    communityId: community,
    userId: "inbox-author",
    membershipId: "inbox-video-commenter-member",
  });
  const { store, finalized } = await finalizedFixture(f.url);
  const analysis = {
    ...trustedAnalysis(),
    ...(approval ? { mediaSafety: "review_required" as const } : {}),
  };
  const decision = decideOriginalAudioVideo({
    state: finalized.state,
    analysis,
    canonicalCaptionSha256: null,
    decidedAt: "2026-10-16T00:00:00Z",
  });
  let ready = await store.commitAnalysisDecision({
    submission: finalized.state,
    analysis,
    decision,
    nextState: attachVideoDecision(finalized.state, analysis, decision),
  });
  if (approval) {
    await store.moderate({
      submission: ready.state,
      actor: { kind: "user", userId: actor },
      expectedCreationRevision: 1,
      action: { kind: "approve", hold: "safety", evidenceRef: null },
      endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
      idempotencyKey: "video-owner-approval",
      requestHash: "8".repeat(64),
      responseBytes,
      responseSha256,
    });
    const approved = await store.getSubmissionByOperation({ submissionId, operationId });
    if (approved === null) throw new Error("Approved video missing");
    ready = approved;
  }
  const postId = await videoPublicationPostId(ready.state);
  const published = publishOriginalVideo(ready.state, postId);
  if (ready.state.decision === null) throw new Error("Ready publication decision required");
  const bundle = {
    observedEventSequence: ready.eventSequence,
    ...published,
    decision: ready.state.decision,
    poster: {
      artifactRef: analysis.frames.extracted[0].artifactRef,
      canonicalSha256: analysis.frames.extracted[0].sha256,
    },
    derivedArtifacts: [
      {
        artifactRef: analysis.audio.soundtrack.extractedAudioRef,
        artifactKind: "extracted_audio" as const,
        canonicalSha256: analysis.audio.soundtrack.extractedAudioSha256,
      },
      ...analysis.frames.extracted.map((frame) => ({
        artifactRef: frame.artifactRef,
        artifactKind: frame.role,
        canonicalSha256: frame.sha256,
      })),
    ],
  };
  return { store, ready, bundle, postId, publish: () => store.publish(bundle) };
}
async function admission(f: Fixture) {
  const source = await Bun.file(
    new URL("../../../db/postgres/candidates/notifications-video-cutover.sql", import.meta.url),
  ).text();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
  );
  // Disposable fixture inputs, explicitly not paired runtime acceptance evidence.
  const plan = {
    contract_sha256: "36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19",
    plan_sha256: "a".repeat(64),
    paired_solid_sha256: "b".repeat(64),
    alias_run_id: crypto.randomUUID(),
    cutover_source_sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
  const result = await runVideoAdmissionFixture(f.runtime, (store) =>
    Effect.gen(function* () {
      yield* store.startAudit({
        runId: plan.alias_run_id,
        planSha256: plan.plan_sha256,
        mode: "materialize",
      });
      const batch = yield* store.auditBatch({
        runId: plan.alias_run_id,
        planSha256: plan.plan_sha256,
      });
      yield* store.drain();
      const cutover = yield* store.cutover(plan, source);
      return { batch, cutover };
    }),
  );
  expect(result.batch.rows[0]).toMatchObject({ examined: 1 });
  expect(result.cutover).toEqual({ alreadyCommitted: false });
}
export function registerVideoNotificationPostgresCases(completed: () => void) {
  const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL ? describe : describe.skip;
  suite("adopted video destination extension (unapplied-candidate proof)", () => {
    for (const intent of ["original_audio", "song_reference"] as const)
      test(`${intent} real publication collision rolls back repeatedly with fixed identity; namespace owner and source bytes remain immutable`, async () => {
        await withInbox(async (f) => {
          const { store, publish, postId } =
            intent === "original_audio"
              ? await prepare(f, false)
              : await prepareNotificationSongVideo(f, false);
          expect(
            (
              await f.admin.query("SELECT video_publication_post_id_v1($1,$2) AS id", [
                submissionId,
                operationId,
              ])
            ).rows[0].id,
          ).toBe(postId);
          await f.admin.query(
            "INSERT INTO posts(community_id,post_id,post_type,status,visibility,created_at,updated_at) VALUES($1,'video-collision-owner','text','published','public',now(),now())",
            [community],
          );
          await f.admin.query(
            "INSERT INTO post_slug_aliases(slug,post_id,slug_policy_version) VALUES($1,'video-collision-owner','post-slug-v1')",
            [postId],
          );
          const before = (
            await f.admin.query("SELECT * FROM post_slug_aliases WHERE slug=$1", [postId])
          ).rows;
          for (let attempt = 0; attempt < 2; attempt++) {
            await expect(publish()).rejects.toThrow();
            expect(
              (await store.getSubmissionByOperation({ submissionId, operationId }))?.state.postId,
            ).toBeNull();
            expect(
              (
                await f.admin.query("SELECT count(*)::int AS n FROM posts WHERE post_id=$1", [
                  postId,
                ])
              ).rows[0].n,
            ).toBe(0);
          }
          expect(
            (await f.admin.query("SELECT * FROM post_slug_aliases WHERE slug=$1", [postId])).rows,
          ).toEqual(before);
          await expect(
            f.admin.query(
              "UPDATE media_post_submissions SET operation_id='rotated' WHERE submission_id=$1",
              [submissionId],
            ),
          ).rejects.toThrow();
          await expect(
            f.admin.query("UPDATE post_slug_aliases SET post_id='inbox-post' WHERE slug=$1", [
              postId,
            ]),
          ).rejects.toThrow("immutable");
          await expect(
            f.admin.query("SELECT require_video_publication_identity_v1($1,$2,'post-random')", [
              submissionId,
              operationId,
            ]),
          ).rejects.toThrow("identity mismatch");
        });
        completed();
      }, 120000);
    for (const intent of ["original_audio", "song_reference"] as const)
      for (const approved of [false, true])
        test(`${intent} ${approved ? "owner-approved" : "ordinary"} real video/notification publication, exact detail aliases, old-policy cutover, current read redaction and replay`, async () => {
          await withInbox(async (f) => {
            const prepared =
              intent === "original_audio"
                ? await prepare(f, approved)
                : await prepareNotificationSongVideo(f, approved);
            const { postId } = prepared;
            if ("publishWithLostAck" in prepared) await prepared.publishWithLostAck();
            else await prepared.publish();
            if (intent === "song_reference") {
              const proof = (
                await f.admin.query(
                  `SELECT analysis.canonical_video_sha256 AS analysis_digest,
              capture.canonical_sha256 AS capture_digest,pub.canonical_video_sha256 AS published_digest,
              master.master_sha256 AS master_digest,pub.video_asset_ref=master.verified_object_key AS owned_master
              FROM media_publication_projections pub
              JOIN media_video_analyses analysis USING(submission_id,analysis_revision)
              JOIN media_video_revisions capture ON capture.submission_id=pub.submission_id AND capture.video_revision=pub.video_revision
              JOIN media_song_video_masters master ON master.master_revision_id=pub.song_video_master_revision_id
              JOIN media_song_video_accepted_masters accepted ON accepted.master_revision_id=master.master_revision_id AND accepted.plan_id=pub.song_video_plan_id
              WHERE pub.post_id=$1`,
                  [postId],
                )
              ).rows[0];
              expect(proof.analysis_digest).toBe(proof.capture_digest);
              expect(proof.published_digest).toBe(proof.master_digest);
              expect(proof.published_digest).not.toBe(proof.capture_digest);
              expect(proof.owned_master).toBe(true);
            }
            expect(
              (
                await f.admin.query(
                  "SELECT slug,slug_policy_version FROM post_slug_aliases WHERE post_id=$1",
                  [postId],
                )
              ).rows,
            ).toEqual([{ slug: postId, slug_policy_version: "video-receipt-exact-v1" }]);
            const detail = makeControlPlaneVideoDetailStore(f.runtime);
            for (const kind of ["post_id", "alias"] as const)
              expect(
                await f.run(
                  detail.read({ selector: { kind, value: postId }, viewerUserId: actor }),
                ),
              ).toMatchObject({
                kind: "result",
                result: { kind: "content", post_id: postId, route: null },
              });
            expect(
              await f.run(
                detail.read({ selector: { kind: "alias", value: "post-never-recorded" } }),
              ),
            ).toEqual({ kind: "not_found" });
            const comment = async (key: string, parent?: string) => {
              const submitted = await f.submit(
                key,
                parent,
                "inbox-author",
                approved,
                postId,
                community,
              );
              if (submitted.kind !== "created" && submitted.kind !== "replay")
                throw new Error("Expected comment publication");
              if (approved) {
                if (!submitted.snapshot.review_ref) throw new Error("Review case required");
                await f.run(
                  makeControlPlaneCommunityModerationStore(f.runtime).actOnCase({
                    caseRef: submitted.snapshot.review_ref,
                    actor: { kind: "user", userId: actor },
                    idempotencyKey: `approve-${key}`,
                    requestHash: "8".repeat(64),
                    expectedCaseRevision: 1,
                    action: "approve_as_general",
                  }),
                );
              }
              const fact = (
                await f.admin.query(
                  "SELECT outbox_event_id,comment_id FROM content_publication_outbox WHERE submission_id=$1 AND event_type='comment_notification'",
                  [submitted.snapshot.submission_id],
                )
              ).rows;
              expect(fact).toHaveLength(1);
              return fact[0] as { outbox_event_id: string; comment_id: string };
            };
            const old = await comment("video-pre-extension");
            const oldHistory = (
              await f.admin.query(
                "SELECT to_jsonb(f) AS fact,to_jsonb(d) AS receipt FROM content_publication_outbox f JOIN notification_publication_deliveries d ON d.source_event_id=f.outbox_event_id WHERE f.outbox_event_id=$1",
                [old.outbox_event_id],
              )
            ).rows;
            expect(oldHistory[0].receipt.outcome).toBe("suppressed");
            await admission(f);
            const fresh = await comment("video-admitted");
            const page = await f.run(f.store.list({ recipientUserId: actor }));
            expect(page.unread_count).toBe(1);
            expect(page.items).toHaveLength(1);
            expect(await f.run(f.store.recover())).toMatchObject({ examined: 0, processed: 0 });
            expect(await f.run(f.store.deliver({ sourceEventId: fresh.outbox_event_id }))).toEqual({
              processed: false,
              delivered: true,
            });
            const item = page.items[0];
            if (item === undefined) throw new Error("Delivered video item required");
            expect(
              await f.run(
                f.navigation.resolve({ viewerUserId: actor, commentId: fresh.comment_id }),
              ),
            ).toMatchObject({
              kind: "available",
              post_path: `/post/${postId}`,
              target_comment_id: fresh.comment_id,
            });
            const reply = await comment("video-nested-reply", fresh.comment_id);
            const thread = makeCommentThreadStore(f.runtime);
            expect(await f.run(thread.list({ postId, viewerUserId: actor }))).toMatchObject({
              items: expect.arrayContaining([
                expect.objectContaining({ comment_id: fresh.comment_id }),
              ]),
            });
            expect(
              await f.run(
                thread.list({ postId, viewerUserId: actor, parentCommentId: fresh.comment_id }),
              ),
            ).toMatchObject({ items: [expect.objectContaining({ comment_id: reply.comment_id })] });
            expect(
              await f.run(
                f.navigation.resolve({ viewerUserId: actor, commentId: reply.comment_id }),
              ),
            ).toMatchObject({
              kind: "available",
              post_path: `/post/${postId}`,
              target_comment_id: reply.comment_id,
              ancestor_comment_ids: [fresh.comment_id],
            });
            if ("songPostId" in prepared) {
              await f.admin.query("UPDATE posts SET visibility='members_only' WHERE post_id=$1", [
                prepared.songPostId,
              ]);
              await f.admin.query(
                "UPDATE community_memberships SET status='left',left_at=clock_timestamp() WHERE community_id=$1 AND user_id=$2",
                [community, actor],
              );
              for (const kind of ["post_id", "alias"] as const)
                expect(
                  await f.run(
                    detail.read({ selector: { kind, value: postId }, viewerUserId: actor }),
                  ),
                ).toEqual({ kind: "not_found" });
              expect(await f.run(f.store.list({ recipientUserId: actor }))).toMatchObject({
                items: [],
                unread_count: 0,
              });
              await expect(
                f.run(
                  f.store.read({ recipientUserId: actor, notificationId: item.notification_id }),
                ),
              ).rejects.toThrow();
              await expect(
                f.run(f.navigation.resolve({ viewerUserId: actor, commentId: fresh.comment_id })),
              ).rejects.toThrow();
              await expect(f.run(thread.list({ postId, viewerUserId: actor }))).rejects.toThrow();
              await f.admin.query(
                "UPDATE community_memberships SET status='member',left_at=NULL WHERE community_id=$1 AND user_id=$2",
                [community, actor],
              );
              await f.admin.query("UPDATE posts SET visibility='public' WHERE post_id=$1", [
                prepared.songPostId,
              ]);
            }
            expect(await f.run(f.store.list({ recipientUserId: actor }))).toMatchObject({
              unread_count: 1,
            });
            const read = await f.run(
              f.store.read({ recipientUserId: actor, notificationId: item.notification_id }),
            );
            await f.admin.query("UPDATE posts SET status='hidden' WHERE post_id=$1", [postId]);
            expect(await f.run(f.store.list({ recipientUserId: actor }))).toMatchObject({
              items: [],
              unread_count: 0,
            });
            await expect(
              f.run(f.store.read({ recipientUserId: actor, notificationId: item.notification_id })),
            ).rejects.toThrow();
            await expect(
              f.run(f.navigation.resolve({ viewerUserId: actor, commentId: fresh.comment_id })),
            ).rejects.toThrow();
            for (const kind of ["post_id", "alias"] as const)
              expect(await f.run(detail.read({ selector: { kind, value: postId } }))).toEqual({
                kind: "not_found",
              });
            await f.admin.query("UPDATE posts SET status='published' WHERE post_id=$1", [postId]);
            expect(
              await f.run(
                f.store.read({ recipientUserId: actor, notificationId: item.notification_id }),
              ),
            ).toEqual(read);
            expect(await f.run(f.store.deliver({ sourceEventId: old.outbox_event_id }))).toEqual({
              processed: false,
              delivered: false,
            });
            expect(
              (
                await f.admin.query(
                  "SELECT to_jsonb(f) AS fact,to_jsonb(d) AS receipt FROM content_publication_outbox f JOIN notification_publication_deliveries d ON d.source_event_id=f.outbox_event_id WHERE f.outbox_event_id=$1",
                  [old.outbox_event_id],
                )
              ).rows,
            ).toEqual(oldHistory);
            await expect(
              f.admin.query(
                "UPDATE media_post_submissions SET post_id='rotated' WHERE submission_id=$1",
                [submissionId],
              ),
            ).rejects.toThrow();
            await expect(
              f.admin.query("UPDATE posts SET idempotency_key='rotated' WHERE post_id=$1", [
                postId,
              ]),
            ).rejects.toThrow("immutable");
            if ("songPostId" in prepared) {
              // Irreversible 0185 floor raise is LAST: finish reversible
              // restoration/read/replay first, then publish a distinct unread
              // item while the song/video/comment floors are still general.
              const ageTarget = await comment("video-age-unread");
              const beforeAgePage = await f.run(f.store.list({ recipientUserId: actor }));
              expect(beforeAgePage.unread_count).toBe(1);
              const ageItem = beforeAgePage.items.find(
                (entry) =>
                  entry.target.kind === "comment_thread" &&
                  entry.target.comment_id === ageTarget.comment_id,
              );
              if (!ageItem) throw new Error("Unread age scenario item required");
              expect(ageItem.read_at).toBeNull();
              expect(
                await f.run(
                  f.navigation.resolve({ viewerUserId: actor, commentId: ageTarget.comment_id }),
                ),
              ).toMatchObject({ kind: "available", target_comment_id: ageTarget.comment_id });
              const retained = async () =>
                (
                  await f.admin.query(
                    `SELECT to_jsonb(fact) AS fact,to_jsonb(delivery) AS receipt,to_jsonb(inbox) AS inbox
                   FROM content_publication_outbox fact
                   JOIN notification_publication_deliveries delivery ON delivery.source_event_id=fact.outbox_event_id
                   JOIN notification_inbox inbox ON inbox.source_event_id=fact.outbox_event_id
                   WHERE fact.outbox_event_id=$1`,
                    [ageTarget.outbox_event_id],
                  )
                ).rows;
              const ageHistory = await retained();
              expect(ageHistory).toHaveLength(1);
              expect(ageHistory[0].inbox.read_at).toBeNull();
              await f.admin.query("UPDATE posts SET content_rating='adult_18' WHERE post_id=$1", [
                prepared.songPostId,
              ]);
              expect(
                (
                  await f.admin.query(
                    "SELECT post_id,content_rating FROM posts WHERE post_id=ANY($1::text[]) ORDER BY post_id",
                    [[prepared.songPostId, postId]],
                  )
                ).rows,
              ).toEqual(
                [prepared.songPostId, postId]
                  .sort()
                  .map((id) => ({ post_id: id, content_rating: "adult_18" })),
              );
              expect(
                (
                  await f.admin.query("SELECT content_rating FROM comments WHERE comment_id=$1", [
                    ageTarget.comment_id,
                  ])
                ).rows,
              ).toEqual([{ content_rating: "adult_18" }]);
              for (const kind of ["post_id", "alias"] as const)
                expect(
                  await f.run(
                    detail.read({ selector: { kind, value: postId }, viewerUserId: actor }),
                  ),
                ).toMatchObject({ kind: "result", result: { kind: "age_locked" } });
              expect(await f.run(f.store.list({ recipientUserId: actor }))).toMatchObject({
                items: [],
                unread_count: 0,
              });
              for (const notificationId of [ageItem.notification_id, item.notification_id])
                await expect(
                  f.run(f.store.read({ recipientUserId: actor, notificationId })),
                ).rejects.toMatchObject({ _tag: "NotFound" });
              for (const commentId of [ageTarget.comment_id, reply.comment_id])
                await expect(
                  f.run(f.navigation.resolve({ viewerUserId: actor, commentId })),
                ).rejects.toMatchObject({ _tag: "NotFound" });
              await expect(
                f.run(thread.list({ postId, viewerUserId: actor })),
              ).rejects.toMatchObject({ _tag: "NotFound" });
              expect(await retained()).toEqual(ageHistory);
              expect(
                (
                  await f.admin.query(
                    `SELECT to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at
                 FROM notification_inbox WHERE notification_id=$1`,
                    [item.notification_id],
                  )
                ).rows[0].read_at,
              ).toBe(read.read_at);
              // No downgrade, reset, trigger bypass or post-age publication.
            }
          });
          completed();
        }, 120000);
    test("real LOGIN/default/inherited ACLs cannot forge audits or cutover; controlled audit operator still works", async () => {
      await proveNotificationsVideoPrivateAcl(async (f) => {
        const prepared = await prepare(f, false);
        await prepared.publish();
      });
      completed();
    }, 120000);
  });
}
