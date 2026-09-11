import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import { SONG_VIDEO_MASTER_POLICY_V1 } from "@pirate/domain";
import { verifyRenderedOutput } from "../packages/platform-cf/src/song-video-output-verification.ts";
import {
  makeLocalPinnedFfmpegSongVideoEngine,
  SONG_VIDEO_DECODE_CHAIN,
} from "./song-video-ffmpeg.ts";

/**
 * Real FFmpeg, real media. Skipped where the pinned FFmpeg 6.1.1 is absent, so
 * a machine without it reports a skip rather than a pass.
 */
const ffmpegAvailable = Bun.which("ffmpeg") !== null;
const version = ffmpegAvailable
  ? Bun.spawnSync(["ffmpeg", "-version"], { stdout: "pipe", stderr: "ignore" })
  : null;
const pinned =
  version !== null &&
  version.exitCode === 0 &&
  new TextDecoder().decode(version.stdout).startsWith("ffmpeg version 6.1.1");
const suite = pinned ? describe : describe.skip;

const SECOND = 48_000;

async function run(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", "-y", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}

suite("local song-video engine", () => {
  let directory = "";
  const media = new Map<string, Uint8Array>();
  let source: { reference: string; sha256: string; byteLength: number };
  let song: { reference: string; sha256: string };
  let songDurationSamples = 0;
  let engine: ReturnType<typeof makeLocalPinnedFfmpegSongVideoEngine>;

  /** The canonical interval as an independent decode, to compare the master against. */
  const intervalDigest = async (start: number, end: number): Promise<string> => {
    const out = join(directory, `interval-${start}-${end}.pcm`);
    await run([
      "-i",
      join(directory, "song.mp3"),
      "-map",
      "0:a:0",
      "-af",
      `${SONG_VIDEO_DECODE_CHAIN},atrim=start_sample=${start}:end_sample=${end}`,
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      out,
    ]);
    return mediaSha256Bytes(new Uint8Array(await readFile(out)));
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pirate-song-engine-test-"));
    // A 10 s recording carrying its own 220 Hz sound, which must never reach
    // the master, and a 20 s song as a 44.1 kHz MP3 with gapless metadata.
    await run([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x568:rate=30:duration=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      join(directory, "source.mp4"),
    ]);
    await run([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=20",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      join(directory, "song.mp3"),
    ]);
    const sourceBytes = new Uint8Array(await readFile(join(directory, "source.mp4")));
    const songBytes = new Uint8Array(await readFile(join(directory, "song.mp3")));
    media.set("media://immutable/source", sourceBytes);
    media.set("media://immutable/song", songBytes);
    source = {
      reference: "media://immutable/source",
      sha256: await mediaSha256Bytes(sourceBytes),
      byteLength: sourceBytes.byteLength,
    };
    song = { reference: "media://immutable/song", sha256: await mediaSha256Bytes(songBytes) };
    engine = makeLocalPinnedFfmpegSongVideoEngine({
      mediaReader: {
        read: async (reference) => {
          const bytes = media.get(reference);
          if (bytes === undefined) throw new Error("missing media");
          return bytes;
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("measures the decoded length, which a frame-sum estimate overstates", async () => {
    const probe = await engine.prober.measure({
      songPostId: "post-song",
      audioRevision: 1,
      canonicalAudioSha256: song.sha256,
      audioAssetRef: song.reference,
    });
    expect(probe).toEqual({ ok: true, durationSamples: 20 * SECOND });
    songDurationSamples = 20 * SECOND;
    // The MP3's frames, summed and resampled, run past the real end: the
    // encoder delay and padding a gapless decoder trims. Containment has no
    // tolerance, so that estimate could admit an interval with no audio at its end.
    const frames = Bun.spawnSync(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-count_packets",
        "-show_entries",
        "stream=nb_read_packets",
        "-of",
        "csv=p=0",
        join(directory, "song.mp3"),
      ],
      { stdout: "pipe" },
    );
    const frameSum = Math.floor(
      (Number(new TextDecoder().decode(frames.stdout).trim()) * 1152 * SECOND) / 44_100,
    );
    expect(frameSum).toBeGreaterThan(20 * SECOND);
  }, 60_000);

  test("refuses to measure bytes that are not the expected song", async () => {
    expect(
      await engine.prober.measure({
        songPostId: "post-song",
        audioRevision: 1,
        canonicalAudioSha256: "0".repeat(64),
        audioAssetRef: song.reference,
      }),
    ).toEqual({ ok: false, permanent: true, failureCode: "source_digest_mismatch" });
  });

  test("renders an interval that is not a whole number of video frames, exactly", async () => {
    // 2.0026 s in, 5.0162 s long: neither boundary falls on a 30 fps frame.
    const start = 2 * SECOND + 123;
    const duration = 5 * SECOND + 777;
    const result = await engine.render({
      source,
      song: { ...song, durationSamples: songDurationSamples },
      clipStartSamples: start,
      clipDurationSamples: duration,
    });
    if (!result.ok) throw new Error(`render refused: ${result.reason}`);
    // Both tracks end on the interval's last sample; nothing is padded.
    expect(result.facts).toEqual({
      videoDurationSamples: duration,
      audioDurationSamples: duration,
      audioSampleRateHz: SECOND,
      audioChannels: 2,
      hasVideoTrack: true,
    });
    // The soundtrack is the canonical interval bit for bit, so the captured
    // 220 Hz sound is not in it and no other interval could pass for it.
    expect(result.soundtrackSha256).toBe(await intervalDigest(start, start + duration));
    expect(result.soundtrackSha256).not.toBe(
      await intervalDigest(start + SECOND, start + SECOND + duration),
    );
    // And the master passes the repository's own output verification.
    const verification = await verifyRenderedOutput({
      store: {
        read: async () => ({ bytes: result.masterBytes, objectVersion: "v1", etag: "etag-v1" }),
        readVersion: async () => result.masterBytes,
      },
      prober: { probe: (bytes) => engine.probeMaster(bytes) },
      objectKey: "master-object/test",
      planClipDurationSamples: duration,
      sourceSha256: source.sha256,
      masterCeilingBytes: SONG_VIDEO_MASTER_POLICY_V1.maxBytes,
    });
    expect(verification.verified).toBe(true);
    // Seal-time binding, computed without anything render reported: the
    // master's audio and the canonical interval decode to the same samples,
    // and an equal-length interval elsewhere in the song does not.
    const canonical = await engine.canonicalIntervalDigest({
      songAssetId: song.reference,
      canonicalAudioSha256: song.sha256,
      songDurationSamples,
      clipStartSamples: start,
      clipDurationSamples: duration,
    });
    expect(await engine.decodedSoundtrackDigest(result.masterBytes)).toBe(canonical);
    expect(
      await engine.canonicalIntervalDigest({
        songAssetId: song.reference,
        canonicalAudioSha256: song.sha256,
        songDurationSamples,
        clipStartSamples: start + SECOND,
        clipDurationSamples: duration,
      }),
    ).not.toBe(canonical);
    // Bytes that are not the frozen song are refused rather than measured.
    expect(
      await engine.canonicalIntervalDigest({
        songAssetId: song.reference,
        canonicalAudioSha256: "0".repeat(64),
        songDurationSamples,
        clipStartSamples: start,
        clipDurationSamples: duration,
      }),
    ).toBeNull();
  }, 180_000);

  test("refuses a recording shorter than the interval instead of padding it", async () => {
    const result = await engine.render({
      source,
      song: { ...song, durationSamples: songDurationSamples },
      clipStartSamples: 0,
      clipDurationSamples: 15 * SECOND,
    });
    expect(result).toEqual({ ok: false, reason: "source_video_too_short" });
  }, 120_000);

  test("refuses a plan frozen against a length this decode does not reproduce", async () => {
    const result = await engine.render({
      source,
      song: { ...song, durationSamples: songDurationSamples + 1 },
      clipStartSamples: 0,
      clipDurationSamples: 5 * SECOND,
    });
    expect(result).toEqual({ ok: false, reason: "canonical_duration_mismatch" });
  }, 120_000);

  test("refuses an interval past the canonical end before running anything", async () => {
    const result = await engine.render({
      source,
      song: { ...song, durationSamples: songDurationSamples },
      clipStartSamples: songDurationSamples - 5 * SECOND + 1,
      clipDurationSamples: 5 * SECOND,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_interval" });
  });

  test("leaves no workspace behind", async () => {
    // Every measure, probe and render above removed its own workspace.
    const leftovers = await Array.fromAsync(
      new Bun.Glob("pirate-song-{measure,probe,render,interval,soundtrack}-*").scan({
        cwd: tmpdir(),
        onlyFiles: false,
      }),
    );
    expect(leftovers).toEqual([]);
  });
});
