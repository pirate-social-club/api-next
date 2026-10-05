import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The page opens the microphone and then counts in before the song starts.
 * Chromium's fake microphone plays its file from the moment the stream opens,
 * so the speech is delayed by that measured count-in (2.55 to 2.81 seconds).
 */
export const karaokeCountInMs = 2800;
export const karaokeSpeechSha256 =
  "4bb11497b24cdb80ee172dc78a3a0abdd71acaa480956d065d395c60895fdbfe";

const ffmpeg = (args) =>
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const duration = (path) =>
  Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      { encoding: "utf8" },
    ),
  );

/**
 * Builds the Karaoke microphone fixture: each lyric line of the fixture song
 * spoken by a synthetic voice at its own timestamp. The original recording
 * cannot be transcribed by the scoring provider, and a real take through the
 * provider is still required; nothing here injects a transcript or a score.
 */
export function buildKaraokeSpeech(linesPath, output) {
  const lines = JSON.parse(readFileSync(linesPath, "utf8")).filter(
    (line) => line.kind === "lyric" && line.text.trim(),
  );
  const directory = mkdtempSync(join(tmpdir(), "karaoke-speech-"));
  try {
    const inputs = [];
    const filters = [];
    lines.forEach((line, index) => {
      const text = join(directory, `${index}.txt`);
      const spoken = join(directory, `${index}.wav`);
      writeFileSync(text, line.text.replace(/[^\p{L}\p{N}' ,.?!-]/gu, " "));
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `flite=textfile=${text}:voice=slt`,
        "-af",
        "silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.2:stop_threshold=-45dB",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-bitexact",
        spoken,
      ]);
      const window = Math.max(0.5, (line.end_ms - line.start_ms) / 1000);
      // Natural pace fits nearly every sung line; never slow the speech down.
      const tempo = Math.min(2, Math.max(1, duration(spoken) / window));
      inputs.push("-i", spoken);
      filters.push(
        `[${index}:a]atempo=${tempo.toFixed(4)},adelay=${line.start_ms + karaokeCountInMs}:all=1[a${index}]`,
      );
    });
    const total = (lines.at(-1).end_ms / 1000 + 3).toFixed(2);
    const mix = `${lines.map((_, index) => `[a${index}]`).join("")}amix=inputs=${lines.length}:normalize=0,apad=whole_dur=${total},volume=1.5[m]`;
    ffmpeg([
      ...inputs,
      "-filter_complex",
      `${filters.join(";")};${mix}`,
      "-map",
      "[m]",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-bitexact",
      output,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return createHash("sha256").update(readFileSync(output)).digest("hex");
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output) throw Error("Output WAV path required");
  const sha256 = buildKaraokeSpeech(
    resolve(import.meta.dir, "../../tests/rewards-e2e/karaoke-lines.json"),
    resolve(output),
  );
  console.log(
    JSON.stringify({ output: resolve(output), sha256, pinned: sha256 === karaokeSpeechSha256 }),
  );
}
