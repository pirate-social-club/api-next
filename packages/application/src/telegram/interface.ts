import { Schema } from "effect";
import {
  resolveTelegramLocale,
  type TelegramCopyKey,
  type TelegramLocale,
  telegramLanguageNames,
  telegramLocale,
  telegramText,
} from "./copy.ts";
import type { InboxRecord, IntegrationRecord, TelegramServices } from "./types.ts";

export const TelegramMenu = Schema.Literals(["study", "songs", "help", "resume", "settings"]);
export async function learnerInterface(
  services: TelegramServices,
  inbox: InboxRecord,
  integration: IntegrationRecord,
  userId: string,
  suggested: unknown,
) {
  if (!integration.botId) throw Error("Telegram interface requires a bot identity");
  const sender = {
    communityId: inbox.communityId,
    botId: integration.botId,
    epoch: inbox.botEpoch,
    telegramUserId: userId,
  };
  let context = await services.store.learnerLanguageContext(sender);
  let locale = resolveTelegramLocale(context, suggested);
  if (!context.preference?.explicit && context.preference?.locale !== locale) {
    await services.store.saveLearnerLanguage(sender, inbox.id, locale, false);
    context = await services.store.learnerLanguageContext(sender);
    locale = resolveTelegramLocale(context, suggested);
  }
  return {
    sender,
    context,
    locale,
    text: (key: TelegramCopyKey, values?: Readonly<Record<string, string | number>>) =>
      telegramText(locale, key, values),
  };
}

export function interfaceKeyboard(
  locale: TelegramLocale,
  practice: boolean,
  resume: boolean,
  suggestion?: unknown,
) {
  const button = (key: typeof TelegramMenu.Type) => ({
    text: telegramText(locale, key),
    callback_data: `tg-menu:${key}`,
  });
  return {
    inline_keyboard: [
      Object.entries(telegramLanguageNames).map(([code, name]) => ({
        text:
          code === telegramLocale(suggestion)
            ? `${name} · ${telegramText(locale, "suggested")}`
            : name,
        callback_data: `tg-language:${code}`,
      })),
      [...(practice ? [button("study")] : []), button("songs")],
      [...(practice && resume ? [button("resume")] : []), button("help"), button("settings")],
    ],
  };
}
