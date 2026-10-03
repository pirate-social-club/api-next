import { expect, test } from "bun:test";
import type { Client } from "pg";
import {
  parseRewardOperationsCommand,
  setRewardOperationsControl,
} from "./reward-operations-control.ts";

test("operator command requires explicit mode, revision and bounded reason", () => {
  expect(parseRewardOperationsCommand(["pause", "2", " incident "])).toEqual({
    state: "paused",
    expectedRevision: "2",
    reason: "incident",
  });
  expect(parseRewardOperationsCommand(["resume", "3", "rehearsal_complete"]).state).toBe("running");
  expect(parseRewardOperationsCommand(["settle", "3", "incident"]).state).toBe("settling");
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
    setRewardOperationsControl(client, {
      state: "paused",
      expectedRevision: "1",
      reason: "incident",
    }),
  ).rejects.toThrow("readback unavailable");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.values).toEqual(["1", true, "incident"]);
  expect(
    calls.filter((call) => call.text.includes("set_reward_operations_paused_v1")),
  ).toHaveLength(1);
});

test("settling uses explicit authority and verifies state as well as the projected pause", async () => {
  for (const state of ["settling", "paused", "running"]) {
    const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
    const client = {
      query: async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        if (calls.length === 1) return { rows: [{ revision: "4" }], rowCount: 1 };
        if (calls.length === 2)
          return { rows: [{ state, paused: true, revision: "4" }], rowCount: 1 };
        return { rows: [{ effect_kind: "ticket_purchase", state: "confirming", effects: "1" }] };
      },
    } as unknown as Client;
    const result = setRewardOperationsControl(client, {
      state: "settling",
      expectedRevision: "3",
      reason: "incident",
    });
    if (state === "settling") {
      await expect(result).resolves.toMatchObject({
        control: { state: "settling", paused: true, revision: "4" },
        admitted: [{ effect_kind: "ticket_purchase", state: "confirming", effects: "1" }],
      });
    } else await expect(result).rejects.toThrow("readback failed");
    expect(calls[0]?.values).toEqual(["3", "settling", "incident"]);
    expect(calls[0]?.text).toContain("set_reward_operations_state_v2");
    expect(calls.filter((call) => call.text.includes("set_reward_operations_"))).toHaveLength(1);
  }
});
