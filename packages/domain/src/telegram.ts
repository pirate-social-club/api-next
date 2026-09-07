export type TelegramMessageKind = "text" | "photo" | "video" | "audio" | "voice";
export type TelegramMessage = Readonly<{
  kind: TelegramMessageKind;
  text: string;
  media: string | null;
  buttons: readonly Readonly<{ text: string; url: string }>[];
  replyTo?: number;
  keyboard?: unknown;
}>;

export type TelegramDeliveryState =
  | "pending"
  | "sending"
  | "delivered"
  | "failed"
  | "uncertain"
  | "withdrawn"
  | "cancelled";
export type TelegramDeliveryDecision =
  | "send"
  | "edit"
  | "delete"
  | "unchanged"
  | "review"
  | "cancel";

/** Only confirmed payloads may satisfy deduplication. Reservations never do. */
export function decideTelegramDelivery(input: {
  state: TelegramDeliveryState;
  messageId: number | null;
  desiredHash: string | null;
  confirmedHash: string | null;
  desiredKind: TelegramMessageKind | null;
  confirmedKind: TelegramMessageKind | null;
}): TelegramDeliveryDecision {
  if (input.state === "cancelled" || input.state === "uncertain" || input.state === "sending")
    return "review";
  if (input.desiredHash === null) return input.messageId === null ? "cancel" : "delete";
  if (input.messageId === null) return "send";
  if (input.state === "delivered" && input.confirmedHash === input.desiredHash) return "unchanged";
  if (input.confirmedKind !== input.desiredKind) return "review";
  return "edit";
}

export function telegramPublicContentAllowed(input: {
  communityStatus: string;
  status: string;
  visibility: string;
  rating: string | null;
}): boolean {
  return (
    input.communityStatus === "active" &&
    input.status === "published" &&
    input.visibility === "public" &&
    input.rating === "general"
  );
}

export function telegramReplyUsesVoice(
  policy: { voice_enabled: boolean; voice_reply_mode: string },
  voiceInput: boolean,
  explicitVoiceRequest: boolean,
): boolean {
  return (
    policy.voice_enabled &&
    (policy.voice_reply_mode === "always" ||
      explicitVoiceRequest ||
      (policy.voice_reply_mode === "match_input" && voiceInput))
  );
}

/** Strings remain plain text, so untrusted titles cannot inject Telegram markup. */
export function boundedTelegramText(text: string, media = false): string {
  const limit = media ? 1024 : 4096;
  if (text.length <= limit) return text;
  const head = text.slice(0, limit - 1);
  return `${/[\uD800-\uDBFF]$/u.test(head) ? head.slice(0, -1) : head}…`;
}

export function formatTelegramAtomicAmount(atomic: string, decimals: number): string {
  if (!/^\d+$/u.test(atomic) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 77)
    throw new TypeError("Invalid reward amount");
  const padded = atomic.padStart(decimals + 1, "0");
  if (decimals === 0) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/u, "");
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}
