import { Schema } from "effect";

export const TelegramLocale = Schema.Literals(["en", "ru", "ka"]);
export type TelegramLocale = Schema.Schema.Type<typeof TelegramLocale>;
const LanguageTag = Schema.String.check(Schema.isMaxLength(64));

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
    : (telegramLocale(context.accountLocale) ??
        telegramLocale(suggested) ??
        context.preference?.locale ??
        "en");
}

// Application-owned drafts. Language-qualified review is required before cohort acceptance.
export const telegramCatalogs = {
  en: {
    welcome:
      "Welcome to {community}. Practice English song lines by reading aloud and replying with voice notes. Practice only; no rewards are earned. The community owner can read your messages and listen to your voice notes.",
    discoveryWelcome:
      "Welcome to {community}. Browse this community’s songs here. Read-aloud practice is not enabled in this bot yet. Choose your interface language below.",
    study: "Study songs",
    songs: "Browse songs",
    help: "Help",
    resume: "Resume",
    settings: "Language / Settings",
    language: "Interface language:",
    changed: "Interface language saved.",
    suggested: "suggested",
    preferences:
      "Interface language: {interface}. Study helper language: {helper}. Learning language: English. Changing the interface does not change Study preferences. Manage your Study helper language on Pirate; this read-aloud pilot does not use translation exercises.",
    unset: "Not selected",
    studyHelp:
      "Use /study to choose a ready song, /resume to continue, and /cancel to stop. Practice only: read each line aloud and reply to it with a voice note. Voice answers are required. The community owner can read your messages and listen to your voice notes. Manage your link and persona on Pirate.",
    discoveryHelp:
      "Use /songs to browse. Native Study is not available in this bot yet; open Pirate for Study, rewards and account changes. Use /help for these commands.",
    begin: "Send /start to begin, then /study or /songs. Use /help for help.",
    ended: "This lesson has ended. Use /study to start again.",
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
    complete:
      "{prefix}\nPersona: {persona} ({personaId})\nPractice complete. {correct}/{total} correct on the first try; the threshold was {required}. No reward or pool share was earned.",
    card: "{prefix}\nPersona: {persona} ({personaId})\nPractice only. {total} cards; {required} first-try correct to meet the threshold.\nProgress: {resolved}/{total}; first-try correct: {correct}.\nRead aloud (presentation {presentation}):\n{line}\nReply to this message with a voice note. /resume repeats the prompt; /cancel stops.",
    stopped:
      "Practice stopped. Your Study progress is saved. Use /resume to return within the session lifetime, or /study to choose a song.",
    processing:
      "Your previous voice answer has not finished. Please wait, or use /cancel before starting another lesson. No new answer was submitted.",
    chooseSong: "Choose a song:",
    noReadySongs: "No ready practice songs are available here yet. Use /help for help.",
    selectionExpired: "This song selection has expired. Use /study to choose again.",
    songUnavailable: "This song is not ready for practice. Use /study to choose another.",
    link: "Practice only. Voice answers are required: you will read lines aloud and send voice notes. The community owner can read your messages and listen to them. Link on Pirate, explicitly choose your community persona, then return here and use /resume. Owners of multiple bots can correlate your Telegram identity across them.",
    linkButton: "Link with Pirate",
    chooseBeforeLink:
      "Use /study to choose a ready song before linking. Manage your Telegram link and community persona on Pirate.",
    selectionUnavailable: "This song selection is unavailable. Use /study to choose again.",
    noReferenceAudio: "Read-aloud practice; there is no reference audio.",
    sessionExpired: "This practice session has expired. Use /study to start again.",
    resuming: "Resuming saved practice.",
    shorterVoice:
      "Keep voice notes to a minute or less and at most 512 KiB. No attempt was used. Reply to the current line with a shorter note, or use /resume.",
    replyToLine:
      "Reply to the current line with your voice note so it can be graded safely. No attempt was used. Use /resume to show it again.",
    heard: "Heard: {answer}",
    nothingClear: "(nothing clear)",
    trySaying: "Try saying: {words}",
    correct: "Correct.",
    rerecord: "Record this line again. No attempt was used.",
    incorrect: "This presentation was incorrect. Continue with the line shown below.",
    voiceRequired:
      "This read-aloud lesson requires a voice note replying to the current line. Typed text does not use an attempt. Use /resume or /cancel.",
    gradingTimeout:
      "Voice grading took too long. Your link does not need to be changed. Resuming current practice.",
    gradingUnavailable:
      "Voice grading is temporarily unavailable. No attempt was used. Resuming current practice.",
    answerUnavailable: "That answer could not be accepted. Resuming current practice.",
    grantUnavailable:
      "This lesson or its authorization is unavailable. Check your link and persona on Pirate, then use /study.",
  },
  ru: {
    welcome:
      "Добро пожаловать в {community}. Практикуйте английский: читайте строки песен вслух и отвечайте голосовыми сообщениями. Это только практика, без наград. Владелец сообщества может читать ваши сообщения и слушать ваши записи.",
    discoveryWelcome:
      "Добро пожаловать в {community}. Здесь можно просматривать песни сообщества. Практика чтения вслух в этом боте пока не включена. Выберите язык интерфейса ниже.",
    study: "Учить песни",
    songs: "Посмотреть песни",
    help: "Помощь",
    resume: "Продолжить",
    settings: "Язык / Настройки",
    language: "Язык интерфейса:",
    changed: "Язык интерфейса сохранён.",
    suggested: "рекомендуется",
    preferences:
      "Язык интерфейса: {interface}. Вспомогательный язык обучения: {helper}. Изучаемый язык: английский. Изменение интерфейса не меняет настройки обучения. Вспомогательный язык можно настроить в Pirate; в этой пробной практике нет заданий на перевод.",
    unset: "Не выбран",
    studyHelp:
      "Отправьте /study, чтобы выбрать готовую песню, /resume, чтобы продолжить, или /cancel, чтобы остановиться. Это только практика: читайте каждую строку вслух и отвечайте на неё голосовым сообщением. Нужны голосовые ответы. Владелец сообщества может читать ваши сообщения и слушать записи. Управляйте связью аккаунта и персоной в Pirate.",
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
    complete:
      "{prefix}\nПерсона: {persona} ({personaId})\nПрактика завершена. С первой попытки верно: {correct}/{total}; порог: {required}. Награда или доля в пуле не начислена.",
    card: "{prefix}\nПерсона: {persona} ({personaId})\nТолько практика. Карточек: {total}; для достижения порога нужно {required} верных ответов с первой попытки.\nПрогресс: {resolved}/{total}; верно с первой попытки: {correct}.\nПрочитайте вслух (показ {presentation}):\n{line}\nОтветьте на это сообщение голосовой записью. /resume повторяет задание; /cancel останавливает практику.",
    stopped:
      "Практика остановлена. Прогресс сохранён. Отправьте /resume до истечения срока сессии или /study, чтобы выбрать песню.",
    processing:
      "Предыдущий голосовой ответ ещё обрабатывается. Подождите или используйте /cancel перед новым уроком. Новый ответ не отправлен.",
    chooseSong: "Выберите песню:",
    noReadySongs: "Здесь пока нет песен, готовых для практики. Для помощи используйте /help.",
    selectionExpired: "Срок выбора песни истёк. Отправьте /study и выберите снова.",
    songUnavailable: "Эта песня не готова для практики. Отправьте /study и выберите другую.",
    link: "Это только практика. Нужны голосовые ответы: вы будете читать строки вслух и отправлять записи. Владелец сообщества может читать ваши сообщения и слушать записи. Свяжите аккаунт в Pirate, явно выберите персону сообщества, затем вернитесь сюда и отправьте /resume. Владельцы нескольких ботов могут сопоставить вашу личность в Telegram между ними.",
    linkButton: "Связать с Pirate",
    chooseBeforeLink:
      "Перед связыванием выберите готовую песню через /study. Управляйте связью Telegram и персоной сообщества в Pirate.",
    selectionUnavailable: "Выбор песни недоступен. Отправьте /study и выберите снова.",
    noReferenceAudio: "Практика чтения вслух; образца аудио нет.",
    sessionExpired: "Срок этой практики истёк. Отправьте /study, чтобы начать снова.",
    resuming: "Продолжаем сохранённую практику.",
    shorterVoice:
      "Запись должна быть не длиннее минуты и не больше 512 КиБ. Попытка не использована. Ответьте на текущую строку более короткой записью или используйте /resume.",
    replyToLine:
      "Отправьте голосовой ответ именно на сообщение с текущей строкой, чтобы его можно было проверить. Попытка не использована. /resume покажет строку снова.",
    heard: "Распознано: {answer}",
    nothingClear: "(ничего не разобрано)",
    trySaying: "Попробуйте произнести: {words}",
    correct: "Верно.",
    rerecord: "Запишите эту строку снова. Попытка не использована.",
    incorrect: "Этот ответ неверный. Продолжите со строкой ниже.",
    voiceRequired:
      "Для этого урока нужен голосовой ответ на текущую строку. Текст не использует попытку. Используйте /resume или /cancel.",
    gradingTimeout:
      "Проверка записи заняла слишком много времени. Менять связь аккаунта не нужно. Продолжаем текущую практику.",
    gradingUnavailable:
      "Проверка записей временно недоступна. Попытка не использована. Продолжаем текущую практику.",
    answerUnavailable: "Не удалось принять ответ. Продолжаем текущую практику.",
    grantUnavailable:
      "Урок или разрешение недоступны. Проверьте связь аккаунта и персону в Pirate, затем отправьте /study.",
  },
  ka: {
    welcome:
      "კეთილი იყოს თქვენი მობრძანება — {community}. ივარჯიშეთ ინგლისურში: ხმამაღლა წაიკითხეთ სიმღერის სტრიქონები და უპასუხეთ ხმოვანი შეტყობინებებით. ეს მხოლოდ ვარჯიშია; ჯილდოები არ გაიცემა. თემის მფლობელს შეუძლია თქვენი შეტყობინებების წაკითხვა და ჩანაწერების მოსმენა.",
    discoveryWelcome:
      "კეთილი იყოს თქვენი მობრძანება — {community}. აქ შეგიძლიათ თემის სიმღერების ნახვა. ამ ბოტში ხმამაღლა კითხვის ვარჯიში ჯერ არ არის ჩართული. ქვემოთ აირჩიეთ ინტერფეისის ენა.",
    study: "სიმღერების სწავლა",
    songs: "სიმღერების ნახვა",
    help: "დახმარება",
    resume: "გაგრძელება",
    settings: "ენა / პარამეტრები",
    language: "ინტერფეისის ენა:",
    changed: "ინტერფეისის ენა შენახულია.",
    suggested: "რეკომენდებული",
    preferences:
      "ინტერფეისის ენა: {interface}. სწავლის დამხმარე ენა: {helper}. შესასწავლი ენა: ინგლისური. ინტერფეისის შეცვლა სწავლის პარამეტრებს არ ცვლის. დამხმარე ენა Pirate-ში შეცვალეთ; ამ საცდელ ვარჯიშში თარგმნის დავალებები არ არის.",
    unset: "არ არის არჩეული",
    studyHelp:
      "მზად სიმღერას ირჩევთ /study-ით, აგრძელებთ /resume-ით და აჩერებთ /cancel-ით. ეს მხოლოდ ვარჯიშია: თითოეული სტრიქონი ხმამაღლა წაიკითხეთ და უპასუხეთ ხმოვანი შეტყობინებით. აუცილებელია ხმოვანი პასუხი. თემის მფლობელს შეუძლია თქვენი შეტყობინებების წაკითხვა და ჩანაწერების მოსმენა. ანგარიშის დაკავშირება და პერსონა Pirate-ში მართეთ.",
    discoveryHelp:
      "სიმღერების სანახავად გამოიყენეთ /songs. ამ ბოტში ჩატით სწავლა ჯერ მიუწვდომელია; სწავლისთვის, ჯილდოებისა და ანგარიშის პარამეტრებისთვის გახსენით Pirate. /help ამ ბრძანებებს აჩვენებს.",
    begin:
      "გასაგრძელებლად გაგზავნეთ /start, შემდეგ /study ან /songs. დახმარებისთვის გამოიყენეთ /help.",
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
    complete:
      "{prefix}\nპერსონა: {persona} ({personaId})\nვარჯიში დასრულებულია. პირველი ცდიდან სწორია {correct}/{total}; საჭირო ზღვარია {required}. ჯილდო ან ფონდის წილი არ მიგიღიათ.",
    card: "{prefix}\nპერსონა: {persona} ({personaId})\nმხოლოდ ვარჯიში. ბარათები: {total}; ზღვრის მისაღწევად პირველი ცდიდან საჭიროა {required} სწორი პასუხი.\nპროგრესი: {resolved}/{total}; პირველი ცდიდან სწორია: {correct}.\nხმამაღლა წაიკითხეთ (ჩვენება {presentation}):\n{line}\nამ შეტყობინებას უპასუხეთ ხმოვანი ჩანაწერით. /resume დავალებას იმეორებს; /cancel ვარჯიშს აჩერებს.",
    stopped:
      "ვარჯიში შეჩერებულია. პროგრესი შენახულია. სესიის ვადის გასვლამდე დაბრუნდით /resume-ით, ან /study-ით აირჩიეთ სიმღერა.",
    processing:
      "წინა ხმოვანი პასუხი ჯერ მუშავდება. დაელოდეთ ან ახალი გაკვეთილის დაწყებამდე გამოიყენეთ /cancel. ახალი პასუხი არ გაგზავნილა.",
    chooseSong: "აირჩიეთ სიმღერა:",
    noReadySongs: "აქ სავარჯიშოდ მზად სიმღერები ჯერ არ არის. დახმარებისთვის გამოიყენეთ /help.",
    selectionExpired: "სიმღერის არჩევის ვადა გავიდა. /study-ით აირჩიეთ ხელახლა.",
    songUnavailable: "ეს სიმღერა სავარჯიშოდ მზად არ არის. /study-ით აირჩიეთ სხვა.",
    link: "ეს მხოლოდ ვარჯიშია. აუცილებელია ხმოვანი პასუხები: სტრიქონებს ხმამაღლა წაიკითხავთ და ჩანაწერებს გაგზავნით. თემის მფლობელს შეუძლია თქვენი შეტყობინებების წაკითხვა და ჩანაწერების მოსმენა. ანგარიში Pirate-ში დააკავშირეთ, თავად აირჩიეთ თემის პერსონა, შემდეგ დაბრუნდით აქ და გაგზავნეთ /resume. რამდენიმე ბოტის მფლობელს შეუძლია მათ შორის თქვენი Telegram-ის ვინაობის დაკავშირება.",
    linkButton: "Pirate-თან დაკავშირება",
    chooseBeforeLink:
      "დაკავშირებამდე /study-ით აირჩიეთ მზად სიმღერა. Telegram-ის კავშირი და თემის პერსონა Pirate-ში მართეთ.",
    selectionUnavailable: "სიმღერის არჩევა მიუწვდომელია. /study-ით აირჩიეთ ხელახლა.",
    noReferenceAudio: "ხმამაღლა კითხვის ვარჯიში; აუდიო ნიმუში არ არის.",
    sessionExpired: "ამ ვარჯიშის ვადა გავიდა. თავიდან დასაწყებად გაგზავნეთ /study.",
    resuming: "შენახულ ვარჯიშს ვაგრძელებთ.",
    shorterVoice:
      "ჩანაწერი არ უნდა აღემატებოდეს ერთ წუთსა და 512 კიბიბაიტს. ცდა არ გამოყენებულა. მიმდინარე სტრიქონს უფრო მოკლე ჩანაწერით უპასუხეთ ან გამოიყენეთ /resume.",
    replyToLine:
      "ხმოვანი ჩანაწერით უშუალოდ მიმდინარე სტრიქონის შეტყობინებას უპასუხეთ, რათა მისი შემოწმება შესაძლებელი იყოს. ცდა არ გამოყენებულა. /resume სტრიქონს ხელახლა აჩვენებს.",
    heard: "ამოცნობილია: {answer}",
    nothingClear: "(ვერაფერი გაირჩა)",
    trySaying: "სცადეთ წარმოთქმა: {words}",
    correct: "სწორია.",
    rerecord: "ეს სტრიქონი ხელახლა ჩაწერეთ. ცდა არ გამოყენებულა.",
    incorrect: "ეს პასუხი არასწორი იყო. გააგრძელეთ ქვემოთ ნაჩვენები სტრიქონით.",
    voiceRequired:
      "ამ გაკვეთილს მიმდინარე სტრიქონზე ხმოვანი პასუხი სჭირდება. ტექსტი ცდას არ იყენებს. გამოიყენეთ /resume ან /cancel.",
    gradingTimeout:
      "ჩანაწერის შემოწმება დიდხანს გაგრძელდა. ანგარიშის კავშირის შეცვლა არ გჭირდებათ. მიმდინარე ვარჯიშს ვაგრძელებთ.",
    gradingUnavailable:
      "ხმოვანი პასუხების შემოწმება დროებით მიუწვდომელია. ცდა არ გამოყენებულა. მიმდინარე ვარჯიშს ვაგრძელებთ.",
    answerUnavailable: "პასუხის მიღება ვერ მოხერხდა. მიმდინარე ვარჯიშს ვაგრძელებთ.",
    grantUnavailable:
      "გაკვეთილი ან ნებართვა მიუწვდომელია. Pirate-ში შეამოწმეთ ანგარიშის კავშირი და პერსონა, შემდეგ გაგზავნეთ /study.",
  },
} as const satisfies Record<TelegramLocale, Record<string, string>>;

export type TelegramCopyKey = keyof typeof telegramCatalogs.en;
export const telegramLanguageNames = { en: "English", ru: "Русский", ka: "ქართული" } as const;
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
