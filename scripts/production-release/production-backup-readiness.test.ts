import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBackup } from "./production-release-admission.ts";
import { fileHash } from "./production-operation-evidence.ts";

test("every SQL phase backup gate requires exact current accepted production readiness", () => {
  const directory = mkdtempSync(join(tmpdir(), "production-backup-qualification-")), path = join(directory, "fixture-backup.json"), now = Date.now();
  const valid = { kind: "website-production-backup-readiness-v1", accepted: true, reviewer_role: "independent_reviewer", findings: [],
    environment: "production", logical_branch: "main", branch_id: "mqfaju65wdm3", database: "postgres", completed: true,
    backup_id: "synthetic-fixture-backup", observed_at: new Date(now).toISOString(), completed_at: new Date(now - 1_000).toISOString(), expires_at: new Date(now + 600_000).toISOString() };
  const invoke = (value: typeof valid) => {
    writeFileSync(path, JSON.stringify(value));
    return checkBackup({ production_backup: { path, sha256: fileHash(path) } }, now);
  };
  try {
    expect(invoke(valid).backup_id).toBe("synthetic-fixture-backup");
    for (const invalid of [
      { ...valid, completed: false }, { ...valid, accepted: false }, { ...valid, branch_id: "foreign" },
      { ...valid, environment: "staging" }, { ...valid, observed_at: new Date(now + 1).toISOString() },
      { ...valid, observed_at: new Date(now - 300_001).toISOString() },
      { ...valid, completed_at: new Date(now - 86_400_001).toISOString() },
      { ...valid, expires_at: new Date(now + 190_000).toISOString() },
    ]) expect(() => invoke(invalid)).toThrow();
    writeFileSync(path, JSON.stringify(valid));
    expect(() => checkBackup({ production_backup: { path, sha256: "0".repeat(64) } }, now)).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
