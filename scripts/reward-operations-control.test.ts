import { expect, test } from "bun:test";
import { parseRewardOperationsCommand } from "./reward-operations-control.ts";

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
