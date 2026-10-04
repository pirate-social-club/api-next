import { expect, test } from "bun:test";
import { REWARD_SHUTDOWN_PREDICATES } from "../rewards-binding-deploy-preflight.ts";
import { assertShutdownInventory } from "./database-evidence.mjs";

test("an obligation in any shutdown family or a missing category refuses acceptance", () => {
  const categories = [
    ...REWARD_SHUTDOWN_PREDICATES.map(([category]) => category),
    "unresolved_winner_sends",
  ];
  const cleared = Object.fromEntries(categories.map((category) => [category, "0"]));
  expect(assertShutdownInventory(cleared).nothingOwed).toBe(true);
  for (const category of categories) {
    expect(() => assertShutdownInventory({ ...cleared, [category]: "1" })).toThrow(category);
    expect(() => assertShutdownInventory({ ...cleared, [category]: undefined })).toThrow(category);
  }
});
