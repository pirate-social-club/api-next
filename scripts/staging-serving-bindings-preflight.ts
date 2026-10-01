import { readFile } from "node:fs/promises";
import type { CommandRunner } from "./deploy-worker-with-provenance.ts";
import {
  assertReviewedDrift,
  assertUnchangedBaseline,
  type BindingDriftReceipt,
  bindings,
  type CandidateBindings,
  compareServingBindings,
  type DriftContext,
  object,
  parseJson,
  parseServingDeployments,
  runtime,
  type ServingVersion,
  string,
} from "./worker-binding-drift.ts";
import { readCandidateBindings } from "./worker-deployment-bindings.ts";

export type StagingBindingGuard = Readonly<{
  receipt: BindingDriftReceipt;
  recheck: () => Promise<void>;
}>;
export type PrepareStagingBindingGuard = (
  root: string,
  context: DriftContext,
  runner: CommandRunner,
  reviewPath: string | undefined,
  diagnostic: (text: string) => void,
) => Promise<StagingBindingGuard | null>;

async function output(
  runner: CommandRunner,
  command: readonly string[],
  root: string,
): Promise<string> {
  const result = await runner(command, root, AbortSignal.timeout(30_000));
  if (result.exitCode !== 0 || result.stdout.length > 1_048_576)
    throw Error("staging binding preflight: serving inventory unavailable");
  return result.stdout;
}

async function readServing(
  root: string,
  context: DriftContext,
  runner: CommandRunner,
): Promise<readonly ServingVersion[]> {
  const target = ["--env", context.environment, "--config", context.config_path, "--json"];
  const serving = parseServingDeployments(
    await output(runner, ["bunx", "wrangler", "deployments", "list", ...target], root),
  );
  if (serving.length > 10) throw Error("staging binding preflight: too many serving versions");
  const result: ServingVersion[] = [];
  for (const allocation of serving) {
    const version = object(
      parseJson(
        await output(
          runner,
          ["bunx", "wrangler", "versions", "view", allocation.version_id, ...target],
          root,
        ),
        "serving version",
      ),
      "version",
    );
    if (string(version.id, "version id") !== allocation.version_id)
      throw Error("staging binding preflight: version identity mismatch");
    const resources = object(version.resources, "version resources");
    const inventory = bindings(resources.bindings);
    for (const binding of inventory)
      if (binding.type === "durable_object_namespace")
        string(binding.namespace_id, "namespace identity");
    result.push({
      ...allocation,
      bindings: inventory,
      runtime: runtime(resources.script_runtime),
    });
  }
  return result;
}

export async function prepareStagingBindingGuard(
  root: string,
  context: DriftContext,
  runner: CommandRunner,
  reviewPath: string | undefined,
  diagnostic: (text: string) => void,
  candidateReader: (
    root: string,
    config: string,
    environment: string,
  ) => Promise<CandidateBindings> = readCandidateBindings,
): Promise<StagingBindingGuard | null> {
  if (context.environment !== "staging") return null;
  const review: unknown =
    reviewPath === undefined
      ? undefined
      : parseJson(await readFile(reviewPath, "utf8"), "binding review");
  const collect = async () =>
    compareServingBindings(
      context,
      await candidateReader(root, context.config_path, context.environment),
      await readServing(root, context, runner),
    );
  const receipt = await collect();
  diagnostic(`${JSON.stringify({ staging_binding_preflight: receipt })}\n`);
  assertReviewedDrift(receipt, review);
  return {
    receipt,
    recheck: async () => {
      const current = await collect();
      assertUnchangedBaseline(receipt, current);
      assertReviewedDrift(current, review);
    },
  };
}
