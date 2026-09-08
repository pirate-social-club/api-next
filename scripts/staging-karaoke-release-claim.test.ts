import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  persistKaraokeReleaseClaim,
  replaceCancelledKaraokeReleaseClaim,
} from "./staging-karaoke-release-claim.ts";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "karaoke-release-claim-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});

const childSource = `
  import { persistKaraokeReleaseClaim } from "./scripts/staging-karaoke-release-claim.ts";
  const [directory, kind, stop] = Bun.argv.slice(-3);
  const granted = persistKaraokeReleaseClaim(directory, JSON.stringify({ kind }), stage => {
    if (stage === stop) process.exit(73);
  });
  console.log(JSON.stringify({ pid: process.pid, kind, granted }));
`;
async function child(path: string, kind: string, stop = "none", source = childSource) {
  const process = Bun.spawn([execPath, "--eval", source, path, kind, stop], {
    cwd: join(import.meta.dir, ".."),
    // Children inherit the suite's priority and need no shell tooling on PATH.
    env: { ...globalThis.process.env, PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, output, error };
}

const successorSource = `
  import { replaceCancelledKaraokeReleaseClaim } from "./scripts/staging-karaoke-release-claim.ts";
  const [directory, kind, stop] = Bun.argv.slice(-3);
  let granted = false;
  try {
    granted = replaceCancelledKaraokeReleaseClaim(directory, "cancelled", kind, stage => {
      if (stage === stop) process.exit(73);
    });
  } catch { }
  console.log(JSON.stringify({ pid: process.pid, kind, granted }));
`;

test("independent successor processes cannot both replace the cancelled head", async () => {
  const path = directory();
  persistKaraokeReleaseClaim(path, "cancelled");
  const results = await Promise.all([
    child(path, "executor-one", "none", successorSource),
    child(path, "executor-two", "none", successorSource),
  ]);
  const outcomes = results.map((result) => {
    expect(result.code).toBe(0);
    return JSON.parse(result.output);
  });
  expect(outcomes.filter((result) => result.granted)).toHaveLength(1);
  expect(readFileSync(join(path, "release-claim.json"), "utf8")).toBe(
    outcomes.find((result) => result.granted).kind,
  );
});

for (const stage of ["archived", "replacement-synced", "renamed", "directory-synced"] as const) {
  test(`process death at successor ${stage} retains the lock and refuses a second successor`, async () => {
    const path = directory();
    persistKaraokeReleaseClaim(path, "cancelled");
    expect((await child(path, "executing", stage, successorSource)).code).toBe(73);
    expect(readdirSync(path)).toContain("journal.lock");
    const retry = await child(path, "second-executor", "none", successorSource);
    expect(JSON.parse(retry.output).granted).toBe(false);
    expect(readFileSync(join(path, `${reconciliationDigest("cancelled")}.json`), "utf8")).toBe(
      "cancelled",
    );
  });
}

test("independent executor and canceller processes have exactly one claim winner", async () => {
  const path = directory();
  const results = await Promise.all([child(path, "executing"), child(path, "cancelled")]);
  for (const result of results) {
    expect(result.error).toBe("");
    expect(result.code).toBe(0);
  }
  const outcomes = results.map((result) => JSON.parse(result.output));
  expect(new Set(outcomes.map((result) => result.pid)).size).toBe(2);
  expect(outcomes.filter((result) => result.granted)).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(path, "release-claim.json"), "utf8")).kind).toBe(
    outcomes.find((result) => result.granted).kind,
  );
});

for (const stage of ["created", "written", "file-synced", "directory-synced"] as const) {
  test(`process interruption at ${stage} never permits a second claim`, async () => {
    const path = directory();
    const interrupted = await child(path, "executing", stage);
    expect(interrupted.code).toBe(73);
    expect(interrupted.output).toBe("");
    for (const kind of ["executing", "cancelled"]) {
      const retry = await child(path, kind);
      expect(retry.code).toBe(0);
      expect(JSON.parse(retry.output).granted).toBe(false);
    }
  });
}

test("directory durability precedes grant and file descriptors are released on failure", () => {
  const before = readdirSync("/proc/self/fd").length;
  const seen: string[] = [];
  expect(persistKaraokeReleaseClaim(directory(), "claim", (stage) => seen.push(stage))).toBe(true);
  expect(seen).toEqual(["created", "written", "file-synced", "directory-synced"]);
  for (const stage of seen) {
    expect(() =>
      persistKaraokeReleaseClaim(directory(), "claim", (current) => {
        if (current === stage) throw new Error("injected persistence failure");
      }),
    ).toThrow("injected persistence failure");
  }
  expect(readdirSync("/proc/self/fd").length).toBe(before);
});

test("successor claims compare the exact cancelled head and retain its bytes", () => {
  const path = directory();
  expect(persistKaraokeReleaseClaim(path, "cancelled")).toBe(true);
  expect(replaceCancelledKaraokeReleaseClaim(path, "foreign", "executing")).toBe(false);
  const stages: string[] = [];
  expect(
    replaceCancelledKaraokeReleaseClaim(path, "cancelled", "executing", (stage) =>
      stages.push(stage),
    ),
  ).toBe(true);
  expect(stages).toEqual(["archived", "replacement-synced", "renamed", "directory-synced"]);
  expect(readFileSync(join(path, `${reconciliationDigest("cancelled")}.json`), "utf8")).toBe(
    "cancelled",
  );
  expect(replaceCancelledKaraokeReleaseClaim(path, "cancelled", "second-executor")).toBe(false);
  expect(readFileSync(join(path, "release-claim.json"), "utf8")).toBe("executing");
});

for (const stage of ["archived", "replacement-synced", "renamed", "directory-synced"] as const) {
  test(`successor failure at ${stage} never grants execution or erases the cancellation`, () => {
    const path = directory();
    persistKaraokeReleaseClaim(path, "cancelled");
    expect(() =>
      replaceCancelledKaraokeReleaseClaim(path, "cancelled", "executing", (current) => {
        if (current === stage) throw new Error("interrupted successor");
      }),
    ).toThrow("interrupted successor");
    expect(readFileSync(join(path, `${reconciliationDigest("cancelled")}.json`), "utf8")).toBe(
      "cancelled",
    );
    expect(persistKaraokeReleaseClaim(path, "second-executor")).toBe(false);
    expect(readFileSync(join(path, "release-claim.json"), "utf8")).toBe(
      stage === "archived" || stage === "replacement-synced" ? "cancelled" : "executing",
    );
  });
}
