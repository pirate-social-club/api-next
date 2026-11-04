import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimPublishAttempt,
  JourneyDispatchAmbiguity,
  JourneyRefusal,
  journeyFailureOutput,
  readPublishAttempt,
  requirePrivateStateDirectory,
} from "./journey-publish-receipt.ts";

const root = "e2eabc123";
const attempt = {
  root,
  root_import_session_id: "session_fixture",
  publish_plan_sha256: "b".repeat(64),
  encoded_resource_sha256: "c".repeat(64),
  response_sha256: "d".repeat(64),
};
const code = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? "untyped";
  }
  return "admitted";
};

test("the dispatch fence refuses an unsafe state directory before any claim", async () => {
  const base = await mkdtemp(join(tmpdir(), "hns-state-"));
  try {
    const fresh = join(base, "fresh", "nested");
    expect(await requirePrivateStateDirectory(fresh)).toBe(fresh);
    const loose = join(base, "loose");
    await mkdir(loose, { mode: 0o700 });
    await chmod(loose, 0o755);
    expect(await code(() => claimPublishAttempt(attempt, loose))).toBe("state_directory_unsafe");
    const target = join(base, "target");
    await mkdir(target, { mode: 0o700 });
    const link = join(base, "link");
    await symlink(target, link);
    expect(await code(() => claimPublishAttempt(attempt, link))).toBe("state_directory_unsafe");
    const file = join(base, "file");
    await writeFile(file, "x");
    expect(await code(() => requirePrivateStateDirectory(file))).toBe("state_directory_unsafe");
  } finally {
    await rm(base, { recursive: true });
  }
});

test("status reads the receipt without guessing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hns-receipt-"));
  try {
    expect((await readPublishAttempt(root, directory)).state).toBe("absent");
    await claimPublishAttempt(attempt, directory);
    const claimed = await readPublishAttempt(root, directory);
    expect(claimed).toMatchObject({ state: "present", status: "dispatch_claimed", txid: null });
    await writeFile(join(directory, `publish-${root}.json`), "{torn");
    expect((await readPublishAttempt(root, directory)).state).toBe("partial");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("only pre-claim failures are definite refusals", () => {
  expect(journeyFailureOutput(new JourneyRefusal("run_lease_missing"), root)).toEqual({
    exitCode: 1,
    line: { outcome: "journey_chain_refused", code: "run_lease_missing" },
  });
  expect(journeyFailureOutput(new Error("rpc detail with host"), null)).toEqual({
    exitCode: 1,
    line: { outcome: "journey_chain_refused", code: "unexpected" },
  });
  expect(
    journeyFailureOutput(new JourneyDispatchAmbiguity("post_claim_failure", null, "/r.json"), root),
  ).toEqual({
    exitCode: 3,
    line: {
      outcome: "journey_chain_dispatch_ambiguous",
      code: "post_claim_failure",
      root,
      txid: null,
      receipt: "/r.json",
    },
  });
  expect(
    journeyFailureOutput(
      new JourneyDispatchAmbiguity("not_an_update", "f".repeat(64), "/r.json"),
      root,
    ).line,
  ).toMatchObject({ txid: "f".repeat(64) });
});
