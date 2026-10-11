import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

/** Prerequisite failures consume nothing; any submitted action is never replayed. */
export async function executeOnce(directory, actionId, prerequisites, submit, options = {}) {
  if (
    !/^[a-z][a-z0-9-]{0,79}$/.test(actionId) ||
    typeof prerequisites !== "function" ||
    typeof submit !== "function" ||
    typeof options.recheck !== "function" ||
    !Number.isFinite(options.deadline)
  )
    throw new Error("Single-use action requires a bounded plan and final recheck");
  const now = options.now ?? Date.now;
  const marker = join(directory, `${actionId}.consumed.json`);
  try {
    await stat(marker);
    throw new Error("Single-use action already consumed; inspect evidence, never replay");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (now() >= options.deadline) throw new Error("Single-use action deadline expired");
  await prerequisites();
  await options.recheck();
  if (now() >= options.deadline) throw new Error("Single-use action deadline expired");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (now() >= options.deadline) throw new Error("Single-use action deadline expired");
  const file = await open(marker, "wx", 0o600);
  try {
    await file.writeFile(
      `${JSON.stringify({
        actionId,
        consumedAt: new Date(now()).toISOString(),
        outcome: "submitted-or-uncertain",
      })}\n`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  // Never retry, even when a click throws after reaching its provider.
  return await submit();
}
