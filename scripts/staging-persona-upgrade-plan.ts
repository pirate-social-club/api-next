import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PostgresMigration } from "../packages/platform-cf/src/postgres-migrations.ts";
import { runPostgresMigrations } from "./postgres-migrations.ts";
import { withProviderRehearsalOperator } from "./staging-persona-rehearsal-inventory.ts";
import {
  loadStagingResetArtifacts,
  STAGING_RESET_RELEASE,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan.ts";

/** Owner-reviewed upgrade source for the staging window that follows the
 * verified 0119 reset baseline. The reset pin stays `ba0fd445` with
 * `0001`–`0119`; this pin carries the reviewed terminal set and is never
 * derived from current HEAD.
 *
 * Reviewed terminal set, 2026-09-14. The terminal is the released API build's
 * own migration terminal: `e9d6e6c7` (the song recovery merge `535df676` plus
 * its required breaking-waiver retirement) carries the 176 registered
 * migrations through `0179`, and its `0001`–`0119` prefix
 * is checksum-identical to the reset manifest, so the resulting schema is
 * exactly the build's own migration set. The five migrations `0168`–`0172`
 * are the merged HNS single-owner cutover (PR #339) and are applied here as
 * schema because the deployed build ships their provisioner code. The HNS
 * runtime stays dormant: this release binds no HNS port, starts no HNS
 * service unit, seeds no probe and runs no ceremony; those remain in the
 * separately gated later window, whose `0172` ledger precondition this
 * release satisfies rather than replaces. The compatibility receipts are
 * the repository gates and PostgreSQL receipts recorded for PRs #342 and
 * #343. The allocation intentionally has no `0173`–`0175`; those numbers were
 * held by concurrent lanes and are not part of the reviewed manifest. */
export const STAGING_UPGRADE_RELEASE = Object.freeze({
  sourceSha: "e9d6e6c7495bb2b5e257c4e5cd3508d134c1c8aa",
  manifestSha256: "4721dafc88ed36f376e11f1e0a6742dfd26bb0f71f1e19428adba447ad94dd7c",
  baselineSha256: "5359d61ac37f9bce6827f12324deafffe63b6e224d6790a9cdd02103013bedf0",
  migrationCount: 176,
  firstUpgradeVersion: "0120_hns_root_health_renewal_recovery.sql",
  terminalVersion: "0179_data_registration_confirmed_recovery.sql",
  upgradeCount: 57,
});

export const STAGING_UPGRADE_ORDINALS = Object.freeze([
  ...Array.from({ length: 53 }, (_, index) => 120 + index),
  176,
  177,
  178,
  179,
]);

/** Ends the first bounded apply transaction before the later video and DATA
 * migrations add another large set of relation locks. The exact ledger at
 * this boundary is the only intermediate state the release accepts. */
export const STAGING_UPGRADE_CHECKPOINT_VERSION = "0153_hns_activation_policy.sql";
export const STAGING_UPGRADE_CHECKPOINT_COUNT = 34;

export type StagingUpgradeReceipt = {
  readonly sourceSha: string;
  readonly manifestSha256: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  /** Exactly the migrations the ordinary runner committed, in order. */
  readonly applied: readonly string[];
};

export type StagingUpgradeArtifacts = {
  readonly sourceSha: string;
  readonly manifest: string;
  readonly baseline: string;
  readonly migrations: readonly PostgresMigration[];
};

/** Carries only progress established by a completed exact-ledger transaction.
 * Callers retain the original cause while using this evidence for the durable
 * release marker. */
export class StagingUpgradeApplyFailed extends Error {
  constructor(
    readonly appliedMigrations: number,
    readonly upgradeSourceSha: string,
    readonly upgradeManifestSha256: string,
    options: { readonly cause: unknown },
  ) {
    if (
      ![0, STAGING_UPGRADE_CHECKPOINT_COUNT, STAGING_UPGRADE_RELEASE.upgradeCount].includes(
        appliedMigrations,
      ) ||
      upgradeSourceSha !== STAGING_UPGRADE_RELEASE.sourceSha ||
      upgradeManifestSha256 !== STAGING_UPGRADE_RELEASE.manifestSha256
    )
      throw new Error("staging_upgrade_failure_evidence_invalid");
    super(
      options.cause instanceof Error ? options.cause.message : "staging_upgrade_apply_failed",
      options,
    );
    this.name = "StagingUpgradeApplyFailed";
  }
}

export function stagingUpgradeFailureEvidence(error: unknown) {
  if (!(error instanceof StagingUpgradeApplyFailed)) {
    return {
      appliedMigrations: 0,
      upgradeSourceSha: null,
      upgradeManifestSha256: null,
      cause: error,
    } as const;
  }
  return {
    appliedMigrations: error.appliedMigrations,
    upgradeSourceSha: error.upgradeSourceSha,
    upgradeManifestSha256: error.upgradeManifestSha256,
    cause: error.cause,
  } as const;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function manifestEntries(
  text: string,
  expected: { readonly sha256: string; readonly count: number; readonly terminal: string },
): Readonly<Record<string, string>> {
  if (sha256(text) !== expected.sha256) {
    throw new Error("Manifest digest differs from the approved release.");
  }
  const parsed = JSON.parse(text) as { algorithm: unknown; migrations: Record<string, unknown> };
  if (parsed.algorithm !== "sha256" || !parsed.migrations || Array.isArray(parsed.migrations)) {
    throw new Error("Invalid migration manifest structure.");
  }
  const entries = Object.entries(parsed.migrations).sort(([a], [b]) => a.localeCompare(b));
  const ordinals = entries.map(([version]) => Number(version.slice(0, 4)));
  if (
    entries.length !== expected.count ||
    entries.at(-1)?.[0] !== expected.terminal ||
    ordinals.some(
      (ordinal, index) =>
        !Number.isInteger(ordinal) ||
        (index > 0 && ordinal <= (ordinals[index - 1] ?? Number.POSITIVE_INFINITY)),
    ) ||
    entries.some(
      ([version, checksum]) =>
        !/^\d{4}_[a-z0-9_]+\.sql$/u.test(version) ||
        typeof checksum !== "string" ||
        !/^[a-f0-9]{64}$/u.test(checksum),
    )
  ) {
    throw new Error("Invalid migration set.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

const upgradeManifestEntries = (text: string) =>
  manifestEntries(text, {
    sha256: STAGING_UPGRADE_RELEASE.manifestSha256,
    count: STAGING_UPGRADE_RELEASE.migrationCount,
    terminal: STAGING_UPGRADE_RELEASE.terminalVersion,
  });

const resetManifestEntries = (text: string) =>
  manifestEntries(text, {
    sha256: STAGING_RESET_RELEASE.manifestSha256,
    count: STAGING_RESET_RELEASE.migrationCount,
    terminal: STAGING_RESET_RELEASE.terminalVersion,
  });

/** The reset prefix is the same checksum set the reset replays, so the upgrade
 * cannot silently carry a different `0001`–`0119` than the one reconstructed
 * against. Compared canonically rather than by file bytes: the manifest file
 * is regenerated between releases and only the entries are the approved
 * identity. */
function assertResetPrefix(
  expected: Readonly<Record<string, string>>,
  upgrade: Readonly<Record<string, string>>,
) {
  const expectedVersions = Object.keys(expected);
  if (
    expectedVersions.length !== STAGING_RESET_RELEASE.migrationCount ||
    Object.keys(upgrade).slice(0, expectedVersions.length).join("\n") !==
      expectedVersions.join("\n") ||
    expectedVersions.some((version) => upgrade[version] !== expected[version])
  ) {
    throw new Error("Upgrade reset prefix differs from the approved reset baseline.");
  }
}

function gitReader(repositoryRoot: string) {
  return (args: readonly string[]): string => {
    try {
      return execFileSync("git", [...args], {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("Could not read the approved upgrade release from Git history.");
    }
  };
}

/** Reads immutable Git objects, not mutable files from the executing checkout.
 * The reset manifest is read from its own pin and compared as the upgrade's
 * prefix, so the prefix check does not depend on this checkout's working
 * tree. */
export function loadStagingUpgradeArtifacts(
  repositoryRoot = fileURLToPath(new URL("../", import.meta.url)),
): StagingUpgradeArtifacts {
  const git = gitReader(repositoryRoot);
  const sourceSha = STAGING_UPGRADE_RELEASE.sourceSha;
  git(["cat-file", "-e", `${sourceSha}^{commit}`]);
  git(["cat-file", "-e", `${STAGING_RESET_RELEASE.sourceSha}^{commit}`]);
  const read = (sha: string, path: string) => git(["show", `${sha}:${path}`]);
  const manifest = read(sourceSha, "db/postgres/migrations/checksums.json");
  const entries = upgradeManifestEntries(manifest);
  const resetManifest = read(
    STAGING_RESET_RELEASE.sourceSha,
    "db/postgres/migrations/checksums.json",
  );
  assertResetPrefix(resetManifestEntries(resetManifest), entries);
  const names = git(["ls-tree", "--name-only", `${sourceSha}:db/postgres/migrations`])
    .trim()
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.join("\n") !== Object.keys(entries).join("\n")) {
    throw new Error("Upgrade migration set differs from the approved release.");
  }
  const baseline = read(sourceSha, "db/postgres/schema.sql");
  if (sha256(baseline) !== STAGING_UPGRADE_RELEASE.baselineSha256) {
    throw new Error("Upgrade schema baseline differs from the approved release.");
  }
  const migrations = names.map((version) => {
    const sql = read(sourceSha, `db/postgres/migrations/${version}`);
    const checksum = sha256(sql);
    if (checksum !== entries[version]) {
      throw new Error("Upgrade migration checksum differs from the approved release.");
    }
    return { version, checksum, sql };
  });
  return { sourceSha, manifest, baseline, migrations };
}

/** The only accepted upgrade result. The bounded runner starts at the exact
 * 0119 ledger and yields the exact reviewed ordinal sequence through 0179,
 * including the intentional 0173–0175 allocation gap; anything else means the
 * target was not the verified reset state and the run must not proceed to
 * grants or traffic. */
export function assertStagingUpgradeReceipt(receipt: StagingUpgradeReceipt) {
  const ordinals = receipt.applied.map((version) => Number(version.slice(0, 4)));
  if (
    receipt.sourceSha !== STAGING_UPGRADE_RELEASE.sourceSha ||
    receipt.manifestSha256 !== STAGING_UPGRADE_RELEASE.manifestSha256 ||
    receipt.fromVersion !== STAGING_RESET_RELEASE.terminalVersion ||
    receipt.toVersion !== STAGING_UPGRADE_RELEASE.terminalVersion ||
    receipt.applied.length !== STAGING_UPGRADE_RELEASE.upgradeCount ||
    receipt.applied[0] !== STAGING_UPGRADE_RELEASE.firstUpgradeVersion ||
    receipt.applied.at(-1) !== STAGING_UPGRADE_RELEASE.terminalVersion ||
    receipt.applied.some(
      (version, index) =>
        !/^\d{4}_[a-z0-9_]+\.sql$/u.test(version) ||
        ordinals[index] !== STAGING_UPGRADE_ORDINALS[index],
    )
  ) {
    throw new Error("staging_upgrade_receipt_mismatch");
  }
}

/** Builds the one accepted receipt shape and refuses anything else. Exported so
 * a local fixture can verify the span without reaching the provider boundary;
 * it makes no target decision. */
export function stagingUpgradeReceipt(
  artifacts: Pick<StagingUpgradeArtifacts, "sourceSha">,
  applied: readonly string[],
): StagingUpgradeReceipt {
  const receipt: StagingUpgradeReceipt = {
    sourceSha: artifacts.sourceSha,
    manifestSha256: STAGING_UPGRADE_RELEASE.manifestSha256,
    fromVersion: STAGING_RESET_RELEASE.terminalVersion,
    toVersion: STAGING_UPGRADE_RELEASE.terminalVersion,
    applied,
  };
  assertStagingUpgradeReceipt(receipt);
  return receipt;
}

/** The exact reconstructed ledger the upgrade may start from: all 119 names
 * and checksums of the reset plan, not the 109-entry source prefix. The runner
 * enforces this inside its apply transaction, so a 0109 source state or any
 * drifted prefix is refused before the first mutation. */
export function stagingUpgradeBaseLedger(plan: {
  readonly migrations: readonly { readonly version: string; readonly checksum: string }[];
}): readonly { readonly version: string; readonly checksum: string }[] {
  return plan.migrations.map(({ version, checksum }) => ({ version, checksum }));
}

/** Applies the reviewed upgrade in two exact-ledger transactions. Provider r18
 * observed 1,216 non-fast-path locks when the complete span shared one
 * transaction. Ending the first transaction at 0153 releases its DDL locks
 * before the later video and DATA migrations run. If the second phase fails,
 * the caller's release marker and fences retain the unresolved midpoint for
 * governed restoration; it is never reported as a completed upgrade. */
export async function applyStagingUpgradeInPhases(
  connectionString: string,
  run: typeof runPostgresMigrations = runPostgresMigrations,
): Promise<StagingUpgradeReceipt> {
  const upgrade = loadStagingUpgradeArtifacts();
  const resetPlan = validateStagingResetArtifacts(loadStagingResetArtifacts());
  const checkpoint = upgrade.migrations.findIndex(
    ({ version }) => version === STAGING_UPGRADE_CHECKPOINT_VERSION,
  );
  if (checkpoint < STAGING_RESET_RELEASE.migrationCount)
    throw new Error("staging_upgrade_checkpoint_missing");

  const firstMigrations = upgrade.migrations.slice(0, checkpoint + 1);
  const fail = (cause: unknown, appliedMigrations: number) =>
    new StagingUpgradeApplyFailed(
      appliedMigrations,
      upgrade.sourceSha,
      STAGING_UPGRADE_RELEASE.manifestSha256,
      { cause },
    );
  let first: Awaited<ReturnType<typeof run>>;
  try {
    first = await run({
      connectionString,
      migrations: firstMigrations,
      expectedLedger: stagingUpgradeBaseLedger(resetPlan),
    });
  } catch (error) {
    throw fail(error, 0);
  }
  if (first.dryRun) throw fail(new Error("staging_upgrade_unexpected_dry_run"), 0);

  const committedCheckpoint = firstMigrations.length - STAGING_RESET_RELEASE.migrationCount;
  if (committedCheckpoint !== STAGING_UPGRADE_CHECKPOINT_COUNT)
    throw new Error("staging_upgrade_checkpoint_count_changed");

  let second: Awaited<ReturnType<typeof run>>;
  try {
    second = await run({
      connectionString,
      migrations: upgrade.migrations,
      expectedLedger: firstMigrations.map(({ version, checksum }) => ({ version, checksum })),
    });
  } catch (error) {
    throw fail(error, committedCheckpoint);
  }
  if (second.dryRun)
    throw fail(new Error("staging_upgrade_unexpected_dry_run"), committedCheckpoint);
  try {
    return stagingUpgradeReceipt(upgrade, [...first.result.applied, ...second.result.applied]);
  } catch (error) {
    throw fail(error, STAGING_UPGRADE_RELEASE.upgradeCount);
  }
}

/** The rehearsal applier. It acquires the isolated branch through the same
 * provider-verified operator boundary the reset uses, then applies the pinned
 * span in bounded exact-ledger transactions, beginning with the reconstructed
 * `0119` ledger. There is deliberately no connection,
 * URL, or target parameter: caller identifiers alone are not evidence, and an
 * unverified target has no path into this function. */
export async function applyStagingUpgradeOnRehearsalBranch(): Promise<StagingUpgradeReceipt> {
  return withProviderRehearsalOperator(async (_admin, _operator, _runtimeRole, connectionString) =>
    applyStagingUpgradeInPhases(connectionString),
  );
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3 || Bun.argv[2] !== "--dry-run")
      throw new Error("This planner accepts only --dry-run; upgrade execution is not exposed.");
    const artifacts = loadStagingUpgradeArtifacts();
    const upgrade = artifacts.migrations.filter(
      ({ version }) => Number(version.slice(0, 4)) >= 120,
    );
    console.log(
      JSON.stringify({
        mode: "offline-upgrade-plan",
        source_sha: artifacts.sourceSha,
        manifest_sha256: STAGING_UPGRADE_RELEASE.manifestSha256,
        reset_terminal_version: STAGING_RESET_RELEASE.terminalVersion,
        upgrade_count: upgrade.length,
        terminal_version: upgrade.at(-1)?.version,
        migrations: upgrade.map(({ version, checksum }) => ({ version, checksum })),
        database_connected: false,
        execution_available: false,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Upgrade plan validation failed.");
    process.exitCode = 1;
  }
}
