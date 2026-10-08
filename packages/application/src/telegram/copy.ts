import { Schema } from "effect";

export const TelegramLocale = Schema.Literals(["en", "ru", "ka"]);
export type TelegramLocale = Schema.Schema.Type<typeof TelegramLocale>;
const LanguageTag = Schema.String.check(Schema.isMaxLength(64));
const NamedHelperLanguage = Schema.Literals(["en", "ru", "ka", "zh", "ar"]);

export function telegramLocale(value: unknown): TelegramLocale | null {
  const parsed = Schema.decodeUnknownOption(LanguageTag)(value);
  if (parsed._tag === "None") return null;
  try {
    const tag = new Intl.Locale(parsed.value);
    const locale = Schema.decodeUnknownOption(TelegramLocale)(tag.language);
    if (locale._tag === "None") return null;
    const script = { en: "Latn", ru: "Cyrl", ka: "Geor" }[locale.value];
    return tag.script && tag.script !== script ? null : locale.value;
  } catch {
    return null;
  }
}

export interface TelegramLanguagePreference {
  readonly locale: TelegramLocale;
  readonly explicit: boolean;
}
export interface TelegramLanguageContext {
  readonly preference: TelegramLanguagePreference | null;
  readonly accountLocale: string | null;
  readonly helperLanguage: string | null;
  readonly communityName: string;
  readonly resumeAvailable: boolean;
}
export function resolveTelegramLocale(context: TelegramLanguageContext, suggested: unknown) {
  return context.preference?.explicit
    ? context.preference.locale
    : (telegramLocale(suggested) ??
        context.preference?.locale ??
        telegramLocale(context.accountLocale) ??
        "en");
}

