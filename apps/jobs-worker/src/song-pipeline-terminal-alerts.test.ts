import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import * as BunRuntime from "bun";
import { Effect, Layer } from "effect";
import {
  type AlertSuppressionState,
  alertTick,
  decideAlertSuppression,
  type PipelineLogFields,
} from "../../../packages/platform-cf/src/alerts.ts";
import type { CloudflareDataRegistrationWorkflowBinding } from "../../../packages/platform-cf/src/data/registration-workflow-cloudflare.ts";
import type { CloudflareMediaWorkflowBinding } from "../../../packages/platform-cf/src/media-processing-cloudflare.ts";
import {
  collectSongMaintenanceObservationAlert,
  collectSongPipelineTerminalAlerts,
  handleSongPipelineDlqBatch,
  SONG_MAINTENANCE_OBSERVATION_OPERATION_ID,
  SONG_MAINTENANCE_OBSERVATION_WORKFLOW_ID,
} from "./song-pipeline-terminal-alerts.ts";

function runtime(
  execute: (statement: ControlPlaneStatement) => ReturnType<ControlPlaneDb["Service"]["execute"]>,
) {
  return Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: () => Effect.die("terminal alert collectors are read-only"),
  } as unknown as ControlPlaneDb["Service"]);
}

const mediaWorkflow = (status: "running" | "errored"): CloudflareMediaWorkflowBinding => ({
  get: async () => ({
    status: async () => ({ status }),
    sendEvent: async () => undefined,
  }),
  createBatch: async () => [],
});

const dataWorkflow = (status: string): CloudflareDataRegistrationWorkflowBinding => ({
  get: async () => ({ status: async () => ({ status }) }),
  createBatch: async () => [],
});

