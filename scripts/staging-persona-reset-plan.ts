import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Owner-approved release boundary; never derive these pins from current HEAD. */
export const STAGING_RESET_RELEASE = Object.freeze({
  sourceSha: "ba0fd44529d834f491879126cdb8c67c4ec9fcdc",
  manifestSha256: "b68453cb883b59d30358a43f2b1a5d44dc2a8bc52a266dedca646f712161ecc9",
  baselineSha256: "8d680727f9869a1b9fe24a76674f29306e527df90b5506ebdc574dec88250102",
  migrationCount: 119,
  sourceLedgerCount: 109,
  terminalVersion: "0119_hns_root_health_renewal.sql",
});

type MigrationSource = Readonly<{ version: string; sql: string }>;
type LedgerEntry = Readonly<{ version: string; checksum: string }>;
type ResetArtifacts = Readonly<{
  sourceSha: string;
  manifest: string;
  baseline: string;
  migrations: readonly MigrationSource[];
}>;
type ResetReleasePlan = Readonly<{
  sourceSha: string;
  manifestSha256: string;
  baselineSha256: string;
  migrations: readonly Readonly<MigrationSource & LedgerEntry>[];
}>;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function manifestEntries(text: string): Readonly<Record<string, string>> {
  if (sha256(text) !== STAGING_RESET_RELEASE.manifestSha256) {
    throw new Error("Reset manifest digest differs from the approved release.");
  }
  const parsed = JSON.parse(text) as { algorithm: unknown; migrations: Record<string, unknown> };
  if (parsed.algorithm !== "sha256" || !parsed.migrations || Array.isArray(parsed.migrations)) {
    throw new Error("Invalid reset manifest structure.");
  }
  const entries = Object.entries(parsed.migrations).sort(([a], [b]) => a.localeCompare(b));
  if (
    entries.length !== STAGING_RESET_RELEASE.migrationCount ||
    entries.at(-1)?.[0] !== STAGING_RESET_RELEASE.terminalVersion ||
    entries.some(
      ([version, checksum], index) =>
        !/^\d{4}_[a-z0-9_]+\.sql$/u.test(version) ||
        Number(version.slice(0, 4)) !== index + 1 ||
        typeof checksum !== "string" ||
        !/^[a-f0-9]{64}$/u.test(checksum),
    )
  ) {
    throw new Error("Invalid reset migration set.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Pure validation only: no database, provider, process or filesystem effects. */
export function validateStagingResetArtifacts(artifacts: ResetArtifacts): ResetReleasePlan {
  if (artifacts.sourceSha !== STAGING_RESET_RELEASE.sourceSha) {
    throw new Error("Reset source pin differs from the approved release.");
  }
  const manifest = manifestEntries(artifacts.manifest);
  if (sha256(artifacts.baseline) !== STAGING_RESET_RELEASE.baselineSha256) {
    throw new Error("Reset baseline digest differs from the approved release.");
  }
  const versions = Object.keys(manifest);
  if (
    artifacts.migrations.length !== versions.length ||
    artifacts.migrations.some((entry, index) => entry.version !== versions[index])
  ) {
    throw new Error("Reset migration set differs from the approved release.");
  }
  const migrations = artifacts.migrations.map(({ version, sql }) => {
    const checksum = sha256(sql);
    if (checksum !== manifest[version]) {
      throw new Error("Reset migration checksum differs from the approved release.");
    }
    return Object.freeze({ version, checksum, sql });
  });
  return Object.freeze({
    sourceSha: STAGING_RESET_RELEASE.sourceSha,
    manifestSha256: STAGING_RESET_RELEASE.manifestSha256,
    baselineSha256: STAGING_RESET_RELEASE.baselineSha256,
    migrations: Object.freeze(migrations),
  });
}

/** Ledger evidence is necessary, never sufficient authority to reset a target. */
export function assertStagingResetLedger(
  plan: ResetReleasePlan,
  ledger: readonly LedgerEntry[],
): void {
  if (
    ledger.length !== STAGING_RESET_RELEASE.sourceLedgerCount ||
    ledger.some(
      (entry, index) =>
        entry.version !== plan.migrations[index]?.version ||
        entry.checksum !== plan.migrations[index]?.checksum,
    )
  ) {
    throw new Error("Reset source ledger differs from the reviewed 0109 prefix.");
  }
}

/** Read immutable Git objects, not mutable files from the executing checkout. */
export function loadStagingResetArtifacts(
  repositoryRoot = fileURLToPath(new URL("../", import.meta.url)),
): ResetArtifacts {
  const git = (args: readonly string[]): string => {
    try {
      return execFileSync("git", [...args], {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Git errors may embed raw buffers or environment-specific paths.
      throw new Error("Could not read the approved reset release from Git history.");
    }
  };
  const sourceSha = STAGING_RESET_RELEASE.sourceSha;
  git(["cat-file", "-e", `${sourceSha}^{commit}`]);
  const read = (path: string) => git(["show", `${sourceSha}:${path}`]);
  const manifest = read("db/postgres/migrations/checksums.json");
  const entries = manifestEntries(manifest);
  const names = git(["ls-tree", "--name-only", `${sourceSha}:db/postgres/migrations`])
    .trim()
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.join("\n") !== Object.keys(entries).join("\n")) {
    throw new Error("Reset migration set differs from the approved release.");
  }
  return {
    sourceSha,
    manifest,
    baseline: read("db/postgres/schema.sql"),
    migrations: names.map((version) => ({
      version,
      sql: read(`db/postgres/migrations/${version}`),
    })),
  };
}

if (import.meta.main) {
  try {
    if (Bun.argv.slice(2).some((arg) => arg !== "--dry-run")) {
      throw new Error("This planner accepts only --dry-run; reset execution is not implemented.");
    }
    const plan = validateStagingResetArtifacts(loadStagingResetArtifacts());
    console.log(
      JSON.stringify({
        mode: "offline-release-plan",
        source_sha: plan.sourceSha,
        manifest_sha256: plan.manifestSha256,
        baseline_sha256: plan.baselineSha256,
        migration_count: plan.migrations.length,
        terminal_version: plan.migrations.at(-1)?.version,
        migrations: plan.migrations.map(({ version, checksum }) => ({ version, checksum })),
        database_connected: false,
        execution_available: false,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Reset plan validation failed.");
    process.exitCode = 1;
  }
}
