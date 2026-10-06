import { decodeTelegramConfiguration } from "../packages/platform-cf/src/telegram-configuration.ts";
import type { CandidateBindings, DriftContext, ServingVersion } from "./worker-binding-drift.ts";

const configs = new Set(["apps/http-worker/wrangler.jsonc", "apps/jobs-worker/wrangler.jsonc"]);

/** Preserve public configuration only; secret bindings remain with the existing drift guard. */
export function preserveStagingTelegramConfiguration(
  context: DriftContext,
  candidate: CandidateBindings,
  serving: readonly ServingVersion[],
): Readonly<{ candidate: CandidateBindings; telegramConfig?: string }> {
  if (context.environment !== "staging" || !configs.has(context.config_path)) return { candidate };
  if (serving.length === 0) throw Error("staging Telegram preservation requires serving versions");
  const values = serving.map(({ bindings }) => {
    const matches = bindings.filter((binding) => binding.name === "TELEGRAM_CONFIG_JSON");
    const binding = matches[0];
    if (matches.length !== 1 || binding?.type !== "plain_text" || typeof binding.text !== "string")
      throw Error("staging Telegram serving configuration missing or invalid");
    const intent = decodeTelegramConfiguration({ TELEGRAM_CONFIG_JSON: binding.text });
    if (context.config_path.includes("jobs-worker") && intent.linking_enabled)
      throw Error("Telegram linking cannot be enabled on jobs");
    return binding.text;
  });
  const telegramConfig = values[0];
  if (telegramConfig === undefined || values.some((value) => value !== telegramConfig))
    throw Error("staging Telegram serving configurations disagree");
  if (candidate.bindings.filter((binding) => binding.name === "TELEGRAM_CONFIG_JSON").length !== 1)
    throw Error("staging Telegram candidate configuration missing or duplicated");
  return {
    telegramConfig,
    candidate: {
      ...candidate,
      bindings: candidate.bindings.map((binding) =>
        binding.name === "TELEGRAM_CONFIG_JSON"
          ? { name: binding.name, type: "plain_text", text: telegramConfig }
          : binding,
      ),
    },
  };
}
