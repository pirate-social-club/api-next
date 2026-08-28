import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  exhaustedLaunchAlert,
  runSongPipelineOutboxAlertTick,
} from "./song-pipeline-outbox-alerts";

describe("song pipeline outbox alerts", () => {
  test("projects only redacted launch identity into one stable alert", () => {
    expect(
      exhaustedLaunchAlert({
        subsystem: "data",
        operation_id: "registration-1",
        outbox_id: "outbox-1",
        workflow_revision: "2",
        failure_code: "workflow_unavailable",
        outcome: "exhausted",
      }),
    ).toEqual({
      key: "song-pipeline:data-launch-exhausted",
      severity: "high",
      body: "A current song-pipeline launch exhausted and requires recovery observation.",
      entity: "data:registration-1:r2:outbox-1",
    });
  });

  test("distinguishes a terminal Queue DLQ outcome", () => {
    expect(
      exhaustedLaunchAlert({
        subsystem: "media",
        operation_id: "media-operation-1",
        outbox_id: "media-outbox-1",
        workflow_revision: "3",
        failure_code: "invalid_binding",
        outcome: "queue_dlq",
      }).key,
    ).toBe("song-pipeline:media-queue_dlq");
  });

  test("uses a distinct key when automatic replacements stop", () => {
    expect(
      exhaustedLaunchAlert({
        subsystem: "data",
        operation_id: "registration-2",
        outbox_id: "outbox-4",
        workflow_revision: "4",
        failure_code: "workflow_unavailable",
        outcome: "replacement_limit",
      }).key,
    ).toBe("song-pipeline:data-replacement-limit-reached");
  });

  test("isolates alert collection failure from the scheduled tick", async () => {
    const messages: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => messages.push(String(message));
    try {
      await expect(
        runSongPipelineOutboxAlertTick(
          { email: () => Effect.void, webhook: () => Effect.void },
          Effect.fail(new Error("database unavailable")),
        ),
      ).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(messages).toEqual(["song-pipeline outbox alert collection unavailable"]);
  });
});
