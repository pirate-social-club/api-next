/** Socket-free coordination tests, not SQL/MVCC or PG acceptance. */
import { expect, test } from "bun:test";
import {
  MATRIX_RESOLVER_SQL,
  matrixCommitLoss,
  matrixDispatchBarrier,
  matrixSnapshotQuery,
} from "./notifications-video-race.pg-fixture.ts";
import { READ_VIDEO_DETAIL_SNAPSHOT_V1 } from "./video-detail-repository.ts";

test("snapshot instrumentation binds its lock after original parameters and correlates the owned read after the barrier", () => {
  for (const query of [
    { text: READ_VIDEO_DETAIL_SNAPSHOT_V1, values: ["post_id", "post-owned", "viewer"] },
    { text: READ_VIDEO_DETAIL_SNAPSHOT_V1, values: ["alias", "post-owned", "viewer"] },
    { text: MATRIX_RESOLVER_SQL, values: ["viewer", "comment-owned"] },
  ]) {
    const wrapped = matrixSnapshotQuery(query, "12345");
    expect(wrapped.values).toEqual([...query.values, "12345"]);
    expect(wrapped.text).toContain(
      `pg_advisory_xact_lock_shared($${query.values.length + 1}::bigint)`,
    );
    expect(wrapped.text).toContain(`${query.text} OFFSET (matrix_snapshot_barrier.token-1)`);
    expect(query.values).not.toContain("12345");
  }
  expect(() => matrixSnapshotQuery({ text: "UPDATE posts SET status='hidden'" }, "1")).toThrow(
    "Only the actual owned detail/resolver read",
  );
});

test("native dispatch participants stay paused until explicit release, including after both have arrived", async () => {
  const gate = matrixDispatchBarrier(2);
  let finished = 0;
  const a = gate.arrive(101).then(() => {
    finished++;
  });
  await Promise.resolve();
  expect(finished).toBe(0);
  const b = gate.arrive(102).then(() => {
    finished++;
  });
  await gate.ready;
  expect(gate.pids()).toEqual([101, 102]);
  expect(finished).toBe(0);
  gate.release();
  await Promise.all([a, b]);
  expect(finished).toBe(2);
});

test("duplicate dispatch participation fails visibly without making coordination look complete", async () => {
  const gate = matrixDispatchBarrier(2);
  const a = gate.arrive(101);
  try {
    await expect(gate.arrive(101)).rejects.toThrow("Unexpected duplicate");
    expect(gate.pids()).toEqual([101]);
    expect(() => matrixDispatchBarrier(0)).toThrow("Positive participant count");
  } finally {
    gate.release();
    await a;
  }
});

test("lost acknowledgement instrumentation throws once only AFTER the successful native mutation/COMMIT callbacks", async () => {
  const loss = matrixCommitLoss("INSERT INTO video_notification_cutovers_v1");
  await loss.after({ text: "COMMIT" });
  expect(loss.lost()).toBe(false);
  await loss.after({ text: "INSERT INTO video_notification_cutovers_v1" });
  expect(loss.lost()).toBe(false);
  await expect(loss.after({ text: "COMMIT" })).rejects.toThrow("AFTER actual native COMMIT");
  expect(loss.lost()).toBe(true);
  await loss.after({ text: "COMMIT" });
  expect(loss.mutations()).toBe(1);
});
