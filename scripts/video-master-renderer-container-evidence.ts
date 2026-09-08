import { Schema } from "effect";

const imageName = "pirate-video-renderer-evidence:local";
const cpuLimit = 1;
const memoryLimitBytes = 384 * 1_024 * 1_024;
const pidLimit = 128;
const tmpfsLimitBytes = 512 * 1_024 * 1_024;

const ContainerFacts = Schema.Struct({
  ffmpeg_version: Schema.String,
  ffmpeg_package: Schema.String,
  cpu_max: Schema.String,
  memory_max: Schema.Number,
  memory_peak: Schema.Number,
  pids_max: Schema.Number,
  concurrent_overlap: Schema.Literal("true"),
  first_duration_ms: Schema.Number,
  second_duration_ms: Schema.Number,
  root_read_only: Schema.Literal("true"),
});

type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
};

async function run(command: string, arguments_: readonly string[]): Promise<RunResult> {
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
  if (exitCode !== 0) {
    throw new Error(`${command} failed with exit ${exitCode}: ${stderr.trim()}`);
  }
  return { stdout, stderr };
}

function parseKeyValueOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`invalid evidence line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function containerRunArguments(): readonly string[] {
  return [
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    `--cpus=${cpuLimit}`,
    `--memory=${memoryLimitBytes}`,
    `--memory-swap=${memoryLimitBytes}`,
    `--pids-limit=${pidLimit}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,size=${tmpfsLimitBytes}`,
    "--entrypoint=/bin/sh",
    imageName,
    "-ec",
    containerEvidenceScript,
  ] as const;
}

const containerEvidenceScript = String.raw`
root_read_only=false
if ! touch /renderer-root-write-test 2>/dev/null; then root_read_only=true; fi

ffmpeg -hide_banner -loglevel error -y -f lavfi \
  -i testsrc2=size=640x360:rate=30:duration=4 \
  -f lavfi -i sine=frequency=880:sample_rate=48000:duration=4 \
  -filter_threads 1 -threads 2 \
  -map 0:v:0 -map 1:a:0 -c:v libx264 -preset medium -pix_fmt yuv420p \
  -r 30 -g 30 -bf 0 -c:a aac -ar 48000 -ac 2 -movflags +faststart \
  /tmp/first.mp4 >/tmp/first.log 2>&1 &
first_pid=$!
ffmpeg -hide_banner -loglevel error -y -f lavfi \
  -i testsrc2=size=640x360:rate=30:duration=4 \
  -f lavfi -i sine=frequency=990:sample_rate=48000:duration=4 \
  -filter_threads 1 -threads 2 \
  -map 0:v:0 -map 1:a:0 -c:v libx264 -preset medium -pix_fmt yuv420p \
  -r 30 -g 30 -bf 0 -c:a aac -ar 48000 -ac 2 -movflags +faststart \
  /tmp/second.mp4 >/tmp/second.log 2>&1 &
second_pid=$!

concurrent_overlap=false
if kill -0 "$first_pid" 2>/dev/null && kill -0 "$second_pid" 2>/dev/null; then
  concurrent_overlap=true
fi
wait "$first_pid"
wait "$second_pid"

first_duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/first.mp4)
second_duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/second.mp4)
ffmpeg_version=$(ffmpeg -version | sed -n '1s/=/_/g;1p')
ffmpeg_package=$(dpkg-query -W -f='${"$"}{Version}' ffmpeg)

printf 'ffmpeg_version=%s\n' "$ffmpeg_version"
printf 'ffmpeg_package=%s\n' "$ffmpeg_package"
printf 'cpu_max=%s\n' "$(cat /sys/fs/cgroup/cpu.max)"
printf 'memory_max=%s\n' "$(cat /sys/fs/cgroup/memory.max)"
printf 'memory_peak=%s\n' "$(cat /sys/fs/cgroup/memory.peak)"
printf 'pids_max=%s\n' "$(cat /sys/fs/cgroup/pids.max)"
printf 'concurrent_overlap=%s\n' "$concurrent_overlap"
printf 'first_duration_ms=%s\n' "$(awk -v duration="$first_duration" 'BEGIN { printf "%.0f", duration * 1000 }')"
printf 'second_duration_ms=%s\n' "$(awk -v duration="$second_duration" 'BEGIN { printf "%.0f", duration * 1000 }')"
printf 'root_read_only=%s\n' "$root_read_only"
`;

export function decodeContainerFacts(output: string) {
  const values = parseKeyValueOutput(output);
  return Schema.decodeUnknownSync(ContainerFacts)({
    ...values,
    memory_max: Number(values.memory_max),
    memory_peak: Number(values.memory_peak),
    pids_max: Number(values.pids_max),
    first_duration_ms: Number(values.first_duration_ms),
    second_duration_ms: Number(values.second_duration_ms),
  });
}

export function validateContainerFacts(facts: Schema.Schema.Type<typeof ContainerFacts>) {
  if (facts.memory_max !== memoryLimitBytes) {
    throw new Error(`container memory.max ${facts.memory_max} did not equal ${memoryLimitBytes}`);
  }
  if (facts.memory_peak > facts.memory_max) {
    throw new Error("container memory peak exceeded the cgroup maximum");
  }
  if (facts.pids_max !== pidLimit) {
    throw new Error(`container pids.max ${facts.pids_max} did not equal ${pidLimit}`);
  }
  if (facts.cpu_max !== "100000 100000") {
    throw new Error(`container cpu.max was not one CPU: ${facts.cpu_max}`);
  }
  if (facts.first_duration_ms !== 4_000 || facts.second_duration_ms !== 4_000) {
    throw new Error("one or more concurrent renders produced an unexpected duration");
  }
  return facts;
}

export async function runContainerEvidence(repositoryRoot: string) {
  await run("docker", [
    "build",
    "--pull=false",
    "--file",
    "scripts/video-master-renderer-container.Dockerfile",
    "--tag",
    imageName,
    repositoryRoot,
  ]);
  const outcome = await run("docker", containerRunArguments());
  return validateContainerFacts(decodeContainerFacts(outcome.stdout));
}

if (import.meta.main) {
  const facts = await runContainerEvidence(process.cwd());
  console.log(JSON.stringify(facts, undefined, 2));
}
