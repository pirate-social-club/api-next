import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readBoundedText, runPinnedTool } from "./pinned-ffmpeg.ts";
import {
  type FrameMetrics,
  frameCount,
  frameVerdict,
  matchesQualificationVersion,
  SONG_VIDEO_FRAME_POLICY,
} from "./song-video-frame-policy.ts";

export type FrameIdentity = Readonly<{
  sha256: string;
  byteLength: number;
  objectKey: string;
  objectVersion: string;
}>;
export type FrameManifest = Readonly<{
  submissionId: string;
  planId: string;
  attemptId: string;
  masterRevisionId: string;
  clipDurationSamples: number;
  source: FrameIdentity;
  master: FrameIdentity;
}>;

type Probe = {
  streams: {
    width: number;
    height: number;
    time_base: string;
    duration_ts: number;
    sample_aspect_ratio?: string;
    pix_fmt: string;
    codec_name: string;
  }[];
  frames: {
    pts: number;
    pkt_duration?: number;
    duration?: number;
    width: number;
    height: number;
  }[];
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const quiet = ["-nostdin", "-hide_banner", "-loglevel", "error"];
const timeoutMs = 120_000;

export function validateManifest(value: unknown): FrameManifest {
  if (typeof value !== "object" || value === null) throw new Error("missing identity manifest");
  const manifest = value as FrameManifest;
  for (const id of [
    manifest.submissionId,
    manifest.planId,
    manifest.attemptId,
    manifest.masterRevisionId,
  ]) {
    if (typeof id !== "string" || id.length < 1 || id.length > 160 || /\s/u.test(id)) {
      throw new Error("invalid work identity");
    }
  }
  frameCount(manifest.clipDurationSamples);
  if (
    manifest.planId !== `song-video-plan:${manifest.submissionId}` ||
    !manifest.attemptId.startsWith(`${manifest.planId}:g`) ||
    manifest.masterRevisionId !== `${manifest.attemptId}:master`
  ) {
    throw new Error("work identities are not the same accepted plan");
  }
  for (const identity of [manifest.source, manifest.master]) {
    if (
      !identity ||
      !/^[0-9a-f]{64}$/u.test(identity.sha256) ||
      !Number.isSafeInteger(identity.byteLength) ||
      identity.byteLength < 1 ||
      identity.byteLength > SONG_VIDEO_FRAME_POLICY.maxBytes ||
      typeof identity.objectKey !== "string" ||
      !identity.objectKey.startsWith("media://immutable/") ||
      typeof identity.objectVersion !== "string" ||
      !/^[0-9a-f]{32}$/u.test(identity.objectVersion)
    ) {
      throw new Error("invalid immutable identity");
    }
  }
  if (manifest.source.sha256 === manifest.master.sha256)
    throw new Error("source/master identity collapsed");
  return manifest;
}

async function checkedFile(path: string, identity: FrameIdentity): Promise<string> {
  const absolute = await realpath(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || metadata.size !== identity.byteLength)
    throw new Error("file length differs");
  if (sha256(await readFile(absolute)) !== identity.sha256) throw new Error("file digest differs");
  return absolute;
}

export function checkMasterTimeline(probe: Probe, durationSamples: number): void {
  const count = frameCount(durationSamples);
  const stream = probe.streams[0];
  if (
    probe.streams.length !== 1 ||
    !stream ||
    stream.time_base !== "1/48000" ||
    stream.duration_ts !== durationSamples ||
    stream.pix_fmt !== "yuv420p" ||
    stream.codec_name !== "h264" ||
    (stream.sample_aspect_ratio !== undefined && stream.sample_aspect_ratio !== "1:1") ||
    probe.frames.length !== count
  ) {
    throw new Error("master timeline or video format differs");
  }
  for (const [index, frame] of probe.frames.entries()) {
    const expectedDuration = index === count - 1 ? durationSamples - index * 1600 : 1600;
    if (
      frame.pts !== index * 1600 ||
      (frame.duration ?? frame.pkt_duration) !== expectedDuration ||
      frame.width !== stream.width ||
      frame.height !== stream.height
    ) {
      throw new Error("master frame timing or dimensions differ");
    }
  }
}

function stats(text: string, keys: readonly string[]): Record<string, number>[] {
  const lines = text.trim().split(/\r?\n/u);
  return lines.map((line) => {
    const result: Record<string, number> = {};
    for (const key of keys) {
      const match = new RegExp(`(?:^|\\s)${key}:([^\\s]+)`, "u").exec(line);
      if (!match) throw new Error("incomplete comparison statistic");
      result[key] = match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
    }
    return result;
  });
}

export function parseFrameMetrics(ssimText: string, psnrText: string): FrameMetrics[] {
  const ssim = stats(ssimText, ["n", "Y", "U", "V", "All"]);
  const psnr = stats(psnrText, ["n", "psnr_y", "psnr_u", "psnr_v", "psnr_avg"]);
  if (ssim.length !== psnr.length) throw new Error("metric coverage differs");
  return ssim.map((entry, index) => {
    const other = psnr[index];
    if (!other || entry.n !== other.n) throw new Error("metric frame identity differs");
    return {
      frame: entry.n as number,
      ssim: {
        all: entry.All as number,
        y: entry.Y as number,
        u: entry.U as number,
        v: entry.V as number,
      },
      psnr: {
        all: other.psnr_avg as number,
        y: other.psnr_y as number,
        u: other.psnr_u as number,
        v: other.psnr_v as number,
      },
    };
  });
}

export async function compareSongVideoFrames(
  input: Readonly<{
    manifest: FrameManifest;
    sourcePath: string;
    masterPath: string;
    outputDirectory: string;
  }>,
) {
  const manifest = validateManifest(input.manifest);
  const originalSource = await checkedFile(input.sourcePath, manifest.source);
  const originalMaster = await checkedFile(input.masterPath, manifest.master);
  const output = resolve(input.outputDirectory);
  // Refuse preexisting output: a new run cannot overwrite or merge old evidence.
  await mkdir(output);
  // Decode bounded, hash-verified private snapshots, never a caller's mutable
  // path. The copies contain no network capability and remain in the receipt.
  const snapshot = async (original: string, identity: FrameIdentity, name: string) => {
    const bytes = await readFile(original);
    if (bytes.length !== identity.byteLength || sha256(bytes) !== identity.sha256) {
      throw new Error("input changed before snapshot");
    }
    const path = `${output}/${name}.mp4`;
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return path;
  };
  const source = await snapshot(originalSource, manifest.source, "source-snapshot");
  const master = await snapshot(originalMaster, manifest.master, "master-snapshot");
  const tools = await Promise.all(
    ["ffmpeg", "ffprobe"].map(async (name) => {
      const binary = Bun.which(name);
      if (!binary) throw new Error("qualification decoder absent");
      const identity = await runPinnedTool([binary, "-version"], timeoutMs);
      if (!matchesQualificationVersion(name as "ffmpeg" | "ffprobe", identity.stdout)) {
        throw new Error("qualification decoder version differs");
      }
      return { name, binary, sha256: sha256(await readFile(binary)), version: identity.stdout };
    }),
  );
  const count = frameCount(manifest.clipDurationSamples);
  const probe = async (path: string) =>
    JSON.parse(
      (
        await runPinnedTool(
          [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_streams",
            "-show_entries",
            "stream=codec_name,width,height,time_base,duration_ts,pix_fmt,sample_aspect_ratio:frame=pts,pkt_duration,duration,width,height",
            "-of",
            "json=compact=1",
            path,
          ],
          timeoutMs,
        )
      ).stdout,
    ) as Probe;
  const masterProbe = await probe(master);
  await writeFile(`${output}/master-probe.json`, `${JSON.stringify(masterProbe, null, 2)}\n`);
  checkMasterTimeline(masterProbe, manifest.clipDurationSamples);
  const sourceSelection = `fps=30,trim=end_frame=${count},setpts=PTS-STARTPTS,format=yuv420p`;
  // Normalize only the reference according to the provider recipe. The master
  // is never fps-filtered, trimmed or padded; timing was independently checked.
  const sourceInfo = await runPinnedTool(
    [
      "ffmpeg",
      ...quiet,
      "-threads",
      "2",
      "-i",
      source,
      "-an",
      "-vf",
      sourceSelection,
      "-fps_mode",
      "passthrough",
      "-f",
      "framemd5",
      "-",
    ],
    timeoutMs,
  );
  const sourceRows = sourceInfo.stdout
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const dimensions = /#dimensions 0: (\d+)x(\d+)/u.exec(sourceInfo.stdout);
  if (
    sourceRows.length !== count ||
    !dimensions ||
    Number(dimensions[1]) !== masterProbe.streams[0]?.width ||
    Number(dimensions[2]) !== masterProbe.streams[0]?.height
  )
    throw new Error("selected source coverage/dimensions differ");
  await writeFile(`${output}/source-selected.framemd5`, sourceInfo.stdout);
  const filter =
    `[0:v:0]${sourceSelection},settb=1/30,setpts=N,split=2[s1][s2];` +
    "[1:v:0]format=yuv420p,settb=1/30,setpts=N,split=2[m1][m2];" +
    "[s1][m1]ssim=stats_file=ssim.log:shortest=1:repeatlast=0[a];" +
    "[s2][m2]psnr=stats_file=psnr.log:shortest=1:repeatlast=0[b]";
  // Stats paths are fixed relative names; user-controlled paths never enter a
  // filter expression. Use the child cwd instead of shell quoting.
  const child = Bun.spawn(
    [
      "ffmpeg",
      ...quiet,
      "-threads",
      "2",
      "-i",
      source,
      "-threads",
      "2",
      "-i",
      master,
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      filter,
      "-map",
      "[a]",
      "-map",
      "[b]",
      "-an",
      "-fps_mode",
      "passthrough",
      "-f",
      "null",
      "-",
    ],
    { cwd: output, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const diagnostic = await readBoundedText(child.stderr);
    if ((await child.exited) !== 0) throw new Error("comparison decoder failed");
    await writeFile(`${output}/comparison-diagnostic.txt`, diagnostic);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
  const metrics = parseFrameMetrics(
    await readFile(`${output}/ssim.log`, "utf8"),
    await readFile(`${output}/psnr.log`, "utf8"),
  );
  const verdict = frameVerdict(metrics, count);
  // Detect input replacement during the decoder runs, rather than crediting
  // the hash checked at the beginning against different decoded bytes.
  await checkedFile(source, manifest.source);
  await checkedFile(master, manifest.master);
  const minimums = {
    ssimAll: Math.min(...metrics.map((metric) => metric.ssim.all)),
    ssimPlane: Math.min(
      ...metrics.flatMap((metric) => [metric.ssim.y, metric.ssim.u, metric.ssim.v]),
    ),
    psnrAllDb: Math.min(...metrics.map((metric) => metric.psnr.all)),
    psnrPlaneDb: Math.min(
      ...metrics.flatMap((metric) => [metric.psnr.y, metric.psnr.u, metric.psnr.v]),
    ),
  };
  const report = {
    observedAt: new Date().toISOString(),
    policy: SONG_VIDEO_FRAME_POLICY,
    manifest,
    tools,
    frameCount: count,
    comparedFrames: metrics.length,
    minimums,
    verdict,
  };
  await writeFile(
    `${output}/metrics.json`,
    `${JSON.stringify(metrics, (_key, value) => (value === Infinity ? "inf" : value), 2)}\n`,
  );
  await writeFile(
    `${output}/verdict.json`,
    `${JSON.stringify(report, (_key, value) => (value === Infinity ? "inf" : value), 2)}\n`,
  );
  return report;
}

if (import.meta.main) {
  const [manifestPath, sourcePath, masterPath, outputDirectory, ...extra] = process.argv.slice(2);
  if (!manifestPath || !sourcePath || !masterPath || !outputDirectory || extra.length > 0) {
    console.error(
      "Usage: bun scripts/song-video-frame-comparison.ts MANIFEST SOURCE MASTER NEW_OUTPUT_DIRECTORY",
    );
    process.exitCode = 2;
  } else {
    try {
      const report = await compareSongVideoFrames({
        manifest: validateManifest(JSON.parse(await readFile(manifestPath, "utf8"))),
        sourcePath,
        masterPath,
        outputDirectory,
      });
      console.log(
        JSON.stringify({
          passed: report.verdict.passed,
          comparedFrames: report.comparedFrames,
          minimums: report.minimums,
        }),
      );
      if (!report.verdict.passed) process.exitCode = 1;
    } catch {
      console.error(
        "frame comparison refused; inspect retained evidence, never retry a provider job",
      );
      process.exitCode = 1;
    }
  }
}
