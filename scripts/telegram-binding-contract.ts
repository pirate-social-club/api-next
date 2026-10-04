import type { TelegramBindings } from "../packages/platform-cf/src/telegram-runtime.ts";

export const TELEGRAM_BINDING_KINDS = {
  TELEGRAM_STUDY_PRACTICE_ENABLED: "var",
  TELEGRAM_STUDY_PRACTICE_COMMUNITY_ID: "var",
  TELEGRAM_STUDY_PRACTICE_POST_IDS_JSON: "var",
  API_NEXT_ENV: "var",
  ELEVENLABS_API_KEY: "secret",
  LEARNER_AUDIO: "platform",
  TELEGRAM_ENABLED: "var",
  TELEGRAM_PUBLIC_ORIGIN: "var",
  TELEGRAM_WEBHOOK_ORIGIN: "var",
  TELEGRAM_CREDENTIAL_ACTIVE_VERSION: "var",
  TELEGRAM_CREDENTIAL_KEYS_JSON: "secret",
  TELEGRAM_QUEUE: "platform",
} as const satisfies { [K in keyof TelegramBindings]-?: "var" | "secret" | "platform" };
