import type { CandidateBindings, DriftContext, ServingVersion } from "./worker-binding-drift.ts";

const configs = new Set(["apps/http-worker/wrangler.jsonc", "apps/jobs-worker/wrangler.jsonc"]);

/** This internal parameter can only preserve disabled staging HTTP/Jobs Rewards. */
export function assertStagingRewardsPreservation(
  configPath: string,
  environment: string,
  disabled: unknown,
): asserts disabled is "false" | undefined {
  if (disabled === undefined) return;
  if (disabled !== "false" || environment !== "staging" || !configs.has(configPath))
    throw Error("disabled Rewards preservation applies only to staging HTTP/Jobs");
}

/** Serving true follows normal drift/lifecycle policy; this path never enables Rewards. */
export function preserveStagingRewardsConfiguration(
  context: DriftContext,
  candidate: CandidateBindings,
  serving: readonly ServingVersion[],
): Readonly<{ candidate: CandidateBindings; disabledRewards?: "false" }> {
  if (context.environment !== "staging" || !configs.has(context.config_path)) return { candidate };
  if (serving.length === 0) throw Error("staging Rewards preservation requires serving versions");
  const values = serving.map(({ bindings }) => {
    const matches = bindings.filter((binding) => binding.name === "MEGAPOT_REWARDS_ENABLED");
    const binding = matches[0];
    if (
      matches.length !== 1 ||
      binding?.type !== "plain_text" ||
      (binding.text !== "false" && binding.text !== "true")
    )
      throw Error("staging Rewards serving binding missing or invalid");
    return binding.text;
  });
  const enabled = values[0];
  if (values.some((value) => value !== enabled))
    throw Error("staging Rewards serving bindings disagree");
  const matches = candidate.bindings.filter(
    (binding) => binding.name === "MEGAPOT_REWARDS_ENABLED",
  );
  if (
    matches.length !== 1 ||
    matches[0]?.type !== "plain_text" ||
    (matches[0].text !== "false" && matches[0].text !== "true")
  )
    throw Error("staging Rewards candidate binding missing or invalid");
  if (enabled === "true") return { candidate };
  return {
    disabledRewards: "false",
    candidate: {
      ...candidate,
      bindings: candidate.bindings.map((binding) =>
        binding.name === "MEGAPOT_REWARDS_ENABLED"
          ? { name: binding.name, type: "plain_text", text: "false" }
          : binding,
      ),
    },
  };
}
