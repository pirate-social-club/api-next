import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type HotfixClaimRunner,
  withDurableHotfixClaim,
} from "./community-session-production-hotfix-claim.ts";
import {
  findDeployedVersion,
  parseWorkerVersions,
  type WorkerVersion,
} from "./deploy-worker-with-provenance.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEPLOYED_BASE_SHA = "4335629e1d123bd7a83c86a4d41e263c7f5ef356";
const RELEASE_BRANCH = "release/community-session-production-compatibility";
const CONFIG_PATH = "apps/http-worker/wrangler.jsonc";
const ENVIRONMENT = "production";
const ALLOWED_CHANGED_PATHS = new Set([
  "apps/http-worker/package.json",
  "bun.lock",
  "package.json",
  "packages/platform-cf/src/community-creation-repository.pg.test.ts",
  "packages/platform-cf/src/community-creation-repository.ts",
  "packages/platform-cf/src/community-owner-reservation.pg.test.ts",
  "packages/platform-cf/src/community-owner-reservation.ts",
  "scripts/community-session-production-hotfix-deploy.test.ts",
  "scripts/community-session-production-hotfix-deploy.ts",
  "scripts/community-session-production-hotfix-claim.ts",
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
  claimDirectory: string;
}>;

type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type HotfixCommandRunner = (
  command: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

type Deployment = Readonly<{
  versions: readonly Readonly<{ version_id: string; percentage: number }>[];
}>;

type VersionShare = Readonly<{ versionId: string; percentage: number }>;

export type HotfixUploadReceipt = Readonly<{
  schema_version: 1;
  operation: "upload";
  source_sha: string;
  deployed_base_sha: string;
  previous_worker_version_id: string;
  uploaded_worker_version_id: string;
  environment: "production";
  config_path: typeof CONFIG_PATH;
  capture_manifest_sha256: string;
}>;

export type HotfixPromotionInput = HotfixDeploymentInput &
  Readonly<{
    previousVersionId: string;
    uploadedVersionId: string;
    percentage: 10 | 50 | 100;
  }>;

export type HotfixPromotionReceipt = Readonly<{
  schema_version: 1;
  operation: "promote" | "rollback";
  source_sha: string;
  previous_worker_version_id: string;
  uploaded_worker_version_id: string;
  distribution: readonly VersionShare[];
}>;

function optionValue(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${args[index]} requires a value`);
  }
  return value;
}

export function parseHotfixDeploymentArgs(args: readonly string[]): HotfixDeploymentInput {
  if (args.length !== 10) throw new Error("invalid hotfix deployment arguments");
  let sourceSha: string | null = null;
  let captureDirectory: string | null = null;
  let captureManifestSha256: string | null = null;
  let claimDirectory: string | null = null;
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
      case "--claim-directory":
        claimDirectory = value;
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
  if (claimDirectory === null || !isAbsolute(claimDirectory)) {
    throw new Error("claim directory must be absolute");
  }
  if (confirmation !== `upload-community-session-hotfix:${sourceSha}:${captureManifestSha256}`) {
    throw new Error("hotfix upload confirmation mismatch");
  }
  return { sourceSha, captureDirectory, captureManifestSha256, claimDirectory };
}

function parsedBaseInput(values: Readonly<Record<string, string>>): HotfixDeploymentInput {
  const sourceSha = values.sourceSha;
  const captureDirectory = values.captureDirectory;
  const captureManifestSha256 = values.captureManifestSha256;
  const claimDirectory = values.claimDirectory;
  if (sourceSha === undefined || !FULL_SHA.test(sourceSha)) throw new Error("invalid source SHA");
  if (captureDirectory === undefined || !isAbsolute(captureDirectory)) {
    throw new Error("capture directory must be absolute");
  }
  if (captureManifestSha256 === undefined || !SHA256.test(captureManifestSha256)) {
    throw new Error("invalid capture manifest SHA-256");
  }
  if (claimDirectory === undefined || !isAbsolute(claimDirectory)) {
    throw new Error("claim directory must be absolute");
  }
  return { sourceSha, captureDirectory, captureManifestSha256, claimDirectory };
}

function promotionValues(args: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const argument = args[index];
    const value = optionValue(args, index);
    const key =
      argument === "--source-sha"
        ? "sourceSha"
        : argument === "--capture-directory"
          ? "captureDirectory"
          : argument === "--capture-manifest-sha256"
            ? "captureManifestSha256"
            : argument === "--claim-directory"
              ? "claimDirectory"
              : argument === "--previous-version-id"
                ? "previousVersionId"
                : argument === "--uploaded-version-id"
                  ? "uploadedVersionId"
                  : argument === "--percentage"
                    ? "percentage"
                    : argument === "--confirm"
                      ? "confirmation"
                      : null;
    if (key === null || values[key] !== undefined) {
      throw new Error(`unknown or repeated rollout argument: ${argument ?? ""}`);
    }
    values[key] = value;
  }
  return values;
}

export function parseHotfixPromotionArgs(args: readonly string[]): HotfixPromotionInput {
  if (args.length !== 16) throw new Error("invalid hotfix promotion arguments");
  const values = promotionValues(args);
  const base = parsedBaseInput(values);
  const previousVersionId = values.previousVersionId;
  const uploadedVersionId = values.uploadedVersionId;
  const percentage = Number(values.percentage);
  if (
    previousVersionId === undefined ||
    !VERSION_ID.test(previousVersionId) ||
    uploadedVersionId === undefined ||
    !VERSION_ID.test(uploadedVersionId) ||
    previousVersionId === uploadedVersionId ||
    (percentage !== 10 && percentage !== 50 && percentage !== 100)
  ) {
    throw new Error("invalid hotfix promotion identity");
  }
  if (
    values.confirmation !==
    `promote-community-session-hotfix:${base.sourceSha}:${base.captureManifestSha256}:${previousVersionId}:${uploadedVersionId}:${percentage}`
  ) {
    throw new Error("hotfix promotion confirmation mismatch");
  }
  return { ...base, previousVersionId, uploadedVersionId, percentage };
}

export function parseHotfixRollbackArgs(
  args: readonly string[],
): Omit<HotfixPromotionInput, "percentage"> {
  if (args.length !== 14) throw new Error("invalid hotfix rollback arguments");
  const values = promotionValues(args);
  const base = parsedBaseInput(values);
  const previousVersionId = values.previousVersionId;
  const uploadedVersionId = values.uploadedVersionId;
  if (
    previousVersionId === undefined ||
    !VERSION_ID.test(previousVersionId) ||
    uploadedVersionId === undefined ||
    !VERSION_ID.test(uploadedVersionId) ||
    previousVersionId === uploadedVersionId
  ) {
    throw new Error("invalid hotfix rollback identity");
  }
  if (
    values.confirmation !==
    `rollback-community-session-hotfix:${base.sourceSha}:${base.captureManifestSha256}:${previousVersionId}:${uploadedVersionId}`
  ) {
    throw new Error("hotfix rollback confirmation mismatch");
  }
  return { ...base, previousVersionId, uploadedVersionId };
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

export function parseCurrentDeployment(source: string): readonly VersionShare[] {
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
  const seen = new Set<string>();
  let total = 0;
  const shares = current.versions.map((version) => {
    if (
      typeof version.version_id !== "string" ||
      !VERSION_ID.test(version.version_id) ||
      typeof version.percentage !== "number" ||
      !Number.isFinite(version.percentage) ||
      version.percentage <= 0 ||
      version.percentage > 100 ||
      seen.has(version.version_id)
    ) {
      throw new Error("current deployment distribution is invalid");
    }
    seen.add(version.version_id);
    total += version.percentage;
    return { versionId: version.version_id, percentage: version.percentage };
  });
  if (Math.abs(total - 100) > 0.001) {
    throw new Error("current deployment percentages do not total 100");
  }
  return shares.sort((left, right) => left.versionId.localeCompare(right.versionId));
}

function expectedDistribution(
  previousVersionId: string,
  uploadedVersionId: string,
  percentage: 0 | 10 | 50 | 100,
): readonly VersionShare[] {
  if (percentage === 0) return [{ versionId: previousVersionId, percentage: 100 }];
  if (percentage === 100) return [{ versionId: uploadedVersionId, percentage: 100 }];
  return [
    { versionId: previousVersionId, percentage: 100 - percentage },
    { versionId: uploadedVersionId, percentage },
  ].sort((left, right) => left.versionId.localeCompare(right.versionId));
}

function assertDistribution(
  actual: readonly VersionShare[],
  expected: readonly VersionShare[],
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("serving Worker distribution does not match the approved rollout stage");
  }
}

function assertVersionProvenance(
  versions: readonly WorkerVersion[],
  versionId: string,
  expectedMessage: string,
): void {
  const matchingId = versions.filter(({ id }) => id === versionId);
  const matchingMessage = versions.filter(({ message }) => message === expectedMessage);
  if (
    matchingId.length !== 1 ||
    matchingId[0]?.message !== expectedMessage ||
    matchingMessage.length !== 1 ||
    matchingMessage[0]?.id !== versionId
  ) {
    throw new Error("Worker version provenance is not unique for the approved source");
  }
}

function assertNoCandidateVersion(
  versions: readonly WorkerVersion[],
  expectedMessage: string,
): void {
  if (versions.some(({ message }) => message === expectedMessage)) {
    throw new Error("candidate Worker version already exists; reconcile before another upload");
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
  claimRunner: HotfixClaimRunner = withDurableHotfixClaim,
): Promise<HotfixUploadReceipt> {
  return claimRunner(input.claimDirectory, `upload:${input.sourceSha}`, async () => {
    await verifyHotfixDeploymentSource(repositoryRoot, input, runner);
    const beforeVersions = parseWorkerVersions(
      await requiredOutput(runner, versionsCommand(), repositoryRoot, "pre-upload version listing"),
    );
    const beforeDistribution = parseCurrentDeployment(
      await requiredOutput(
        runner,
        deploymentsCommand(),
        repositoryRoot,
        "pre-upload traffic readback",
      ),
    );
    if (beforeDistribution.length !== 1) {
      throw new Error("hotfix upload requires one prior version at 100 percent");
    }
    const previousVersionId = beforeDistribution[0]?.versionId;
    if (previousVersionId === undefined) throw new Error("prior Worker version is missing");
    assertVersionProvenance(beforeVersions, previousVersionId, `git:${DEPLOYED_BASE_SHA}`);

    const message = `git:${input.sourceSha}`;
    assertNoCandidateVersion(beforeVersions, message);
    await requiredOutput(
      runner,
      [
        "bunx",
        "wrangler",
        "versions",
        "upload",
        "--dry-run",
        "--env",
        ENVIRONMENT,
        "--config",
        CONFIG_PATH,
      ],
      repositoryRoot,
      "production Worker upload dry run",
    );
    const upload = await runner(
      [
        "bunx",
        "wrangler",
        "versions",
        "upload",
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
    if (upload.exitCode !== 0) throw new Error(`wrangler upload failed (exit ${upload.exitCode})`);

    const afterVersions = parseWorkerVersions(
      await requiredOutput(
        runner,
        versionsCommand(),
        repositoryRoot,
        "post-upload version listing",
      ),
    );
    const version = findDeployedVersion(beforeVersions, afterVersions, message);
    assertVersionProvenance(afterVersions, version.id, message);
    const afterDistribution = parseCurrentDeployment(
      await requiredOutput(
        runner,
        deploymentsCommand(),
        repositoryRoot,
        "post-upload traffic readback",
      ),
    );
    assertDistribution(afterDistribution, beforeDistribution);
    return {
      schema_version: 1,
      operation: "upload",
      source_sha: input.sourceSha,
      deployed_base_sha: DEPLOYED_BASE_SHA,
      previous_worker_version_id: previousVersionId,
      uploaded_worker_version_id: version.id,
      environment: ENVIRONMENT,
      config_path: CONFIG_PATH,
      capture_manifest_sha256: input.captureManifestSha256,
    };
  });
}

function rolloutCommand(
  previousVersionId: string,
  uploadedVersionId: string,
  percentage: 0 | 10 | 50 | 100,
  message: string,
): readonly string[] {
  const versions =
    percentage === 0
      ? [`${previousVersionId}@100`]
      : percentage === 100
        ? [`${uploadedVersionId}@100`]
        : [`${previousVersionId}@${100 - percentage}`, `${uploadedVersionId}@${percentage}`];
  return [
    "bunx",
    "wrangler",
    "versions",
    "deploy",
    ...versions,
    "--yes",
    "--env",
    ENVIRONMENT,
    "--config",
    CONFIG_PATH,
    "--message",
    message,
  ];
}

async function verifiedRolloutContext(
  repositoryRoot: string,
  input: Omit<HotfixPromotionInput, "percentage">,
  runner: HotfixCommandRunner,
): Promise<readonly VersionShare[]> {
  await verifyHotfixDeploymentSource(repositoryRoot, input, runner);
  const versions = parseWorkerVersions(
    await requiredOutput(runner, versionsCommand(), repositoryRoot, "rollout version listing"),
  );
  assertVersionProvenance(versions, input.previousVersionId, `git:${DEPLOYED_BASE_SHA}`);
  assertVersionProvenance(versions, input.uploadedVersionId, `git:${input.sourceSha}`);
  return parseCurrentDeployment(
    await requiredOutput(runner, deploymentsCommand(), repositoryRoot, "rollout traffic readback"),
  );
}

export async function promoteCommunitySessionProductionHotfix(
  repositoryRoot: string,
  input: HotfixPromotionInput,
  runner: HotfixCommandRunner = runCommand,
  claimRunner: HotfixClaimRunner = withDurableHotfixClaim,
): Promise<HotfixPromotionReceipt> {
  const identity = `promote:${input.sourceSha}:${input.previousVersionId}:${input.uploadedVersionId}:${input.percentage}`;
  return claimRunner(input.claimDirectory, identity, async () => {
    const current = await verifiedRolloutContext(repositoryRoot, input, runner);
    const priorPercentage = input.percentage === 10 ? 0 : input.percentage === 50 ? 10 : 50;
    assertDistribution(
      current,
      expectedDistribution(input.previousVersionId, input.uploadedVersionId, priorPercentage),
    );
    const promoted = await runner(
      rolloutCommand(
        input.previousVersionId,
        input.uploadedVersionId,
        input.percentage,
        `rollout:git:${input.sourceSha}:${input.percentage}`,
      ),
      repositoryRoot,
    );
    if (promoted.exitCode !== 0) {
      throw new Error(`wrangler rollout failed (exit ${promoted.exitCode})`);
    }
    const distribution = parseCurrentDeployment(
      await requiredOutput(
        runner,
        deploymentsCommand(),
        repositoryRoot,
        "post-rollout traffic readback",
      ),
    );
    assertDistribution(
      distribution,
      expectedDistribution(input.previousVersionId, input.uploadedVersionId, input.percentage),
    );
    return {
      schema_version: 1,
      operation: "promote",
      source_sha: input.sourceSha,
      previous_worker_version_id: input.previousVersionId,
      uploaded_worker_version_id: input.uploadedVersionId,
      distribution,
    };
  });
}

export async function rollbackCommunitySessionProductionHotfix(
  repositoryRoot: string,
  input: Omit<HotfixPromotionInput, "percentage">,
  runner: HotfixCommandRunner = runCommand,
  claimRunner: HotfixClaimRunner = withDurableHotfixClaim,
): Promise<HotfixPromotionReceipt> {
  const identity = `rollback:${input.sourceSha}:${input.previousVersionId}:${input.uploadedVersionId}`;
  return claimRunner(input.claimDirectory, identity, async () => {
    const current = await verifiedRolloutContext(repositoryRoot, input, runner);
    if (
      current.some(
        ({ versionId }) =>
          versionId !== input.previousVersionId && versionId !== input.uploadedVersionId,
      ) ||
      !current.some(({ versionId }) => versionId === input.uploadedVersionId)
    ) {
      throw new Error("rollback refuses an unrelated or already-restored distribution");
    }
    const rollback = await runner(
      rolloutCommand(
        input.previousVersionId,
        input.uploadedVersionId,
        0,
        `rollback:git:${input.sourceSha}:to:${DEPLOYED_BASE_SHA}`,
      ),
      repositoryRoot,
    );
    if (rollback.exitCode !== 0) {
      throw new Error(`wrangler rollback failed (exit ${rollback.exitCode})`);
    }
    const distribution = parseCurrentDeployment(
      await requiredOutput(
        runner,
        deploymentsCommand(),
        repositoryRoot,
        "post-rollback traffic readback",
      ),
    );
    assertDistribution(
      distribution,
      expectedDistribution(input.previousVersionId, input.uploadedVersionId, 0),
    );
    return {
      schema_version: 1,
      operation: "rollback",
      source_sha: input.sourceSha,
      previous_worker_version_id: input.previousVersionId,
      uploaded_worker_version_id: input.uploadedVersionId,
      distribution,
    };
  });
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const operation = args[0];
  const operationArgs = args.slice(1);
  const receipt =
    operation === "upload"
      ? await deployCommunitySessionProductionHotfix(
          repositoryRoot,
          parseHotfixDeploymentArgs(operationArgs),
        )
      : operation === "promote"
        ? await promoteCommunitySessionProductionHotfix(
            repositoryRoot,
            parseHotfixPromotionArgs(operationArgs),
          )
        : operation === "rollback"
          ? await rollbackCommunitySessionProductionHotfix(
              repositoryRoot,
              parseHotfixRollbackArgs(operationArgs),
            )
          : (() => {
              throw new Error("expected upload, promote, or rollback operation");
            })();
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
