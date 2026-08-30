import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  HnsEdgeAlertFailed,
  type HnsEdgeAlertSink,
  makeHnsEdgeAlertService,
} from "./hns-edge-alerts.ts";

describe("HNS edge alert service", () => {
  test("trims and delivers a bounded alert", async () => {
    const delivered: string[] = [];
    const sink: HnsEdgeAlertSink = {
      deliver: ({ text }) => Effect.sync(() => delivered.push(text)).pipe(Effect.asVoid),
    };

    await Effect.runPromise(makeHnsEdgeAlertService(sink).deliver({ text: "  DNS drift  " }));

    expect(delivered).toEqual(["DNS drift"]);
  });

  test("rejects empty and over-limit UTF-8 text without calling the sink", async () => {
    let calls = 0;
    const sink: HnsEdgeAlertSink = {
      deliver: () => Effect.sync(() => calls++).pipe(Effect.asVoid),
    };
    const service = makeHnsEdgeAlertService(sink);

    for (const text of ["   ", "é".repeat(2_049)]) {
      const result = await Effect.runPromiseExit(service.deliver({ text }));
      expect(result._tag).toBe("Failure");
    }
    expect(calls).toBe(0);
  });

  test("preserves a typed delivery failure", async () => {
    const failure = new HnsEdgeAlertFailed({ reason: "delivery-unavailable" });
    const sink: HnsEdgeAlertSink = { deliver: () => Effect.fail(failure) };

    const result = await Effect.runPromise(
      makeHnsEdgeAlertService(sink).deliver({ text: "x" }).pipe(Effect.flip),
    );

    expect(result.reason).toBe("delivery-unavailable");
  });
});
