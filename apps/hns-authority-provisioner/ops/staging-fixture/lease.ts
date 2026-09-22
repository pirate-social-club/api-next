import { lstat, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fixed loopback listeners require host-wide exclusion, not just unique container names. */
export async function acquireAuthorityFixtureLease(
  path = join(tmpdir(), "pirate-hns-staging-authority-fixture.lock"),
): Promise<() => Promise<void>> {
  await mkdir(path, { mode: 0o700 });
  const identity = await lstat(path);
  await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  return async () => {
    const current = await lstat(path);
    if (current.ino !== identity.ino || current.dev !== identity.dev || !current.isDirectory()) {
      throw new Error("Fixture lease changed; refusing cleanup");
    }
    await unlink(join(path, "owner.json"));
    await rmdir(path);
  };
}
