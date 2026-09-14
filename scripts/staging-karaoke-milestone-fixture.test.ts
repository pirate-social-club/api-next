import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture,
} from "./staging-karaoke-milestone-fixture.ts";

test("disposal keeps fixture files for work that outlives a timed-out test", async () => {
  const fixture = makeKaraokeMilestoneFixture();
  const pending = fixture.pass("post-fence");
  disposeMilestoneFixtures();
  expect(existsSync(fixture.journal.directory)).toBe(true);
  const result = await pending;
  expect(result.latestPasses.length).toBeGreaterThan(0);
  expect(result.executionAuthorized).toBe(false);
});
