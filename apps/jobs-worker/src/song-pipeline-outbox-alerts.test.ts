import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  alertTick,
  type PipelineHealthSnapshotFields,
} from "../../../packages/platform-cf/src/alerts.ts";
import {
  collectSongPipelineOutboxAlerts,
  exhaustedLaunchAlert,
  runSongPipelineOutboxAlertTick,
  SONG_PIPELINE_PENDING_DEGRADED_AGE_SECONDS,
} from "./song-pipeline-outbox-alerts";

function runtime(
  execute: (statement: ControlPlaneStatement) => ReturnType<ControlPlaneDb["Service"]["execute"]>,
) {
  return Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: () => Effect.die("health snapshots are read-only"),
  } as unknown as ControlPlaneDb["Service"]);
}

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
      subsystem: "data",
      operation: "data-registration",
      operation_id: "registration-1",
      outbox_id: "outbox-1",
      workflow_revision: 2,
      failure_class: "workflow_unavailable",
      outcome: "terminal",
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
        runSongPipelineOutboxAlertTick({}, Effect.fail(new Error("database unavailable"))),
      ).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(messages).toEqual(["song-pipeline outbox alert collection unavailable"]);
  });

  test("emits one five-minute health snapshot despite cron delivery seconds", async () => {
    const labels: string[] = [];
    const logs: PipelineHealthSnapshotFields[] = [];
    const controlPlane = runtime((statement) => {
      labels.push(statement.label);
      if (statement.label === "song-pipeline.health.media") {
        return Effect.succeed({
          rows: [
            {
              pending_count: "2",
              retrying_count: "1",
              exhausted_count: "1",
              terminal_count: "8",
              oldest_pending_age_seconds: "42",
              last_success_at: new Date("2026-08-29T00:04:00.000Z"),
            },
          ],
          rowCount: 1,
        });
      }
      return Effect.succeed({ rows: [], rowCount: 0 });
    });

    await Effect.runPromise(
      alertTick(
        { environment: "staging" },
        collectSongPipelineOutboxAlerts(
          controlPlane,
          { media: true, data: false },
          {
            scheduledTime: 5 * 60 * 1000 + 14_000,
            environment: "staging",
            log: (_event, fields) => {
              if (fields.event === "pipeline.health.snapshot") logs.push(fields);
            },
            claimSnapshot: () => Effect.succeed(true),
          },
        ),
      ),
    );

    expect(labels).toEqual(["song-pipeline.health.media", "song-pipeline.outbox.exhausted-alerts"]);
    expect(logs).toEqual([
      {
        event: "pipeline.health.snapshot",
        schema_version: 1,
        emitted_at: "1970-01-01T00:05:14.000Z",
        environment: "staging",
        subsystem: "media",
        operation: "media-analysis",
        pending_count: 2,
        retrying_count: 1,
        exhausted_count: 1,
        terminal_count: 8,
        oldest_pending_age_seconds: 42,
        last_success_at: "2026-08-29T00:04:00.000Z",
        health: "blocked",
        sampled: false,
      },
    ]);
  });

  test("projects current revisions and degrades only stale pending work", async () => {
    const statements: ControlPlaneStatement[] = [];
    const logs: PipelineHealthSnapshotFields[] = [];
    const controlPlane = runtime((statement) => {
      statements.push(statement);
      if (statement.label === "song-pipeline.health.media") {
        return Effect.succeed({
          rows: [
            {
              pending_count: "1",
              retrying_count: "0",
              exhausted_count: "0",
              terminal_count: "9",
              oldest_pending_age_seconds: String(SONG_PIPELINE_PENDING_DEGRADED_AGE_SECONDS),
              last_success_at: null,
            },
          ],
          rowCount: 1,
        });
      }
      if (statement.label === "song-pipeline.health.data") {
        return Effect.succeed({
          rows: [
            {
              pending_count: "1",
              retrying_count: "0",
              exhausted_count: "0",
              terminal_count: "4",
              oldest_pending_age_seconds: String(SONG_PIPELINE_PENDING_DEGRADED_AGE_SECONDS + 1),
              last_success_at: null,
            },
          ],
          rowCount: 1,
        });
      }
      return Effect.succeed({ rows: [], rowCount: 0 });
    });

    await Effect.runPromise(
      alertTick(
        {},
        collectSongPipelineOutboxAlerts(
          controlPlane,
          { media: true, data: true },
          {
            scheduledTime: 5 * 60 * 1000,
            log: (_event, fields) => {
              if (fields.event === "pipeline.health.snapshot") logs.push(fields);
            },
            claimSnapshot: () => Effect.succeed(true),
          },
        ),
      ),
    );

    const mediaQuery = statements.find(
      (statement) => statement.label === "song-pipeline.health.media",
    )?.text;
    expect(mediaQuery).toContain("JOIN media_post_submissions submission");
    expect(mediaQuery).toContain("submission.workflow_revision=outbox.workflow_revision");
    expect(mediaQuery).toContain(
      "submission.status IN ('processing','action_required','manual_review')",
    );

    const dataQuery = statements.find(
      (statement) => statement.label === "song-pipeline.health.data",
    )?.text;
    expect(dataQuery).toContain("JOIN data_registration_operations operation");
    expect(dataQuery).toContain("operation.workflow_revision=outbox.workflow_revision");
    expect(dataQuery).toContain(
      "operation.state NOT IN ('registered','failed','reconciliation_required')",
    );
    expect(logs.map((fields) => fields.health)).toEqual(["healthy", "degraded"]);
  });

  test("retrying current work is degraded before it becomes stale", async () => {
    const logs: PipelineHealthSnapshotFields[] = [];
    const controlPlane = runtime((statement) =>
      Effect.succeed(
        statement.label === "song-pipeline.health.media"
          ? {
              rows: [
                {
                  pending_count: "0",
                  retrying_count: "1",
                  exhausted_count: "0",
                  terminal_count: "0",
                  oldest_pending_age_seconds: null,
                  last_success_at: null,
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 },
      ),
    );

    await Effect.runPromise(
      alertTick(
        {},
        collectSongPipelineOutboxAlerts(
          controlPlane,
          { media: true, data: false },
          {
            scheduledTime: 5 * 60 * 1000,
            log: (_event, fields) => {
              if (fields.event === "pipeline.health.snapshot") logs.push(fields);
            },
            claimSnapshot: () => Effect.succeed(true),
          },
        ),
      ),
    );

    expect(logs.map((fields) => fields.health)).toEqual(["degraded"]);
  });

  test("disabled and non-boundary lanes make no health-snapshot query", async () => {
    const labels: string[] = [];
    const controlPlane = runtime((statement) => {
      labels.push(statement.label);
      return Effect.succeed({ rows: [], rowCount: 0 });
    });

    await Effect.runPromise(
      alertTick(
        {},
        collectSongPipelineOutboxAlerts(
          controlPlane,
          { media: false, data: false },
          {
            scheduledTime: 5 * 60 * 1000,
          },
        ),
      ),
    );
    expect(labels).toEqual([]);

    await Effect.runPromise(
      alertTick(
        {},
        collectSongPipelineOutboxAlerts(
          controlPlane,
          { media: true, data: false },
          {
            scheduledTime: 6 * 60 * 1000,
          },
        ),
      ),
    );
    expect(labels).toEqual(["song-pipeline.outbox.exhausted-alerts"]);
  });

  test("a rejected durable window claim suppresses the health query", async () => {
    const labels: string[] = [];
    const controlPlane = runtime((statement) => {
      labels.push(statement.label);
      return Effect.succeed({ rows: [], rowCount: 0 });
    });

    await Effect.runPromise(
      alertTick(
        {},
        collectSongPipelineOutboxAlerts(
          controlPlane,
          { media: false, data: true },
          {
            scheduledTime: 10 * 60 * 1000,
            claimSnapshot: () => Effect.succeed(false),
          },
        ),
      ),
    );
    expect(labels).toEqual(["song-pipeline.outbox.exhausted-alerts"]);
  });

  test("a failed health projection does not suppress exhausted-operation collection", async () => {
    const labels: string[] = [];
    const controlPlane = runtime((statement) => {
      labels.push(statement.label);
      if (statement.label === "song-pipeline.health.media") {
        return Effect.die("fixture health query unavailable");
      }
      return Effect.succeed({ rows: [], rowCount: 0 });
    });

    await expect(
      Effect.runPromise(
        alertTick(
          {},
          collectSongPipelineOutboxAlerts(
            controlPlane,
            { media: true, data: false },
            {
              scheduledTime: 5 * 60 * 1000,
              claimSnapshot: () => Effect.succeed(true),
            },
          ),
        ),
      ),
    ).resolves.toBe(0);
    expect(labels).toEqual(["song-pipeline.health.media", "song-pipeline.outbox.exhausted-alerts"]);
  });
});
