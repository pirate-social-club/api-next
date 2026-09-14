import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan";

const target = "pirate-staging/postgres/api_next";
const markerName = "pirate-staging-api-next.reset-in-progress.json";
const releaseMarkerName = "pirate-staging-api-next.release-in-progress.json";

async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filename: string, value: unknown) {
  const file = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Early refusal before consulting a partially reconstructed schema. The
 * exclusive creation below remains the race-safe final admission check.
 */
export async function assertResetMarkerAbsent(directory: string) {
  if (!isAbsolute(directory)) throw new Error("reset_marker_input_invalid");
  try {
    await lstat(join(directory, markerName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("reset_marker_unreadable_restore_required");
  }
  throw new Error("reset_marker_exists_restore_required");
}

type Marker = Readonly<{
  version: 1;
  target: typeof target;
  run: string;
  sourceSha: string;
  recoveryDigest: string;
  targetAndFenceDigest: string;
  validUntilMs: number;
  phase: "admitted" | "removing" | "replaying" | "verifying" | "failed";
  completedBatches: number;
}>;

/** Coordinator-host persistence only. This is not a distributed fence: all
 * admitted reset entrypoints must use the same approved directory, and the
 * independent Worker fence must remain held. Never place this in api_next.
 */
export async function createResetMarker(
  directory: string,
  input: {
    sourceSha: string;
    recoveryDigest: string;
    targetAndFenceDigest: string;
    validUntilMs: number;
  },
) {
  if (
    !isAbsolute(directory) ||
    input.sourceSha !== STAGING_RESET_RELEASE.sourceSha ||
    !/^[a-f0-9]{64}$/.test(input.recoveryDigest) ||
    !/^[a-f0-9]{64}$/.test(input.targetAndFenceDigest) ||
    !Number.isSafeInteger(input.validUntilMs) ||
    input.validUntilMs <= Date.now()
  )
    throw new Error("reset_marker_input_invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("reset_marker_directory_untrusted");
  const path = join(directory, markerName);
  let current: Marker = {
    version: 1,
    target,
    run: crypto.randomUUID(),
    sourceSha: input.sourceSha,
    recoveryDigest: input.recoveryDigest,
    targetAndFenceDigest: input.targetAndFenceDigest,
    validUntilMs: input.validUntilMs,
    phase: "admitted",
    completedBatches: 0,
  };
  try {
    await writeExclusive(path, current);
  } catch {
    throw new Error("reset_marker_exists_or_unwritable_restore_required");
  }
  await syncDirectory(directory);
  const assertCurrent = async () => {
    if ((await readFile(path, "utf8")) !== `${JSON.stringify(current)}\n`)
      throw new Error("reset_marker_changed_restore_required");
  };
  return Object.freeze({
    run: current.run,
    async advance(phase: Marker["phase"], completedBatches: number) {
      await assertCurrent();
      const rank = { admitted: 0, removing: 1, replaying: 2, verifying: 3, failed: 4 };
      if (
        current.phase === "failed" ||
        !Object.hasOwn(rank, phase) ||
        rank[phase] < rank[current.phase] ||
        (phase !== "failed" && rank[phase] > rank[current.phase] + 1) ||
        (phase !== "failed" && Date.now() >= current.validUntilMs) ||
        !Number.isSafeInteger(completedBatches) ||
        completedBatches < current.completedBatches
      )
        throw new Error("reset_marker_transition_invalid");
      const next = { ...current, phase, completedBatches };
      const temporary = join(directory, `${current.run}.${crypto.randomUUID()}.tmp`);
      await writeExclusive(temporary, next);
      // A temporary or malformed marker is not recoverable by rerunning reset.
      await assertCurrent();
      await rename(temporary, path);
      await syncDirectory(directory);
      current = next;
    },
    async completeAfterVerification() {
      await assertCurrent();
      if (current.phase !== "verifying" || Date.now() >= current.validUntilMs)
        throw new Error("reset_marker_verification_required");
      await unlink(path);
      await syncDirectory(directory);
    },
  });
}

/** The window's release-phase marker, separate from the reset marker. The reset
 * marker retires when the reset is verified, before the upgrade mutates the
 * schema; this one is written before the upgrade and retired only after grant
 * reconciliation commits, so a process kill in that interval leaves evidence
 * requiring recovery instead of an 0119 state indistinguishable from a
 * verified reset with no next step. */
export async function assertReleaseMarkerAbsent(directory: string) {
  if (!isAbsolute(directory)) throw new Error("release_marker_input_invalid");
  try {
    await lstat(join(directory, releaseMarkerName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("release_marker_unreadable_restore_required");
  }
  throw new Error("release_marker_exists_restore_required");
}

type ReleaseMarker = Readonly<{
  version: 1;
  target: typeof target;
  run: string;
  phase: "upgrading" | "reconciling" | "failed";
  targetAndFenceDigest: string;
  validUntilMs: number;
  appliedMigrations: number;
  upgradeSourceSha: string | null;
  upgradeManifestSha256: string | null;
}>;

export async function createReleaseMarker(
  directory: string,
  input: { targetAndFenceDigest: string; validUntilMs: number },
) {
  if (
    !isAbsolute(directory) ||
    !/^[a-f0-9]{64}$/.test(input.targetAndFenceDigest) ||
    !Number.isSafeInteger(input.validUntilMs) ||
    input.validUntilMs <= Date.now()
  )
    throw new Error("release_marker_input_invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("release_marker_directory_untrusted");
  const path = join(directory, releaseMarkerName);
  let current: ReleaseMarker = {
    version: 1,
    target,
    run: crypto.randomUUID(),
    phase: "upgrading",
    targetAndFenceDigest: input.targetAndFenceDigest,
    validUntilMs: input.validUntilMs,
    appliedMigrations: 0,
    upgradeSourceSha: null,
    upgradeManifestSha256: null,
  };
  try {
    await writeExclusive(path, current);
  } catch {
    throw new Error("release_marker_exists_or_unwritable_restore_required");
  }
  await syncDirectory(directory);
  const assertCurrent = async () => {
    if ((await readFile(path, "utf8")) !== `${JSON.stringify(current)}\n`)
      throw new Error("release_marker_changed_restore_required");
  };
  return Object.freeze({
    run: current.run,
    async advance(
      phase: "reconciling" | "failed",
      update: {
        appliedMigrations: number;
        upgradeSourceSha: string | null;
        upgradeManifestSha256: string | null;
      },
    ) {
      await assertCurrent();
      if (
        current.phase === "failed" ||
        (phase === "reconciling" && current.phase !== "upgrading") ||
        (phase !== "failed" && Date.now() >= current.validUntilMs) ||
        !Number.isSafeInteger(update.appliedMigrations) ||
        update.appliedMigrations < current.appliedMigrations ||
        (update.upgradeSourceSha !== null && !/^[a-f0-9]{40}$/.test(update.upgradeSourceSha)) ||
        (update.upgradeManifestSha256 !== null &&
          !/^[a-f0-9]{64}$/.test(update.upgradeManifestSha256)) ||
        (phase === "reconciling" &&
          (update.upgradeSourceSha === null || update.upgradeManifestSha256 === null))
      )
        throw new Error("release_marker_transition_invalid");
      const next: ReleaseMarker = {
        ...current,
        phase,
        appliedMigrations: update.appliedMigrations,
        upgradeSourceSha: update.upgradeSourceSha,
        upgradeManifestSha256: update.upgradeManifestSha256,
      };
      const temporary = join(directory, `${current.run}.${crypto.randomUUID()}.tmp`);
      await writeExclusive(temporary, next);
      // A temporary or malformed marker is not recoverable by rerunning the window.
      await assertCurrent();
      await rename(temporary, path);
      await syncDirectory(directory);
      current = next;
    },
    async completeAfterReconciliation() {
      await assertCurrent();
      if (current.phase !== "reconciling")
        throw new Error("release_marker_reconciliation_required");
      await unlink(path);
      await syncDirectory(directory);
    },
  });
}
