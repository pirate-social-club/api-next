import { describe, expect, test } from "bun:test";
import { type Alert, AlertCollector } from "@pirate/application";
import { Effect } from "effect";

import { type AlertDigest, type AlertSink, AlertSinkDeliveryFailed, alertTick } from "./alerts";

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
});
