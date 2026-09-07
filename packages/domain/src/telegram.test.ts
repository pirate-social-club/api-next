import { expect, test } from "bun:test";
import {
  boundedTelegramText,
  decideTelegramDelivery,
  formatTelegramAtomicAmount,
  telegramPublicContentAllowed,
  telegramReplyUsesVoice,
} from "./telegram.ts";

test("failed edit cannot suppress the next attempt by matching a desired hash", () => {
  expect(
    decideTelegramDelivery({
      state: "failed",
      messageId: 12,
      desiredHash: "new",
      confirmedHash: "old",
      desiredKind: "text",
      confirmedKind: "text",
    }),
  ).toBe("edit");
  expect(
    decideTelegramDelivery({
      state: "uncertain",
      messageId: null,
      desiredHash: "new",
      confirmedHash: null,
      desiredKind: "text",
      confirmedKind: null,
    }),
  ).toBe("review");
  expect(
    decideTelegramDelivery({
      state: "delivered",
      messageId: 12,
      desiredHash: null,
      confirmedHash: "old",
      desiredKind: null,
      confirmedKind: "text",
    }),
  ).toBe("delete");
});

test("public context rejects private, removed, hidden-community and unrated content", () => {
  const allowed = {
    communityStatus: "active",
    status: "published",
    visibility: "public",
    rating: "general",
  };
  expect(telegramPublicContentAllowed(allowed)).toBe(true);
  for (const override of [
    { visibility: "members_only" },
    { status: "removed" },
    { communityStatus: "hidden" },
    { rating: null },
    { rating: "adult_18" },
  ]) {
    expect(telegramPublicContentAllowed({ ...allowed, ...override })).toBe(false);
  }
});

test("voice follows input unless explicitly requested and stays behind its own gate", () => {
  expect(
    telegramReplyUsesVoice({ voice_enabled: true, voice_reply_mode: "match_input" }, false, false),
  ).toBe(false);
  expect(
    telegramReplyUsesVoice({ voice_enabled: true, voice_reply_mode: "match_input" }, true, false),
  ).toBe(true);
  expect(
    telegramReplyUsesVoice({ voice_enabled: false, voice_reply_mode: "always" }, true, true),
  ).toBe(false);
});

test("Telegram formatting preserves integer reward precision and Unicode boundaries", () => {
  expect(formatTelegramAtomicAmount("123456789012345678901", 18)).toBe("123.456789012345678901");
  expect(boundedTelegramText(`${"a".repeat(1022)}😀more`, true)).toBe(`${"a".repeat(1022)}…`);
});
