import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type PostgresSentinel,
  verifyPostgresTestSentinels,
} from "./verify-postgres-test-sentinels";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function sentinelSet(): Promise<{
  readonly directory: string;
  readonly sentinels: PostgresSentinel[];
}> {
  const directory = await mkdtemp(join("/tmp", "api-next-postgres-sentinels-"));
  temporaryDirectories.push(directory);
  const sentinels = ["adapter", "foundation", "migration", "identity"].map((name) => ({
    name,
    path: join(directory, `${name}.complete`),
    contents: `${name}-complete\n`,
  }));
  for (const sentinel of sentinels) await Bun.write(sentinel.path, sentinel.contents);
  return { directory, sentinels };
}

describe("Postgres suite sentinel verification", () => {
  test("accepts only when every distinct suite marker is complete", async () => {
    const { sentinels } = await sentinelSet();
    await verifyPostgresTestSentinels(sentinels);
  });

  test("fails when only postgres.pg.test.ts ran", async () => {
    const { sentinels } = await sentinelSet();
    await rm(sentinels[1]?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow("foundation");
  });

  test("fails when the foundation suite is skipped or omitted", async () => {
    const { sentinels } = await sentinelSet();
    await rm(sentinels[1]?.path ?? "", { force: true });
    await expect(verifyPostgresTestSentinels(sentinels)).rejects.toThrow(
      "completion marker missing",
    );
  });
});
