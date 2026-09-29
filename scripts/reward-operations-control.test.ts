import { expect, test } from "bun:test";
import type { Client } from "pg";
import {
  parseRewardOperationsCommand,
  setRewardOperationsControl,
} from "./reward-operations-control.ts";

test("operator command requires explicit mode, revision and bounded reason", () => {
  expect(parseRewardOperationsCommand(["pause", "2", " incident "])).toEqual({
    paused: true,
    expectedRevision: "2",
    reason: "incident",
  });
  expect(parseRewardOperationsCommand(["resume", "3", "rehearsal_complete"]).paused).toBe(false);
  for (const args of [
    [],
    ["off", "0", "incident"],
    ["pause", "-1", "incident"],
    ["pause", "01", "incident"],
    ["pause", "0", " "],
    ["pause", "0", "x".repeat(257)],
    ["pause", "0", "incident", "extra"],
  ]) {
    expect(() => parseRewardOperationsCommand(args)).toThrow();
  }
});

test("a failed readback never performs a compensating resume", async () => {
  const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      if (calls.length === 1) return { rows: [{ revision: "2" }], rowCount: 1 };
      throw new Error("readback unavailable");
    },
  } as unknown as Client;
  await expect(
    setRewardOperationsControl(client, { paused: true, expectedRevision: "1", reason: "incident" }),
  ).rejects.toThrow("readback unavailable");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.values).toEqual(["1", true, "incident"]);
  expect(
    calls.filter((call) => call.text.includes("set_reward_operations_paused_v1")),
  ).toHaveLength(1);
});
