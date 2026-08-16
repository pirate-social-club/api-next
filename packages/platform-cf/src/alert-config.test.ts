import { describe, expect, test } from "bun:test";
import { AlertCollector } from "@pirate/application";
import { Effect, Redacted } from "effect";

import { AlertSinkConfigurationError, makeConfiguredAlertSink } from "./alert-config";
import { alertTick, makeHttpAlertSink } from "./alerts";

const emitHigh = AlertCollector.use((collector) =>
  collector.emit({
    key: "routing:integrity",
    severity: "high",
    body: "provider-secret https://private.invalid/raw",
    entity: "routing:ready_missing_binding",
  }),
);

describe("production alert configuration boundary", () => {
  test("requires both production endpoints and secrets without exposing values", () => {
    expect(() =>
      makeConfiguredAlertSink({
        API_NEXT_ENV: "production",
        API_NEXT_ALERT_EMAIL_URL: "https://email.invalid/alerts",
        API_NEXT_ALERT_WEBHOOK_URL: "https://webhook.invalid/alerts",
        API_NEXT_ALERT_EMAIL_TOKEN: "email-secret",
      }),
    ).toThrow(AlertSinkConfigurationError);

    const redacted = Redacted.make("email-secret");
    expect(String(redacted)).not.toContain("email-secret");
  });

  test("HTTP adapters send bounded alert projections, never provider message bodies", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const sink = makeHttpAlertSink({
      emailUrl: "https://email.invalid/alerts",
      webhookUrl: "https://webhook.invalid/alerts",
      emailToken: Redacted.make("email-secret"),
      webhookToken: Redacted.make("webhook-secret"),
      fetch: fetcher,
    });

    await Effect.runPromise(alertTick(sink, emitHigh));

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.init?.body)).not.toContain("provider-secret");
    expect(JSON.stringify(requests[1]?.init?.body)).not.toContain("private.invalid");
    expect(JSON.stringify(requests[1]?.init?.body)).toContain("api-next high-severity");
  });
});
