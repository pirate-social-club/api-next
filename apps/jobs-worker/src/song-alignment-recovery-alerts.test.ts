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

const emptyCursor = JSON.stringify({ operation_id: "", workflow_instance_id: "" });
function cursorRuntime(
  candidates: readonly Readonly<Record<string, unknown>>[],
  options: { stored?: string; missing?: boolean; fail?: "initialize" | "lookups" | "advance" } = {},
) {
  let stored = options.missing ? undefined : (options.stored ?? emptyCursor);
  let advances = 0;
  const execute: ControlPlaneDb["Service"]["execute"] = ((statement) => {
    if (statement.label.endsWith("cursor.initialize")) {
      if (options.fail === "initialize") return Effect.die("private initialization failure");
      return Effect.sync(() => {
        stored ??= String(statement.values[0]);
        return { rows: [], rowCount: 0 };
      });
    }
    if (statement.label.endsWith("-cursor"))
      return Effect.succeed({ rows: [{ last_identifier: stored }], rowCount: 1 });
    if (statement.label.endsWith("cursor.advance")) {
      if (options.fail === "advance") return Effect.die("private storage failure");
      return Effect.sync(() => {
        stored = String(statement.values[0]);
        advances += 1;
        return { rows: [], rowCount: 1 };
      });
    }
    if (statement.label.endsWith("lookups")) {
      if (options.fail === "lookups") return Effect.die("private lookup failure");
      const afterOperation = String(statement.values[0]);
      const afterWorkflow = String(statement.values[1]);
      const rows = candidates
        .filter(
          (candidate) =>
            String(candidate.operation_id) > afterOperation ||
            (candidate.operation_id === afterOperation &&
              String(candidate.workflow_instance_id) > afterWorkflow),
        )
        .slice(0, 50);
      return Effect.succeed({ rows, rowCount: rows.length });
    }
    return Effect.succeed({ rows: [], rowCount: 0 });
  }) as ControlPlaneDb["Service"]["execute"];
  return {
    layer: Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
    stored: () => stored ?? "",
    advances: () => advances,
  };
}
const runtime = cursorRuntime([
  {
    operation_id: "recovery-operation",
    workflow_revision: "3",
    workflow_instance_id: "media-recovery-operation-r3",
  },
]).layer;

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

  test("bounds each tick to 50 inspections, resumes later candidates and wraps with deduplication", async () => {
    const candidates = Array.from({ length: 51 }, (_, index) => {
      const operationId = `pagination-operation-${String(index + 1).padStart(3, "0")}`;
      return {
        operation_id: operationId,
        workflow_revision: "1",
        workflow_instance_id: `media-${operationId}-r1`,
      };
    });
    const controlPlane = cursorRuntime(candidates, { missing: true });
    const inspected: string[] = [];
    const diagnostic = alignmentRecoveryTerminalMessage({
      outcome: "alignment_recovery_lookup_stale",
      reason: "invalid_projection_row_count",
    });
    const workflow: CloudflareMediaWorkflowBinding = {
      get: async (instanceId) => {
        inspected.push(instanceId);
        return {
          status: async () => ({
            status: instanceId === "media-pagination-operation-051-r1" ? "errored" : "running",
            error: { name: "Error", message: diagnostic },
          }),
          sendEvent: async () => undefined,
        };
      },
      createBatch: async () => [],
    };
    const logs: PipelineLogFields[] = [];
    const sink = {
      ...makeLocalAlertSink(),
      log: (_event: string, fields: PipelineLogFields) => logs.push(fields),
    };
    const emitted: number[] = [];
    const inspectedPerTick: number[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      const before = inspected.length;
      emitted.push(
        await Effect.runPromise(
          alertTick(
            sink,
            collectSongAlignmentRecoveryAlerts(workflow).pipe(Effect.provide(controlPlane.layer)),
          ),
        ),
      );
      inspectedPerTick.push(inspected.length - before);
    }
    expect(emitted).toEqual([0, 1, 0, 1]);
    expect(inspectedPerTick).toEqual([50, 1, 50, 1]);
    expect(new Set(inspected).size).toBe(51);
    expect(JSON.parse(controlPlane.stored())).toEqual({
      operation_id: "pagination-operation-051",
      workflow_instance_id: "media-pagination-operation-051-r1",
    });
    expect(logs.map((entry) => entry.event)).toEqual([
      "pipeline.alert",
      "pipeline.alert.suppression",
    ]);
    expect(logs[0]).toMatchObject({ operation_id: "pagination-operation-051", severity: "high" });
  });

  test("advances past malformed candidates and failed Workflow observations", async () => {
    const candidates = Array.from({ length: 51 }, (_, index) => ({
      operation_id: `advance-${String(index).padStart(3, "0")}`,
      workflow_revision: index < 49 ? "invalid" : "1",
      workflow_instance_id: `media-advance-${String(index).padStart(3, "0")}-r1`,
    }));
    const controlPlane = cursorRuntime(candidates);
    const inspected: string[] = [];
    const workflow: CloudflareMediaWorkflowBinding = {
      get: async (id) => {
        inspected.push(id);
        throw new Error("private Workflow response");
      },
      createBatch: async () => [],
    };
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      for (let tick = 0; tick < 2; tick += 1)
        expect(
          await Effect.runPromise(
            alertTick(
              makeLocalAlertSink(),
              collectSongAlignmentRecoveryAlerts(workflow).pipe(Effect.provide(controlPlane.layer)),
            ),
          ),
        ).toBe(0);
    } finally {
      console.error = original;
    }
    expect(inspected).toEqual(["media-advance-049-r1", "media-advance-050-r1"]);
    expect(controlPlane.advances()).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.[0]).toBe("song_alignment_recovery_workflow_observation_unavailable");
    expect(JSON.stringify(errors)).not.toContain("private");
  });

  for (const failure of ["initialize", "stored", "candidate", "lookups", "advance"] as const)
    test(`logs an error and performs no Workflow I/O when the scan fails at ${failure}`, async () => {
      const candidate = {
        operation_id: "scan-operation",
        workflow_revision: "1",
        workflow_instance_id: failure === "candidate" ? null : "media-scan-operation-r1",
      };
      const controlPlane = cursorRuntime([candidate], {
        ...(failure === "stored" ? { stored: "private malformed cursor" } : {}),
        ...(failure === "initialize" || failure === "lookups" || failure === "advance"
          ? { fail: failure }
          : {}),
      });
      let inspected = 0;
      const workflow: CloudflareMediaWorkflowBinding = {
        get: async () => {
          inspected += 1;
          throw new Error("must not observe");
        },
        createBatch: async () => [],
      };
      const errors: unknown[][] = [];
      const original = console.error;
      console.error = (...args) => errors.push(args);
      try {
        expect(
          await Effect.runPromise(
            alertTick(
              makeLocalAlertSink(),
              collectSongAlignmentRecoveryAlerts(workflow).pipe(Effect.provide(controlPlane.layer)),
            ),
          ),
        ).toBe(0);
      } finally {
        console.error = original;
      }
      expect(inspected).toBe(0);
      expect(controlPlane.advances()).toBe(0);
      expect(errors).toEqual([["song_alignment_recovery_alert_scan_unavailable"]]);
    });
});
