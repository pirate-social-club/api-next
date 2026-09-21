import { describe, expect, test } from "bun:test";
import {
  deployCommunitySessionProductionHotfix,
  type HotfixCommandRunner,
  parseCurrentDeployment,
  parseHotfixDeploymentArgs,
  parseHotfixPromotionArgs,
  parseHotfixRollbackArgs,
  promoteCommunitySessionProductionHotfix,
  rollbackCommunitySessionProductionHotfix,
  verifyHotfixDeploymentSource,
} from "./community-session-production-hotfix-deploy.ts";

const sourceSha = "a".repeat(40);
const manifestSha = "b".repeat(64);
const baseSha = "4335629e1d123bd7a83c86a4d41e263c7f5ef356";
const branch = "release/community-session-production-compatibility";
const captureDirectory = "/capture";
const previousVersionId = "11111111-1111-4111-8111-111111111111";
const uploadedVersionId = "22222222-2222-4222-8222-222222222222";
const unrelatedVersionId = "33333333-3333-4333-8333-333333333333";
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

type Result = Readonly<{ exitCode: number; stdout?: string; stderr?: string }>;

function queueRunner(results: readonly Result[]): Readonly<{
  runner: HotfixCommandRunner;
  commands: string[][];
}> {
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

function verificationResults(changedPaths = allowedPaths): readonly Result[] {
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

function versions(previousMessage = `git:${baseSha}`, includeUploaded = true): string {
  return JSON.stringify([
    { id: previousVersionId, annotations: { "workers/message": previousMessage } },
    ...(includeUploaded
      ? [{ id: uploadedVersionId, annotations: { "workers/message": `git:${sourceSha}` } }]
      : []),
  ]);
}

function deployment(
  uploadedPercentage: 0 | 10 | 50 | 100,
  otherVersionId = previousVersionId,
): string {
  const rows =
    uploadedPercentage === 0
      ? [{ version_id: otherVersionId, percentage: 100 }]
      : uploadedPercentage === 100
        ? [{ version_id: uploadedVersionId, percentage: 100 }]
        : [
            { version_id: otherVersionId, percentage: 100 - uploadedPercentage },
            { version_id: uploadedVersionId, percentage: uploadedPercentage },
          ];
  return JSON.stringify([{ versions: rows }]);
}

function baseInput() {
  return { sourceSha, captureDirectory, captureManifestSha256: manifestSha } as const;
}

function rolloutInput(percentage: 10 | 50 | 100) {
  return { ...baseInput(), previousVersionId, uploadedVersionId, percentage } as const;
}

describe("community session production hotfix deployment", () => {
  test("requires exact upload, promotion, and rollback confirmations", () => {
    expect(
      parseHotfixDeploymentArgs([
        "--source-sha",
        sourceSha,
        "--capture-directory",
        captureDirectory,
        "--capture-manifest-sha256",
        manifestSha,
        "--confirm",
        `upload-community-session-hotfix:${sourceSha}`,
      ]),
    ).toEqual(baseInput());

    expect(
      parseHotfixPromotionArgs([
        "--source-sha",
        sourceSha,
        "--capture-directory",
        captureDirectory,
        "--capture-manifest-sha256",
        manifestSha,
        "--previous-version-id",
        previousVersionId,
        "--uploaded-version-id",
        uploadedVersionId,
        "--percentage",
        "10",
        "--confirm",
        `promote-community-session-hotfix:${sourceSha}:10`,
      ]),
    ).toEqual(rolloutInput(10));

    expect(
      parseHotfixRollbackArgs([
        "--source-sha",
        sourceSha,
        "--capture-directory",
        captureDirectory,
        "--capture-manifest-sha256",
        manifestSha,
        "--previous-version-id",
        previousVersionId,
        "--uploaded-version-id",
        uploadedVersionId,
        "--confirm",
        `rollback-community-session-hotfix:${sourceSha}`,
      ]),
    ).toEqual({ ...baseInput(), previousVersionId, uploadedVersionId });

    expect(() =>
      parseHotfixPromotionArgs([
        "--source-sha",
        sourceSha,
        "--capture-directory",
        captureDirectory,
        "--capture-manifest-sha256",
        manifestSha,
        "--previous-version-id",
        previousVersionId,
        "--uploaded-version-id",
        uploadedVersionId,
        "--percentage",
        "25",
        "--confirm",
        `promote-community-session-hotfix:${sourceSha}:25`,
      ]),
    ).toThrow("promotion identity");
  });

  test("parses only valid 100-percent deployment distributions", () => {
    expect(parseCurrentDeployment(deployment(0))).toEqual([
      { versionId: previousVersionId, percentage: 100 },
    ]);
    expect(parseCurrentDeployment(deployment(10))).toEqual([
      { versionId: previousVersionId, percentage: 90 },
      { versionId: uploadedVersionId, percentage: 10 },
    ]);
    expect(() =>
      parseCurrentDeployment(
        JSON.stringify([
          {
            versions: [
              { version_id: previousVersionId, percentage: 80 },
              { version_id: uploadedVersionId, percentage: 10 },
            ],
          },
        ]),
      ),
    ).toThrow("total 100");
  });

  test("verifies the deployed base, exact path set, clean tree, and complete capture", async () => {
    const { runner } = queueRunner(verificationResults());
    await expect(
      verifyHotfixDeploymentSource("/repo", baseInput(), runner),
    ).resolves.toBeUndefined();

    const badPaths = queueRunner(
      verificationResults(`${allowedPaths}\napps/http-worker/src/index.ts`),
    );
    await expect(
      verifyHotfixDeploymentSource("/repo", baseInput(), badPaths.runner),
    ).rejects.toThrow("approved path set");
  });

  test("refuses upload when the serving Worker is not the exact deployed base", async () => {
    const { runner, commands } = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: versions(`git:${"c".repeat(40)}`, false) },
      { exitCode: 0, stdout: deployment(0) },
    ]);
    await expect(
      deployCommunitySessionProductionHotfix("/repo", baseInput(), runner),
    ).rejects.toThrow("provenance does not match");
    expect(commands.some((command) => command.includes("upload"))).toBe(false);
  });

  test("uploads without changing the serving distribution", async () => {
    const { runner, commands } = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: versions(`git:${baseSha}`, false) },
      { exitCode: 0, stdout: deployment(0) },
      { exitCode: 0, stdout: "dry run complete" },
      { exitCode: 0, stdout: "upload complete" },
      { exitCode: 0, stdout: versions() },
      { exitCode: 0, stdout: deployment(0) },
    ]);
    await expect(
      deployCommunitySessionProductionHotfix("/repo", baseInput(), runner),
    ).resolves.toEqual({
      schema_version: 1,
      operation: "upload",
      source_sha: sourceSha,
      deployed_base_sha: baseSha,
      previous_worker_version_id: previousVersionId,
      uploaded_worker_version_id: uploadedVersionId,
      environment: "production",
      config_path: "apps/http-worker/wrangler.jsonc",
      capture_manifest_sha256: manifestSha,
    });
    const uploadCommands = commands.filter(
      (command) =>
        command[1] === "wrangler" && command[2] === "versions" && command[3] === "upload",
    );
    expect(uploadCommands).toHaveLength(2);
    expect(uploadCommands[0]).toContain("--dry-run");
    expect(uploadCommands[1]).toContain("--strict");
  });

  test("promotes only in the approved 0-10-50-100 sequence", async () => {
    const { runner, commands } = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: versions() },
      { exitCode: 0, stdout: deployment(0) },
      { exitCode: 0, stdout: "promoted" },
      { exitCode: 0, stdout: deployment(10) },
    ]);
    await expect(
      promoteCommunitySessionProductionHotfix("/repo", rolloutInput(10), runner),
    ).resolves.toMatchObject({
      operation: "promote",
      distribution: [
        { versionId: previousVersionId, percentage: 90 },
        { versionId: uploadedVersionId, percentage: 10 },
      ],
    });
    const deploy = commands.find(
      (command) =>
        command[1] === "wrangler" && command[2] === "versions" && command[3] === "deploy",
    );
    expect(deploy).toContain(`${previousVersionId}@90`);
    expect(deploy).toContain(`${uploadedVersionId}@10`);

    const drift = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: versions() },
      { exitCode: 0, stdout: deployment(0) },
    ]);
    await expect(
      promoteCommunitySessionProductionHotfix("/repo", rolloutInput(50), drift.runner),
    ).rejects.toThrow("approved rollout stage");
    expect(drift.commands.some((command) => command[3] === "deploy")).toBe(false);
  });

  test("promotes the reviewed candidate from 10 to 50 and from 50 to 100", async () => {
    for (const [percentage, priorPercentage] of [
      [50, 10],
      [100, 50],
    ] as const) {
      const { runner } = queueRunner([
        ...verificationResults(),
        { exitCode: 0, stdout: versions() },
        { exitCode: 0, stdout: deployment(priorPercentage) },
        { exitCode: 0, stdout: "promoted" },
        { exitCode: 0, stdout: deployment(percentage) },
      ]);
      await expect(
        promoteCommunitySessionProductionHotfix("/repo", rolloutInput(percentage), runner),
      ).resolves.toMatchObject({
        operation: "promote",
        distribution: parseCurrentDeployment(deployment(percentage)),
      });
    }
  });

  test("rolls back an active candidate and refuses unrelated traffic", async () => {
    const { runner } = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: versions() },
      { exitCode: 0, stdout: deployment(50) },
      { exitCode: 0, stdout: "rolled back" },
      { exitCode: 0, stdout: deployment(0) },
    ]);
    await expect(
      rollbackCommunitySessionProductionHotfix(
        "/repo",
        { ...baseInput(), previousVersionId, uploadedVersionId },
        runner,
      ),
    ).resolves.toMatchObject({ operation: "rollback" });

    const unrelated = queueRunner([
      ...verificationResults(),
      { exitCode: 0, stdout: versions() },
      { exitCode: 0, stdout: deployment(10, unrelatedVersionId) },
    ]);
    await expect(
      rollbackCommunitySessionProductionHotfix(
        "/repo",
        { ...baseInput(), previousVersionId, uploadedVersionId },
        unrelated.runner,
      ),
    ).rejects.toThrow("unrelated");
  });
});
