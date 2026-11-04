import type { TELEGRAM_ACTIVATION_TABLES } from "./telegram-activation-privileges.ts";

type AdmissionTable = (typeof TELEGRAM_ACTIVATION_TABLES)[number][0];

export class TelegramSetupFailure extends Error {
  constructor(
    readonly category: "permission_refused" | "query_failed",
    message: string,
    readonly table?: AdmissionTable,
  ) {
    super(message);
  }
}

export function logTelegramSetupFailure(operation: "chat" | "linking", error: unknown) {
  // Only typed admission facts cross this boundary. Never serialize raw errors.
  console.error(`Telegram ${operation} setup unavailable; ${operation} operations disabled`, {
    category: error instanceof TelegramSetupFailure ? error.category : "configuration",
    ...(error instanceof TelegramSetupFailure && error.table !== undefined
      ? { table: error.table }
      : {}),
  });
}
