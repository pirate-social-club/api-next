import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InstallTransport, installJourneyChain } from "./install-journey-chain.ts";

test("journey installer dry run checks the bundle without host access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hns-journey-installer-"));
  const bundle = join(directory, "journey-chain.js");
  const bytes = new TextEncoder().encode("reviewed fixture bundle");
  const digest = createHash("sha256").update(bytes).digest("hex");
  let calls = 0;
  const transport: InstallTransport = async () => {
    calls++;
    return "absent";
  };
  try {
    await writeFile(bundle, bytes);
    expect((await installJourneyChain(bundle, digest, false, transport)).outcome).toBe("dry_run");
    expect(calls).toBe(0);
    await expect(installJourneyChain(bundle, "a".repeat(64), true, transport)).rejects.toThrow(
      "differs from its reviewed digest",
    );
    expect(calls).toBe(0);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("journey installer admits one exact-target copy and rejects a different target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hns-journey-installer-"));
  const bundle = join(directory, "journey-chain.js");
  const bytes = new TextEncoder().encode("reviewed fixture bundle");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const target = "/opt/pirate-hns-staging/journey-chain.js";
  try {
    await writeFile(bundle, bytes);
    const calls: { command: string; input: Uint8Array }[] = [];
    const transport: InstallTransport = async (command, input) => {
      calls.push({ command, input });
      return calls.length === 1
        ? "absent"
        : calls.length === 2
          ? "installed"
          : `${digest}  ${target}`;
    };
    expect((await installJourneyChain(bundle, digest, true, transport)).outcome).toBe("installed");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.input.byteLength).toBe(0);
    expect(calls[1]?.input).toEqual(bytes);
    expect(calls[1]?.command).toContain(`= ${digest}`);
    expect(calls[1]?.command).toContain("sudo mv -n");
    expect(calls[2]?.input.byteLength).toBe(0);
    const different: InstallTransport = async () => `${"b".repeat(64)}  ${target}`;
    await expect(installJourneyChain(bundle, digest, true, different)).rejects.toThrow(
      "target differs",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
