import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { linuxProcess } from "./production-linux-process-bound.ts";

const wrapper = fileURLToPath(new URL("./fixtures/process-qualification-wrapper.ts", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
async function ready(path: string) {
  const until = Date.now() + 8_000;
  while (!existsSync(path) && Date.now() < until) await delay(10);
  expect(existsSync(path)).toBe(true);
}
function start(directory: string, scenario: string) {
  return Bun.spawn([process.execPath, wrapper, directory, scenario], { stdout: "pipe", stderr: "pipe", env: process.env });
}
async function result(child: ReturnType<typeof start>) {
  const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, out, error }).toMatchObject({ exit: 0 });
}
async function finishOwnedFixture(child: ReturnType<typeof start>, directory: string) {
  writeFileSync(join(directory, "fixture-stop"), "stop");
  if (child.exitCode === null) await Promise.race([child.exited, delay(500)]);
  if (child.exitCode === null) {
    const childName = readdirSync(directory).find(name => name.endsWith("-child.json"));
    if (childName) {
      const identity = read(join(directory, childName)).timeout_identity;
      // Only this fixture's exact still-live timeout instance can receive a signal.
      assert.deepEqual(linuxProcess(identity.pid), identity);
      process.kill(identity.pid, "SIGTERM");
    }
  }
  await child.exited;
}

for (const scenario of ["valid", "wrong-tool", "wrong-argv", "descendant"]) test("real GNU timeout ancestry: " + scenario, async () => {
  const directory = mkdtempSync(join(tmpdir(), "production-proc-qualification-"));
  const child = start(directory, scenario);
  try {
    await result(child);
    expect(read(join(directory, "fixture-result.json")).accepted).toBe(!["wrong-tool", "wrong-argv"].includes(scenario));
    expect(readdirSync(directory).filter(name => name.endsWith("-start.json"))).toHaveLength(1);
    expect(readdirSync(directory).filter(name => name.endsWith("-child.json"))).toHaveLength(1);
    expect(readdirSync(directory).filter(name => name.endsWith("-end.json"))).toHaveLength(1);
    if (scenario === "descendant") expect(read(join(directory, "descendant-result.json")).accepted).toBe(false);
  } finally {
    await finishOwnedFixture(child, directory);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

test("completed start cannot be replayed by a direct executor within 180 seconds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "production-proc-replay-"));
  const child = start(directory, "valid");
  try {
    await result(child);
    const observed = read(join(directory, "fixture-result.json")), original = read(observed.startPath);
    const unwrapped = Bun.spawn(original.argv, { env: { ...process.env, PIRATE_RELEASE_OUTER_START_PATH: "",
      QUALIFICATION_DIRECT_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
    await result(unwrapped);
    expect(read(join(directory, "direct-result-" + unwrapped.pid + ".json")).failure).toContain("Missing outer start evidence");
    const replay = Bun.spawn(original.argv, { env: { ...process.env, PIRATE_RELEASE_OUTER_START_PATH: observed.startPath,
      QUALIFICATION_DIRECT_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
    await result(replay);
    const refused = read(join(directory, "direct-result-" + replay.pid + ".json"));
    expect(refused.accepted).toBe(false); expect(refused.failure).toContain("already completed");
    // Simulate missing completion evidence only in this disposable fixture, not in an operation namespace.
    rmSync((observed.startPath as string).replace(/-start\.json$/u, "-end.json"));
    const orphanReplay = Bun.spawn(original.argv, { env: { ...process.env, PIRATE_RELEASE_OUTER_START_PATH: observed.startPath,
      QUALIFICATION_DIRECT_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
    await result(orphanReplay);
    expect(read(join(directory, "direct-result-" + orphanReplay.pid + ".json")).accepted).toBe(false);
  } finally {
    await finishOwnedFixture(child, directory);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a direct sibling cannot borrow an active wrapper and timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "production-proc-sibling-"));
  const child = start(directory, "hold");
  try {
    await ready(join(directory, "fixture-result.json"));
    const observed = read(join(directory, "fixture-result.json")); expect(observed.accepted).toBe(true);
    const original = read(observed.startPath);
    const sibling = Bun.spawn(original.argv, { env: { ...process.env, PIRATE_RELEASE_OUTER_START_PATH: observed.startPath,
      QUALIFICATION_DIRECT_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
    await result(sibling); expect(read(join(directory, "direct-result-" + sibling.pid + ".json")).accepted).toBe(false);
    writeFileSync(join(directory, "fixture-stop"), "stop"); await result(child);
  } finally {
    await finishOwnedFixture(child, directory);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
