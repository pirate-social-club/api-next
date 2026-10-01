import { fileURLToPath } from "node:url";
import { parseWorkerDeploymentArgs, runCommand } from "./deploy-worker-with-provenance.ts";
import { prepareStagingBindingGuard } from "./staging-serving-bindings-preflight.ts";

/** Read-only source preview; never calls deploy, upload or a provider operation. */
async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const input = parseWorkerDeploymentArgs(Bun.argv.slice(2));
  if (input.environment !== "staging") throw Error("binding preview requires staging");
  const sha = await runCommand(
    ["git", "rev-parse", "--verify", `${input.sourceRef}^{commit}`],
    root,
  );
  const tree = await runCommand(["git", "diff", "--quiet", sha.stdout.trim(), "--"], root);
  const untracked = await runCommand(["git", "ls-files", "--others", "--exclude-standard"], root);
  const tracked = await runCommand(
    ["git", "ls-files", "--error-unmatch", "--", input.configPath],
    root,
  );
  if (
    sha.exitCode ||
    tree.exitCode ||
    untracked.exitCode ||
    untracked.stdout.trim() ||
    tracked.exitCode
  )
    throw Error("binding preview requires exact clean source");
  await prepareStagingBindingGuard(
    root,
    {
      source_sha: sha.stdout.trim(),
      config_path: input.configPath,
      environment: input.environment,
    },
    runCommand,
    input.bindingReviewPath,
    (text) => process.stdout.write(text),
  );
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "staging binding preview failed");
    process.exitCode = 1;
  });
