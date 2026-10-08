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
  // A catalog this deployment does not offer is never shown, whatever was saved or suggested.
  const offered = (value: TelegramLocale): TelegramLocale =>
    telegramLocaleOffered(services.interfaceLocales, value) ? value : "en";
  let context = await services.store.learnerLanguageContext(sender);
  let locale = offered(resolveTelegramLocale(context, suggested));
  if (!context.preference?.explicit && context.preference?.locale !== locale) {
    await services.store.saveLearnerLanguage(sender, inbox.id, locale, false);
    context = await services.store.learnerLanguageContext(sender);
    locale = offered(resolveTelegramLocale(context, suggested));
  }
  return {
    sender,
    context,
    locale,
    text: (key: TelegramCopyKey, values?: Readonly<Record<string, string | number>>) =>
      telegramText(locale, key, values),
  };
}

/** Whether a deployment offers this interface language. No list means every catalog. */
export function telegramLocaleOffered(
  offered: readonly TelegramLocale[] | undefined,
  locale: TelegramLocale,
) {
  return offered === undefined || offered.includes(locale);
}

export function interfaceKeyboard(
  locale: TelegramLocale,
  practice: boolean,
  resume: boolean,
  suggestion?: unknown,
  offered?: readonly TelegramLocale[],
) {
  const button = (key: typeof TelegramMenu.Type) => ({
    text: telegramText(locale, key),
    callback_data: `tg-menu:${key}`,
  });
  const languages = Object.entries(telegramLanguageNames).filter(([code]) =>
    telegramLocaleOffered(offered, code as TelegramLocale),
  );
  return {
    inline_keyboard: [
      // A single offered language needs no picker.
      ...(languages.length > 1
        ? [
            languages.map(([code, name]) => ({
              text:
                code === telegramLocale(suggestion)
                  ? `${name} · ${telegramText(locale, "suggested")}`
                  : name,
              callback_data: `tg-language:${code}`,
            })),
          ]
        : []),
      // One song-list action: in a practice bot it opens the practice picker.
      [button("songs")],
      [...(practice && resume ? [button("resume")] : []), button("help"), button("settings")],
    ],
  };
}