describe("song pipeline terminal alert collectors", () => {
  test("emits the production observation only after the opaque revision-ceiling identity is absent", async () => {
    const requested: string[] = [];
    const logs: PipelineLogFields[] = [];
    const binding: CloudflareMediaWorkflowBinding = {
      get: async (instanceId) => {
        requested.push(instanceId);
        throw new Error("instance does not exist");
      },
      createBatch: async () => {
        throw new Error("the observation must never create a Workflow");
      },
    };

    const emitted = await Effect.runPromise(
      alertTick(
        {
          environment: "production",
          log: (_event, fields) => logs.push(fields),
        },
        collectSongMaintenanceObservationAlert({
          enabled: true,
          environment: "production",
          media: binding,
        }),
      ),
    );

    expect(emitted).toBe(1);
    expect(requested).toEqual([SONG_MAINTENANCE_OBSERVATION_WORKFLOW_ID]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "pipeline.alert",
        severity: "high",
        key: "song-pipeline:media-replacement-limit-reached",
        operation_id: SONG_MAINTENANCE_OBSERVATION_OPERATION_ID,
        workflow_revision: 4,
        failure_class: "workflow_missing_at_replacement_limit",
        outcome: "terminal",
      }),
    );
  });

  test("keeps the observation inert when disabled and fails closed if its identity exists", async () => {
    let reads = 0;
    const binding = mediaWorkflow("running");
    const counted: CloudflareMediaWorkflowBinding = {
      ...binding,
      get: async (instanceId) => {
        reads += 1;
        return binding.get(instanceId);
      },
    };

    expect(
      await Effect.runPromise(
        alertTick(
          {},
          collectSongMaintenanceObservationAlert({
            enabled: false,
            environment: "production",
            media: counted,
          }),
        ),
      ),
    ).toBe(0);
    expect(reads).toBe(0);

    await expect(
      Effect.runPromise(
        alertTick(
          {},
          collectSongMaintenanceObservationAlert({
            enabled: true,
            environment: "production",
            media: counted,
          }),
        ),
      ),
    ).rejects.toThrow("Workflow identity unexpectedly exists");
    expect(reads).toBe(1);
  });

  test("emits each authoritative terminal condition with redacted correlation", async () => {
    const statements: ControlPlaneStatement[] = [];
    const logs: PipelineLogFields[] = [];
    const controlPlane = runtime((statement) => {
      statements.push(statement);
      if (statement.label === "song-pipeline.terminal.data-reconciliation") {
        return Effect.succeed({
          rows: [{ operation_id: "registration-1", workflow_revision: "2" }],
          rowCount: 1,
        });
      }
      if (statement.label === "song-pipeline.terminal.media-provider-failures") {
        return Effect.succeed({
          rows: [
            {
              operation_id: "media-operation-1",
              workflow_revision: "3",
              attempt_id: "attempt-3",
              failure_code: "provider_unavailable",
            },
          ],
          rowCount: 1,
        });
      }
      if (statement.label === "song-pipeline.terminal.media-workflow-ceiling") {
        return Effect.succeed({
          rows: [
            {
              operation_id: "media-operation-2",
              workflow_revision: "4",
              workflow_instance_id: "media-media-operation-2-r4",
            },
          ],
          rowCount: 1,
        });
      }
      if (statement.label === "song-pipeline.terminal.data-workflow-ceiling") {
        return Effect.succeed({
          rows: [
            {
              operation_id: "registration-2",
              workflow_revision: "4",
              workflow_instance_id: "data-registration-workflow:registration-2:r4",
            },
          ],
          rowCount: 1,
        });
      }
      return Effect.die("unexpected terminal alert query");
    });

    const emitted = await Effect.runPromise(
      alertTick(
        {
          environment: "staging",
          log: (_event, fields) => logs.push(fields),
        },
        collectSongPipelineTerminalAlerts(
          controlPlane,
          { media: true, data: true },
          { media: mediaWorkflow("errored"), data: dataWorkflow("errored") },
        ),
      ),
    );

    expect(emitted).toBe(4);
    expect(
      logs
        .filter((fields) => fields.event === "pipeline.alert")
        .map((fields) => fields.key)
        .sort(),
    ).toEqual([
      "song-pipeline:data-reconciliation-required",
      "song-pipeline:data-replacement-limit-reached",
      "song-pipeline:media-provider-terminal-failure",
      "song-pipeline:media-replacement-limit-reached",
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "pipeline.alert",
        operation_id: "media-operation-1",
        workflow_revision: 3,
        subsystem: "media",
        operation: "media-analysis",
        failure_class: "provider_unavailable",
        outcome: "terminal",
      }),
    );
    expect(JSON.stringify(logs)).not.toContain("workflow_instance_id");
    expect(statements.every((statement) => statement.readonly === true)).toBe(true);
  });

  test("requires current lineage, a terminal attempt, and a delivered launch before alerting", async () => {
    const statements: ControlPlaneStatement[] = [];
    const controlPlane = runtime((statement) => {
      statements.push(statement);
      return Effect.succeed({ rows: [], rowCount: 0 });
    });
    await Effect.runPromise(
      alertTick(
        {},
        collectSongPipelineTerminalAlerts(
          controlPlane,
          { media: true, data: true },
          { media: mediaWorkflow("running"), data: dataWorkflow("running") },
        ),
      ),
    );
    const sql = (label: string) =>
      statements.find((statement) => statement.label === label)?.text ?? "";
    const reconciliationSql = sql("song-pipeline.terminal.data-reconciliation");
    const providerSql = sql("song-pipeline.terminal.media-provider-failures");
    const mediaWorkflowSql = sql("song-pipeline.terminal.media-workflow-ceiling");
    const dataWorkflowSql = sql("song-pipeline.terminal.data-workflow-ceiling");

    expect(reconciliationSql).toContain("state='reconciliation_required'");
    expect(providerSql).toContain("attempt.state='exhausted'");
    expect(providerSql).toContain("attempt.attempt_number=3");
    expect(providerSql).toContain("submission.status='manual_review'");
    expect(providerSql).toContain("submission.review_exhaustion_code='acr_exhausted'");
    expect(providerSql).toContain("submission.review_exhaustion_attempt_id=attempt.attempt_id");
    expect(providerSql).toContain("attempt.audio_revision=submission.audio_revision");
    expect(providerSql).toContain("attempt.analysis_revision=submission.analysis_revision");
    expect(providerSql).toContain("NOT EXISTS");
    expect(providerSql).toContain("later.attempt_number>attempt.attempt_number");
    expect(mediaWorkflowSql).toContain("launch.workflow_revision=submission.workflow_revision");
    expect(mediaWorkflowSql).toContain("launch.state IN ('delivered','exhausted')");
    expect(dataWorkflowSql).toContain("launch.workflow_revision=operation.workflow_revision");
    expect(dataWorkflowSql).toContain(
      "operation.state NOT IN ('registered','failed','reconciliation_required')",
    );
  });

  test("does not manufacture a ceiling alert for a present Workflow or stale rows", async () => {
    const logs: PipelineLogFields[] = [];
    const controlPlane = runtime((statement) => {
      if (statement.label === "song-pipeline.terminal.media-provider-failures") {
        return Effect.succeed({
          rows: [
            {
              operation_id: "invalid correlation",
              workflow_revision: "3",
              attempt_id: "attempt-3",
              failure_code: "provider_unavailable",
            },
          ],
          rowCount: 1,
        });
      }
      if (statement.label === "song-pipeline.terminal.media-workflow-ceiling") {
        return Effect.succeed({
          rows: [
            {
              operation_id: "media-operation-1",
              workflow_revision: "4",
              workflow_instance_id: "media-media-operation-1-r4",
            },
          ],
          rowCount: 1,
        });
      }
      return Effect.succeed({ rows: [], rowCount: 0 });
    });

    expect(
      await Effect.runPromise(
        alertTick(
          { log: (_event, fields) => logs.push(fields) },
          collectSongPipelineTerminalAlerts(
            controlPlane,
            { media: true, data: false },
            { media: mediaWorkflow("running") },
          ),
        ),
      ),
    ).toBe(0);
    expect(logs).toEqual([]);
  });

  test("isolates one failed collector and continues the remaining read-only collectors", async () => {
    const logs: PipelineLogFields[] = [];
    const diagnostics: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    try {
      const controlPlane = runtime((statement) =>
        statement.label === "song-pipeline.terminal.data-reconciliation"
          ? Effect.die("fixture query unavailable")
          : statement.label === "song-pipeline.terminal.data-workflow-ceiling"
            ? Effect.succeed({
                rows: [
                  {
                    operation_id: "registration-2",
                    workflow_revision: "4",
                    workflow_instance_id: "data-registration-workflow:registration-2:r4",
                  },
                ],
                rowCount: 1,
              })
            : Effect.succeed({ rows: [], rowCount: 0 }),
      );
      expect(
        await Effect.runPromise(
          alertTick(
            { log: (_event, fields) => logs.push(fields) },
            collectSongPipelineTerminalAlerts(
              controlPlane,
              { media: false, data: true },
              { data: dataWorkflow("errored") },
            ),
          ),
        ),
      ).toBe(1);
    } finally {
      console.error = original;
    }
    expect(diagnostics).toEqual(["song-pipeline DATA reconciliation alert query unavailable"]);
    expect(logs).toContainEqual(
      expect.objectContaining({ key: "song-pipeline:data-replacement-limit-reached" }),
    );
  });
});

