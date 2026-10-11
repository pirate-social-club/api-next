import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HNS_STAGING_MANIFEST_COMMAND,
  readHnsStagingGatewayPin,
  verifyHnsStagingGatewayManifest,
} from "./hns-staging-gateway-preflight.ts";
import { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";
import {
  type PrepareStagingBindingGuard,
  prepareStagingBindingGuard,
} from "./staging-serving-bindings-preflight.ts";
import { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";
import type { BindingDriftReceipt } from "./worker-binding-drift.ts";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export type WorkerDeploymentInput = Readonly<{
  configPath: string;
  environment: string;
  sourceRef: string;
  acceptedMainRef: string;
  bindingReviewPath?: string;
  repositoryRoot?: string;
  toolingSourceRef?: string;
}>;

export type WorkerDeploymentReceipt = Readonly<{
  schema_version: 1;
  source_sha: string;
  worker_version_id: string;
  environment: string;
  config_path: string;
  staging_binding_preflight?: BindingDriftReceipt;
}>;

type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type CommandRunner = (
  command: readonly string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandResult>;

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
  let bindingReviewPath: string | undefined;
  let repositoryRoot: string | undefined;
  let toolingSourceRef: string | undefined;
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
      case "--tooling-source-ref":
        toolingSourceRef = optionValue(args, index);
        if (!FULL_GIT_SHA.test(toolingSourceRef))
          throw Error("--tooling-source-ref must be a full Git SHA");
        index += 1;
        break;
      case "--repository-root":
        repositoryRoot = optionValue(args, index);
        if (!isAbsolute(repositoryRoot)) throw Error("--repository-root must be absolute");
        index += 1;
        break;
      case "--binding-review":
        bindingReviewPath = optionValue(args, index);
        index += 1;
        break;
      default:
        throw new Error(`unknown deployment argument: ${argument ?? ""}`);
    }
  }

  if (configPath === null) throw new Error("--config is required");
  if (environment === null) throw new Error("--env is required");
  if (!ENVIRONMENT_NAME.test(environment)) throw new Error("--env is invalid");
  if (bindingReviewPath !== undefined && environment !== "staging")
    throw new Error("--binding-review applies only to staging");
  return {
    configPath,
    environment,
    sourceRef,
    acceptedMainRef,
    ...(bindingReviewPath === undefined ? {} : { bindingReviewPath }),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(toolingSourceRef === undefined ? {} : { toolingSourceRef }),
  };
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

/**
 * The managed `CLOUDFLARE_API_TOKEN` is a read-scoped staging diagnostics
 * credential (docs/api-next/secrets-contract.md), not deployment authority.
 * Wrangler prefers it over the operator's approved login, so a deploy started
 * inside the secret runner reads successfully and then fails its upload with
 * 403. Deployment Wrangler children therefore never inherit it; the shared
 * read-only runner retains its original diagnostics environment.
 */
export function commandEnvironment(
  command: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const child = { ...environment };
  if (command[0] === "bunx" && command[1] === "wrangler") delete child.CLOUDFLARE_API_TOKEN;
  return child;
}

export async function runCommand(
  command: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CommandResult> {
  if (signal?.aborted) throw Error("deployment command interrupted");
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const [stdout, stderr] = await Promise.all([
    child.stdout === null ? Promise.resolve("") : new Response(child.stdout).text(),
    child.stderr === null ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  signal?.removeEventListener("abort", abort);
  if (signal?.aborted) throw Error("deployment command interrupted");
  return { exitCode, stdout, stderr };
}

/** Use one deployment credential for provider preflight, upload and readback. */
export function runDeploymentCommand(
  command: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CommandResult> {
  return runCommand(command, cwd, signal, commandEnvironment(command, environment));
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
  runner: CommandRunner = runDeploymentCommand,
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
  runner: CommandRunner = runDeploymentCommand,
  writeDiagnostic: (text: string) => void = (text) => process.stderr.write(text),
  readStagingGatewayPin: (root: string) => Promise<unknown> = readHnsStagingGatewayPin,
  rewardDeploymentGuard: typeof withRewardsBindingDeployment = withRewardsBindingDeployment,
  stagingBindingGuard: PrepareStagingBindingGuard = prepareStagingBindingGuard,
  telegramDeploymentGuard: typeof withTelegramActivationDeployment = withTelegramActivationDeployment,
): Promise<WorkerDeploymentReceipt> {
  const { sourceSha, configPath } = await verifyDeploymentSource(repositoryRoot, input, runner);
  const guardedHnsStagingHttp =
    configPath === "apps/http-worker/wrangler.jsonc" && input.environment === "staging";
  const solidRoot = resolve(repositoryRoot, "../pirate-web-solid");
  if (guardedHnsStagingHttp) {
    const manifestRead = await runner(HNS_STAGING_MANIFEST_COMMAND, repositoryRoot);
    if (manifestRead.exitCode !== 0)
      throw new Error("staging HNS gateway read failed before HTTP deploy");
    verifyHnsStagingGatewayManifest(
      manifestRead.stdout,
      await readStagingGatewayPin(repositoryRoot),
    );
    const solidCheck = await runner(
      ["node", "scripts/hns-staging-gateway-preflight.mjs"],
      solidRoot,
    );
    if (solidCheck.exitCode !== 0)
      throw new Error("staging Solid ingress preflight failed before HTTP deploy");
  }
  const message = `git:${sourceSha}`;
  const listCommand = versionsCommand(input, configPath);
  const before = parseWorkerVersions(
    await requiredOutput(runner, listCommand, repositoryRoot, "pre-deploy version listing"),
  );
  const bindingGuard = await stagingBindingGuard(
    repositoryRoot,
    {
      source_sha: sourceSha,
      config_path: configPath,
      environment: input.environment,
    },
    runner,
    input.bindingReviewPath,
    writeDiagnostic,
  );

  const deployed = await telegramDeploymentGuard(
    repositoryRoot,
    configPath,
    input.environment,
    () =>
      rewardDeploymentGuard(repositoryRoot, configPath, input.environment, async (signal) => {
        if (bindingGuard !== null) {
          await bindingGuard.recheck();
          const current = await verifyDeploymentSource(repositoryRoot, input, runner);
          if (current.sourceSha !== sourceSha)
            throw Error("deployment source changed before upload");
        }
        if (signal?.aborted) throw Error("reward shutdown control connection lost before deploy");
        return runner(
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
            ...(bindingGuard?.telegramConfig === undefined
              ? []
              : ["--var", `TELEGRAM_CONFIG_JSON:${bindingGuard.telegramConfig}`]),
          ],
          repositoryRoot,
          signal,
        );
      }),
    bindingGuard?.telegramConfig,
    async () => {
      // Run schema admission from the exact deployment source, including older accepted releases.
      const result = await runner(
        ["bun", "scripts/telegram-activation-preflight.ts"],
        repositoryRoot,
        AbortSignal.timeout(30_000),
      );
      if (result.exitCode !== 0) throw Error("Telegram serving-role admission refused");
    },
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
  if (guardedHnsStagingHttp) {
    const serving = await runner(["bun", "run", "check:staging:hns-route"], solidRoot);
    if (serving.exitCode !== 0) {
      throw new Error(
        `staging HNS serving check failed after HTTP deploy (exit ${serving.exitCode})`,
      );
    }
    if (serving.stdout.length > 0) writeDiagnostic(serving.stdout);
  }
  return {
    schema_version: 1,
    source_sha: sourceSha,
    worker_version_id: version.id,
    environment: input.environment,
    config_path: configPath,
    ...(bindingGuard === null ? {} : { staging_binding_preflight: bindingGuard.receipt }),
  };
}

/** Separate accepted tooling from an exact older accepted deployment checkout. */
export async function resolveDeploymentRepository(
  input: WorkerDeploymentInput,
  runner: CommandRunner = runDeploymentCommand,
  toolingRoot = fileURLToPath(new URL("../", import.meta.url)),
): Promise<string> {
  const target = input.repositoryRoot === undefined ? toolingRoot : resolve(input.repositoryRoot);
  if (target === resolve(toolingRoot)) return target;
  if (input.environment !== "staging")
    throw Error("external deployment checkout applies only to staging");
  await verifyDeploymentSource(
    toolingRoot,
    { ...input, sourceRef: input.toolingSourceRef ?? input.acceptedMainRef },
    runner,
  );
  const command = ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"];
  const toolGit = await requiredOutput(runner, command, toolingRoot, "tooling repository identity");
  const targetGit = await requiredOutput(runner, command, target, "deployment repository identity");
  if (toolGit !== targetGit) throw Error("deployment checkout must share the tooling repository");
  return target;
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const input = parseWorkerDeploymentArgs(args);
  const repositoryRoot = await resolveDeploymentRepository(input);
  const receipt = await deployWorkerWithProvenance(repositoryRoot, input);
  console.log(JSON.stringify(receipt));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Worker deployment failed");
    process.exitCode = 1;
  });
}
