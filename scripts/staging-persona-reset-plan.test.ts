import { describe, expect, test } from "bun:test";
import {
  assertStagingResetLedger,
  loadStagingResetArtifacts,
  STAGING_RESET_RELEASE,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

const artifacts = loadStagingResetArtifacts();

describe("staging persona reset release plan", () => {
  test("loads exactly the approved release, not the newer checkout manifest", () => {
    const plan = validateStagingResetArtifacts(artifacts);
    expect(plan.sourceSha).toBe(STAGING_RESET_RELEASE.sourceSha);
    expect(plan.migrations).toHaveLength(119);
    expect(plan.migrations.at(-1)?.version).toBe("0119_hns_root_health_renewal.sql");
    expect(plan.baselineSha256).toBe(STAGING_RESET_RELEASE.baselineSha256);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.migrations)).toBe(true);
    expect(Object.isFrozen(plan.migrations[0])).toBe(true);
  });

  test("rejects a different source even with identical supplied artifacts", () => {
    expect(() =>
      validateStagingResetArtifacts({ ...artifacts, sourceSha: "f".repeat(40) }),
    ).toThrow("source pin");
  });

  test("rejects changed manifest bytes before interpreting the plan", () => {
    expect(() =>
      validateStagingResetArtifacts({ ...artifacts, manifest: `${artifacts.manifest}\n` }),
    ).toThrow("manifest digest");
  });

  test("rejects a changed baseline", () => {
    expect(() => validateStagingResetArtifacts({ ...artifacts, baseline: "SELECT 1;" })).toThrow(
      "baseline digest",
    );
  });

  test("rejects an added migration rather than silently truncating at 0119", () => {
    expect(() =>
      validateStagingResetArtifacts({
        ...artifacts,
        migrations: [...artifacts.migrations, { version: "0120_extra.sql", sql: "SELECT 1;" }],
      }),
    ).toThrow("migration set");
  });

  test("rejects a missing migration", () => {
    expect(() =>
      validateStagingResetArtifacts({ ...artifacts, migrations: artifacts.migrations.slice(1) }),
    ).toThrow("migration set");
  });

  test("rejects duplicate or reordered entries", () => {
    const migrations = [...artifacts.migrations];
    const first = migrations[0];
    if (!first) throw new Error("Pinned release has no migrations");
    migrations[1] = first;
    expect(() => validateStagingResetArtifacts({ ...artifacts, migrations })).toThrow(
      "migration set",
    );
    expect(() =>
      validateStagingResetArtifacts({
        ...artifacts,
        migrations: [...artifacts.migrations].reverse(),
      }),
    ).toThrow("migration set");
  });

  test("rejects changed SQL even when the manifest is unchanged", () => {
    const migrations = artifacts.migrations.map((migration, index) =>
      index === 109 ? { ...migration, sql: `${migration.sql}\nSELECT 1;` } : migration,
    );
    expect(() => validateStagingResetArtifacts({ ...artifacts, migrations })).toThrow(
      "migration checksum",
    );
  });

  test("accepts only the exact reviewed 0109 source ledger prefix", () => {
    const plan = validateStagingResetArtifacts(artifacts);
    const ledger = plan.migrations
      .slice(0, 109)
      .map(({ version, checksum }) => ({ version, checksum }));
    expect(() => assertStagingResetLedger(plan, ledger)).not.toThrow();
    expect(() => assertStagingResetLedger(plan, ledger.slice(1))).toThrow("source ledger");
    expect(() => assertStagingResetLedger(plan, [])).toThrow("source ledger");
    expect(() => assertStagingResetLedger(plan, plan.migrations.slice(0, 110))).toThrow(
      "source ledger",
    );
    expect(() => assertStagingResetLedger(plan, [...ledger].reverse())).toThrow("source ledger");
    expect(() =>
      assertStagingResetLedger(
        plan,
        ledger.map((entry, index) =>
          index === 1 ? { ...entry, checksum: "0".repeat(64) } : entry,
        ),
      ),
    ).toThrow("source ledger");
  });
});
