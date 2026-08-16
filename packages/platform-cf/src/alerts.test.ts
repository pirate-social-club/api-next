import { describe, expect, test } from "bun:test";
import { type Alert, AlertCollector } from "@pirate/application";
import { Effect } from "effect";

import {
  type AlertDigest,
  type AlertSink,
  AlertSinkDeliveryFailed,
  alertTick,
  decideAlertSuppression,
} from "./alerts";

const emit = (alert: Alert) => AlertCollector.use((service) => service.emit(alert));

describe("api-next alert delivery policy", () => {
  test("low severity uses the digest path and never the email sink", async () => {
    const emails: AlertDigest[] = [];
    const digests: AlertDigest[] = [];
    const sink: AlertSink = {
      email: (digest) => Effect.sync(() => emails.push(digest)),
      digest: (digest) => Effect.sync(() => digests.push(digest)),
      webhook: () => Effect.void,
    };

    await Effect.runPromise(
      alertTick(sink, emit({ key: "routine:check", severity: "low", body: "fixed" })),
    );

    expect(emails).toHaveLength(0);
    expect(digests).toHaveLength(1);
  });

  test("a failing sink gets one compensating retry and no resend storm", async () => {
    let emailCalls = 0;
    let marks = 0;
    let compensations = 0;
    const sink: AlertSink = {
      email: () =>
        Effect.gen(function* () {
          emailCalls += 1;
          return yield* Effect.fail(new AlertSinkDeliveryFailed({ sink: "email" }));
        }),
      webhook: () => Effect.void,
      delivery: {
        markSent: () =>
          Effect.sync(() => {
            marks += 1;
            return true;
          }),
        compensate: () =>
          Effect.sync(() => {
            compensations += 1;
          }),
      },
    };

    const exit = await Effect.runPromiseExit(
      alertTick(sink, emit({ key: "failure:email", severity: "high", body: "fixed" })),
    );

    expect(exit._tag).toBe("Failure");
    expect(emailCalls).toBe(2);
    expect(marks).toBe(2);
    expect(compensations).toBe(2);
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
});
