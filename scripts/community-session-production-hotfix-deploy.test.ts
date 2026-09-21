import { describe, expect, test } from "bun:test";
import {
  deployCommunitySessionProductionHotfix,
  type HotfixCommandRunner,
  parseCurrentDeployment,
  parseHotfixDeploymentArgs,
  verifyHotfixDeploymentSource,
} from "./community-session-production-hotfix-deploy.ts";

const sourceSha = "a".repeat(40);
const manifestSha = "b".repeat(64);
const baseSha = "4335629e1d123bd7a83c86a4d41e263c7f5ef356";
const branch = "release/community-session-production-compatibility";
const captureDirectory = "/capture";
const allowedPaths = [
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
].join("\n");

function queueRunner(
  results: readonly Readonly<{ exitCode: number; stdout?: string; stderr?: string }>[],
): Readonly<{ runner: HotfixCommandRunner; commands: string[][] }> {
  let index = 0;
  const commands: string[][] = [];
  return {
    commands,
    runner: async (command) => {
      commands.push([...command]);
      const result = results[index];
      index += 1;
      if (result === undefined) throw new Error("unexpected command");
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

function verificationResults(
  changedPaths = allowedPaths,
): readonly Readonly<{ exitCode: number; stdout?: string }>[] {
  return [
    { exitCode: 0, stdout: sourceSha },
    { exitCode: 0, stdout: branch },
    { exitCode: 0, stdout: baseSha },
    { exitCode: 0 },
    { exitCode: 0 },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "apps/http-worker/wrangler.jsonc" },
    { exitCode: 0, stdout: changedPaths },
    { exitCode: 0, stdout: captureDirectory },
    { exitCode: 0, stdout: `${manifestSha}  MANIFEST.sha256` },
    { exitCode: 0, stdout: "head.bundle: OK" },
    { exitCode: 0, stdout: "bundle is complete" },
    { exitCode: 0, stdout: `${sourceSha} refs/heads/${branch}` },
  ];
}

describe("community session production hotfix deployment", () => {
  test("requires exact source, capture digest, and source-bound confirmation", () => {
    expect(
      parseHotfixDeploymentArgs([
        "--source-sha",
        sourceSha,
        "--capture-directory",
        captureDirectory,
        "--capture-manifest-sha256",
        manifestSha,
        "--confirm",
        `deploy-community-session-hotfix:${sourceSha}`,
      ]),
    ).toEqual({ sourceSha, captureDirectory, captureManifestSha256: manifestSha });
    expect(() =>
      parseHotfixDeploymentArgs([
        "--source-sha",
        sourceSha,
        "--capture-directory",
        captureDirectory,
        "--capture-manifest-sha256",
        manifestSha,
        "--confirm",
        "deploy-community-session-hotfix:wrong",
      ]),
    ).toThrow("confirmation mismatch");
  });

  test("accepts only a single version serving 100 percent", () => {
    expect(
      parseCurrentDeployment(
        JSON.stringify([{ versions: [{ version_id: "version-1", percentage: 100 }] }]),
      ),
    ).toBe("version-1");
    expect(() =>
      parseCurrentDeployment(
        JSON.stringify([
          {
            versions: [
              { version_id: "version-1", percentage: 90 },
              { version_id: "version-2", percentage: 10 },
            ],
          },
        ]),
      ),
    ).toThrow("not a single version");
  });

  test("verifies the deployed base, exact path set, clean tree, and complete capture", async () => {
    const { runner } = queueRunner(verificationResults());
    await expect(
      verifyHotfixDeploymentSource(
        "/repo",
        { sourceSha, captureDirectory, captureManifestSha256: manifestSha },
        runner,
      ),
    ).resolves.toBeUndefined();

    const badPaths = queueRunner(
      verificationResults(`${allowedPaths}\napps/http-worker/src/index.ts`),
    );
    await expect(
      verifyHotfixDeploymentSource(
        "/repo",
        { sourceSha, captureDirectory, captureManifestSha256: manifestSha },
        badPaths.runner,
      ),
    ).rejects.toThrow("approved path set");
  });

  test("refuses deployment when the serving Worker is not the exact deployed base", async () => {
    const versions = JSON.stringify([
      { id: "old-version", annotations: { "workers/message": `git:${"c".repeat(40)}` } },
    ]);
    const deployments = JSON.stringify([
      { versions: [{ version_id: "old-version", percentage: 100 }] },
    ]);
    const { runner, commands } = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: versions },
      { exitCode: 0, stdout: deployments },
    ]);
    await expect(
      deployCommunitySessionProductionHotfix(
        "/repo",
        { sourceSha, captureDirectory, captureManifestSha256: manifestSha },
        runner,
      ),
    ).rejects.toThrow("provenance does not match");
    expect(commands.some((command) => command.includes("deploy"))).toBe(false);
  });

  test("dry-runs, deploys once, and verifies version provenance and 100 percent traffic", async () => {
    const before = JSON.stringify([
      { id: "old-version", annotations: { "workers/message": `git:${baseSha}` } },
    ]);
    const beforeDeployment = JSON.stringify([
      { versions: [{ version_id: "old-version", percentage: 100 }] },
    ]);
    const after = JSON.stringify([
      { id: "new-version", annotations: { "workers/message": `git:${sourceSha}` } },
      { id: "old-version", annotations: { "workers/message": `git:${baseSha}` } },
    ]);
    const afterDeployment = JSON.stringify([
      { versions: [{ version_id: "new-version", percentage: 100 }] },
    ]);
    const { runner, commands } = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: before },
      { exitCode: 0, stdout: beforeDeployment },
      { exitCode: 0, stdout: "dry run complete" },
      { exitCode: 0, stdout: "deploy complete" },
      { exitCode: 0, stdout: after },
      { exitCode: 0, stdout: afterDeployment },
    ]);
    await expect(
      deployCommunitySessionProductionHotfix(
        "/repo",
        { sourceSha, captureDirectory, captureManifestSha256: manifestSha },
        runner,
      ),
    ).resolves.toEqual({
      schema_version: 1,
      source_sha: sourceSha,
      deployed_base_sha: baseSha,
      previous_worker_version_id: "old-version",
      worker_version_id: "new-version",
      environment: "production",
      config_path: "apps/http-worker/wrangler.jsonc",
      capture_manifest_sha256: manifestSha,
    });
    const deployCommands = commands.filter(
      (command) => command[1] === "wrangler" && command[2] === "deploy",
    );
    expect(deployCommands).toHaveLength(2);
    expect(deployCommands[0]).toContain("--dry-run");
    expect(deployCommands[1]).toContain("--strict");
    expect(deployCommands[1]).toContain(`git:${sourceSha}`);
  });
});
