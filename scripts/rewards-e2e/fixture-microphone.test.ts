import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFixtureMicrophone } from "./fixture-microphone.mjs";

const directory = mkdtempSync(join(tmpdir(), "fixture-microphone-"));
const wav = (bytes: number) => {
  const data = Buffer.alloc(bytes);
  data.write("RIFF", 0, "latin1");
  data.write("WAVE", 8, "latin1");
  return data;
};
const file = (name: string, data: Buffer | string) => {
  const path = join(directory, name);
  writeFileSync(path, data);
  return path;
};

test("an unset or missing recording is refused", () => {
  expect(() => readFixtureMicrophone("karaoke", undefined)).toThrow("path required for karaoke");
  expect(() => readFixtureMicrophone("karaoke", join(directory, "absent.wav"))).toThrow(
    "not readable",
  );
});

test("a file that is not a bounded WAV is refused for any account", () => {
  expect(() => readFixtureMicrophone("study", file("notes.wav", "x".repeat(200)))).toThrow(
    "bounded WAV",
  );
  expect(() => readFixtureMicrophone("study", file("short.wav", wav(43)))).toThrow("bounded WAV");
});

test("a well-formed WAV that is not the accepted take is refused for Karaoke, before any lock", () => {
  // This is the file that used to pass preparation and fail in the browser host.
  const synthetic = file("synthetic.wav", wav(4_000));
  expect(() => readFixtureMicrophone("karaoke", synthetic)).toThrow(
    "Accepted Karaoke microphone fixture differs",
  );
  // The same file is a usable microphone for the accounts with no pinned take.
  expect(readFixtureMicrophone("study", synthetic)).toEqual({
    path: synthetic,
    sha256: createHash("sha256").update(wav(4_000)).digest("hex"),
    bytes: 4_000,
  });
});
