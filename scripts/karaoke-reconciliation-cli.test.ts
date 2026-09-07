import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { makeKaraokeCollectorFixture } from "../packages/testing/src/karaoke-collector-fixture.ts";
import { runKaraokeReconciliationCli } from "./karaoke-reconciliation-cli.ts";

const fixtures: ReturnType<typeof makeKaraokeCollectorFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function setup() {
  const f = makeKaraokeCollectorFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest);
  const privateConfig = makeKaraokeCollectorFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest);
  fixtures.push(f, privateConfig);
  const configPath = join(privateConfig.directory, "operator.json");
  const assertionPath = join(privateConfig.directory, "access.jwt");
  const collectorPath = join(privateConfig.directory, "collector.mjs");
  writeFileSync(assertionPath, f.assertion(), { mode: 0o600 });
  const bundle = f.bundle(assertionPath);
  writeFileSync(collectorPath, bundle, { mode: 0o600 });
  const config = {
    version: "staging-karaoke-operator-config-v1",
    ...f.trust,
    collectorPath,
    collectorSourceDigest: reconciliationDigest(bundle),
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { f, config, configPath, assertionPath, collectorPath };
}

test("CLI launches pinned stdin collector, verifies signed bytes and invokes the real verifier", async () => {
  const { f, configPath, assertionPath } = setup();
  const result = await runKaraokeReconciliationCli(configPath, assertionPath, {
    now: f.now,
    authenticationFetch: f.authenticationFetch,
  });
  expect(result.resetAdmission).toBe("eligible");
  expect(result.executionAuthorized).toBe(false);
  expect(result.latestPasses).toHaveLength(6);
});

test("CLI rejects a changed collector before executing its replacement", async () => {
  const { f, configPath, assertionPath, collectorPath } = setup();
  writeFileSync(collectorPath, "throw new Error('must not execute');");
  await expect(
    runKaraokeReconciliationCli(configPath, assertionPath, {
      now: f.now,
      authenticationFetch: f.authenticationFetch,
    }),
  ).rejects.toThrow("collector_source_mismatch");
});

test("CLI refuses configuration stored within caller evidence", async () => {
  const { f, config, assertionPath } = setup();
  const configPath = join(f.directory, "operator.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  await expect(
    runKaraokeReconciliationCli(configPath, assertionPath, {
      now: f.now,
      authenticationFetch: f.authenticationFetch,
    }),
  ).rejects.toThrow("operator_trust_inside_evidence");
});
