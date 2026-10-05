import type { TelegramBindings } from "../packages/platform-cf/src/telegram-runtime.ts";

export const TELEGRAM_BINDING_KINDS = {
  API_NEXT_ENV: "var",
  ELEVENLABS_API_KEY: "secret",
  LEARNER_AUDIO: "platform",
  TELEGRAM_CONFIG_JSON: "var",
  TELEGRAM_SECRETS_JSON: "secret",
  TELEGRAM_QUEUE: "platform",
} as const satisfies { [K in keyof TelegramBindings]-?: "var" | "secret" | "platform" };
