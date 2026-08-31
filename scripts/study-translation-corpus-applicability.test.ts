import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeZhHansB1ApplicabilityPolicyV1,
  measureStudySongLibraryV1,
} from "./study-translation-corpus-applicability.ts";

const temporaryRoots: string[] = [];

const makeLibrary = async (songs: Readonly<Record<string, string | null>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "study-song-library-"));
  temporaryRoots.push(root);
  for (const [song, lyrics] of Object.entries(songs)) {
    const songDirectory = join(root, song);
    await mkdir(songDirectory);
    if (lyrics !== null) await writeFile(join(songDirectory, "lyrics.txt"), lyrics, "utf8");
  }
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("Study translation corpus applicability", () => {
  test("measures every song directory and binds missing lyrics into a stable digest", async () => {
    const root = await makeLibrary({ z_song: null, a_song: "Sing it again\n" });

    const first = await measureStudySongLibraryV1(root);
    const second = await measureStudySongLibraryV1(root);

    expect(first).toEqual(second);
    expect(first.song_directory_count).toBe(2);
    expect(first.lyrics_file_count).toBe(1);
    expect(first.target_script_song_count).toBe(0);
    expect(first.library_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("detects Han script and refuses the zero-Han applicability policy", async () => {
    const root = await makeLibrary({ mandarin_song: "你 gotta say what you gotta say\n" });
    const measurement = await measureStudySongLibraryV1(root);

    expect(measurement.target_script_song_count).toBe(1);
    expect(() => makeZhHansB1ApplicabilityPolicyV1(measurement)).toThrow(
      "zh-Hans already-target applicability must be remeasured",
    );
  });

  test("classifies required, opportunistic, and not-applicable quotas explicitly", async () => {
    const root = await makeLibrary({ english_song: "You gotta say what you gotta say\n" });
    const policy = makeZhHansB1ApplicabilityPolicyV1(await measureStudySongLibraryV1(root));
    const byCategory = new Map(policy.categories.map((entry) => [entry.category, entry]));

    expect(byCategory.get("already_target_language")).toMatchObject({
      applicability: "not_applicable",
      minimum_sample_count: 0,
    });
    expect(byCategory.get("gender_or_formality")).toMatchObject({
      applicability: "opportunistic",
      minimum_sample_count: 20,
    });
    expect(byCategory.get("idiom")).toMatchObject({
      applicability: "required",
      minimum_sample_count: 20,
    });
    expect(byCategory.get("ordinary")).toMatchObject({
      applicability: "required",
      minimum_sample_count: 10,
    });
  });
});
