import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildNormalRewardsJobsArtifact,
  buildRewardsHttpArtifact,
} from "./isolated-http-build.mjs";
import { loadIsolatedWorkerPlan } from "./worker-plan.mjs";

export const deploymentPins = {
  hyperdriveId: "04a1c805805d42d6bfc67ae7b005ec93",
  databaseHost: "aws-us-east-1-3.pg.psdb.cloud",
  attestationId: "megapot-e2e-sepolia-20261004-r2",
  databaseRoleUsernameSha256: "e8baf39d2c952c232b7f0986a7ef960bc06fdd3589d04249ba1b746594d405c8",
  databaseSqlRoleSha256: "96c2f4482ba02cf95cfb3f62c8ff90df582cf3181b1f6b8dbbfae8ee72667284",
};

export async function workerConfigurations(root) {
  const plans = await loadIsolatedWorkerPlan(root, deploymentPins);
  return Object.fromEntries(
    Object.entries(plans).map(([kind, plan]) => {
      const environment = Object.fromEntries(
        [
          "name",
          "version_metadata",
          "vars",
          "r2_buckets",
          "services",
          "vpc_services",
          "hyperdrive",
          "durable_objects",
          "workflows",
          "queues",
          "routes",
          "triggers",
          "secrets",
          "placement",
        ].map((key) => [key, plan[key]]),
      );
      return [kind, { ...plan, env: { "rewards-e2e": environment } }];
    }),
  );
}

/** The tracked target plan must match before generating any deployable artifact. */
export async function prepareWorkerBuild(root) {
  const plans = await workerConfigurations(root);
  for (const [kind, plan] of Object.entries(plans)) {
    const tracked = Bun.JSONC.parse(
      await readFile(resolve(root, `tests/rewards-e2e/${kind}.wrangler.jsonc`), "utf8"),
    );
    if (JSON.stringify(tracked) !== JSON.stringify(plan))
      throw new Error(`Tracked isolated ${kind} plan differs from the reviewed source`);
  }
  const jobs = await buildNormalRewardsJobsArtifact();
  if (
    jobs.inputPaths.some(
      (path) =>
        path.includes("reward-claim-stub") || path.includes("tests/rewards-e2e/claim-provider"),
    )
  )
    throw new Error("Jobs build contains simulated verification");
  const http = await buildRewardsHttpArtifact("isolated", deploymentPins.databaseSqlRoleSha256);
  if (!http.inputPaths.some((path) => path.includes("reward-claim-stub")))
    throw new Error("Isolated HTTP build lacks its labelled verification adapter");
  const output = resolve(root, "tests/rewards-e2e/dist");
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "http.bundle.mjs"), http.source);
  return {
    simulatedVerification: true,
    databaseRoleUsernameSha256: deploymentPins.databaseRoleUsernameSha256,
    databaseSqlRoleSha256: deploymentPins.databaseSqlRoleSha256,
    httpArtifactSha256: createHash("sha256").update(http.source).digest("hex"),
    jobsArtifactSha256: createHash("sha256").update(jobs.source).digest("hex"),
    httpInputCount: http.inputPaths.length,
    jobsInputCount: jobs.inputPaths.length,
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  console.log(JSON.stringify(await prepareWorkerBuild(root), null, 2));
}
