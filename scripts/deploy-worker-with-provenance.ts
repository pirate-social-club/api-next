import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export type WorkerDeploymentInput = Readonly<{
  configPath: string;
  environment: string;
  sourceRef: string;
  acceptedMainRef: string;
}>;

export type WorkerDeploymentReceipt = Readonly<{
  schema_version: 1;
  source_sha: string;
  worker_version_id: string;
  environment: string;
  config_path: string;
}>;

type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type CommandRunner = (command: readonly string[], cwd: string) => Promise<CommandResult>;

export type WorkerVersion = Readonly<{
  id: string;
  message: string | null;
}>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionValue(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${args[index]} requires a value`);
  }
  return value;
}

export function parseWorkerDeploymentArgs(args: readonly string[]): WorkerDeploymentInput {
  let configPath: string | null = null;
  let environment: string | null = null;
  let sourceRef = "HEAD";
  const acceptedMainRef = "origin/main";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--config":
        configPath = optionValue(args, index);
        index += 1;
        break;
      case "--env":
        environment = optionValue(args, index);
        index += 1;
        break;
      case "--source-ref":
        sourceRef = optionValue(args, index);
        index += 1;
        break;
      default:
        throw new Error(`unknown deployment argument: ${argument ?? ""}`);
    }
  }

  if (configPath === null) throw new Error("--config is required");
  if (environment === null) throw new Error("--env is required");
  if (!ENVIRONMENT_NAME.test(environment)) throw new Error("--env is invalid");
  return { configPath, environment, sourceRef, acceptedMainRef };
}

export function parseWorkerVersions(source: string): readonly WorkerVersion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("wrangler versions list returned invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("wrangler versions list returned a non-array response");
  }

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const row = object(entry, `wrangler version ${index}`);
    if (typeof row.id !== "string" || row.id.length === 0) {
      throw new Error(`wrangler version ${index} has no id`);
    }
    if (seen.has(row.id)) throw new Error(`wrangler version ${index} repeats an id`);
    seen.add(row.id);

    const annotations = row.annotations === undefined ? {} : object(row.annotations, "annotations");
    const message = annotations["workers/message"];
    if (message !== undefined && typeof message !== "string") {
      throw new Error(`wrangler version ${index} has an invalid message`);
    }
    return { id: row.id, message: message ?? null };
  });
}

export function findDeployedVersion(
  before: readonly WorkerVersion[],
  after: readonly WorkerVersion[],
  expectedMessage: string,
): WorkerVersion {
  const beforeIds = new Set(before.map(({ id }) => id));
  const candidates = after.filter(
    ({ id, message }) => !beforeIds.has(id) && message === expectedMessage,
  );
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? "new Worker version is missing the expected Git provenance"
        : "new Worker version provenance is ambiguous",
    );
  }
  return candidates[0] as WorkerVersion;
}

async function runCommand(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    child.stdout === null ? Promise.resolve("") : new Response(child.stdout).text(),
    child.stderr === null ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

async function requiredOutput(
  runner: CommandRunner,
  command: readonly string[],
  cwd: string,
  label: string,
): Promise<string> {
  const result = await runner(command, cwd);
  if (result.exitCode !== 0) throw new Error(`${label} failed (exit ${result.exitCode})`);
  return result.stdout.trim();
}

function repositoryPath(repositoryRoot: string, inputPath: string): string {
  const absolutePath = resolve(repositoryRoot, inputPath);
  const relativePath = relative(repositoryRoot, absolutePath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("--config must resolve inside the repository");
  }
  return relativePath;
}

export async function verifyDeploymentSource(
  repositoryRoot: string,
  input: WorkerDeploymentInput,
  runner: CommandRunner = runCommand,
): Promise<Readonly<{ sourceSha: string; configPath: string }>> {
  const configPath = repositoryPath(repositoryRoot, input.configPath);
  const sourceSha = await requiredOutput(
    runner,
    ["git", "rev-parse", "--verify", `${input.sourceRef}^{commit}`],
    repositoryRoot,
    "source-ref resolution",
  );
  if (!FULL_GIT_SHA.test(sourceSha))
    throw new Error("source ref did not resolve to a full Git SHA");

  const reachable = await runner(
    ["git", "merge-base", "--is-ancestor", sourceSha, input.acceptedMainRef],
    repositoryRoot,
  );
  if (reachable.exitCode !== 0) {
    throw new Error(
      reachable.exitCode === 1
        ? "source commit is not reachable from accepted main"
        : `accepted-main reachability check failed (exit ${reachable.exitCode})`,
    );
  }

  const tracked = await runner(["git", "diff", "--quiet", sourceSha, "--"], repositoryRoot);
  if (tracked.exitCode !== 0) {
    throw new Error(
      tracked.exitCode === 1
        ? "checkout tree does not match the source commit"
        : `checkout tree check failed (exit ${tracked.exitCode})`,
    );
  }

  const untracked = await requiredOutput(
    runner,
    ["git", "ls-files", "--others", "--exclude-standard"],
    repositoryRoot,
    "untracked-file check",
  );
  if (untracked.length > 0) throw new Error("checkout contains untracked files");

  await requiredOutput(
    runner,
    ["git", "ls-files", "--error-unmatch", "--", configPath],
    repositoryRoot,
    "Wrangler config tracking check",
  );
  return { sourceSha, configPath };
}

function versionsCommand(input: WorkerDeploymentInput, configPath: string): readonly string[] {
  return [
    "bunx",
    "wrangler",
    "versions",
    "list",
    "--env",
    input.environment,
    "--config",
    configPath,
    "--json",
  ];
}

export async function deployWorkerWithProvenance(
  repositoryRoot: string,
  input: WorkerDeploymentInput,
  runner: CommandRunner = runCommand,
  writeDiagnostic: (text: string) => void = (text) => process.stderr.write(text),
): Promise<WorkerDeploymentReceipt> {
  const { sourceSha, configPath } = await verifyDeploymentSource(repositoryRoot, input, runner);
  const message = `git:${sourceSha}`;
  const listCommand = versionsCommand(input, configPath);
  const before = parseWorkerVersions(
    await requiredOutput(runner, listCommand, repositoryRoot, "pre-deploy version listing"),
  );

  const deployed = await runner(
    [
      "bunx",
      "wrangler",
      "deploy",
      "--env",
      input.environment,
      "--config",
      configPath,
      "--message",
      message,
    ],
    repositoryRoot,
  );
  if (deployed.stdout.length > 0) writeDiagnostic(deployed.stdout);
  if (deployed.stderr.length > 0) writeDiagnostic(deployed.stderr);
  if (deployed.exitCode !== 0) {
    throw new Error(`wrangler deploy failed (exit ${deployed.exitCode})`);
  }

  const after = parseWorkerVersions(
    await requiredOutput(runner, listCommand, repositoryRoot, "post-deploy version listing"),
  );
  const version = findDeployedVersion(before, after, message);
  return {
    schema_version: 1,
    source_sha: sourceSha,
    worker_version_id: version.id,
    environment: input.environment,
    config_path: configPath,
  };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const receipt = await deployWorkerWithProvenance(repositoryRoot, parseWorkerDeploymentArgs(args));
  console.log(JSON.stringify(receipt));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Worker deployment failed");
    process.exitCode = 1;
  });
}
