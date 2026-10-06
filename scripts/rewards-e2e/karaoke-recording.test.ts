import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertKaraokeRecording } from "./karaoke-recording.mjs";

const directory = mkdtempSync(join(tmpdir(), "karaoke-recording-"));
const wav = (bytes: number) => {
  const data = Buffer.alloc(bytes);
  data.write("RIFF", 0, "latin1");
  data.write("WAVE", 8, "latin1");
  return data;
};

test("an unset, relative or missing recording is refused before a run can start", () => {
  expect(() => assertKaraokeRecording(undefined)).toThrow("REWARDS_E2E_KARAOKE_WAV");
  expect(() => assertKaraokeRecording("take.wav")).toThrow("REWARDS_E2E_KARAOKE_WAV");
  expect(() => assertKaraokeRecording(join(directory, "absent.wav"))).toThrow("not readable");
});

test("a file that is not a WAV with audio in it is refused", () => {
  const text = join(directory, "notes.wav");
  writeFileSync(text, "x".repeat(200));
  expect(() => assertKaraokeRecording(text)).toThrow("not a WAV file");
  const empty = join(directory, "header-only.wav");
  writeFileSync(empty, wav(44));
  expect(() => assertKaraokeRecording(empty)).toThrow("not a WAV file");
});

test("a real recording is accepted and its size reported", () => {
  const take = join(directory, "take.wav");
  writeFileSync(take, wav(4_000));
  expect(assertKaraokeRecording(take)).toEqual({ path: take, bytes: 4_000 });
});
