import { describe, expect, test } from "bun:test";
import {
  observeVideoStreamIngest,
  prepareVideoStreamCopy,
  type VideoStreamObservation,
} from "./video-stream-ingest.ts";

const identity = {
  operationId: "operation-1",
  creator: "pirate-video-v1-operation-1",
  sourceSha256: "a".repeat(64),
};
const begin = () =>
  prepareVideoStreamCopy({
    current: { state: "not_started" },
    identity,
    nowMs: 0,
    acceptanceDeadlineMs: 100,
    encodingDeadlineMs: 1_000,
  });
const observation = (overrides: Partial<VideoStreamObservation> = {}): VideoStreamObservation => ({
  providerVideoId: "provider-1",
  creator: identity.creator,
  sourceSha256: identity.sourceSha256,
  encoding: "pending",
  requireSignedURLs: true,
  downloadsEnabled: false,
  ...overrides,
});

describe("durable Stream ingest decisions", () => {
  test("only initial intent authorizes copying; replay retains the original deadlines", () => {
    const first = begin();
    expect(first.copyAllowed).toBe(true);
    const replay = prepareVideoStreamCopy({
      current: first.next,
      identity,
      nowMs: 50,
      acceptanceDeadlineMs: 500,
      encodingDeadlineMs: 5_000,
    });
    expect(replay).toEqual({ next: first.next, copyAllowed: false });
  });
  test("lost acceptance and temporarily empty lookup cannot start another encode", () => {
    const sending = observeVideoStreamIngest({ current: begin().next, matches: [], nowMs: 99 });
    expect(sending.state).toBe("sending");
    const bound = observeVideoStreamIngest({
      current: sending,
      matches: [observation()],
      nowMs: 100,
    });
    expect(bound).toMatchObject({ state: "bound", providerVideoId: "provider-1" });
    expect(
      prepareVideoStreamCopy({
        current: bound,
        identity,
        nowMs: 101,
        acceptanceDeadlineMs: 200,
        encodingDeadlineMs: 2_000,
      }).copyAllowed,
    ).toBe(false);
  });
  test("acceptance deadline reaches reconciliation, not a fresh copy", () => {
    const stopped = observeVideoStreamIngest({ current: begin().next, matches: [], nowMs: 100 });
    expect(stopped).toMatchObject({
      state: "reconciliation_required",
      reason: "acceptance_unknown",
    });
    expect(
      observeVideoStreamIngest({ current: stopped, matches: [observation()], nowMs: 101 }),
    ).toEqual(stopped);
    expect(
      prepareVideoStreamCopy({
        current: stopped,
        identity,
        nowMs: 101,
        acceptanceDeadlineMs: 200,
        encodingDeadlineMs: 2_000,
      }).copyAllowed,
    ).toBe(false);
  });
  test("binding is not readiness; encoding success and safe delivery must both be observed", () => {
    const bound = observeVideoStreamIngest({
      current: begin().next,
      matches: [observation()],
      nowMs: 1,
    });
    expect(bound.state).toBe("bound");
    const ready = observeVideoStreamIngest({
      current: bound,
      matches: [observation({ encoding: "ready" })],
      nowMs: 2,
    });
    expect(ready.state).toBe("ready");
    expect(
      observeVideoStreamIngest({
        current: ready,
        matches: [observation({ encoding: "ready" })],
        nowMs: 3,
      }),
    ).toEqual(ready);
  });
  test.each([{ creator: "wrong" }, { sourceSha256: "b".repeat(64) }, { providerVideoId: " " }])(
    "rejects mismatched provider identity %j",
    (mismatch) => {
      expect(
        observeVideoStreamIngest({
          current: begin().next,
          matches: [observation(mismatch)],
          nowMs: 1,
        }),
      ).toMatchObject({ state: "reconciliation_required", reason: "identity_mismatch" });
    },
  );
  test("multiple matches never select an arbitrary provider identity", () => {
    expect(
      observeVideoStreamIngest({
        current: begin().next,
        matches: [observation(), observation({ providerVideoId: "provider-2" })],
        nowMs: 1,
      }),
    ).toMatchObject({ state: "reconciliation_required", reason: "multiple_matches" });
  });
  test.each([{ requireSignedURLs: false }, { downloadsEnabled: true }])(
    "unsafe delivery cannot become ready %j",
    (unsafe) => {
      expect(
        observeVideoStreamIngest({
          current: begin().next,
          matches: [observation({ encoding: "ready", ...unsafe })],
          nowMs: 1,
        }),
      ).toMatchObject({ state: "reconciliation_required", reason: "unsafe_delivery" });
    },
  );
  test("terminal errors and encoding timeout retain provider identity and cannot recopy", () => {
    for (const [nowMs, encoding, reason] of [
      [1, "error", "encoding_failed"],
      [1_000, "pending", "encoding_timeout"],
    ] as const) {
      const failed = observeVideoStreamIngest({
        current: begin().next,
        matches: [observation({ encoding })],
        nowMs,
      });
      expect(failed).toMatchObject({ state: "failed", providerVideoId: "provider-1", reason });
      expect(
        observeVideoStreamIngest({
          current: failed,
          matches: [observation({ encoding: "ready" })],
          nowMs: 2_000,
        }),
      ).toEqual(failed);
    }
  });
  test("a bound provider cannot disappear or change identity silently", () => {
    const bound = observeVideoStreamIngest({
      current: begin().next,
      matches: [observation()],
      nowMs: 1,
    });
    for (const matches of [[], [observation({ providerVideoId: "provider-2" })]]) {
      expect(observeVideoStreamIngest({ current: bound, matches, nowMs: 2 })).toMatchObject({
        state: "reconciliation_required",
        reason: "identity_mismatch",
      });
    }
  });
  test("changed source authority and invalid time are rejected", () => {
    expect(() =>
      prepareVideoStreamCopy({
        current: begin().next,
        identity: { ...identity, sourceSha256: "b".repeat(64) },
        nowMs: 1,
        acceptanceDeadlineMs: 100,
        encodingDeadlineMs: 1_000,
      }),
    ).toThrow("immutable");
    expect(() =>
      observeVideoStreamIngest({ current: begin().next, matches: [], nowMs: Number.NaN }),
    ).toThrow("time");
  });
});
