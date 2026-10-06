import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * The Karaoke leg sings a recorded take. A missing or unusable recording would
 * otherwise only be found after the runner had taken its lock and started a run.
 */
export function assertKaraokeRecording(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw Error("REWARDS_E2E_KARAOKE_WAV must be an absolute path to the Karaoke recording");
  let size;
  const header = Buffer.alloc(12);
  try {
    size = statSync(path).size;
    const file = openSync(path, "r");
    try {
      readSync(file, header, 0, 12, 0);
    } finally {
      closeSync(file);
    }
  } catch {
    throw Error("Karaoke recording is not readable");
  }
  if (
    size <= 44 ||
    header.toString("latin1", 0, 4) !== "RIFF" ||
    header.toString("latin1", 8, 12) !== "WAVE"
  )
    throw Error("Karaoke recording is not a WAV file with audio in it");
  return { path, bytes: size };
}
