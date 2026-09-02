import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

const StreamProbe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      codec_name: Schema.String,
      codec_type: Schema.String,
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
      sample_aspect_ratio: Schema.optional(Schema.String),
      nb_read_frames: Schema.optional(Schema.String),
      side_data_list: Schema.optional(
        Schema.Array(
          Schema.Struct({
            rotation: Schema.optional(Schema.Number),
          }),
        ),
      ),
    }),
  ),
});

async function run(command: string, arguments_: readonly string[]): Promise<Uint8Array> {
  const child = Bun.spawn([command, ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} failed with exit ${exitCode}: ${stderr.trim()}`);
  }
  return new Uint8Array(stdout);
}

async function probeVideo(path: string) {
  const bytes = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=codec_name,codec_type,width,height,sample_aspect_ratio,nb_read_frames:stream_side_data=rotation",
    "-of",
    "json",
    path,
  ]);
  const stream = Schema.decodeUnknownSync(StreamProbe)(JSON.parse(new TextDecoder().decode(bytes)))
    .streams[0];
  if (!stream) throw new Error("rotation fixture has no video stream");
  return stream;
}

function rotation(stream: Awaited<ReturnType<typeof probeVideo>>): number {
  return stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0;
}

export async function runRotationEvidence(workingDirectory: string) {
  const basePath = join(workingDirectory, "rotation-base.mp4");
  const rotatedPath = join(workingDirectory, "rotation-tagged.mp4");
  const normalizedPath = join(workingDirectory, "rotation-normalized.mp4");

  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=1",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    basePath,
  ]);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-display_rotation",
    "90",
    "-i",
    basePath,
    "-map",
    "0:v:0",
    "-c:v",
    "copy",
    rotatedPath,
  ]);
  const renderArguments = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    rotatedPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    "scale=320:568:flags=bicubic,setsar=1,format=yuv420p",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-metadata:s:v:0",
    "rotate=0",
    normalizedPath,
  ] as const;
  await run("ffmpeg", renderArguments);

  const input = await probeVideo(rotatedPath);
  const output = await probeVideo(normalizedPath);
  return {
    inputCodec: input.codec_name,
    inputStoredWidth: input.width,
    inputStoredHeight: input.height,
    inputDisplayRotationDegrees: rotation(input),
    outputCodec: output.codec_name,
    outputWidth: output.width,
    outputHeight: output.height,
    outputSampleAspectRatio: output.sample_aspect_ratio,
    outputDisplayRotationDegrees: rotation(output),
    outputFrames: Number(output.nb_read_frames),
    renderArguments,
  } as const;
}

if (import.meta.main) {
  const workingDirectory = await mkdtemp(join(tmpdir(), "api-video-rotation-evidence-"));
  try {
    console.log(JSON.stringify(await runRotationEvidence(workingDirectory), null, 2));
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
