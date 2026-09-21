import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findDeployedVersion,
  parseWorkerVersions,
  type WorkerVersion,
} from "./deploy-worker-with-provenance.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEPLOYED_BASE_SHA = "4335629e1d123bd7a83c86a4d41e263c7f5ef356";
const RELEASE_BRANCH = "release/community-session-production-compatibility";
const CONFIG_PATH = "apps/http-worker/wrangler.jsonc";
const ENVIRONMENT = "production";
const ALLOWED_CHANGED_PATHS = new Set([
  "packages/platform-cf/src/community-creation-repository.pg.test.ts",
  "packages/platform-cf/src/community-creation-repository.ts",
  "packages/platform-cf/src/community-owner-reservation.pg.test.ts",
  "packages/platform-cf/src/community-owner-reservation.ts",
  "scripts/community-session-production-hotfix-deploy.test.ts",
  "scripts/community-session-production-hotfix-deploy.ts",
  "scripts/community-session-sufficiency-hotfix-sql.ts",
  "scripts/community-session-sufficiency-hotfix.pg.test.ts",
  "scripts/community-session-sufficiency-hotfix.test.ts",
  "scripts/community-session-sufficiency-hotfix.ts",
  "scripts/postgres-test-suite-manifest.ts",
]);

export type HotfixDeploymentInput = Readonly<{
  sourceSha: string;
  captureDirectory: string;
  captureManifestSha256: string;
}>;

