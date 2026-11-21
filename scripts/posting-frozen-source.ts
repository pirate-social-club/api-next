import assert from "node:assert/strict";
import type { CommandRunner, WorkerDeploymentInput } from "./deploy-worker-with-provenance.ts";

/** The independently qualified schema333 snapshot; this is not a caller-selected trust anchor. */
export const POSTING_FROZEN_RUNTIME = Object.freeze({
  source: "ebe8f84ccd47c41b01453031c65946166b358da5",
  tree: "52e552c785769d8721596dab3b3321062ec3bcf0",
  baseline: "fa101b220a108bfa044805289823916ec1c06d0a",
  donor: "236f5a67de0d66b8c832116cfde619fe168eebf0",
  ref: "refs/heads/release/hns-v4-posting-runtime-20261103",
  paths: Object.freeze([
    "apps/http-worker/src/composition.test.ts",
    "apps/http-worker/src/composition.ts",
    "apps/http-worker/src/rewards-song-offer-handlers.test.ts",
    "apps/http-worker/src/rewards-song-offer-handlers.ts",
    "packages/contracts/src/registry.ts",
    "packages/contracts/src/rewards-song-offers.test.ts",
    "packages/contracts/src/rewards-song-offers.ts",
  ]),
});
const origin = "https://github.com/pirate-social-club/api-next.git";
const mainRef = "refs/heads/main";
const shaPattern = /^[0-9a-f]{40}$/u;

export async function assertPostingFrozenSource(
  root: string,
  input: WorkerDeploymentInput,
  sourceSha: string,
  configPath: string,
  runner: CommandRunner,
): Promise<void> {
  const expected = POSTING_FROZEN_RUNTIME;
  assert.equal(input.postingFrozenRuntime, true);
  assert.equal(input.environment, "staging", "posting snapshot is staging only");
  assert.equal(configPath, "apps/http-worker/wrangler.jsonc", "posting snapshot is HTTP only");
  assert.equal(
    input.acceptedMainRef,
    "origin/main",
    "posting snapshot cannot override accepted main",
  );
  assert.equal(sourceSha, expected.source, "posting snapshot source differs");
  const read = async (args: readonly string[]): Promise<string> => {
    const result = await runner(["git", ...args], root);
    if (result.exitCode !== 0) throw Error("posting snapshot Git proof unavailable");
    return result.stdout.trim();
  };
  if ((await read(["remote", "get-url", "origin"])) !== origin)
    throw Error("posting origin differs");
  assert.equal(await read(["rev-parse", "HEAD"]), expected.source, "posting checkout HEAD differs");
  assert.equal(
    await read(["rev-parse", `${sourceSha}^{tree}`]),
    expected.tree,
    "posting tree differs",
  );
  const published = async () => {
    const rows = (await read(["ls-remote", "--refs", "origin", mainRef, expected.ref])).split("\n");
    assert.equal(rows.length, 2, "posting publication missing or ambiguous");
    const refs = new Map<string, string>();
    for (const row of rows) {
      const fields = row.split("\t");
      assert.equal(fields.length, 2);
      assert.match(fields[0] ?? "", shaPattern);
      assert.ok(fields[1] === mainRef || fields[1] === expected.ref);
      assert.ok(!refs.has(fields[1]));
      refs.set(fields[1], fields[0] ?? "");
    }
    assert.equal(refs.get(expected.ref), expected.source, "posting release ref moved");
    return refs;
  };
  const before = await published();
  const main = await read(["rev-parse", input.acceptedMainRef]);
  assert.equal(before.get(mainRef), main, "refresh accepted main before posting deployment");
  for (const ancestor of [expected.baseline, expected.donor])
    await read(["merge-base", "--is-ancestor", ancestor, main]);
  const changed = (
    await read(["diff", "--name-only", "--no-renames", expected.baseline, sourceSha, "--"])
  )
    .split("\n")
    .sort();
  assert.deepEqual(changed, [...expected.paths].sort(), "posting projection changed paths");
  for (const path of expected.paths) {
    const blobs: string[] = (
      await read(["rev-parse", `${sourceSha}:${path}`, `${expected.donor}:${path}`])
    ).split("\n");
    assert.equal(blobs.length, 2);
    assert.match(blobs[0] ?? "", shaPattern);
    assert.equal(blobs[0], blobs[1], `posting projection differs from accepted donor: ${path}`);
  }
  assert.deepEqual(await published(), before, "posting publication changed during proof");
}
