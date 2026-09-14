import { expect, test } from "bun:test";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan.ts";
import {
  applyStagingUpgradeOnRehearsalBranch,
  assertStagingUpgradeReceipt,
  loadStagingUpgradeArtifacts,
  STAGING_UPGRADE_ORDINALS,
  STAGING_UPGRADE_RELEASE,
  stagingUpgradeBaseLedger,
  stagingUpgradeReceipt,
} from "./staging-persona-upgrade-plan.ts";

const upgradeVersions = (() => {
  return STAGING_UPGRADE_ORDINALS.map((ordinal, index) => {
    if (index === 0) return STAGING_UPGRADE_RELEASE.firstUpgradeVersion;
    if (index === STAGING_UPGRADE_ORDINALS.length - 1)
      return STAGING_UPGRADE_RELEASE.terminalVersion;
    return `${String(ordinal).padStart(4, "0")}_fixture_migration.sql`;
  });
})();

test("the pinned upgrade reads exactly the reviewed span from Git", () => {
  const artifacts = loadStagingUpgradeArtifacts();
  expect(artifacts.sourceSha).toBe(STAGING_UPGRADE_RELEASE.sourceSha);
  expect(artifacts.migrations).toHaveLength(STAGING_UPGRADE_RELEASE.migrationCount);
  const upgrade = artifacts.migrations.filter(({ version }) => Number(version.slice(0, 4)) >= 120);
  expect(upgrade).toHaveLength(STAGING_UPGRADE_RELEASE.upgradeCount);
  expect(upgrade[0]?.version).toBe(STAGING_UPGRADE_RELEASE.firstUpgradeVersion);
  expect(upgrade.at(-1)?.version).toBe(STAGING_UPGRADE_RELEASE.terminalVersion);
}, 120_000);

test("a receipt is accepted only for the exact reviewed sequence through 0179", () => {
  const artifacts = { sourceSha: STAGING_UPGRADE_RELEASE.sourceSha };
  const receipt = stagingUpgradeReceipt(artifacts, upgradeVersions);
  expect(receipt.toVersion).toBe(STAGING_UPGRADE_RELEASE.terminalVersion);
  expect(() => stagingUpgradeReceipt(artifacts, upgradeVersions.slice(0, -1))).toThrow(
    "staging_upgrade_receipt_mismatch",
  );
  const extra = [...upgradeVersions, "0180_fixture_migration.sql"];
  expect(() => stagingUpgradeReceipt(artifacts, extra)).toThrow("staging_upgrade_receipt_mismatch");
  expect(() => assertStagingUpgradeReceipt({ ...receipt, manifestSha256: "0".repeat(64) })).toThrow(
    "staging_upgrade_receipt_mismatch",
  );
});

test("the base ledger is the full reconstructed plan, not the source prefix", () => {
  const plan = validateStagingResetArtifacts(loadStagingResetArtifacts());
  const ledger = stagingUpgradeBaseLedger(plan);
  expect(ledger).toHaveLength(119);
  expect(ledger[0]?.version).toBe(plan.migrations[0]?.version);
  expect(ledger.at(-1)?.version).toBe("0119_hns_root_health_renewal.sql");
  expect(ledger.at(-1)?.checksum).toBe(plan.migrations.at(-1)?.checksum);
}, 120_000);

test("the rehearsal applier accepts no caller target or connection", () => {
  // Caller-supplied identifiers alone are not evidence. The only production
  // entry point must acquire the verified branch itself, which is why its
  // arity is zero; a connection parameter is the regression.
  expect(applyStagingUpgradeOnRehearsalBranch.length).toBe(0);
  expect(applyStagingUpgradeOnRehearsalBranch).not.toHaveProperty("connectionString");
});