type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type HotfixCommandRunner = (
  command: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

type Deployment = Readonly<{
  versions: readonly Readonly<{ version_id: string; percentage: number }>[];
}>;

export type HotfixDeploymentReceipt = Readonly<{
  schema_version: 1;
  source_sha: string;
  deployed_base_sha: string;
  previous_worker_version_id: string;
  worker_version_id: string;
  environment: "production";
  config_path: typeof CONFIG_PATH;
  capture_manifest_sha256: string;
}>;

function optionValue(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${args[index]} requires a value`);
  }
  return value;
}

export function parseHotfixDeploymentArgs(args: readonly string[]): HotfixDeploymentInput {
  if (args.length !== 8) throw new Error("invalid hotfix deployment arguments");
  let sourceSha: string | null = null;
  let captureDirectory: string | null = null;
  let captureManifestSha256: string | null = null;
  let confirmation: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = optionValue(args, index);
    switch (argument) {
      case "--source-sha":
        sourceSha = value;
        break;
      case "--capture-directory":
        captureDirectory = value;
        break;
      case "--capture-manifest-sha256":
        captureManifestSha256 = value;
        break;
      case "--confirm":
        confirmation = value;
        break;
      default:
        throw new Error(`unknown hotfix deployment argument: ${argument ?? ""}`);
    }
    index += 1;
  }
  if (sourceSha === null || !FULL_SHA.test(sourceSha)) throw new Error("invalid source SHA");
  if (captureDirectory === null || !isAbsolute(captureDirectory)) {
    throw new Error("capture directory must be absolute");
  }
  if (captureManifestSha256 === null || !SHA256.test(captureManifestSha256)) {
    throw new Error("invalid capture manifest SHA-256");
  }
  if (confirmation !== `deploy-community-session-hotfix:${sourceSha}`) {
    throw new Error("hotfix deployment confirmation mismatch");
  }
  return { sourceSha, captureDirectory, captureManifestSha256 };
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
  runner: HotfixCommandRunner,
  command: readonly string[],
  cwd: string,
  label: string,
): Promise<string> {
  const result = await runner(command, cwd);
  if (result.exitCode !== 0) throw new Error(`${label} failed (exit ${result.exitCode})`);
  return result.stdout.trim();
}

function repositoryPath(repositoryRoot: string, inputPath: string): string {
  const absolute = resolve(repositoryRoot, inputPath);
  const candidate = relative(repositoryRoot, absolute);
  if (candidate.length === 0 || candidate.startsWith("..") || isAbsolute(candidate)) {
    throw new Error("configured path escapes the repository");
  }
  return candidate;
}

function parseDigest(output: string, label: string): string {
  const digest = output.trim().split(/\s+/, 1)[0];
  if (digest === undefined || !SHA256.test(digest)) throw new Error(`${label} is invalid`);
  return digest;
}

export function parseCurrentDeployment(source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("wrangler deployments list returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("wrangler deployments list returned no deployments");
  }
  const current = parsed.at(-1) as Deployment | undefined;
  if (current === undefined || !Array.isArray(current.versions)) {
    throw new Error("current deployment has no versions");
  }
  const serving = current.versions.filter((version) => version.percentage === 100);
  if (serving.length !== 1 || current.versions.length !== 1) {
    throw new Error("current deployment is not a single version at 100 percent");
  }
  const versionId = serving[0]?.version_id;
  if (typeof versionId !== "string" || versionId.length === 0) {
    throw new Error("current deployment version id is invalid");
  }
  return versionId;
}

function assertVersionProvenance(
  versions: readonly WorkerVersion[],
  versionId: string,
  expectedMessage: string,
): void {
  const matching = versions.filter(({ id }) => id === versionId);
  if (matching.length !== 1 || matching[0]?.message !== expectedMessage) {
    throw new Error("serving Worker provenance does not match the approved source");
  }
}

export async function verifyHotfixDeploymentSource(
  repositoryRoot: string,
  input: HotfixDeploymentInput,
  runner: HotfixCommandRunner = runCommand,
): Promise<void> {
  const head = await requiredOutput(runner, ["git", "rev-parse", "HEAD"], repositoryRoot, "HEAD");
  if (head !== input.sourceSha) throw new Error("checkout HEAD does not match approved source SHA");
  const branch = await requiredOutput(
    runner,
    ["git", "branch", "--show-current"],
    repositoryRoot,
    "branch check",
  );
  if (branch !== RELEASE_BRANCH) throw new Error("checkout is not on the approved release branch");
  const base = await requiredOutput(
    runner,
    ["git", "rev-parse", "--verify", `${DEPLOYED_BASE_SHA}^{commit}`],
    repositoryRoot,
    "deployed base check",
  );
  if (base !== DEPLOYED_BASE_SHA) throw new Error("deployed base SHA mismatch");
  const ancestry = await runner(
    ["git", "merge-base", "--is-ancestor", DEPLOYED_BASE_SHA, input.sourceSha],
    repositoryRoot,
  );
  if (ancestry.exitCode !== 0) throw new Error("approved source is not based on deployed source");
  const tracked = await runner(["git", "diff", "--quiet", input.sourceSha, "--"], repositoryRoot);
  if (tracked.exitCode !== 0) throw new Error("checkout tree does not match approved source");
  const untracked = await requiredOutput(
    runner,
    ["git", "ls-files", "--others", "--exclude-standard"],
    repositoryRoot,
    "untracked-file check",
  );
  if (untracked.length > 0) throw new Error("checkout contains untracked files");
  await requiredOutput(
    runner,
    ["git", "ls-files", "--error-unmatch", "--", repositoryPath(repositoryRoot, CONFIG_PATH)],
    repositoryRoot,
    "Wrangler config tracking check",
  );
  const changed = (
    await requiredOutput(
      runner,
      ["git", "diff", "--name-only", DEPLOYED_BASE_SHA, input.sourceSha, "--"],
      repositoryRoot,
      "hotfix path check",
    )
  ).split("\n");
  if (
    changed.length !== ALLOWED_CHANGED_PATHS.size ||
    changed.some((path) => !ALLOWED_CHANGED_PATHS.has(path))
  ) {
    throw new Error("hotfix diff does not match the approved path set");
  }

  const captureDirectory = await requiredOutput(
    runner,
    ["realpath", "--canonicalize-existing", input.captureDirectory],
    repositoryRoot,
    "capture path check",
  );
  const manifestDigest = parseDigest(
    await requiredOutput(
      runner,
      ["sha256sum", "MANIFEST.sha256"],
      captureDirectory,
      "capture manifest digest",
    ),
    "capture manifest digest",
  );
  if (manifestDigest !== input.captureManifestSha256) {
    throw new Error("capture manifest digest does not match approval");
  }
  await requiredOutput(
    runner,
    ["sha256sum", "--check", "MANIFEST.sha256"],
    captureDirectory,
    "capture content verification",
  );
  await requiredOutput(
    runner,
    ["git", "bundle", "verify", "head.bundle"],
    captureDirectory,
    "capture bundle verification",
  );
  const heads = await requiredOutput(
    runner,
    ["git", "bundle", "list-heads", "head.bundle"],
    captureDirectory,
    "capture head check",
  );
  if (heads !== `${input.sourceSha} refs/heads/${RELEASE_BRANCH}`) {
    throw new Error("capture does not contain only the approved release head");
  }
}

function versionsCommand(): readonly string[] {
  return [
    "bunx",
    "wrangler",
    "versions",
    "list",
    "--env",
    ENVIRONMENT,
    "--config",
    CONFIG_PATH,
    "--json",
  ];
}

function deploymentsCommand(): readonly string[] {
  return [
    "bunx",
    "wrangler",
    "deployments",
    "list",
    "--env",
    ENVIRONMENT,
    "--config",
    CONFIG_PATH,
    "--json",
  ];
}

export async function deployCommunitySessionProductionHotfix(
  repositoryRoot: string,
  input: HotfixDeploymentInput,
  runner: HotfixCommandRunner = runCommand,
): Promise<HotfixDeploymentReceipt> {
  await verifyHotfixDeploymentSource(repositoryRoot, input, runner);
  const beforeVersions = parseWorkerVersions(
    await requiredOutput(runner, versionsCommand(), repositoryRoot, "pre-deploy version listing"),
  );
  const previousVersionId = parseCurrentDeployment(
    await requiredOutput(
      runner,
      deploymentsCommand(),
      repositoryRoot,
      "pre-deploy traffic readback",
    ),
  );
  assertVersionProvenance(beforeVersions, previousVersionId, `git:${DEPLOYED_BASE_SHA}`);

  await requiredOutput(
    runner,
    ["bunx", "wrangler", "deploy", "--dry-run", "--env", ENVIRONMENT, "--config", CONFIG_PATH],
    repositoryRoot,
    "production Worker dry run",
  );
  const message = `git:${input.sourceSha}`;
  const deployment = await runner(
    [
      "bunx",
      "wrangler",
      "deploy",
      "--strict",
      "--env",
      ENVIRONMENT,
      "--config",
      CONFIG_PATH,
      "--message",
      message,
    ],
    repositoryRoot,
  );
  if (deployment.exitCode !== 0)
    throw new Error(`wrangler deploy failed (exit ${deployment.exitCode})`);

  const afterVersions = parseWorkerVersions(
    await requiredOutput(runner, versionsCommand(), repositoryRoot, "post-deploy version listing"),
  );
  const version = findDeployedVersion(beforeVersions, afterVersions, message);
  const servingVersionId = parseCurrentDeployment(
    await requiredOutput(
      runner,
      deploymentsCommand(),
      repositoryRoot,
      "post-deploy traffic readback",
    ),
  );
  if (servingVersionId !== version.id)
    throw new Error("new Worker version is not serving at 100 percent");
  assertVersionProvenance(afterVersions, servingVersionId, message);
  return {
    schema_version: 1,
    source_sha: input.sourceSha,
    deployed_base_sha: DEPLOYED_BASE_SHA,
    previous_worker_version_id: previousVersionId,
    worker_version_id: version.id,
    environment: ENVIRONMENT,
    config_path: CONFIG_PATH,
    capture_manifest_sha256: input.captureManifestSha256,
  };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const receipt = await deployCommunitySessionProductionHotfix(
    repositoryRoot,
    parseHotfixDeploymentArgs(args),
  );
  console.log(JSON.stringify(receipt));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "community_session_hotfix_deploy_failed",
    );
    process.exitCode = 1;
  });
}
