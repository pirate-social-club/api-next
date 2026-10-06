import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { karaokeSpeechSha256 } from "./karaoke-speech-fixture.mjs";

/**
 * The one rule for a recording a fixture browser will be given as its
 * microphone: a bounded WAV file, and for the Karaoke account exactly the
 * accepted take. The runner applies it before it takes its lock and the browser
 * host applies it again when it opens the file, so a recording the host would
 * refuse can never be found only after a run has started.
 */
export function readFixtureMicrophone(role, path) {
  if (typeof path !== "string" || path.length === 0)
    throw new Error(`Fixture microphone path required for ${role}`);
  const resolved = resolve(path);
  let bytes;
  try {
    bytes = readFileSync(resolved);
  } catch {
    throw new Error(`Fixture microphone for ${role} is not readable`);
  }
  if (
    bytes.length < 44 ||
    bytes.length > 256_000_000 ||
    bytes.subarray(0, 4).toString() !== "RIFF" ||
    bytes.subarray(8, 12).toString() !== "WAVE"
  )
    throw new Error("Fixture microphone must be a bounded WAV file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (role === "karaoke" && sha256 !== karaokeSpeechSha256)
    throw new Error("Accepted Karaoke microphone fixture differs");
  return { path: resolved, sha256, bytes: bytes.length };
}
