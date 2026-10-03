export * from "./generated/client.ts";

/** Match this reason only; other conflict responses do not imply an existing association. */
export const TELEGRAM_IDENTITY_LINK_CONFLICT_REASON =
  "telegram_identity_already_linked_to_another_account" as const;
