import { describe, expect, test } from "bun:test";
import { AlertCollector } from "@pirate/application";
import { Effect } from "effect";

import { AlertSinkConfigurationError, makeConfiguredAlertSink } from "./alert-config";
import { alertTick } from "./alerts";

const emitHigh = AlertCollector.use((collector) =>
  collector.emit({
    key: "routing:integrity",
    severity: "high",
    body: "provider-secret https://private.invalid/raw",
    entity: "routing:ready_missing_binding",
  }),
);

describe("production alert configuration boundary", () => {
  test("production uses the structured local sink without a destination", async () => {
    const logs: unknown[] = [];
    const original = console.info;
    console.info = (_event?: unknown, fields?: unknown) => logs.push(fields);
    try {
      const sink = makeConfiguredAlertSink({ API_NEXT_ENV: "production" });
      await Effect.runPromise(alertTick(sink, emitHigh));
    } finally {
      console.info = original;
    }
    expect(logs).toHaveLength(1);
  });

  test("rejects an unknown environment", () => {
    expect(() => makeConfiguredAlertSink({ API_NEXT_ENV: "prod" })).toThrow(
      AlertSinkConfigurationError,
    );
  });
});
