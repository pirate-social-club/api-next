import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";

/**
 * Process primitives shared by the local FFmpeg engines: video analysis and the
 * song-video renderer. Every engine runs fixed server-built argument lists, with
 * a bounded timeout, bounded diagnostics and a temporary workspace that is
 * always removed. Extracted from the video analysis engine unchanged, so the
 * two engines cannot drift apart in how they run a tool or clean up after it.
 */

export const MAXIMUM_TOOL_DIAGNOSTIC_BYTES = 64 * 1024;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export async function readBoundedText(
  stream: ReadableStream<Uint8Array> | null,
  limit: number = MAXIMUM_TOOL_DIAGNOSTIC_BYTES,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) throw new Error("video tool diagnostics exceeded limit");
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Runs one tool invocation to completion, killing it on timeout or failure. */
export async function runPinnedTool(
  command: readonly string[],
  timeoutMs: number,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error("video tool timed out"));
    }, timeoutMs);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([child.exited, readBoundedText(child.stdout), readBoundedText(child.stderr)]),
      timeout,
    ]);
    if (exitCode !== 0) throw new Error("video tool failed");
    return { stdout, stderr };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A memoized check that the binaries are the pinned version. A drifted tool is
 * refused before it touches any media, because a different decoder can produce
 * a different sample count for the same bytes.
 */
export function makePinnedVersionCheck(
  input: Readonly<{
    ffmpeg: string;
    ffprobe: string;
    timeoutMs: number;
    ffmpegVersionPrefix: string;
    ffprobeVersionPrefix: string;
    failureMessage: string;
  }>,
): () => Promise<void> {
  let check: Promise<void> | undefined;
  return () => {
    check ??= Promise.all([
      runPinnedTool([input.ffmpeg, "-version"], input.timeoutMs),
      runPinnedTool([input.ffprobe, "-version"], input.timeoutMs),
    ]).then(([ffmpegResult, ffprobeResult]) => {
      if (
        !ffmpegResult.stdout.startsWith(input.ffmpegVersionPrefix) ||
        !ffprobeResult.stdout.startsWith(input.ffprobeVersionPrefix)
      ) {
        throw new Error(input.failureMessage);
      }
    });
    return check;
  };
}

/**
 * Writes already-read source bytes into a fresh temporary workspace after
 * verifying their length and digest, runs `use`, and always removes the
 * workspace. The bytes are verified here rather than by the caller so no engine
 * can decode bytes it has not bound to the expected digest.
 */
export async function withVerifiedTempSource<T>(
  input: Readonly<{
    bytes: Uint8Array;
    expectedByteLength?: number;
    expectedSha256: string;
    fileName: string;
    workspacePrefix: string;
    lengthMismatchMessage: string;
    digestMismatchMessage: string;
  }>,
  use: (inputPath: string, directory: string) => Promise<T>,
): Promise<T> {
  if (
    input.expectedByteLength !== undefined &&
    input.bytes.byteLength !== input.expectedByteLength
  ) {
    throw new Error(input.lengthMismatchMessage);
  }
  if ((await mediaSha256Bytes(input.bytes)) !== input.expectedSha256) {
    throw new Error(input.digestMismatchMessage);
  }
  const directory = await mkdtemp(join(tmpdir(), input.workspacePrefix));
  const inputPath = join(directory, input.fileName);
  try {
    await writeFile(inputPath, input.bytes, { flag: "wx" });
    return await use(inputPath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
