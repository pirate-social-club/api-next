import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  collectStagingExternalProducers,
  STAGING_EXTERNAL_HOSTS,
} from "./staging-persona-external-observation.ts";

function fixture(active = "inactive") {
  const bytes = JSON.stringify({
    version: "staging-external-snapshot-v1",
    units: [
      {
        unit: "zkpassport-verifier.service",
        active,
        sub: "dead",
        enabled: "masked-runtime",
        processPresent: false,
        residualProcesses: 0,
        unitDigest: "a".repeat(64),
        environmentDigests: [],
        processDigest: null,
      },
    ],
    code: [{ pathDigest: "b".repeat(64), contentDigest: "c".repeat(64) }],
  });
  return {
    bytes,
    pins: STAGING_EXTERNAL_HOSTS.map((host) => ({
      host,
      heldUnits: host === "94.103.168.209" ? ["zkpassport-verifier.service"] : [],
      codeFiles: ["/opt/reviewed-source.js"],
      expectedSnapshotDigest: reconciliationDigest(bytes),
    })),
  };
}

test("requires all three independently reviewed host snapshots with two actual reads each", async () => {
  const f = fixture();
  let reads = 0;
  const result = await collectStagingExternalProducers({
    pins: f.pins,
    readSnapshot: async () => {
      reads++;
      return f.bytes;
    },
  });
  expect(reads).toBe(6);
  expect(result.executionAuthorized).toBe(false);
  expect(result.observations).toHaveLength(3);
});

test("missing host, changed source and a live held service refuse", async () => {
  const f = fixture();
  await expect(
    collectStagingExternalProducers({ pins: f.pins.slice(1), readSnapshot: async () => f.bytes }),
  ).rejects.toThrow("inventory_incomplete");
  await expect(
    collectStagingExternalProducers({ pins: f.pins, readSnapshot: async () => `${f.bytes} ` }),
  ).rejects.toThrow("snapshot_changed");
  const running = fixture("active");
  await expect(
    collectStagingExternalProducers({
      pins: running.pins,
      readSnapshot: async () => running.bytes,
    }),
  ).rejects.toThrow("held_service_unproven");
  await expect(
    collectStagingExternalProducers({
      pins: f.pins.map((pin) => ({ ...pin, heldUnits: [] })),
      readSnapshot: async () => f.bytes,
    }),
  ).rejects.toThrow("held_inventory_incomplete");
});

test("the embedded read-only remote program parses under the actual Python runtime", () => {
  const source = readFileSync(
    new URL("./staging-persona-external-observation.ts", import.meta.url),
    "utf8",
  );
  const program = source.match(/const program = String.raw`([\s\S]*?)`;/u)?.[1];
  if (!program) throw new Error("missing remote program");
  const result = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
    input: program,
  });
  expect(result.status).toBe(0);
  expect(result.stderr.toString()).toBe("");
});
