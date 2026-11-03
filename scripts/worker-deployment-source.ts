import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner, WorkerDeploymentInput } from "./deploy-worker-with-provenance.ts";
import { assertPostingFrozenSource } from "./posting-frozen-source.ts";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
async function requiredOutput(
  runner: CommandRunner,
  command: readonly string[],
  root: string,
  label: string,
) {
  const result = await runner(command, root);
  if (result.exitCode !== 0) throw Error(`${label} failed (exit ${result.exitCode})`);
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

export async function verifyWorkerDeploymentSource(
  repositoryRoot: string,
  input: WorkerDeploymentInput,
  runner: CommandRunner,
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

  const { postingFrozenRuntime, ...normalInput } = input;
  if (postingFrozenRuntime) {
    const toolingRoot = fileURLToPath(new URL("../", import.meta.url));
    if (
      !input.repositoryRoot ||
      resolve(input.repositoryRoot) !== resolve(repositoryRoot) ||
      resolve(repositoryRoot) === resolve(toolingRoot)
    )
      throw Error("posting snapshot requires a separate deployment checkout");
    await verifyWorkerDeploymentSource(
      toolingRoot,
      { ...normalInput, sourceRef: input.toolingSourceRef ?? input.acceptedMainRef },
      runner,
    );
    const identity = ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"];
    if (
      (await requiredOutput(runner, identity, toolingRoot, "tooling repository identity")) !==
      (await requiredOutput(runner, identity, repositoryRoot, "snapshot repository identity"))
    )
      throw Error("posting snapshot must share the accepted tooling repository");
    await assertPostingFrozenSource(repositoryRoot, input, sourceSha, configPath, runner);
  } else {
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
