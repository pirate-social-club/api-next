import { describe, expect, test } from "bun:test";
import {
  KARAOKE_FINALIZATION_LOCAL_ATTEMPT_LIMIT,
  karaokeFinalizationFailureTransition,
  karaokeFinalizationRetryDelay,
} from "./karaoke-finalization-retry.ts";

describe("Karaoke finalization retry policy", () => {
  test("uses capped exponential backoff", () => {
    expect(karaokeFinalizationRetryDelay(1)).toBe(30_000);
    expect(karaokeFinalizationRetryDelay(2)).toBe(60_000);
    expect(karaokeFinalizationRetryDelay(6)).toBe(15 * 60_000);
    expect(karaokeFinalizationRetryDelay(100)).toBe(15 * 60_000);
  });

  test("exhausts only when central recovery is activated", () => {
    const now = 1_000;
    const enabled = karaokeFinalizationFailureTransition({
      attempts: KARAOKE_FINALIZATION_LOCAL_ATTEMPT_LIMIT - 1,
      exhaustionEnabled: true,
      now,
    });
    expect(enabled).toEqual({
      attempts: KARAOKE_FINALIZATION_LOCAL_ATTEMPT_LIMIT,
      lastFailureAt: now,
      nextAttemptAt: 0,
      state: "exhausted",
    });

    const disabled = karaokeFinalizationFailureTransition({
      attempts: KARAOKE_FINALIZATION_LOCAL_ATTEMPT_LIMIT - 1,
      exhaustionEnabled: false,
      now,
    });
    expect(disabled).toEqual({
      attempts: KARAOKE_FINALIZATION_LOCAL_ATTEMPT_LIMIT,
      lastFailureAt: now,
      nextAttemptAt: now + 15 * 60_000,
      state: "pending",
    });
  });
});
