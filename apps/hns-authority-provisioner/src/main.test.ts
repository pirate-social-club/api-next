import { describe, expect, test } from "bun:test";
import {
  HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS,
  HNS_ROOT_OBSERVATION_RETRY_DELAY_MS,
  nextHnsExecutorWaitMs,
} from "./main.ts";

test("the bounded observation budget spans a one-hour owner session", () => {
  expect(HNS_ROOT_OBSERVATION_RETRY_DELAY_MS * 20).toBe(60 * 60 * 1_000);
});

describe("per-job due scheduling replaces the global retry sleep (T09)", () => {
  const now = 1_770_000_000_000;

  test("an overdue persisted job is claimed immediately", () => {
    expect(
      nextHnsExecutorWaitMs({
        now_epoch_ms: now,
        next_lifecycle_due_epoch_ms: now - 1,
        observation_retry_spacing: false,
      }),
    ).toBe(0);
  });

  test("a future due time waits exactly until it is due, bounded by the sweep", () => {
    expect(
      nextHnsExecutorWaitMs({
        now_epoch_ms: now,
        next_lifecycle_due_epoch_ms: now + 5_000,
        observation_retry_spacing: false,
      }),
    ).toBe(5_000);
    expect(
      nextHnsExecutorWaitMs({
        now_epoch_ms: now,
        next_lifecycle_due_epoch_ms: now + 10 * 60_000,
        observation_retry_spacing: false,
      }),
    ).toBe(HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS);
  });

  test("no persisted job waits at most the recovery sweep", () => {
    expect(
      nextHnsExecutorWaitMs({
        now_epoch_ms: now,
        next_lifecycle_due_epoch_ms: null,
        observation_retry_spacing: false,
      }),
    ).toBe(HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS);
  });

  test("the legacy observation spacing is itself capped by the sweep, never a global block", () => {
    expect(
      nextHnsExecutorWaitMs({
        now_epoch_ms: now,
        next_lifecycle_due_epoch_ms: null,
        observation_retry_spacing: true,
      }),
    ).toBe(HNS_ROOT_EXECUTOR_RECOVERY_SWEEP_MS);
    // An unrelated due job always wins over class spacing.
    expect(
      nextHnsExecutorWaitMs({
        now_epoch_ms: now,
        next_lifecycle_due_epoch_ms: now + 1_000,
        observation_retry_spacing: true,
      }),
    ).toBe(1_000);
  });
});