function queueMessage(body: unknown) {
  const actions: string[] = [];
  const message = {
    body,
    ack: () => actions.push("ack"),
    retry: (options?: { readonly delaySeconds?: number }) =>
      actions.push(`retry:${options?.delaySeconds ?? "default"}`),
  };
  return { message, actions };
}

describe("song pipeline Queue DLQ collector", () => {
  test("alerts a genuine current DLQ delivery once and records bounded suppression", async () => {
    const logs: PipelineLogFields[] = [];
    const states = new Map<string, AlertSuppressionState>();
    const marks = new Set<string>();
    const sink = {
      environment: "staging",
      log: (_event: string, fields: PipelineLogFields) => logs.push(fields),
      delivery: {
        markSent: (key: string) =>
          Effect.sync(() => {
            if (marks.has(key)) return false;
            marks.add(key);
            return true;
          }),
        compensate: (key: string) => Effect.sync(() => void marks.delete(key)),
        suppression: {
          decide: (input: {
            conditionKey: string;
            severity: "low" | "medium" | "high";
            nowMs: number;
            activeWindowMs?: number;
          }) =>
            Effect.sync(() => {
              const previous = states.get(input.conditionKey);
              const decision = decideAlertSuppression({
                ...input,
                ...(previous === undefined ? {} : { previous }),
              });
              states.set(input.conditionKey, decision.state);
              return decision;
            }),
        },
      },
    };
    const statements: ControlPlaneStatement[] = [];
    const controlPlane = runtime((statement) => {
      statements.push(statement);
      return Effect.succeed({
        rows: [
          {
            operation_id: "media-operation-1",
            outbox_id: "media-outbox-1",
            workflow_revision: "2",
            failure_code: "provider_unavailable",
          },
        ],
        rowCount: 1,
      });
    });
    const first = queueMessage({ outbox_id: "media-outbox-1" });
    const second = queueMessage({ outbox_id: "media-outbox-1" });

    await handleSongPipelineDlqBatch(
      { queue: "pirate-media-processing-staging-dlq", messages: [first.message] },
      { runtime: controlPlane, sink, environment: "staging" },
    );
    await handleSongPipelineDlqBatch(
      { queue: "pirate-media-processing-staging-dlq", messages: [second.message] },
      { runtime: controlPlane, sink, environment: "staging" },
    );

    expect(first.actions).toEqual(["ack"]);
    expect(second.actions).toEqual(["ack"]);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.text).toContain("outbox.state<>'delivered'");
    expect(statements[0]?.text).toContain("submission.workflow_revision=outbox.workflow_revision");
    expect(logs.map((fields) => fields.event)).toEqual([
      "pipeline.alert",
      "pipeline.alert.suppression",
    ]);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        key: "song-pipeline:media-queue-dlq",
        operation_id: "media-operation-1",
        outbox_id: "media-outbox-1",
        workflow_revision: 2,
        subsystem: "media",
        failure_class: "provider_unavailable",
        outcome: "terminal",
      }),
    );
  });

  test("acks invalid, missing, stale, and superseded identities without manufacturing an alert", async () => {
    const labels: string[] = [];
    const logs: PipelineLogFields[] = [];
    const diagnostics: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    const controlPlane = runtime((statement) => {
      labels.push(statement.label);
      return Effect.succeed({ rows: [], rowCount: 0 });
    });
    const invalid = queueMessage({ outbox_id: "outbox-1", content: "must-not-cross" });
    const stale = queueMessage({ outbox_id: "outbox-stale" });
    try {
      await handleSongPipelineDlqBatch(
        {
          queue: "pirate-data-registration-production-dlq",
          messages: [invalid.message, stale.message],
        },
        {
          runtime: controlPlane,
          sink: { environment: "production", log: (_event, fields) => logs.push(fields) },
          environment: "production",
        },
      );
    } finally {
      console.error = original;
    }

    expect(invalid.actions).toEqual(["ack"]);
    expect(stale.actions).toEqual(["ack"]);
    expect(labels).toEqual(["song-pipeline.dlq.data-authority"]);
    expect(logs).toEqual([]);
    expect(JSON.stringify({ logs, diagnostics })).not.toContain("must-not-cross");
  });

  test("retries only the diagnostic delivery when PostgreSQL is unavailable", async () => {
    const diagnostics: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    const failed = queueMessage({ outbox_id: "outbox-1" });
    try {
      await handleSongPipelineDlqBatch(
        { queue: "pirate-data-registration-staging-dlq", messages: [failed.message] },
        {
          runtime: runtime(() => Effect.die("fixture database unavailable")),
          sink: {},
          environment: "staging",
        },
      );
    } finally {
      console.error = original;
    }
    expect(failed.actions).toEqual(["retry:300"]);
    expect(diagnostics).toEqual(["song-pipeline DLQ authority query unavailable"]);
  });

  test("declares both DLQ consumers in every environment while production observation is scheduled", async () => {
    const wrangler = BunRuntime.JSONC.parse(
      await BunRuntime.file(new URL("../wrangler.jsonc", import.meta.url)).text(),
    ) as {
      readonly queues?: Readonly<{ consumers?: readonly Readonly<{ queue: string }>[] }>;
      readonly env?: Readonly<
        Record<
          string,
          {
            readonly queues?: Readonly<{
              consumers?: readonly Readonly<{ queue: string }>[];
            }>;
            readonly triggers?: Readonly<{ crons?: readonly string[] }>;
          }
        >
      >;
    };

    for (const environment of ["development", "staging", "production"] as const) {
      const block = environment === "development" ? wrangler : wrangler.env?.[environment];
      expect(block?.queues?.consumers?.map((consumer) => consumer.queue).sort()).toEqual([
        `pirate-data-registration-${environment}-dlq`,
        `pirate-media-processing-${environment}-dlq`,
      ]);
    }
    expect(wrangler.env?.production?.triggers?.crons).toEqual(["* * * * *"]);
  });
});
