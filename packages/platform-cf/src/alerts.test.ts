import { describe, expect, test } from "bun:test";
import { type Alert, AlertCollector } from "@pirate/application";
import { Effect } from "effect";

import {
  type AlertCorrelationFields,
  type AlertLogFields,
  type AlertSink,
  alertTick,
  decideAlertSuppression,
} from "./alerts";

const emit = (alert: Alert) => AlertCollector.use((service) => service.emit(alert));

describe("api-next alert delivery policy", () => {
  test("low severity persists a structured log and never pages", async () => {
    const logs: AlertLogFields[] = [];
    const events: string[] = [];
    const sink: AlertSink = {
      environment: "staging",
    };

    await Effect.runPromise(
      alertTick(sink, emit({ key: "routine:check", severity: "low", body: "fixed" }), {
        log: (event, fields) => {
          events.push(event);
          logs.push(fields);
        },
      }),
    );

    expect(logs).toHaveLength(1);
    expect(events).toEqual(["pipeline.alert"]);
    expect(logs[0]).toMatchObject({
      event: "pipeline.alert",
      schema_version: 1,
      environment: "staging",
      key: "routine:check",
      severity: "low",
      count: 1,
      suppression: "transition",
      sampled: false,
      operation: "maintenance",
    });
    expect(logs[0]).not.toHaveProperty("entity");
  });

  test("persists the exact allowlisted pipeline correlation shape", async () => {
    const logs: AlertLogFields[] = [];
    const pipelineAlert: Alert & AlertCorrelationFields = {
      key: "song-pipeline:data-launch-exhausted",
      severity: "high",
      body: "fixed",
      entity: "data:registration-1:r2:outbox-1",
      subsystem: "data",
      operation: "data-registration",
      operation_id: "registration-1",
      outbox_id: "outbox-1",
      workflow_revision: 2,
      failure_class: "workflow_unavailable",
      outcome: "terminal",
    };

    await Effect.runPromise(
      alertTick({ environment: "staging" }, emit(pipelineAlert), {
        now: () => 0,
        log: (_event, fields) => logs.push(fields),
      }),
    );

    expect(logs).toEqual([
      {
        event: "pipeline.alert",
        schema_version: 1,
        emitted_at: "1970-01-01T00:00:00.000Z",
        environment: "staging",
        key: "song-pipeline:data-launch-exhausted",
        severity: "high",
        count: 1,
        overflow: 0,
        suppression: "transition",
        sampled: false,
        subsystem: "data",
        operation: "data-registration",
        operation_id: "registration-1",
        outbox_id: "outbox-1",
        workflow_revision: 2,
        failure_class: "workflow_unavailable",
        outcome: "terminal",
      },
    ]);
  });

  test("alerts on transition, then follows widening reminders", () => {
    const activeWindowMs = 24 * 60 * 60 * 1000;
    const first = decideAlertSuppression({
      conditionKey: "routing:integrity|route:stuck",
      severity: "medium",
      nowMs: 0,
      activeWindowMs,
    });
    expect(first).toMatchObject({ deliver: true, reason: "transition" });

    const fiveMinutes = decideAlertSuppression({
      conditionKey: first.state.conditionKey,
      severity: "medium",
      nowMs: 5 * 60 * 1000,
      previous: first.state,
      activeWindowMs,
    });
    expect(fiveMinutes).toMatchObject({ deliver: false, reason: "suppressed" });

    const tenMinutes = decideAlertSuppression({
      conditionKey: first.state.conditionKey,
      severity: "medium",
      nowMs: 10 * 60 * 1000,
      previous: fiveMinutes.state,
      activeWindowMs,
    });
    expect(tenMinutes).toMatchObject({ deliver: false, reason: "suppressed" });

    const oneHour = decideAlertSuppression({
      conditionKey: first.state.conditionKey,
      severity: "medium",
      nowMs: 60 * 60 * 1000,
      previous: tenMinutes.state,
      activeWindowMs,
    });
    expect(oneHour).toMatchObject({ deliver: true, reason: "reminder" });

    const fiveHours = decideAlertSuppression({
      conditionKey: first.state.conditionKey,
      severity: "medium",
      nowMs: 5 * 60 * 60 * 1000,
      previous: oneHour.state,
      activeWindowMs,
    });
    expect(fiveHours).toMatchObject({ deliver: true, reason: "reminder" });
  });

  test("treats a returning condition and severity escalation as transitions", () => {
    const initial = decideAlertSuppression({
      conditionKey: "routing:integrity|route:ready",
      severity: "medium",
      nowMs: 0,
    });
    const returning = decideAlertSuppression({
      conditionKey: initial.state.conditionKey,
      severity: "medium",
      nowMs: 11 * 60 * 1000,
      previous: initial.state,
    });
    expect(returning).toMatchObject({ deliver: true, reason: "transition" });

    const escalated = decideAlertSuppression({
      conditionKey: initial.state.conditionKey,
      severity: "high",
      nowMs: 12 * 60 * 1000,
      previous: returning.state,
    });
    expect(escalated).toMatchObject({ deliver: true, reason: "severity-escalation" });
  });

  test("persists state across repeated ticks and widens reminders", async () => {
    let nowMs = 0;
    const logs: AlertLogFields[] = [];
    const states = new Map<string, ReturnType<typeof decideAlertSuppression>["state"]>();
    const sink: AlertSink = {
      log: (_event, fields) => {
        if (fields.event === "pipeline.alert") logs.push(fields);
      },
      delivery: {
        markSent: () => Effect.succeed(true),
        compensate: () => Effect.void,
        suppression: {
          get: (key) => Effect.succeed(states.get(key) ?? null),
          put: (state) => Effect.sync(() => void states.set(state.conditionKey, state)),
        },
      },
    };
    const tick = alertTick(
      sink,
      emit({ key: "routing:integrity", severity: "high", body: "condition", entity: "route:1" }),
      { now: () => nowMs, activeWindowMs: 24 * 60 * 60 * 1000 },
    );

    await Effect.runPromise(tick);
    nowMs = 5 * 60 * 1000;
    await Effect.runPromise(tick);

    nowMs = 60 * 60 * 1000;
    await Effect.runPromise(tick);

    nowMs = 5 * 60 * 60 * 1000;
    await Effect.runPromise(tick);
    expect(logs.map(({ suppression }) => suppression)).toEqual([
      "transition",
      "reminder",
      "reminder",
    ]);
    expect(states.get("routing:integrity|route:1")?.reminderIndex).toBe(2);
  });

  test("isolates logging and suppression outages from successful work", async () => {
    const diagnostics: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => diagnostics.push(String(message));
    try {
      const result = await Effect.runPromise(
        alertTick(
          {
            log: () => {
              throw new Error("fixture logging outage");
            },
            delivery: {
              markSent: () => Effect.succeed(true),
              compensate: () => Effect.void,
              suppression: {
                get: () => Effect.fail("fixture suppression read outage"),
                put: () => Effect.fail("fixture suppression write outage"),
              },
            },
          },
          emit({ key: "routing:integrity", severity: "high", body: "fixed" }).pipe(
            Effect.as("work-completed"),
          ),
        ),
      );
      expect(result).toBe("work-completed");
    } finally {
      console.error = original;
    }
    expect(diagnostics).toEqual([
      "api-next alert suppression read unavailable",
      "api-next alert log unavailable",
      "api-next alert suppression write unavailable",
    ]);
  });
});
