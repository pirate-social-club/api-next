import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  type AlignmentRecoveryLookupDiagnostic,
  alignmentRecoveryTerminalMessage,
} from "../../../packages/application/src/media/alignment-recovery-diagnostics.ts";
import {
  alertTick,
  makeLocalAlertSink,
  type PipelineLogFields,
} from "../../../packages/platform-cf/src/alerts.ts";
import type { CloudflareMediaWorkflowBinding } from "../../../packages/platform-cf/src/media-processing-cloudflare.ts";
import { collectSongAlignmentRecoveryAlerts } from "./song-alignment-recovery-alerts.ts";

const runtime = Layer.succeed(ControlPlaneDb, {
  execute: (statement) =>
    Effect.succeed({
      rows: statement.label.endsWith("lookups")
        ? [
            {
              operation_id: "recovery-operation",
              workflow_revision: "3",
              workflow_instance_id: "media-recovery-operation-r3",
            },
          ]
        : [],
      rowCount: statement.label.endsWith("lookups") ? 1 : 0,
    }),
  withTransaction: () => Effect.die("alert observation is read-only"),
} as ControlPlaneDb["Service"]);

const binding = (
  message: string,
  status: "errored" | "running" = "errored",
): CloudflareMediaWorkflowBinding => ({
  get: async () => ({
    status: async () => ({ status, error: { name: "Error", message } }),
    sendEvent: async () => undefined,
  }),
  createBatch: async () => [],
});

describe("alignment recovery terminal alerts", () => {
  const diagnostics: AlignmentRecoveryLookupDiagnostic[] = [
    ...(
      [
        "invalid_publication_binding",
        "multiple_recovery_rows",
        "malformed_recovery_identifiers",
        "invalid_projection_row_count",
        "unknown_projection_status",
        "invalid_failure_code",
        "malformed_artifact",
      ] as const
    ).map((reason) => ({ outcome: "alignment_recovery_lookup_stale" as const, reason })),
    {
      outcome: "alignment_recovery_lookup_failed",
      reason: {
        errorClass: "ControlPlaneStatementFailed",
        code: "57014",
        query: "media-processing.alignment-recovery-authorization",
      },
    },
  ];
  for (const diagnostic of diagnostics) {
    test(`alerts and suppresses the retained reason ${JSON.stringify(diagnostic)}`, async () => {
      const logs: PipelineLogFields[] = [];
      const sink = {
        ...makeLocalAlertSink(),
        log: (_event: string, fields: PipelineLogFields) => logs.push(fields),
      };
      const workflow = binding(
        `AlignmentRecoveryLookupTerminalError: ${alignmentRecoveryTerminalMessage(diagnostic)}`,
      );
      for (let tick = 0; tick < 2; tick += 1)
        await Effect.runPromise(
          alertTick(
            sink,
            collectSongAlignmentRecoveryAlerts(workflow).pipe(Effect.provide(runtime)),
          ),
        );
      expect(logs.map((entry) => entry.event)).toEqual([
        "pipeline.alert",
        "pipeline.alert.suppression",
      ]);
      expect(logs[0]).toMatchObject({
        operation_id: "recovery-operation",
        workflow_revision: 3,
        failure_class: diagnostic.outcome,
        severity: "high",
      });
      expect(logs[0]?.event === "pipeline.alert" ? logs[0].key : "").toContain(
        diagnostic.outcome === "alignment_recovery_lookup_stale" ? diagnostic.reason : "57014",
      );
    });
  }
  test("ignores active instances, arbitrary errors and unknown diagnostic fields", async () => {
    const logs: PipelineLogFields[] = [];
    const sink = {
      ...makeLocalAlertSink(),
      log: (_event: string, fields: PipelineLogFields) => logs.push(fields),
    };
    for (const workflow of [
      binding("private lyrics and credentials"),
      binding(
        'media-alignment-recovery:{"outcome":"alignment_recovery_lookup_stale","reason":"malformed_artifact","raw":"private row"}',
      ),
      binding(
        alignmentRecoveryTerminalMessage(diagnostics[0] as AlignmentRecoveryLookupDiagnostic),
        "running",
      ),
    ])
      await Effect.runPromise(
        alertTick(sink, collectSongAlignmentRecoveryAlerts(workflow).pipe(Effect.provide(runtime))),
      );
    expect(logs).toEqual([]);
  });
});
