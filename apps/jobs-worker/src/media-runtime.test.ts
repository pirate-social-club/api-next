import { describe, expect, test } from "bun:test";
import {
  isolateMediaMaintenanceAction,
  isolateMediaMaintenanceDispatch,
  observeMediaWorkflowRecovery,
  runMediaMaintenance,
} from "./media-runtime.ts";

describe("media scheduled maintenance", () => {
  test("logs only allowlisted recovery failure fields", () => {
    const logs: string[] = [];
    const original = console.error;
    console.error = (message) => logs.push(String(message));
    try {
      for (const event of [
        "workflow_lookup_failed",
        "workflow_terminal_recovery_failed",
      ] as const) {
        observeMediaWorkflowRecovery({
          event,
          operationId: "operation",
          submissionId: "submission",
          workflowRevision: 4,
        });
      }
      observeMediaWorkflowRecovery({
        event: "workflow_replaced",
        operationId: "operation",
        submissionId: "submission",
        workflowRevision: 5,
      });
    } finally {
      console.error = original;
    }
    expect(logs.map((value) => JSON.parse(value))).toEqual(
      ["workflow_lookup_failed", "workflow_terminal_recovery_failed"].map((failure_class) => ({
        event: "song-pipeline.media-workflow-recovery",
        severity: "high",
        outcome: "failed",
        failure_class,
        operation_id: "operation",
        submission_id: "submission",
        workflow_revision: 4,
      })),
    );
  });

  test("dispatches durable outbox identities before checking retained Workflows", async () => {
    const events: string[] = [];
    const result = await runMediaMaintenance({
      dispatch: async () => {
        events.push("dispatch");
        return { selected: 2, sent: 2, failed: 0 };
      },
      sweep: async () => {
        events.push("sweep");
        return {
          inspected: 1,
          present: 1,
          finished: 0,
          reconciled: 0,
          escalated: 0,
          indeterminate: 0,
          replaced: 0,
          stale: 0,
          limitReached: 0,
          lookupFailed: 0,
          recoveryFailed: 0,
        };
      },
    });

    expect(events).toEqual(["dispatch", "sweep"]);
    expect(result).toEqual({
      dispatch: { selected: 2, sent: 2, failed: 0 },
      sweep: {
        inspected: 1,
        present: 1,
        finished: 0,
        reconciled: 0,
        escalated: 0,
        indeterminate: 0,
        replaced: 0,
        stale: 0,
        limitReached: 0,
        lookupFailed: 0,
        recoveryFailed: 0,
      },
    });
  });

  test("contains video-stage failures so song maintenance can continue", async () => {
    const diagnostics: unknown[][] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => diagnostics.push(values);
    let songDispatches = 0;
    const cleanupError = new Error("video storage unavailable");
    const dispatchError = new Error("video outbox unavailable");
    try {
      const result = await runMediaMaintenance({
        dispatch: async () => {
          await isolateMediaMaintenanceAction("video cleanup", async () => {
            throw cleanupError;
          });
          const [song, video] = await Promise.all([
            (async () => {
              songDispatches += 1;
              return { selected: 1, sent: 1, failed: 0 };
            })(),
            isolateMediaMaintenanceDispatch("video dispatch", async () => {
              throw dispatchError;
            }),
          ]);
          return {
            selected: song.selected + video.selected,
            sent: song.sent + video.sent,
            failed: song.failed + video.failed,
          };
        },
        sweep: async () => ({
          inspected: 0,
          present: 0,
          finished: 0,
          reconciled: 0,
          escalated: 0,
          indeterminate: 0,
          replaced: 0,
          stale: 0,
          limitReached: 0,
          lookupFailed: 0,
          recoveryFailed: 0,
        }),
      });

      expect(result.dispatch).toEqual({ selected: 1, sent: 1, failed: 1 });
    } finally {
      console.error = original;
    }
    expect(songDispatches).toBe(1);
    expect(diagnostics).toEqual([
      ["media maintenance video cleanup unavailable", cleanupError],
      ["media maintenance video dispatch unavailable", dispatchError],
    ]);
  });
});
