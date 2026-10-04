import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { deployWorkerWithProvenance } from "./deploy-worker-with-provenance.ts";
import { verifyNodeForgeRemediation } from "./node-forge-remediation.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const baseline = "1cdaa010a494e8af37426142f6ed2dad93ff1225";
export const releaseBranch = "release/hns-ownership-only-production";
export const hyperdrive = "0c215865d7994c92b940d905f54ece37";
const workers = [
  "http-worker",
  "hns-owner-verifier",
  "jobs-worker",
  "media-processor-worker",
  "data-registration-worker",
];
const paths = new Set([
  "docs/rewards-deployment-lifecycle.json",
  "bun.lock",
  "package.json",
  "patches/README.md",
  "patches/node-forge@1.4.0.patch",
  "patches/node-forge-sdk-rsa-validation.patch",
  "scripts/check-deps.test.ts",
  "scripts/dependency-audit.ts",
  "scripts/node-forge-remediation.ts",
  "scripts/node-forge-remediation.test.ts",
  "scripts/production-song-infrastructure-invariant.test.ts",
  "packages/platform-cf/config/config.test.ts",
  "scripts/deploy-hns-pinned-production.mjs",
  "scripts/deploy-hns-pinned-production.test.mjs",
  ...workers.map((worker) => `apps/${worker}/wrangler.jsonc`),
]);
function refuse(reason) {
  throw new Error(`hns_pinned_api_deploy_refused:${reason}`);
}
function command(program, args) {
  return execFileSync(program, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function validatePinnedSource({
  receipt,
  sha,
  branch,
  advertisedSha,
  baselineSha,
  changedPaths,
}) {
  if (
    receipt?.version !== 1 ||
    receipt.task !== "hns-production-api-security-backport" ||
    receipt.baselineSha !== baseline ||
    receipt.sourceSha !== sha ||
    receipt.hyperdriveId !== hyperdrive ||
    !/^[0-9a-f]{40}$/u.test(sha)
  )
    refuse("invalid_source_receipt");
  if (branch !== releaseBranch || advertisedSha !== sha || baselineSha !== baseline)
    refuse("source_not_published");
  if (changedPaths.some((path) => !paths.has(path))) refuse("ownership_only_scope_changed");
}
export function validateProductionConfig(candidate, before) {
  const copy = structuredClone(candidate);
  if (
    copy.env?.production?.hyperdrive?.length !== 1 ||
    copy.env.production.hyperdrive[0].id !== hyperdrive
  )
    refuse("wrong_production_database");
  copy.env.production.hyperdrive[0].id = before.env.production.hyperdrive[0].id;
  if (JSON.stringify(copy) !== JSON.stringify(before)) refuse("unrelated_configuration_changed");
}
export function validateDependencies(candidate, before, lock = false) {
  const copy = structuredClone(candidate);
  const dev = lock ? copy.workspaces[""].devDependencies : copy.devDependencies;
  const originalDev = lock ? before.workspaces[""].devDependencies : before.devDependencies;
  if (
    dev["@types/node-forge"] !== "1.3.14" ||
    JSON.stringify(copy.patchedDependencies) !==
      JSON.stringify({
        "node-forge@1.4.0": "patches/node-forge@1.4.0.patch",
        "node-forge@github:remicolin/forge#17a11a6": "patches/node-forge-sdk-rsa-validation.patch",
      })
  )
    refuse("dependency_remediation_changed");
  delete copy.patchedDependencies;
  if (Object.hasOwn(originalDev, "@types/node-forge"))
    dev["@types/node-forge"] = originalDev["@types/node-forge"];
  else delete dev["@types/node-forge"];
  if (JSON.stringify(copy) !== JSON.stringify(before)) refuse("unrelated_dependencies_changed");
}
export function validateRewardsPolicy(candidate, before) {
  const expected = structuredClone(before);
  expected.environments.production = expected.environments.prod;
  delete expected.environments.prod;
  if (JSON.stringify(candidate) !== JSON.stringify(expected)) refuse("rewards_lifecycle_changed");
}
export async function main(args = Bun.argv.slice(2)) {
  const execute = args.includes("--execute");
  const options = args.filter((value) => value !== "--execute");
  if (
    options.length !== 4 ||
    options[0] !== "--worker" ||
    !workers.includes(options[1]) ||
    options[2] !== "--receipt" ||
    !isAbsolute(options[3]) ||
    args.filter((value) => value === "--execute").length > 1
  )
    refuse("invalid_arguments");
  const receipt = JSON.parse(await Bun.file(options[3]).text());
  if (command("git", ["status", "--porcelain"])) refuse("dirty_source");
  if (
    command("git", ["remote", "get-url", "origin"]) !==
    "https://github.com/pirate-social-club/api-next.git"
  )
    refuse("unexpected_origin");
  const sha = command("git", ["rev-parse", "HEAD"]);
  const acceptedRef = `origin/${releaseBranch}`;
  validatePinnedSource({
    receipt,
    sha,
    branch: command("git", ["branch", "--show-current"]),
    advertisedSha: command("git", ["ls-remote", "origin", `refs/heads/${releaseBranch}`]).split(
      "\t",
    )[0],
    baselineSha: command("git", [
      "ls-remote",
      "origin",
      "refs/heads/release/hns-ownership-only-baseline",
    ]).split("\t")[0],
    changedPaths: command("git", ["diff", "--name-only", baseline, "HEAD"])
      .split("\n")
      .filter(Boolean),
  });
  if (command("git", ["rev-parse", acceptedRef]) !== sha) refuse("stale_tracking_reference");
  for (const worker of workers) {
    const path = `apps/${worker}/wrangler.jsonc`;
    validateProductionConfig(
      Bun.JSONC.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()),
      Bun.JSONC.parse(command("git", ["show", `${baseline}:${path}`])),
    );
  }
  for (const path of ["package.json", "bun.lock"]) {
    validateDependencies(
      Bun.JSONC.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()),
      Bun.JSONC.parse(command("git", ["show", `${baseline}:${path}`])),
      path === "bun.lock",
    );
  }
  const policyPath = "docs/rewards-deployment-lifecycle.json";
  validateRewardsPolicy(
    JSON.parse(await Bun.file(new URL(`../${policyPath}`, import.meta.url)).text()),
    JSON.parse(command("git", ["show", `${baseline}:${policyPath}`])),
  );
  await verifyNodeForgeRemediation();
  if (!execute) {
    console.log(
      JSON.stringify({
        event: "hns_pinned_api_deploy_preflight",
        sourceSha: sha,
        worker: options[1],
        execute: false,
      }),
    );
    return;
  }
  if (
    receipt.reviewStatus !== "approved" ||
    receipt.reviewerRole !== "independent_reviewer" ||
    !Number.isFinite(Date.parse(receipt.reviewedAt)) ||
    Date.now() - Date.parse(receipt.reviewedAt) < 0 ||
    Date.now() - Date.parse(receipt.reviewedAt) > 3_600_000
  )
    refuse("fresh_independent_review_required");
  const pull = JSON.parse(
    command("gh", [
      "pr",
      "view",
      "551",
      "--repo",
      "pirate-social-club/api-next",
      "--json",
      "headRefOid,statusCheckRollup",
    ]),
  );
  const required = [
    "check",
    "Advisory policy",
    "secret-boundary",
    "postgres17",
    "hns-regtest",
    "postgres18-shape",
  ];
  if (
    pull.headRefOid !== sha ||
    required.some(
      (name) =>
        !pull.statusCheckRollup.some(
          (check) => check.name === name && check.conclusion === "SUCCESS",
        ),
    )
  )
    refuse("hosted_checks_not_green");
  console.log(
    JSON.stringify(
      await deployWorkerWithProvenance(root, {
        configPath: `apps/${options[1]}/wrangler.jsonc`,
        environment: "production",
        sourceRef: sha,
        acceptedMainRef: acceptedRef,
      }),
    ),
  );
}
if (import.meta.main) {
  await main().catch((error) => {
    console.error(
      error instanceof Error && error.message.startsWith("hns_pinned_api_deploy_refused:")
        ? error.message
        : "hns_pinned_api_deploy_refused:operation_failed",
    );
    process.exitCode = 1;
  });
}
