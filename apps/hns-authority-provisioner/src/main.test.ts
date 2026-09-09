import { expect, test } from "bun:test";
import { HNS_ROOT_OBSERVATION_RETRY_DELAY_MS } from "./main.ts";

test("the bounded observation budget spans a one-hour owner session", () => {
  expect(HNS_ROOT_OBSERVATION_RETRY_DELAY_MS * 20).toBe(60 * 60 * 1_000);
});
