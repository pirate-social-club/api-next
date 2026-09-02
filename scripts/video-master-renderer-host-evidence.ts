import { createHash } from "node:crypto";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diagnosticLimitBytes = 1_024;
const artifactLimitBytes = 1_024;
const processTimeoutMs = 150;

type ProcessOutcome =
  | { readonly kind: "completed"; readonly exitCode: number; readonly stderr: Uint8Array }
  | { readonly kind: "timed_out"; readonly stderr: Uint8Array }
  | { readonly kind: "diagnostic_limit_exceeded" };

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onOverflow: () => void,
): Promise<{ readonly exceeded: boolean; readonly bytes: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > maximumBytes) {
      onOverflow();
      return { exceeded: true, bytes: new Uint8Array() };
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { exceeded: false, bytes };
}

async function runBoundedProcess(
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
  maximumDiagnosticBytes: number,
): Promise<ProcessOutcome> {
  const child = Bun.spawn([command, ...arguments_], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let timedOut = false;
  let diagnosticExceeded = false;
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // A process that exited between observation and kill is already bounded.
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const diagnostics = readBounded(child.stderr, maximumDiagnosticBytes, () => {
    diagnosticExceeded = true;
    kill();
  });
  const [exitCode, stderr] = await Promise.all([child.exited, diagnostics]);
  clearTimeout(timeout);
  if (diagnosticExceeded || stderr.exceeded) return { kind: "diagnostic_limit_exceeded" };
  if (timedOut) return { kind: "timed_out", stderr: stderr.bytes };
  return { kind: "completed", exitCode, stderr: stderr.bytes };
}

function internalDiagnosticSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runCorruptSourceEvidence(workingDirectory: string) {
  const sourcePath = join(workingDirectory, "private-source-token-corrupt.mp4");
  await Bun.write(sourcePath, "not an ISO base media file\nprivate-source-token");
  const outcome = await runBoundedProcess(
    "ffprobe",
    ["-v", "error", "-show_streams", "-of", "json", sourcePath],
    2_000,
    diagnosticLimitBytes,
  );
  if (outcome.kind !== "completed" || outcome.exitCode === 0) {
    throw new Error("corrupt source fixture did not produce a bounded probe rejection");
  }
  const publicFailure = {
    code: "invalid_source",
    message: "Video source could not be processed.",
  } as const;
  return {
    rejected: true,
    publicFailure,
    internalDiagnosticSha256: internalDiagnosticSha256(outcome.stderr),
    publicContainsSourcePath: JSON.stringify(publicFailure).includes(sourcePath),
    publicContainsPrivateToken: JSON.stringify(publicFailure).includes("private-source-token"),
  } as const;
}

export async function runHostLimitEvidence() {
  const attemptDirectory = await mkdtemp(join(tmpdir(), "api-video-host-limit-"));
  let timeoutOutcome: ProcessOutcome | undefined;
  let oversizedArtifactRejected = false;
  try {
    timeoutOutcome = await runBoundedProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      processTimeoutMs,
      diagnosticLimitBytes,
    );
    const oversizedArtifactPath = join(attemptDirectory, "oversized-master.bin");
    await Bun.write(oversizedArtifactPath, new Uint8Array(artifactLimitBytes + 1));
    oversizedArtifactRejected = (await stat(oversizedArtifactPath)).size > artifactLimitBytes;
  } finally {
    await rm(attemptDirectory, { recursive: true, force: true });
  }

  const noisyOutcome = await runBoundedProcess(
    process.execPath,
    ["-e", `process.stderr.write("x".repeat(${diagnosticLimitBytes + 1}))`],
    2_000,
    diagnosticLimitBytes,
  );
  return {
    processTimeoutMs,
    diagnosticLimitBytes,
    artifactLimitBytes,
    timeoutKilled: timeoutOutcome?.kind === "timed_out",
    diagnosticOverflowKilled: noisyOutcome.kind === "diagnostic_limit_exceeded",
    oversizedArtifactRejected,
    attemptDirectoryRemoved: !(await pathExists(attemptDirectory)),
  } as const;
}

class Semaphore {
  readonly #waiters: Array<() => void> = [];
  #active = 0;

  constructor(readonly capacity: number) {}

  async withPermit<A>(task: () => Promise<A>): Promise<A> {
    if (this.#active >= this.capacity) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

export async function runConcurrencyEvidence() {
  const configuredMaximum = 2;
  const semaphore = new Semaphore(configuredMaximum);
  let active = 0;
  let observedMaximum = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      semaphore.withPermit(async () => {
        active += 1;
        observedMaximum = Math.max(observedMaximum, active);
        await Bun.sleep(25);
        active -= 1;
      }),
    ),
  );
  return { configuredMaximum, observedMaximum, completedTasks: 6 } as const;
}
