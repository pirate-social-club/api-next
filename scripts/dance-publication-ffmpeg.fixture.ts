import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  makeModeratedDancePublicationBodyCommands,
  measureModeratedDancePublicationBody,
  readModeratedDancePublicationBody,
} from "../packages/platform-cf/src/moderated-dance-publication-body.ts";
import { makeQencodeMediaTransform } from "../packages/platform-cf/src/qencode-media-transform.ts";
import { sha256Hex } from "../packages/platform-cf/src/r2-upload-signing.ts";
import {
  inspectSilentSongVideoInputStructure,
  inspectSongVideoMasterStructure,
} from "../packages/platform-cf/src/song-video-master-verifier/master-structure.ts";

async function execute(args: readonly string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`Native Dance command failed: ${stderr}`);
  return stdout;
}
const boxOffset = (bytes: Uint8Array, type: string) => {
  const needle = new TextEncoder().encode(type),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 4; at < bytes.length - 4; at++)
    if (
      needle.every((v, i) => bytes[at + i] === v) &&
      view.getUint32(at - 4) >= 8 &&
      view.getUint32(at - 4) <= bytes.length - at + 4
    )
      return at;
  throw new Error(`Native Dance box missing: ${type}`);
};

/** Runs the actual command strings from the provider recipe. Synthetic cue
 * red precedes a moving test pattern. This uses local pinned6.1.1, not a claim
 * that CloudConvert6.1.4 conformance or phone alignment has been accepted. */