// Application-owned drafts. Language-qualified review is required before cohort acceptance.
export const telegramCatalogs = {
  en: {
    discoveryWelcome:
      "Welcome to {community}. Browse this community’s songs here. Read-aloud practice is not enabled in this bot yet. Choose your interface language below.",
    study: "Study songs",
    songs: "Songs",
    help: "Help",
    resume: "Resume",
    settings: "Language / Settings",
    language: "Interface language:",
    changed: "Interface language saved.",
    suggested: "suggested",
    preferences:
      "Interface language: {interface}. Study helper language: {helper}. Learning language: English. Changing the interface does not change Study preferences. Manage your Study helper language on Pirate; this read-aloud pilot does not use translation exercises.",
    unset: "Not selected",
    helperEnglish: "English",
    helperRussian: "Russian",
    helperGeorgian: "Georgian",
    helperChinese: "Chinese",
    helperArabic: "Arabic",
    studyHelp:
      "/study shows the songs, /resume repeats the current line, /cancel stops. Answer each line by replying to it with a voice note.",
    discoveryHelp:
      "Use /songs to browse. Native Study is not available in this bot yet; open Pirate for Study, rewards and account changes. Use /help for these commands.",
    begin: "Send /start to begin, then /study or /songs. Use /help for help.",
    ended: "That lesson has ended. Use /study to start again.",
    setupUnavailable:
      "This channel setup link is unavailable. Create a new link in community settings.",
    setupChoose: "Choose the community content channel, then return to Pirate to confirm it.",
    setupButton: "Choose content channel",
    setupReturn: "Return to community settings in Pirate to confirm your selected channel.",
    noPublicSongs: "No public songs are available yet.",
    openSong: "Open song",
    unknown: "Unknown command. Use /help or /songs.",
    browseHint:
      "Use /songs to browse, or /help. Send /study to check whether practice is available.",
    messageLimit: "The daily message limit has been reached. Please try again tomorrow.",
    voiceUnavailable: "Voice input is unavailable. Send a text message instead.",
    complete: "🎉 Lesson complete!\n{correct}/{total} correct on the first try.",
    chooseSongAction: "Choose a song",
    practiceAgain: "Practice again",
    stopped: "Stopped. Use /resume to continue or /study for the songs.",
    processing: "Still checking your last answer.",
    chooseSong: "Choose a song to study:",
    sayThis: "Say this back:\n{line}",
    noReadySongs: "No songs are ready to study in this community yet.",
    selectionExpired: "That choice has expired. Use /study to choose again.",
    songUnavailable: "That song is not ready. Use /study to choose another.",
    chooseFirst: "Use /study to choose a song.",
    practiceUnavailable: "Practice cannot start right now. Try /study again later.",
    selectionUnavailable: "That choice is no longer available. Use /study to choose again.",
    sessionExpired: "That lesson has expired. Use /study to start again.",
    shorterVoice: "Keep voice notes under a minute. Reply to the line again.",
    replyToLine: "Reply to the current line with your voice note. Use /resume to see it again.",
    heard: "You said: “{answer}”",
    correct: "✅ Correct",
    rerecord: "I didn't catch that recording. Please try again.",
    incorrect: "❌ Incorrect",
    voiceRequired: "Reply to the line with a voice note.",
    gradingTimeout: "Checking took too long. Try again.",
    gradingUnavailable: "Voice checking is unavailable right now. Try again.",
    answerUnavailable: "That answer couldn't be used. Try again.",
    grantUnavailable: "This lesson is unavailable. Use /study to start again.",
  },
  ru: {
    discoveryWelcome:
      "Добро пожаловать в {community}. Здесь можно просматривать песни сообщества. Практика чтения вслух в этом боте пока не включена. Выберите язык интерфейса ниже.",
    study: "Практика по песням",
    songs: "Песни",
    help: "Помощь",
    resume: "Продолжить",
    settings: "Язык / Настройки",
    language: "Язык интерфейса:",
    changed: "Язык интерфейса сохранён.",
    suggested: "рекомендуемый",
    preferences:
      "Язык интерфейса: {interface}. Вспомогательный язык обучения: {helper}. Изучаемый язык: английский. Изменение интерфейса не меняет настройки обучения. Вспомогательный язык можно настроить в Pirate; в этой пробной практике нет заданий на перевод.",
    unset: "Не выбран",
    helperEnglish: "Английский",
    helperRussian: "Русский",
    helperGeorgian: "Грузинский",
    helperChinese: "Китайский",
    helperArabic: "Арабский",
    studyHelp:
      "/study показывает песни, /resume повторяет текущую строку, /cancel останавливает урок. Отвечайте на каждую строку голосовым сообщением.",
    discoveryHelp:
      "Отправьте /songs, чтобы посмотреть песни. Обучение в чате этого бота пока недоступно; откройте Pirate для обучения, наград и настроек аккаунта. /help показывает эти команды.",
    begin: "Отправьте /start, затем /study или /songs. Для помощи используйте /help.",
    ended: "Этот урок завершён. Отправьте /study, чтобы начать снова.",
    setupUnavailable: "Ссылка настройки канала недоступна. Создайте новую в настройках сообщества.",
    setupChoose: "Выберите канал сообщества, затем вернитесь в Pirate и подтвердите выбор.",
    setupButton: "Выбрать канал",
    setupReturn: "Вернитесь в настройки сообщества в Pirate и подтвердите выбранный канал.",
    noPublicSongs: "Публичных песен пока нет.",
    openSong: "Открыть песню",
    unknown: "Неизвестная команда. Используйте /help или /songs.",
    browseHint:
      "Посмотрите песни через /songs или помощь через /help. Отправьте /study, чтобы проверить доступность практики.",
    messageLimit: "Дневной лимит сообщений достигнут. Попробуйте завтра.",
    voiceUnavailable: "Голосовой ввод недоступен. Отправьте текстовое сообщение.",
    complete: "🎉 Урок завершён!\n{correct}/{total} с первой попытки.",
    chooseSongAction: "Выбрать песню",
    practiceAgain: "Ещё раз",
    stopped: "Остановлено. Отправьте /resume, чтобы продолжить, или /study, чтобы открыть песни.",
    processing: "Предыдущий ответ ещё проверяется.",
    chooseSong: "Выберите песню для изучения:",
    sayThis: "Произнесите:\n{line}",
    noReadySongs: "В этом сообществе пока нет готовых для изучения песен.",
    selectionExpired: "Срок выбора истёк. Отправьте /study и выберите снова.",
    songUnavailable: "Эта песня не готова. Отправьте /study и выберите другую.",
    chooseFirst: "Отправьте /study, чтобы выбрать песню.",
    practiceUnavailable: "Сейчас начать практику нельзя. Отправьте /study позже.",
    selectionUnavailable: "Этот выбор больше недоступен. Отправьте /study и выберите снова.",
    sessionExpired: "Срок урока истёк. Отправьте /study, чтобы начать снова.",
    shorterVoice: "Голосовое сообщение должно быть короче минуты. Ответьте на строку ещё раз.",
    replyToLine: "Ответьте голосовым сообщением на текущую строку. /resume покажет её снова.",
    heard: "Вы сказали: “{answer}”",
    correct: "✅ Верно",
    rerecord: "Не удалось разобрать запись. Попробуйте ещё раз.",
    incorrect: "❌ Неверно",
    voiceRequired: "Ответьте на строку голосовым сообщением.",
    gradingTimeout: "Проверка заняла слишком много времени. Попробуйте ещё раз.",
    gradingUnavailable: "Проверка голосовых сообщений сейчас недоступна. Попробуйте ещё раз.",
    answerUnavailable: "Этот ответ не удалось принять. Попробуйте ещё раз.",
    grantUnavailable: "Этот урок недоступен. Отправьте /study, чтобы начать снова.",
  },
  ka: {
    discoveryWelcome:
      "კეთილი იყოს თქვენი მობრძანება — {community}. აქ შეგიძლიათ თემის სიმღერების ნახვა. ამ ბოტში ხმამაღლა კითხვის ვარჯიში ჯერ არ არის ჩართული. ქვემოთ აირჩიეთ ინტერფეისის ენა.",
    study: "სიმღერების სწავლა",
    songs: "სიმღერები",
    help: "დახმარება",
    resume: "გაგრძელება",
    settings: "ენა / პარამეტრები",
    language: "ინტერფეისის ენა:",
    changed: "ინტერფეისის ენა შენახულია.",
    suggested: "რეკომენდებული",
    preferences:
      "ინტერფეისის ენა: {interface}. სწავლის დამხმარე ენა: {helper}. შესასწავლი ენა: ინგლისური. ინტერფეისის შეცვლა სწავლის პარამეტრებს არ ცვლის. დამხმარე ენა Pirate-ში შეცვალეთ; ამ საცდელ ვარჯიშში თარგმნის დავალებები არ არის.",
    unset: "არ არის არჩეული",
    helperEnglish: "ინგლისური",
    helperRussian: "რუსული",
    helperGeorgian: "ქართული",
    helperChinese: "ჩინური",
    helperArabic: "არაბული",
    studyHelp:
      "/study აჩვენებს სიმღერებს, /resume იმეორებს მიმდინარე სტრიქონს, /cancel აჩერებს გაკვეთილს. თითოეულ სტრიქონს უპასუხეთ ხმოვანი შეტყობინებით.",
    discoveryHelp:
      "სიმღერების სანახავად გამოიყენეთ /songs. ამ ბოტში ჩატით სწავლა ჯერ მიუწვდომელია; სწავლისთვის, ჯილდოებისა და ანგარიშის პარამეტრებისთვის გახსენით Pirate. /help ამ ბრძანებებს აჩვენებს.",
    begin: "დასაწყებად გაგზავნეთ /start, შემდეგ /study ან /songs. დახმარებისთვის გამოიყენეთ /help.",
    ended: "ეს გაკვეთილი დასრულებულია. თავიდან დასაწყებად გაგზავნეთ /study.",
    setupUnavailable:
      "არხის დაყენების ბმული მიუწვდომელია. თემის პარამეტრებში შექმენით ახალი ბმული.",
    setupChoose: "აირჩიეთ თემის არხი, შემდეგ დაბრუნდით Pirate-ში და დაადასტურეთ არჩევანი.",
    setupButton: "არხის არჩევა",
    setupReturn: "დაბრუნდით Pirate-ში თემის პარამეტრებზე და დაადასტურეთ არჩეული არხი.",
    noPublicSongs: "საჯარო სიმღერები ჯერ არ არის.",
    openSong: "სიმღერის გახსნა",
    unknown: "უცნობი ბრძანება. გამოიყენეთ /help ან /songs.",
    browseHint:
      "სიმღერებისთვის გამოიყენეთ /songs, დახმარებისთვის — /help. ვარჯიშის ხელმისაწვდომობის შესამოწმებლად გაგზავნეთ /study.",
    messageLimit: "დღიური შეტყობინებების ლიმიტი ამოიწურა. სცადეთ ხვალ.",
    voiceUnavailable: "ხმოვანი შეყვანა მიუწვდომელია. გაგზავნეთ ტექსტური შეტყობინება.",
    complete: "🎉 გაკვეთილი დასრულდა!\n{correct}/{total} პირველივე ცდაზე.",
    chooseSongAction: "სიმღერის არჩევა",
    practiceAgain: "კიდევ ერთხელ",
    stopped: "შეჩერებულია. გასაგრძელებლად გაგზავნეთ /resume, სიმღერებისთვის — /study.",
    processing: "წინა პასუხი ჯერ მოწმდება.",
    chooseSong: "აირჩიეთ სასწავლი სიმღერა:",
    sayThis: "თქვით:\n{line}",
    noReadySongs: "ამ თემში სასწავლად მზად სიმღერები ჯერ არ არის.",
    selectionExpired: "არჩევანის ვადა გავიდა. /study-ით აირჩიეთ ხელახლა.",
    songUnavailable: "ეს სიმღერა მზად არ არის. /study-ით აირჩიეთ სხვა.",
    chooseFirst: "სიმღერის ასარჩევად გაგზავნეთ /study.",
    practiceUnavailable: "ვარჯიშის დაწყება ახლა ვერ ხერხდება. მოგვიანებით გაგზავნეთ /study.",
    selectionUnavailable: "ეს არჩევანი აღარ არის ხელმისაწვდომი. /study-ით აირჩიეთ ხელახლა.",
    sessionExpired: "გაკვეთილის ვადა გავიდა. თავიდან დასაწყებად გაგზავნეთ /study.",
    shorterVoice: "ხმოვანი შეტყობინება ერთ წუთზე მოკლე უნდა იყოს. სტრიქონს ხელახლა უპასუხეთ.",
    replyToLine: "მიმდინარე სტრიქონს ხმოვანი შეტყობინებით უპასუხეთ. /resume მას ხელახლა აჩვენებს.",
    heard: "თქვენ თქვით: “{answer}”",
    correct: "✅ სწორია",
    rerecord: "ჩანაწერი ვერ გავიგე. გთხოვთ, სცადოთ ხელახლა.",
    incorrect: "❌ არასწორია",
    voiceRequired: "სტრიქონს ხმოვანი შეტყობინებით უპასუხეთ.",
    gradingTimeout: "შემოწმება დიდხანს გაგრძელდა. სცადეთ ხელახლა.",
    gradingUnavailable: "ხმოვანი პასუხების შემოწმება ახლა მიუწვდომელია. სცადეთ ხელახლა.",
    answerUnavailable: "ამ პასუხის მიღება ვერ მოხერხდა. სცადეთ ხელახლა.",
    grantUnavailable: "ეს გაკვეთილი მიუწვდომელია. თავიდან დასაწყებად გაგზავნეთ /study.",
  },
} as const satisfies Record<TelegramLocale, Record<string, string>>;

export type TelegramCopyKey = keyof typeof telegramCatalogs.en;
export const telegramLanguageNames = { en: "English", ru: "Русский", ka: "ქართული" } as const;
const helperNames = {
  en: "helperEnglish",
  ru: "helperRussian",
  ka: "helperGeorgian",
  zh: "helperChinese",
  ar: "helperArabic",
} as const;
export function telegramHelperLanguageName(locale: TelegramLocale, value: string | null) {
  if (value === null) return telegramText(locale, "unset");
  try {
    const language = Schema.decodeUnknownOption(NamedHelperLanguage)(
      new Intl.Locale(value).language,
    );
    return language._tag === "Some" ? telegramText(locale, helperNames[language.value]) : value;
  } catch {
    return value;
  }
}
export function telegramText(
  locale: TelegramLocale,
  key: TelegramCopyKey,
  values: Readonly<Record<string, string | number>> = {},
) {
  return telegramCatalogs[locale][key].replace(/\{([A-Za-z]+)\}/gu, (_match, name: string) => {
    if (values[name] === undefined) throw Error(`Missing Telegram copy parameter: ${key}.${name}`);
    return String(values[name]);
  });
}
