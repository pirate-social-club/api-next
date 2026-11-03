import { expect, test } from "bun:test";
import { stopBeforePreparedSafeCall } from "./shared-song-prepared-purchase.ts";

test("a deadline crossed during the final control read prevents broadcast", async () => {
  let clock = 999,
    reads = 0,
    broadcasts = 0;
  const stop = await stopBeforePreparedSafeCall({
    verify: async () => ({ executeBeforeMs: 1000 }),
    stopped: async () => {
      if (++reads === 2) clock = 1000;
      return false;
    },
    now: () => clock,
  });
  if (!stop) broadcasts++;
  expect(reads).toBe(2);
  expect(broadcasts).toBe(0);
});

test("pause, missing proof and uncertain reads all stop before broadcast", async () => {
  let verifies = 0;
  expect(
    await stopBeforePreparedSafeCall({
      stopped: async () => true,
      verify: async () => {
        verifies++;
        return { executeBeforeMs: 1000 };
      },
    }),
  ).toBe(true);
  expect(verifies).toBe(0);
  expect(
    await stopBeforePreparedSafeCall({ stopped: async () => false, verify: async () => null }),
  ).toBe(true);
  expect(
    await stopBeforePreparedSafeCall({
      stopped: async () => false,
      verify: async () => {
        throw Error("Fictional unreadable RPC");
      },
    }),
  ).toBe(true);
  expect(
    await stopBeforePreparedSafeCall({
      stopped: async () => {
        throw Error("Fictional unreadable control");
      },
      verify: async () => ({ executeBeforeMs: 1000 }),
    }),
  ).toBe(true);
});

test("a fresh exact call proceeds only while both control reads permit it", async () => {
  expect(
    await stopBeforePreparedSafeCall({
      stopped: async () => false,
      verify: async () => ({ executeBeforeMs: 1000 }),
      now: () => 999,
    }),
  ).toBe(false);
  let paused = false;
  expect(
    await stopBeforePreparedSafeCall({
      stopped: async () => paused,
      verify: async () => {
        paused = true;
        return { executeBeforeMs: 1000 };
      },
      now: () => 999,
    }),
  ).toBe(true);
  expect(
    await stopBeforePreparedSafeCall({
      stopped: async () => false,
      verify: async () => ({ executeBeforeMs: null }),
    }),
  ).toBe(false);
  expect(
    await stopBeforePreparedSafeCall({
      stopped: async () => false,
      verify: async () => ({ executeBeforeMs: 1000 }),
      now: () => NaN,
    }),
  ).toBe(true);
});
