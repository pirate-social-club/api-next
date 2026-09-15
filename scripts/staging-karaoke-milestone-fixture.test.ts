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

test("process exit removes retained fixture directories", async () => {
  const helper = new URL("../packages/testing/src/process-lifetime-directory.ts", import.meta.url)
    .href;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { makeProcessLifetimeTestDirectory } from ${JSON.stringify(helper)}; console.log(makeProcessLifetimeTestDirectory("karaoke-process-exit-test-"));`,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  const directory = stdout.trim();
  expect(directory).not.toBe("");
  expect(existsSync(directory)).toBe(false);
});
