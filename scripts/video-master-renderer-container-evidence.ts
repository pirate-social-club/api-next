import { Schema } from "effect";

const imageName = "pirate-video-renderer-evidence:pinned";
const dockerfilePath = "scripts/video-master-renderer-container.Dockerfile";
const cpuLimit = 1;
const memoryLimitBytes = 384 * 1_024 * 1_024;
const pidLimit = 128;
const tmpfsLimitBytes = 512 * 1_024 * 1_024;

// Enforcement drills deliberately exceed a reduced ceiling so the rejection is
// attributable. They never run at the production ceiling, because a drill that
// merely succeeds proves nothing about the limit.
const memoryDrillLimitBytes = 128 * 1_024 * 1_024;
const memoryDrillAllocationMib = 600;
const pidDrillLimit = 16;
const pidDrillForkAttempts = 40;
const concurrentPidCeilingDrillLimit = 64;
const overlapSampleIntervalMs = 100;

type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

async function spawnProcess(command: string, arguments_: readonly string[]): Promise<RunResult> {
  const child = Bun.spawn([command, ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { stdout, stderr, exitCode };
}

async function run(command: string, arguments_: readonly string[]): Promise<RunResult> {
  const outcome = await spawnProcess(command, arguments_);
  if (outcome.exitCode !== 0) {
    throw new Error(`${command} failed with exit ${outcome.exitCode}: ${outcome.stderr.trim()}`);
  }
  return outcome;
}

export function parseKeyValueOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`invalid evidence line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function isolationArguments(
  overrides: {
    readonly memoryBytes?: number;
    readonly pids?: number;
    readonly tmpfsBytes?: number;
  } = {},
): readonly string[] {
  const memoryBytes = overrides.memoryBytes ?? memoryLimitBytes;
  const pids = overrides.pids ?? pidLimit;
  const tmpfsBytes = overrides.tmpfsBytes ?? tmpfsLimitBytes;
  return [
    "--network=none",
    "--read-only",
    `--cpus=${cpuLimit}`,
    `--memory=${memoryBytes}`,
    `--memory-swap=${memoryBytes}`,
    `--pids-limit=${pids}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,size=${tmpfsBytes}`,
  ] as const;
}

export function containerRunArguments(): readonly string[] {
  return ["run", "--rm", ...isolationArguments()] as const;
}

/* ------------------------------------------------------------------ *
 * Image identity
 * ------------------------------------------------------------------ */

const ImageIdentity = Schema.Struct({
  image_id: Schema.String,
  ffmpeg_package: Schema.String,
  debian_snapshot: Schema.String,
  ffmpeg_version: Schema.String,
});

export function validateImageIdentity(
  identity: Schema.Schema.Type<typeof ImageIdentity>,
  expected: { readonly ffmpegPackage: string; readonly debianSnapshot: string },
) {
  if (!identity.image_id.startsWith("sha256:")) {
    throw new Error(`image id is not a content digest: ${identity.image_id}`);
  }
  if (identity.ffmpeg_package !== expected.ffmpegPackage) {
    throw new Error(
      `image FFmpeg package ${identity.ffmpeg_package} did not equal the pinned ${expected.ffmpegPackage}`,
    );
  }
  if (identity.debian_snapshot !== expected.debianSnapshot) {
    throw new Error(
      `image package snapshot ${identity.debian_snapshot} did not equal the pinned ${expected.debianSnapshot}`,
    );
  }
  return identity;
}

export async function buildPinnedImage(repositoryRoot: string) {
  await run("docker", [
    "build",
    "--pull=false",
    "--file",
    dockerfilePath,
    "--tag",
    imageName,
    repositoryRoot,
  ]);
  const inspected = await run("docker", ["image", "inspect", imageName, "--format", "{{.Id}}"]);
  const facts = await run("docker", [
    "run",
    "--rm",
    ...isolationArguments(),
    "--entrypoint=/bin/sh",
    imageName,
    "-ec",
    "cat /etc/renderer-image-facts; ffmpeg -version | sed -n '1s/=/_/g;1p' | sed 's/^/ffmpeg_version=/'",
  ]);
  const values = parseKeyValueOutput(facts.stdout);
  return Schema.decodeUnknownSync(ImageIdentity)({
    ...values,
    image_id: inspected.stdout.trim(),
  });
}

/** Proves a later run resolved the same recorded image rather than a rebuilt one. */
export async function confirmRecordedImage(recordedImageId: string) {
  const inspected = await run("docker", ["image", "inspect", imageName, "--format", "{{.Id}}"]);
  const observed = inspected.stdout.trim();
  if (observed !== recordedImageId) {
    throw new Error(`image id ${observed} did not equal the recorded ${recordedImageId}`);
  }
  return observed;
}

/* ------------------------------------------------------------------ *
 * Canonical soundtrack replacement inside the image
 * ------------------------------------------------------------------ */

const CanonicalMasterFacts = Schema.Struct({
  ffmpegVersion: Schema.String,
  copiedPacketPayloadsMatch: Schema.Boolean,
  sourcePacketManifestSha256: Schema.String,
  masterPacketManifestSha256: Schema.String,
  selectedVideoPackets: Schema.Number,
  effectiveDurationMs: Schema.Number,
  masterVideoDurationMs: Schema.Number,
  masterAudioPresentationDurationMs: Schema.Number,
  decodedAudioSamplesPerChannel: Schema.Number,
  audioPresentationSamplesPerChannel: Schema.Number,
  audioPrimingSamplesPerChannel: Schema.Number,
  audioPaddingSamplesPerChannel: Schema.Number,
  targetPcmSamples: Schema.Number,
  paddedPcmSamples: Schema.Number,
  encodedAacPackets: Schema.Number,
  paddedAacFrames: Schema.Number,
  masterMovieTimescale: Schema.Number,
  masterSha256: Schema.String,
});

export function validateCanonicalMasterFacts(
  facts: Schema.Schema.Type<typeof CanonicalMasterFacts>,
) {
  if (!facts.copiedPacketPayloadsMatch) {
    throw new Error("copied video packet payloads changed inside the container image");
  }
  if (facts.sourcePacketManifestSha256 !== facts.masterPacketManifestSha256) {
    throw new Error("selected source and master packet manifests diverged inside the image");
  }
  if (facts.decodedAudioSamplesPerChannel !== facts.paddedPcmSamples) {
    throw new Error(
      `decoded soundtrack samples ${facts.decodedAudioSamplesPerChannel} did not equal the padded ${facts.paddedPcmSamples}`,
    );
  }
  if (facts.audioPaddingSamplesPerChannel !== facts.paddedPcmSamples - facts.targetPcmSamples) {
    throw new Error("soundtrack padding accounting is inconsistent");
  }
  if (facts.encodedAacPackets !== facts.paddedAacFrames + 1) {
    throw new Error(
      `encoded AAC packets ${facts.encodedAacPackets} did not equal the padded frames plus one priming frame`,
    );
  }
  if (facts.masterMovieTimescale !== 48_000) {
    throw new Error(`master movie timescale ${facts.masterMovieTimescale} was not the audio rate`);
  }
  return facts;
}

/**
 * Runs the accepted canonical-replacement recipe inside the pinned image, using
 * the same module the host evidence uses. The repository is mounted read-only so
 * the container cannot alter the recipe it is proving.
 */
export async function runCanonicalReplacementInImage(repositoryRoot: string) {
  const outcome = await run("docker", [
    "run",
    "--rm",
    ...isolationArguments(),
    "--volume",
    `${repositoryRoot}:/repo:ro`,
    "--workdir",
    "/repo",
    "--entrypoint=/usr/local/bin/bun",
    imageName,
    "scripts/video-master-renderer-ffmpeg-evidence.ts",
  ]);
  const parsed: unknown = JSON.parse(outcome.stdout);
  return validateCanonicalMasterFacts(Schema.decodeUnknownSync(CanonicalMasterFacts)(parsed));
}

/* ------------------------------------------------------------------ *
 * Sustained concurrent encoding overlap
 * ------------------------------------------------------------------ */

function encodeCommand(frequency: number, output: string): string {
  return [
    "ffmpeg -hide_banner -loglevel error -y",
    "-f lavfi -i testsrc2=size=640x360:rate=30:duration=4",
    `-f lavfi -i sine=frequency=${frequency}:sample_rate=48000:duration=4`,
    "-filter_threads 1 -threads 2",
    "-map 0:v:0 -map 1:a:0 -c:v libx264 -preset medium -pix_fmt yuv420p",
    "-r 30 -g 30 -bf 0 -c:a aac -ar 48000 -ac 2 -movflags +faststart",
    output,
  ].join(" ");
}

const shellScript = (lines: readonly string[]): string => lines.join("\n");

// Samples /proc for both encoders on a fixed interval. Overlap is only counted
// when both processes are running and both accumulated CPU time since the
// previous sample, so a pair that merely exists at one instant is not overlap.
// The script is assembled from plain lines because its shell parameter
// expansions must not be read as template interpolation.
const overlapScript = shellScript([
  `${encodeCommand(880, "/tmp/first.mp4")} >/tmp/first.log 2>&1 &`,
  "first_pid=$!",
  `${encodeCommand(990, "/tmp/second.mp4")} >/tmp/second.log 2>&1 &`,
  "second_pid=$!",
  "",
  "samples=0",
  "both_running=0",
  "both_busy=0",
  "overlap_ms=0",
  "prev_first=-1",
  "prev_second=-1",
  "prev_ms=-1",
  "",
  "while :; do",
  "  first_state=X",
  "  second_state=X",
  "  first_cpu=-1",
  "  second_cpu=-1",
  "  if read -r _ _ first_state _ _ _ _ _ _ _ _ _ _ fu fs _ < /proc/$first_pid/stat 2>/dev/null; then",
  "    first_cpu=$((fu + fs))",
  "  fi",
  "  if read -r _ _ second_state _ _ _ _ _ _ _ _ _ _ su ss _ < /proc/$second_pid/stat 2>/dev/null; then",
  "    second_cpu=$((su + ss))",
  "  fi",
  "  IFS='. ' read -r up_seconds up_fraction _ < /proc/uptime",
  "  up_fraction=${up_fraction#0}",
  "  now_ms=$((up_seconds * 1000 + ${up_fraction:-0} * 10))",
  "",
  "  first_live=0",
  "  second_live=0",
  '  [ "$first_state" != X ] && [ "$first_state" != Z ] && first_live=1',
  '  [ "$second_state" != X ] && [ "$second_state" != Z ] && second_live=1',
  '  if [ "$first_live" = 0 ] && [ "$second_live" = 0 ]; then break; fi',
  "",
  "  samples=$((samples + 1))",
  '  if [ "$first_live" = 1 ] && [ "$second_live" = 1 ]; then',
  "    both_running=$((both_running + 1))",
  '    if [ "$prev_first" -ge 0 ] && [ "$first_cpu" -gt "$prev_first" ] && [ "$second_cpu" -gt "$prev_second" ]; then',
  "      both_busy=$((both_busy + 1))",
  "      overlap_ms=$((overlap_ms + now_ms - prev_ms))",
  "    fi",
  "  fi",
  "  prev_first=$first_cpu",
  "  prev_second=$second_cpu",
  "  prev_ms=$now_ms",
  `  sleep ${overlapSampleIntervalMs / 1_000}`,
  "done",
  "",
  'wait "$first_pid"',
  "first_exit=$?",
  'wait "$second_pid"',
  "second_exit=$?",
  "",
  "first_duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/first.mp4)",
  "second_duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/second.mp4)",
  "",
  "printf 'samples=%s\\n' \"$samples\"",
  "printf 'both_running_samples=%s\\n' \"$both_running\"",
  "printf 'both_busy_samples=%s\\n' \"$both_busy\"",
  "printf 'overlap_ms=%s\\n' \"$overlap_ms\"",
  "printf 'first_exit=%s\\n' \"$first_exit\"",
  "printf 'second_exit=%s\\n' \"$second_exit\"",
  "printf 'memory_peak=%s\\n' \"$(cat /sys/fs/cgroup/memory.peak)\"",
  "printf 'pids_peak=%s\\n' \"$(cat /sys/fs/cgroup/pids.peak)\"",
  "printf 'cpu_max=%s\\n' \"$(cat /sys/fs/cgroup/cpu.max)\"",
  "printf 'memory_max=%s\\n' \"$(cat /sys/fs/cgroup/memory.max)\"",
  "printf 'pids_max=%s\\n' \"$(cat /sys/fs/cgroup/pids.max)\"",
  'printf \'first_duration_ms=%s\\n\' "$(awk -v d="$first_duration" \'BEGIN { printf "%.0f", d * 1000 }\')"',
  'printf \'second_duration_ms=%s\\n\' "$(awk -v d="$second_duration" \'BEGIN { printf "%.0f", d * 1000 }\')"',
]);

const OverlapFacts = Schema.Struct({
  samples: Schema.Number,
  both_running_samples: Schema.Number,
  both_busy_samples: Schema.Number,
  overlap_ms: Schema.Number,
  first_exit: Schema.Number,
  second_exit: Schema.Number,
  memory_peak: Schema.Number,
  pids_peak: Schema.Number,
  cpu_max: Schema.String,
  memory_max: Schema.Number,
  pids_max: Schema.Number,
  first_duration_ms: Schema.Number,
  second_duration_ms: Schema.Number,
});

export function decodeOverlapFacts(output: string) {
  const values = parseKeyValueOutput(output);
  return Schema.decodeUnknownSync(OverlapFacts)({
    ...values,
    samples: Number(values.samples),
    both_running_samples: Number(values.both_running_samples),
    both_busy_samples: Number(values.both_busy_samples),
    overlap_ms: Number(values.overlap_ms),
    first_exit: Number(values.first_exit),
    second_exit: Number(values.second_exit),
    memory_peak: Number(values.memory_peak),
    pids_peak: Number(values.pids_peak),
    memory_max: Number(values.memory_max),
    pids_max: Number(values.pids_max),
    first_duration_ms: Number(values.first_duration_ms),
    second_duration_ms: Number(values.second_duration_ms),
  });
}

export function validateOverlapFacts(facts: Schema.Schema.Type<typeof OverlapFacts>) {
  if (facts.first_exit !== 0 || facts.second_exit !== 0) {
    throw new Error(
      `concurrent renders did not both succeed: ${facts.first_exit} and ${facts.second_exit}`,
    );
  }
  if (facts.both_busy_samples < 2) {
    throw new Error(
      `sustained overlap requires at least two consecutive busy samples, observed ${facts.both_busy_samples}`,
    );
  }
  if (facts.overlap_ms < overlapSampleIntervalMs * 2) {
    throw new Error(`measured encoding overlap ${facts.overlap_ms}ms was not sustained`);
  }
  if (facts.memory_peak > facts.memory_max) {
    throw new Error("observed memory peak exceeded the cgroup maximum");
  }
  if (facts.pids_peak > facts.pids_max) {
    throw new Error("observed PID peak exceeded the cgroup maximum");
  }
  if (facts.cpu_max !== "100000 100000") {
    throw new Error(`container cpu.max was not one CPU: ${facts.cpu_max}`);
  }
  if (facts.first_duration_ms !== 4_000 || facts.second_duration_ms !== 4_000) {
    throw new Error("one or more concurrent renders produced an unexpected duration");
  }
  return facts;
}

export async function runSustainedOverlapEvidence() {
  const outcome = await run("docker", [
    "run",
    "--rm",
    ...isolationArguments(),
    "--entrypoint=/bin/sh",
    imageName,
    "-ec",
    overlapScript,
  ]);
  return validateOverlapFacts(decodeOverlapFacts(outcome.stdout));
}

/* ------------------------------------------------------------------ *
 * Retained enforcement drills
 * ------------------------------------------------------------------ */

export type RetainedContainerState = {
  readonly containerName: string;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly logs: string;
};

/**
 * Runs a drill in a container that is deliberately not removed on exit, so its
 * logs and inspected state survive the failure and the cause stays attributable.
 */
async function runRetainedDrill(
  containerName: string,
  runArguments: readonly string[],
): Promise<RetainedContainerState> {
  await spawnProcess("docker", ["rm", "--force", containerName]);
  const outcome = await spawnProcess("docker", ["run", "--name", containerName, ...runArguments]);
  const inspected = await run("docker", [
    "inspect",
    containerName,
    "--format",
    "{{.State.ExitCode}} {{.State.OOMKilled}}",
  ]);
  const [exitCode, oomKilled] = inspected.stdout.trim().split(" ");
  const logs = `${outcome.stdout}${outcome.stderr}`;
  return {
    containerName,
    exitCode: Number(exitCode),
    oomKilled: oomKilled === "true",
    logs,
  };
}

export async function removeRetainedContainer(containerName: string) {
  await spawnProcess("docker", ["rm", "--force", containerName]);
}

const memoryDrillScript = shellScript([
  `dd if=/dev/zero of=/tmp/balloon bs=1M count=${memoryDrillAllocationMib} 2>&1`,
  "printf 'allocation_exit=%s\\n' \"$?\"",
  'while read -r key value; do printf \'memory_event_%s=%s\\n\' "$key" "$value"; done < /sys/fs/cgroup/memory.events',
]);

const MemoryEnforcement = Schema.Struct({
  allocation_exit: Schema.Number,
  memory_event_max: Schema.Number,
  memory_event_oom: Schema.Number,
  memory_event_oom_kill: Schema.Number,
});

export function decodeMemoryEnforcement(output: string) {
  const values = parseKeyValueOutput(output);
  return Schema.decodeUnknownSync(MemoryEnforcement)({
    allocation_exit: Number(values.allocation_exit),
    memory_event_max: Number(values.memory_event_max),
    memory_event_oom: Number(values.memory_event_oom),
    memory_event_oom_kill: Number(values.memory_event_oom_kill),
  });
}

export function validateMemoryEnforcement(
  facts: Schema.Schema.Type<typeof MemoryEnforcement>,
  state: RetainedContainerState,
) {
  if (facts.memory_event_max < 1) {
    throw new Error("the drill never reached the memory ceiling, so nothing was enforced");
  }
  if (facts.memory_event_oom_kill < 1) {
    throw new Error("the memory ceiling was reached but no process was killed");
  }
  if (facts.allocation_exit !== 137) {
    throw new Error(`allocation exited ${facts.allocation_exit} rather than by SIGKILL`);
  }
  if (!state.oomKilled) {
    throw new Error("the retained container state did not record an out-of-memory kill");
  }
  return facts;
}

/** Deliberately exhausts a reduced memory ceiling and keeps the failed container. */
export async function runMemoryEnforcementDrill() {
  const state = await runRetainedDrill("pirate-video-renderer-drill-memory", [
    ...isolationArguments({
      memoryBytes: memoryDrillLimitBytes,
      tmpfsBytes: tmpfsLimitBytes * 2,
    }),
    "--entrypoint=/bin/sh",
    imageName,
    "-c",
    memoryDrillScript,
  ]);
  const facts = validateMemoryEnforcement(decodeMemoryEnforcement(state.logs), state);
  return { facts, state } as const;
}

// The fork storm runs in a subshell so that its own death by "Cannot fork" does
// not take the reporting shell with it. The counters are read with shell
// builtins, which need no further process creation once the ceiling is reached.
const pidDrillScript = shellScript([
  "(",
  "  attempts=0",
  `  while [ $attempts -lt ${pidDrillForkAttempts} ]; do`,
  "    attempts=$((attempts + 1))",
  "    sleep 5 &",
  "  done",
  ") || true",
  'while read -r key value; do printf \'pid_event_%s=%s\\n\' "$key" "$value"; done < /sys/fs/cgroup/pids.events',
  "while read -r value; do printf 'pids_peak=%s\\n' \"$value\"; done < /sys/fs/cgroup/pids.peak",
  'while read -r key value; do printf \'memory_event_%s=%s\\n\' "$key" "$value"; done < /sys/fs/cgroup/memory.events',
]);

const PidEnforcement = Schema.Struct({
  pid_event_max: Schema.Number,
  pids_peak: Schema.Number,
  memory_event_oom_kill: Schema.Number,
});

export function decodePidEnforcement(output: string) {
  const values = parseKeyValueOutput(output);
  return Schema.decodeUnknownSync(PidEnforcement)({
    pid_event_max: Number(values.pid_event_max),
    pids_peak: Number(values.pids_peak),
    memory_event_oom_kill: Number(values.memory_event_oom_kill ?? 0),
  });
}

export function validatePidEnforcement(
  facts: Schema.Schema.Type<typeof PidEnforcement>,
  state: RetainedContainerState,
  configuredLimit: number,
) {
  if (facts.pid_event_max < 1) {
    throw new Error("the drill never reached the PID ceiling, so nothing was enforced");
  }
  if (facts.pids_peak > configuredLimit) {
    throw new Error(`observed PID peak ${facts.pids_peak} exceeded the configured ceiling`);
  }
  if (facts.memory_event_oom_kill !== 0) {
    throw new Error("the PID drill also ran out of memory, so its cause is not attributable");
  }
  if (state.oomKilled) {
    throw new Error("the retained container recorded an out-of-memory kill, not PID exhaustion");
  }
  if (!/Cannot fork|Resource temporarily unavailable/.test(state.logs)) {
    throw new Error("no retained diagnostic attributes the failure to process creation");
  }
  return facts;
}

/** Deliberately exhausts a reduced PID ceiling and keeps the failed container. */
export async function runPidEnforcementDrill() {
  const state = await runRetainedDrill("pirate-video-renderer-drill-pids", [
    ...isolationArguments({ pids: pidDrillLimit }),
    "--entrypoint=/bin/sh",
    imageName,
    "-c",
    pidDrillScript,
  ]);
  const facts = validatePidEnforcement(decodePidEnforcement(state.logs), state, pidDrillLimit);
  return { facts, state } as const;
}

// Reproduces the historical two-concurrent-render failure at a 64 PID ceiling.
// Earlier runs discarded these containers, leaving the cause unestablished; this
// drill retains the FFmpeg diagnostic and the cgroup counters that separate PID
// exhaustion from an out-of-memory kill.
const concurrentPidCeilingScript = shellScript([
  `${encodeCommand(880, "/tmp/first.mp4")} >/tmp/first.log 2>&1 &`,
  "first_pid=$!",
  `${encodeCommand(990, "/tmp/second.mp4")} >/tmp/second.log 2>&1 &`,
  "second_pid=$!",
  'wait "$first_pid"',
  "first_exit=$?",
  'wait "$second_pid"',
  "second_exit=$?",
  "printf 'first_exit=%s\\n' \"$first_exit\"",
  "printf 'second_exit=%s\\n' \"$second_exit\"",
  "while read -r line; do printf 'render_log=%s\\n' \"$line\"; done < /tmp/first.log",
  "while read -r line; do printf 'render_log=%s\\n' \"$line\"; done < /tmp/second.log",
  'while read -r key value; do printf \'pid_event_%s=%s\\n\' "$key" "$value"; done < /sys/fs/cgroup/pids.events',
  "while read -r value; do printf 'pids_peak=%s\\n' \"$value\"; done < /sys/fs/cgroup/pids.peak",
  'while read -r key value; do printf \'memory_event_%s=%s\\n\' "$key" "$value"; done < /sys/fs/cgroup/memory.events',
]);

const ConcurrentPidCeiling = Schema.Struct({
  first_exit: Schema.Number,
  second_exit: Schema.Number,
  pid_event_max: Schema.Number,
  pids_peak: Schema.Number,
  memory_event_oom_kill: Schema.Number,
});

export function decodeConcurrentPidCeiling(output: string) {
  const values = parseKeyValueOutput(output);
  return Schema.decodeUnknownSync(ConcurrentPidCeiling)({
    first_exit: Number(values.first_exit),
    second_exit: Number(values.second_exit),
    pid_event_max: Number(values.pid_event_max),
    pids_peak: Number(values.pids_peak),
    memory_event_oom_kill: Number(values.memory_event_oom_kill ?? 0),
  });
}

export function validateConcurrentPidCeiling(
  facts: Schema.Schema.Type<typeof ConcurrentPidCeiling>,
  state: RetainedContainerState,
  configuredLimit: number,
) {
  if (facts.first_exit === 0 && facts.second_exit === 0) {
    throw new Error("both renders succeeded, so the reduced PID ceiling rejected nothing");
  }
  if (facts.pid_event_max < 1) {
    throw new Error("no PID ceiling event was recorded, so the cause is not attributable");
  }
  if (facts.pids_peak !== configuredLimit) {
    throw new Error(
      `observed PID peak ${facts.pids_peak} did not reach the configured ceiling ${configuredLimit}`,
    );
  }
  if (facts.memory_event_oom_kill !== 0) {
    throw new Error("the drill also ran out of memory, so PID exhaustion is not the sole cause");
  }
  if (state.oomKilled) {
    throw new Error("the retained container recorded an out-of-memory kill, not PID exhaustion");
  }
  if (!/pthread_create\(\) failed: Resource temporarily unavailable/.test(state.logs)) {
    throw new Error("no retained FFmpeg diagnostic attributes the failure to thread creation");
  }
  return facts;
}

/**
 * Runs the concurrent render workload at the historical 64 PID ceiling and keeps
 * the failed container so the rejection stays attributable.
 */
export async function runConcurrentPidCeilingDrill() {
  const state = await runRetainedDrill("pirate-video-renderer-drill-concurrent-pids", [
    ...isolationArguments({ pids: concurrentPidCeilingDrillLimit }),
    "--entrypoint=/bin/sh",
    imageName,
    "-c",
    concurrentPidCeilingScript,
  ]);
  const facts = validateConcurrentPidCeiling(
    decodeConcurrentPidCeiling(state.logs),
    state,
    concurrentPidCeilingDrillLimit,
  );
  return { facts, state } as const;
}

/* ------------------------------------------------------------------ *
 * Read-only root attribution
 * ------------------------------------------------------------------ */

// Writing into a directory the container user owns separates a read-only mount
// from a permission denial: an unprivileged user may write its own directory, so
// EROFS there can only come from the mount.
const readOnlyRootScript = shellScript([
  "printf 'owned_directory_owner=%s\\n' \"$(stat -c '%U' \"$HOME\")\"",
  "printf 'owned_directory_mode=%s\\n' \"$(stat -c '%a' \"$HOME\")\"",
  "printf 'process_user=%s\\n' \"$(id -un)\"",
  'owned_error=$(touch "$HOME/renderer-write-probe" 2>&1 >/dev/null || true)',
  "printf 'owned_directory_error=%s\\n' \"${owned_error##*: }\"",
  "root_error=$(touch /renderer-write-probe 2>&1 >/dev/null || true)",
  "printf 'root_error=%s\\n' \"${root_error##*: }\"",
  "while read -r _ _ _ _ mount options _; do",
  '  if [ "$mount" = / ]; then printf \'root_mount_options=%s\\n\' "$options"; break; fi',
  "done < /proc/self/mountinfo",
]);

const ReadOnlyRootFacts = Schema.Struct({
  owned_directory_owner: Schema.String,
  owned_directory_mode: Schema.String,
  process_user: Schema.String,
  owned_directory_error: Schema.String,
  root_error: Schema.String,
  root_mount_options: Schema.String,
});

export function decodeReadOnlyRootFacts(output: string) {
  return Schema.decodeUnknownSync(ReadOnlyRootFacts)(parseKeyValueOutput(output));
}

export function validateReadOnlyRootFacts(facts: Schema.Schema.Type<typeof ReadOnlyRootFacts>) {
  if (facts.owned_directory_owner !== facts.process_user) {
    throw new Error("the probe directory is not owned by the container user");
  }
  if (!facts.owned_directory_mode.startsWith("7")) {
    throw new Error(
      `the probe directory mode ${facts.owned_directory_mode} does not grant its owner write permission`,
    );
  }
  if (facts.owned_directory_error !== "Read-only file system") {
    throw new Error(
      `writing an owned directory failed as "${facts.owned_directory_error}" rather than by read-only mount`,
    );
  }
  if (facts.root_error !== "Read-only file system") {
    throw new Error(
      `writing the root failed as "${facts.root_error}" rather than by read-only mount`,
    );
  }
  if (!facts.root_mount_options.split(",").includes("ro")) {
    throw new Error(`the root mount is not read-only: ${facts.root_mount_options}`);
  }
  return facts;
}

export async function runReadOnlyRootEvidence() {
  const outcome = await run("docker", [
    "run",
    "--rm",
    ...isolationArguments(),
    "--entrypoint=/bin/sh",
    imageName,
    "-ec",
    readOnlyRootScript,
  ]);
  return validateReadOnlyRootFacts(decodeReadOnlyRootFacts(outcome.stdout));
}

/* ------------------------------------------------------------------ *
 * Aggregate
 * ------------------------------------------------------------------ */

export const pinnedImageExpectation = {
  ffmpegPackage: "7:7.1.5-0+deb13u1",
  debianSnapshot: "20260901T000000Z",
} as const;

export async function runContainerEvidence(repositoryRoot: string) {
  const image = validateImageIdentity(
    await buildPinnedImage(repositoryRoot),
    pinnedImageExpectation,
  );
  const canonicalMaster = await runCanonicalReplacementInImage(repositoryRoot);
  const sustainedOverlap = await runSustainedOverlapEvidence();
  const memory = await runMemoryEnforcementDrill();
  const pids = await runPidEnforcementDrill();
  const concurrentPidCeiling = await runConcurrentPidCeilingDrill();
  const readOnlyRoot = await runReadOnlyRootEvidence();
  const reusedImageId = await confirmRecordedImage(image.image_id);
  await removeRetainedContainer(memory.state.containerName);
  await removeRetainedContainer(pids.state.containerName);
  await removeRetainedContainer(concurrentPidCeiling.state.containerName);
  return {
    image,
    reusedImageId,
    canonicalMaster,
    sustainedOverlap,
    memoryEnforcement: memory.facts,
    memoryRetainedExitCode: memory.state.exitCode,
    memoryRetainedOomKilled: memory.state.oomKilled,
    pidEnforcement: pids.facts,
    pidRetainedExitCode: pids.state.exitCode,
    pidRetainedOomKilled: pids.state.oomKilled,
    pidRetainedDiagnostic: pids.state.logs
      .split("\n")
      .filter((line) => /Cannot fork|Resource temporarily unavailable/.test(line))
      .slice(0, 4),
    concurrentPidCeiling: concurrentPidCeiling.facts,
    concurrentPidCeilingDiagnostic: concurrentPidCeiling.state.logs
      .split("\n")
      .filter((line) => /pthread_create\(\) failed/.test(line))
      .slice(0, 2),
    readOnlyRoot,
  } as const;
}

if (import.meta.main) {
  console.log(JSON.stringify(await runContainerEvidence(process.cwd()), undefined, 2));
}
