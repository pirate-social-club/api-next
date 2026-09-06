import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan";

const target = "pirate-staging/postgres/api_next";
const markerName = "pirate-staging-api-next.reset-in-progress.json";

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

async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

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
  const write = async (filename: string, value: Marker) => {
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
  };
  try {
    await write(path, current);
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
      await write(temporary, next);
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