export async function proveDancePublicationBodyWithPinnedFfmpeg(directory: string) {
  const bodies: { bytes: Uint8Array; durationMs: number; sha256: string }[] = [];
  // Only an owned mkdtemp path is interpolated into these fixed command strings.
  if (!/^\/tmp\/pirate-song-engine-test-[A-Za-z0-9_-]+$/u.test(directory))
    throw new Error("Owned native path refused");
  const source = join(directory, "dance-private-source.mp4");
  await execute([
    "ffmpeg",
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:size=160x128:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x128:rate=30:duration=33",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=36",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-map",
    "2:a:0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  const sourceSha256 = await sha256Hex(new Uint8Array(await readFile(source)));
  for (const [start, duration] of [
    [3000, 6000],
    [3017, 12017],
    [3000, 29999],
    [3000, 30000],
  ] as const) {
    const end = start + duration,
      binding = {
        tag: `native:body:${duration}`,
        reviewId: `native-${duration}`,
        sourceSha256,
        bodyStartMs: start,
        bodyEndMs: end,
      },
      commands = makeModeratedDancePublicationBodyCommands(start, end),
      intermediate = join(directory, `body-intermediate-${duration}.mp4`),
      output = join(directory, `body-${duration}.mp4`),
      substitute = (command: string) =>
        command
          .replaceAll("/input/import-recording/source.mp4", source)
          .replaceAll("/input/trim-recording/body-pass-one.mp4", intermediate)
          .replaceAll("/output/body-pass-one.mp4", intermediate)
          .replaceAll("/output/body.mp4", output);
    await execute(["sh", "-c", `exec ffmpeg ${substitute(commands.passOne)}`]);
    await execute(["sh", "-c", `exec ffmpeg ${substitute(commands.passTwo)}`]);
    const bytes = new Uint8Array(await readFile(output)),
      metadata = JSON.parse(
        await execute([
          "ffprobe",
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-show_chapters",
          "-of",
          "json",
          output,
        ]),
      ) as {
        format: { duration: string; size: string };
        streams: readonly { codec_type: string; duration_ts: number }[];
      };
    expect(metadata.streams.map((s) => s.codec_type)).toEqual(["video"]);
    expect(metadata.streams[0]?.duration_ts).toBe(duration * 48);
    expect(inspectSilentSongVideoInputStructure(bytes, duration * 48)).toEqual({
      durationSamples: duration * 48,
      videoFrameCount: Math.ceil((duration * 30) / 1000),
    });
    expect(() => inspectSongVideoMasterStructure(bytes, duration * 48)).toThrow();
    const plan = await measureModeratedDancePublicationBody(binding, bytes, metadata);
    const probe = await Effect.runPromise(
      makeQencodeMediaTransform({
        enabled: true,
        apiKey: "native-test-not-live",
        clock: () => 2000,
        transport: {
          createTask: async () => {
            throw new Error("Native probe must not create a job");
          },
          startTask: async () => {
            throw new Error("Native probe must not start a job");
          },
          getStatus: async () => ({
            state: "completed",
            outputs: [
              {
                kind: "metadata",
                userTag: "pirate-probe-v1",
                url: "https://test.qencode.com/native.json",
                outputFormat: "metadata",
                mediaFacts: {
                  codec: null,
                  sampleRateHz: null,
                  channels: null,
                  width: null,
                  height: null,
                },
              },
            ],
          }),
        },
        sourceGateway: {
          issue: async () => {
            throw new Error("Native probe must not issue a source grant");
          },
        },
        artifacts: {
          readJson: async () => metadata,
          seal: async () => {
            throw new Error("Native probe must not seal an artifact");
          },
        },
      }).observe({
        version: "media-transform-video-probe-input-v1",
        binding: {
          operationId: `native-${duration}`,
          videoRevision: 1,
          creationRevision: 1,
          analysisRevision: 1,
          canonicalVideoSha256: plan.sha256,
          requestId: `native-probe-${duration}`,
        },
        source: {
          objectKey: plan.key,
          sha256: plan.sha256,
          byteLength: bytes.length,
          mediaType: "video/mp4",
        },
        attempt: {
          version: "media-transform-attempt-v1",
          providerJobId: "b".repeat(32),
          providerJobPhase: "started",
          runtimeFence: { submittedAtMs: 1000, runtimeDeadlineMs: 60000 },
        },
      }),
    );
    expect(probe.status).toBe("completed");
    if (probe.status !== "completed")
      throw new Error("Real silent body did not pass the publication probe");
    expect(probe.probe).toMatchObject({
      durationMs: duration,
      videoCodec: "h264",
      hasAudio: false,
      audioCodec: null,
    });
    bodies.push({ bytes, durationMs: duration, sha256: plan.sha256 });
    expect(plan).toEqual({
      key: `immutable/dance-post-operation:native-${duration}/video/1`,
      sha256: await sha256Hex(bytes),
      size: bytes.length,
      sourceSha256,
      bodyStartMs: start,
      bodyEndMs: end,
      durationMs: duration,
      transformRevision: "dance-publication-body-v1",
    });
    // Independent complete-frame comparison against the source interval. It
    // catches cue leakage, wrong source windows and reordered/truncated output.
    const stats = join(directory, `dance-body-ssim-${duration}.txt`);
    await execute([
      "ffmpeg",
      "-v",
      "error",
      "-nostdin",
      "-i",
      source,
      "-i",
      output,
      "-filter_complex",
      `[0:v]trim=start=${start / 1000}:end=${end / 1000},setpts=PTS-STARTPTS,fps=30,trim=end_frame=${commands.frameCount}[expected];[1:v]setpts=PTS-STARTPTS[actual];[expected][actual]ssim=stats_file=${stats}`,
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const frames = (await readFile(stats, "utf8")).trim().split("\n");
    expect(frames.length).toBe(commands.frameCount);
    for (const line of frames) {
      const match = /\bAll:(\d+(?:\.\d+)?)/u.exec(line);
      if (match === null || Number(match[1]) < 0.97)
        throw new Error(`Native body frame comparison refused: ${line}`);
    }
    const read = await readModeratedDancePublicationBody({
      binding,
      jobId: "native-job",
      observation: {
        id: "native-job",
        tag: binding.tag,
        status: "finished",
        metadata,
        exportUrl: "https://storage.cloudconvert.com/private/body.mp4",
      },
      signal: new AbortController().signal,
      send: async (_url, init) => {
        expect(init.redirect).toBe("manual");
        expect(init.headers).toBeUndefined();
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      },
    });
    expect(read.plan).toEqual(plan);
    // Test independently malformed media, not just a happy metadata echo.
    await expect(
      measureModeratedDancePublicationBody(binding, bytes.subarray(0, bytes.length - 1), metadata),
    ).rejects.toThrow();
    await expect(
      measureModeratedDancePublicationBody({ ...binding, bodyEndMs: end - 1 }, bytes, metadata),
    ).rejects.toThrow();
    await expect(
      measureModeratedDancePublicationBody(binding, bytes, {
        ...metadata,
        format: { ...metadata.format, size: String(bytes.length + 1) },
      }),
    ).rejects.toThrow();
    const mutated = bytes.slice();
    mutated.set(new TextEncoder().encode("mp4a"), boxOffset(mutated, "avc1"));
    expect(() => inspectSilentSongVideoInputStructure(mutated, duration * 48)).toThrow();
    const timing = bytes.slice(),
      at = boxOffset(timing, "mdhd");
    new DataView(timing.buffer).setUint32(at + 20, duration * 48 - 1);
    expect(() => inspectSilentSongVideoInputStructure(timing, duration * 48)).toThrow();
  }
  return bodies;
}
