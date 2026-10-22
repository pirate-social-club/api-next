/** Additional real-PG source only. Registered in maintained suite; writer UNRUN. */
import { describe, expect, test } from "bun:test";
import { withInbox } from "./notifications.pg-fixture.ts";
import {
  actor,
  community,
  matrixClient,
  matrixComment,
  matrixHistory,
  matrixObservedRuntime,
  matrixPlan,
  prepareMatrixAdmission,
  prepareMatrixVideo,
  startMatrixActors,
} from "./notifications-video-matrix.pg-fixture.ts";
import { runVideoAdmissionFixture } from "./notifications-video-proof.pg-fixture.ts";
import {
  matrixCommitLoss,
  matrixDeadline,
  matrixDispatchBarrier,
} from "./notifications-video-race.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";

export function registerVideoAdmissionMatrixPostgresCases(completed: () => void) {
  const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL ? describe : describe.skip;
  suite("real video inventory/admission restart and exclusion", () => {
    test("105 real published sources: 50/50/5 keysets, committed audit lost-ACK restart, collision refusal and overlapping publication/materialization", async () => {
      await withInbox(async (f) => {
        await startMatrixActors(f);
        const sources: Awaited<ReturnType<typeof prepareMatrixVideo>>[] = [];
        for (let i = 0; i < 105; i++) {
          const source = await prepareMatrixVideo(f, `inventory-${i}`);
          await source.publish();
          sources.push(source);
        }
        const ids = sources.map((source) => source.submissionId);
        const history = async () =>
          (
            await f.admin.query(
              `SELECT
          (SELECT jsonb_agg(jsonb_build_object('id',submission_id,'bytes',encode(response_snapshot_bytes,'hex'),'sha',response_snapshot_sha256) ORDER BY submission_id) FROM media_post_submissions WHERE submission_id=ANY($1::text[])) AS receipts,
          (SELECT jsonb_agg(to_jsonb(c) ORDER BY submission_id,endpoint_template,idempotency_key) FROM media_submission_command_replays c WHERE submission_id=ANY($1::text[])) AS commands,
          (SELECT jsonb_agg(to_jsonb(a) ORDER BY slug) FROM post_slug_aliases a WHERE post_id=ANY($2::text[])) AS aliases`,
              [ids, sources.map((source) => source.postId)],
            )
          ).rows;
        const immutable = await history();
        const blocked = await prepareMatrixVideo(f, "collision-blocked");
        await f.admin.query(
          "INSERT INTO posts(community_id,post_id,post_type,status,visibility,body,created_at,updated_at) VALUES($1,'matrix-collision-owner','text','published','public','Fixture namespace owner',now(),now())",
          [community],
        );
        await f.admin.query(
          "INSERT INTO post_slug_aliases(slug,post_id,slug_policy_version) VALUES($1,'matrix-collision-owner','post-slug-v1')",
          [blocked.postId],
        );
        const owner = (
          await f.admin.query(
            "SELECT to_jsonb(a) AS alias FROM post_slug_aliases a WHERE slug=$1",
            [blocked.postId],
          )
        ).rows;
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(blocked.publish()).rejects.toThrow();
          expect((await blocked.store.getSubmissionByOperation(blocked))?.state.postId).toBeNull();
        }
        expect(
          (
            await f.admin.query("SELECT count(*)::int AS n FROM posts WHERE post_id=$1", [
              blocked.postId,
            ])
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await f.admin.query(
              "SELECT to_jsonb(a) AS alias FROM post_slug_aliases a WHERE slug=$1",
              [blocked.postId],
            )
          ).rows,
        ).toEqual(owner);
        const input = await matrixPlan();
        const audit = { runId: input.plan.alias_run_id, planSha256: input.plan.plan_sha256 };
        await runVideoAdmissionFixture(f.runtime, (store) =>
          store.startAudit({ ...audit, mode: "inventory" }),
        );
        const lost = matrixCommitLoss("SELECT process_video_alias_audit_batch_v1");
        await expect(
          runVideoAdmissionFixture(matrixObservedRuntime(f.url, { after: lost.after }), (store) =>
            store.auditBatch(audit),
          ),
        ).rejects.toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" });
        expect(lost.lost()).toBe(true);
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n FROM video_alias_audit_items_v1 WHERE run_id=$1",
              [audit.runId],
            )
          ).rows[0].n,
        ).toBe(50);
        const durableFirst = (
          await f.admin.query(
            "SELECT * FROM video_alias_audit_items_v1 WHERE run_id=$1 ORDER BY submission_id",
            [audit.runId],
          )
        ).rows;
        const measured = await f.admin.query(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
          SELECT submission_id FROM media_post_submissions WHERE media_kind='video' AND status='published'
            AND (created_at,post_id)>(SELECT cursor_created_at,cursor_post_id FROM video_alias_audit_runs_v1 WHERE run_id=$1)
            AND (created_at,post_id)<=(SELECT upper_created_at,upper_post_id FROM video_alias_audit_runs_v1 WHERE run_id=$1)
          ORDER BY created_at,post_id LIMIT 50`,
          [audit.runId],
        );
        expect(measured.rows).toHaveLength(1);
        expect(measured.rows[0]["QUERY PLAN"][0].Plan["Actual Rows"]).toBe(50);
        // Retain actual plan, including scanned/removed rows; LIMIT is only a
        // returned-row bound. This 105-source measurement is not a history SLA.
        console.info(
          "Notifications synthetic105 inventory plan",
          JSON.stringify(measured.rows[0]["QUERY PLAN"]),
        );
        for (const expected of [50, 5, 0])
          expect(
            (await runVideoAdmissionFixture(f.runtime, (store) => store.auditBatch(audit))).rows[0],
          ).toEqual({ examined: expected });
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n,count(DISTINCT submission_id)::int AS unique_sources,bool_and(outcome='already-exact') AS exact FROM video_alias_audit_items_v1 WHERE run_id=$1",
              [audit.runId],
            )
          ).rows[0],
        ).toEqual({ n: 105, unique_sources: 105, exact: true });
        expect(
          (
            await f.admin.query(
              "SELECT bool_and(item.receipt_digests->>'submission'=source.response_snapshot_sha256) AS exact FROM video_alias_audit_items_v1 item JOIN media_post_submissions source USING(submission_id) WHERE item.run_id=$1",
              [audit.runId],
            )
          ).rows[0].exact,
        ).toBe(true);
        expect(
          (
            await f.admin.query(
              "SELECT complete,cursor_created_at=upper_created_at AND cursor_post_id=upper_post_id AS at_upper FROM video_alias_audit_runs_v1 WHERE run_id=$1",
              [audit.runId],
            )
          ).rows[0],
        ).toEqual({ complete: true, at_upper: true });
        expect(
          (
            await f.admin.query(
              "SELECT * FROM video_alias_audit_items_v1 WHERE run_id=$1 AND submission_id=ANY($2::text[]) ORDER BY submission_id",
              [audit.runId, durableFirst.map((row) => row.submission_id)],
            )
          ).rows,
        ).toEqual(durableFirst);
        const materialize = { runId: crypto.randomUUID(), planSha256: input.plan.plan_sha256 };
        await runVideoAdmissionFixture(f.runtime, (store) =>
          store.startAudit({ ...materialize, mode: "materialize" }),
        );
        const arrival = await prepareMatrixVideo(f, "inventory-new-arrival");
        const barrier = matrixDispatchBarrier(2);
        const auditRuntime = matrixObservedRuntime(f.url, {
          before: async (query, pid) => {
            if (query.text.includes("SELECT process_video_alias_audit_batch_v1"))
              await barrier.arrive(pid);
          },
        });
        const publicationRuntime = matrixObservedRuntime(f.url, {
          before: async (query, pid) => {
            if (query.text.includes("INSERT INTO posts")) await barrier.arrive(pid);
          },
        });
        const auditTask = runVideoAdmissionFixture(auditRuntime, (store) =>
          store.auditBatch(materialize),
        );
        const publicationTask = makeControlPlaneVideoPublicationStore(publicationRuntime).publish(
          arrival.bundle,
        );
        const settled = Promise.allSettled([auditTask, publicationTask]);
        let coordinationError: unknown;
        try {
          await matrixDeadline(barrier.ready);
          expect(
            (
              await f.admin.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND xact_start IS NOT NULL",
                [barrier.pids()],
              )
            ).rows[0].n,
          ).toBe(2);
        } catch (error) {
          coordinationError = error;
        } finally {
          barrier.release();
        }
        const outcomes = await settled;
        if (coordinationError || outcomes.some((result) => result.status === "rejected"))
          throw new AggregateError(
            [
              ...(coordinationError ? [coordinationError] : []),
              ...outcomes
                .filter((result) => result.status === "rejected")
                .map((result) => result.reason),
            ],
            "Native concurrent matrix operation failed",
          );
        expect((await auditTask).rows[0]).toEqual({ examined: 50 });
        for (const expected of [50, 5, 0])
          expect(
            (await runVideoAdmissionFixture(f.runtime, (store) => store.auditBatch(materialize)))
              .rows[0],
          ).toEqual({ examined: expected });
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n,bool_and(outcome='already-exact') AS exact FROM video_alias_audit_items_v1 WHERE run_id=$1",
              [materialize.runId],
            )
          ).rows[0],
        ).toEqual({ n: 105, exact: true });
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n FROM video_alias_audit_items_v1 WHERE run_id=$1 AND submission_id=ANY($2::text[])",
              [materialize.runId, [arrival.submissionId, blocked.submissionId]],
            )
          ).rows[0].n,
        ).toBe(0);
        const next = { runId: crypto.randomUUID(), planSha256: input.plan.plan_sha256 };
        await runVideoAdmissionFixture(f.runtime, (store) =>
          store.startAudit({ ...next, mode: "inventory" }),
        );
        for (const expected of [50, 50, 6, 0])
          expect(
            (await runVideoAdmissionFixture(f.runtime, (store) => store.auditBatch(next))).rows[0],
          ).toEqual({ examined: expected });
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n FROM video_alias_audit_items_v1 WHERE run_id=$1 AND submission_id=$2",
              [next.runId, arrival.submissionId],
            )
          ).rows[0].n,
        ).toBe(1);
        expect(await history()).toEqual(immutable);
        expect(
          (await f.admin.query("SELECT count(*)::int AS n FROM notification_inbox")).rows[0].n,
        ).toBe(0); // alias work is never fan-out
      });
      completed();
    }, 120000);

    test("actual committed cutover lost acknowledgement reconciles immutable receipt without reinstall, replay or old-cohort delivery", async () => {
      await withInbox(async (f) => {
        await startMatrixActors(f);
        const video = await prepareMatrixVideo(f, "cutover-unknown");
        await video.publish();
        const old = await matrixComment(f, video.postId, "cutover-old-fact");
        const before = await matrixHistory(f);
        const input = await prepareMatrixAdmission(f);
        const loss = matrixCommitLoss("INSERT INTO video_notification_cutovers_v1");
        let installs = 0;
        const runtime = matrixObservedRuntime(f.url, {
          after: async (query) => {
            if (query.text === input.source) installs++;
            await loss.after(query);
          },
        });
        await expect(
          runVideoAdmissionFixture(runtime, (store) => store.cutover(input.plan, input.source)),
        ).rejects.toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" });
        expect(loss.lost()).toBe(true);
        expect(installs).toBe(1);
        const receipt = (await f.admin.query("SELECT * FROM video_notification_cutovers_v1")).rows;
        expect(receipt).toHaveLength(1);
        expect(
          await runVideoAdmissionFixture(runtime, (store) =>
            store.cutover(input.plan, input.source),
          ),
        ).toEqual({ alreadyCommitted: true });
        expect(installs).toBe(1);
        expect(loss.mutations()).toBe(1);
        await expect(
          runVideoAdmissionFixture(runtime, (store) =>
            store.cutover({ ...input.plan, paired_solid_sha256: "c".repeat(64) }, input.source),
          ),
        ).rejects.toThrow("receipt differs");
        expect((await f.admin.query("SELECT * FROM video_notification_cutovers_v1")).rows).toEqual(
          receipt,
        );
        expect(await f.run(f.store.deliver({ sourceEventId: old.outbox_event_id }))).toEqual({
          processed: false,
          delivered: false,
        });
        expect(await matrixHistory(f)).toEqual(before);
        const fresh = await matrixComment(f, video.postId, "cutover-new-fact");
        expect(
          (await f.run(f.store.list({ recipientUserId: actor }))).items.map((item) => {
            expect(item.target.kind).toBe("comment_thread");
            if (item.target.kind !== "comment_thread") throw new Error("Comment target required");
            return item.target.comment_id;
          }),
        ).toEqual([fresh.comment_id]);
      });
      completed();
    }, 120000);

    test("real outbox and alias exclusion refusals roll back before install; releasing locks admits once and preserves suppressed facts", async () => {
      await withInbox(async (f) => {
        await startMatrixActors(f);
        const video = await prepareMatrixVideo(f, "cutover-locks");
        await video.publish();
        await matrixComment(f, video.postId, "cutover-locks-old");
        const old = await matrixHistory(f);
        const input = await prepareMatrixAdmission(f);
        const locker = await matrixClient(f.url);
        let installs = 0;
        const runtime = matrixObservedRuntime(f.url, {
          after: async (query) => {
            if (query.text === input.source) installs++;
          },
        });
        try {
          for (const relation of ["content_publication_outbox", "post_slug_aliases"]) {
            await locker.query("BEGIN");
            await locker.query(`LOCK TABLE ${relation} IN ACCESS EXCLUSIVE MODE`);
            await expect(
              runVideoAdmissionFixture(runtime, (store) => store.cutover(input.plan, input.source)),
            ).rejects.toMatchObject({ _tag: "ControlPlaneStatementFailed", sqlState: "55P03" });
            await locker.query("ROLLBACK");
            expect(installs).toBe(0);
            expect(
              (await f.admin.query("SELECT count(*)::int AS n FROM video_notification_cutovers_v1"))
                .rows[0].n,
            ).toBe(0);
            expect(await matrixHistory(f)).toEqual(old);
          }
          expect(
            await runVideoAdmissionFixture(runtime, (store) =>
              store.cutover(input.plan, input.source),
            ),
          ).toEqual({ alreadyCommitted: false });
          expect(installs).toBe(1);
          expect(await matrixHistory(f)).toEqual(old);
        } finally {
          await locker.query("ROLLBACK");
          await locker.end();
        }
      });
      completed();
    }, 120000);

    test("publisher actually waits at outbox exclusion, then commits in new cohort; preselected old delivery remains terminal", async () => {
      await withInbox(async (f) => {
        await startMatrixActors(f);
        const video = await prepareMatrixVideo(f, "cutover-publisher");
        await video.publish();
        const old = await matrixComment(f, video.postId, "cutover-preselected");
        const oldState = async () =>
          (
            await f.admin.query(
              "SELECT to_jsonb(f) AS fact,to_jsonb(d) AS receipt FROM content_publication_outbox f JOIN notification_publication_deliveries d ON d.source_event_id=f.outbox_event_id WHERE f.outbox_event_id=$1",
              [old.outbox_event_id],
            )
          ).rows;
        const before = await oldState();
        const input = await prepareMatrixAdmission(f);
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const publisherPid = Promise.withResolvers<number>();
        const cutoverRuntime = matrixObservedRuntime(f.url, {
          after: async (query) => {
            if (query.text.startsWith("LOCK TABLE post_slug_aliases")) {
              held.resolve();
              await release.promise;
            }
          },
        });
        const publicationRuntime = matrixObservedRuntime(f.url, {
          before: async (query, pid) => {
            if (query.text.includes("INSERT INTO content_publication_outbox"))
              publisherPid.resolve(pid);
          },
        });
        const cutover = runVideoAdmissionFixture(cutoverRuntime, (store) =>
          store.cutover(input.plan, input.source),
        );
        // Observe failures immediately while coordinating, then always drain.
        const cutoverSettled = Promise.allSettled([cutover]);
        let publication: ReturnType<typeof f.submit> | undefined;
        let publicationSettled:
          | Promise<PromiseSettledResult<Awaited<ReturnType<typeof f.submit>>>[]>
          | undefined;
        let coordinationError: unknown;
        try {
          await matrixDeadline(held.promise);
          publication = f.submit(
            "cutover-waiting-publisher",
            undefined,
            "inbox-author",
            false,
            video.postId,
            community,
            publicationRuntime,
          );
          publicationSettled = Promise.allSettled([publication]);
          const pid = await matrixDeadline(publisherPid.promise);
          let blocked = false;
          for (let attempt = 0; attempt < 300; attempt++) {
            const row = (
              await f.admin.query(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='content_publication_outbox'::regclass AND NOT granted) AS blocked",
                [pid],
              )
            ).rows[0];
            if (row.blocked) {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
        } catch (error) {
          coordinationError = error;
        } finally {
          release.resolve();
        }
        const outcomes = [
          ...(await cutoverSettled),
          ...(await (publicationSettled ?? Promise.resolve([]))),
        ];
        if (coordinationError || outcomes.some((row) => row.status === "rejected"))
          throw new AggregateError(
            [
              ...(coordinationError ? [coordinationError] : []),
              ...outcomes.filter((row) => row.status === "rejected").map((row) => row.reason),
            ],
            "Cutover/publisher native coordination failed",
          );
        expect(await cutover).toEqual({ alreadyCommitted: false });
        if (!publication) throw new Error("Actual publisher was not started");
        const published = await publication;
        if (published.kind !== "created" && published.kind !== "replay")
          throw new Error("Actual new-cohort publication required");
        expect(
          (
            await f.admin.query(
              "SELECT d.outcome FROM content_publication_outbox f JOIN notification_publication_deliveries d ON d.source_event_id=f.outbox_event_id WHERE f.submission_id=$1 AND f.event_type='comment_notification'",
              [published.snapshot.submission_id],
            )
          ).rows,
        ).toEqual([{ outcome: "delivered" }]);
        expect(await f.run(f.store.deliver({ sourceEventId: old.outbox_event_id }))).toEqual({
          processed: false,
          delivered: false,
        });
        expect(await oldState()).toEqual(before);
        expect(await f.run(f.store.recover())).toMatchObject({ examined: 0, processed: 0 });
      });
      completed();
    }, 120000);
  });
}
