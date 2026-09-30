import { expect, test } from "bun:test";
import {
  makeRewardOperationsGuard,
  REWARD_OPERATIONS_CACHE_MS,
} from "./reward-operations-guard.ts";

test("HTTP admission expires its running cache and fails closed without stale recovery", async () => {
  let time = 0;
  let running = true;
  let reads = 0;
  let unavailable = false;
  const guard = makeRewardOperationsGuard({
    now: () => time,
    readRunning: async () => {
      reads++;
      if (unavailable) throw new Error("database unavailable");
      return running;
    },
  });
  await guard();
  running = false;
  await guard();
  expect(reads).toBe(1);
  time = REWARD_OPERATIONS_CACHE_MS;
  await expect(guard()).rejects.toMatchObject({
    _tag: "RewardsPaused",
    status: 503,
    code: "rewards_paused",
    message: "Rewards are paused",
  });
  unavailable = true;
  time += REWARD_OPERATIONS_CACHE_MS;
  await expect(guard()).rejects.toMatchObject({
    _tag: "ProviderUnavailable",
    message: "Rewards control is unavailable",
  });
  unavailable = false;
  await expect(guard()).rejects.toMatchObject({
    _tag: "RewardsPaused",
    status: 503,
    code: "rewards_paused",
    message: "Rewards are paused",
  });
});

test("a slow read does not extend the cache bound", async () => {
  let time = 0;
  const guard = makeRewardOperationsGuard({
    now: () => time,
    readRunning: async () => {
      time += REWARD_OPERATIONS_CACHE_MS;
      return true;
    },
  });
  await expect(guard()).rejects.toMatchObject({ _tag: "ProviderUnavailable" });
});
