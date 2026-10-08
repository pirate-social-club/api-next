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
    welcome:
      "Welcome to {community}. Practice English song lines by reading aloud and replying with voice notes. Practice only; no rewards are earned. The community owner can read your messages and listen to your voice notes. Owners of multiple bots can recognize the same Telegram account across them.",
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
    helperEnglish: "English",
    helperRussian: "Russian",
    helperGeorgian: "Georgian",
    helperChinese: "Chinese",
    helperArabic: "Arabic",
    studyHelp:
      "Use /study to choose a ready song, /resume to continue, and /cancel to stop. Practice only: read each line aloud and reply to it with a voice note. Voice answers are required. The community owner can read your messages and listen to your voice notes. No sign-in is needed.",
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
      "{prefix}\n{identity}Practice complete. {correct}/{total} correct on the first try; the threshold was {required}. No reward or pool share was earned.",
    card: "{prefix}\n{identity}Practice only. {total} cards; {required} first-try correct to meet the threshold.\nProgress: {resolved}/{total}; first-try correct: {correct}.\nRead aloud:\n{line}\nReply to this message with a voice note. /resume repeats the prompt; /cancel stops.",
    stopped:
      "Practice stopped. Your Study progress is saved. Use /resume to return within the session lifetime, or /study to choose a song.",
    processing:
      "Your previous voice answer has not finished. Please wait, or use /cancel before starting another lesson. No new answer was submitted.",
    chooseSong: "Choose a song:",
    noReadySongs: "No ready practice songs are available here yet. Use /help for help.",
    selectionExpired: "This song selection has expired. Use /study to choose again.",
    songUnavailable: "This song is not ready for practice. Use /study to choose another.",
    personaLine: "Persona: {persona}",
    practiceOnly: "This lesson is practice only. No rewards are earned in this lesson.",
    ageQuestion:
      "This lesson is practice only. No rewards are earned in this lesson. You will read lines aloud and send voice notes. The community owner can read your messages and listen to your voice notes. Pirate keeps a private practice profile for you so your progress resumes in this bot. No sign-in is needed. Are you 16 or older?",
    ageYes: "I'm 16 or older",
    ageNo: "I'm under 16",
    under16: "Practice in this bot is for learners aged 16 or older. No profile was created.",
    chooseFirst: "Use /study to choose a ready song.",
    practiceUnavailable: "Practice cannot start right now. Use /study to try again later.",
    connectOptional: "Optional: you can connect an existing Pirate account.",
    connectButton: "Connect an existing Pirate account",
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
    gradingTimeout: "Voice grading took too long. Resuming current practice.",
    gradingUnavailable:
      "Voice grading is temporarily unavailable. No attempt was used. Resuming current practice.",
    answerUnavailable: "That answer could not be accepted. Resuming current practice.",
    grantUnavailable: "This lesson is unavailable. Use /study to start again.",
  },
  ru: {
    welcome:
      "Добро пожаловать в {community}. Практикуйте английский: читайте строки песен вслух и отвечайте голосовыми сообщениями. Это только практика, без наград. Владелец сообщества может читать ваши сообщения и слушать ваши голосовые сообщения. Владельцы нескольких ботов могут понять, что в них пишет один и тот же аккаунт Telegram.",
    discoveryWelcome:
      "Добро пожаловать в {community}. Здесь можно просматривать песни сообщества. Практика чтения вслух в этом боте пока не включена. Выберите язык интерфейса ниже.",
    study: "Практика по песням",
    songs: "Посмотреть песни",
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
      "Отправьте /study, чтобы выбрать готовую песню, /resume, чтобы продолжить, или /cancel, чтобы остановиться. Это только практика: читайте каждую строку вслух и отвечайте на неё голосовым сообщением. Нужны голосовые ответы. Владелец сообщества может читать ваши сообщения и слушать ваши голосовые сообщения. Вход в аккаунт не нужен.",
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
      "{prefix}\n{identity}Практика завершена. С первой попытки верно: {correct}/{total}; порог: {required}. Ни награда, ни доля в пуле не начислены.",
    card: "{prefix}\n{identity}Только практика. Карточек: {total}; для достижения порога нужно {required} верных ответов с первой попытки.\nПрогресс: {resolved}/{total}; верно с первой попытки: {correct}.\nПрочитайте вслух:\n{line}\nОтветьте на это сообщение голосовым сообщением. /resume повторяет задание; /cancel останавливает практику.",
    stopped:
      "Практика остановлена. Прогресс сохранён. Отправьте /resume до истечения срока сессии или /study, чтобы выбрать песню.",
    processing:
      "Предыдущий голосовой ответ ещё обрабатывается. Подождите или используйте /cancel перед новым уроком. Новый ответ не отправлен.",
    chooseSong: "Выберите песню:",
    noReadySongs: "Здесь пока нет песен, готовых для практики. Для помощи используйте /help.",
    selectionExpired: "Срок выбора песни истёк. Отправьте /study и выберите снова.",
    songUnavailable: "Эта песня не готова для практики. Отправьте /study и выберите другую.",
    personaLine: "Персона: {persona}",
    practiceOnly: "Этот урок — только практика. Награды за него не начисляются.",
    ageQuestion:
      "Этот урок — только практика. Награды за него не начисляются. Вы будете читать строки вслух и отправлять голосовые сообщения. Владелец сообщества может читать ваши сообщения и слушать ваши голосовые сообщения. Pirate сохранит для вас закрытый учебный профиль, чтобы прогресс продолжался в этом боте. Вход в аккаунт не нужен. Вам уже есть 16 лет?",
    ageYes: "Мне 16 лет или больше",
    ageNo: "Мне меньше 16 лет",
    under16: "Практика в этом боте доступна с 16 лет. Профиль не создан.",
    chooseFirst: "Отправьте /study, чтобы выбрать готовую песню.",
    practiceUnavailable: "Сейчас практику начать нельзя. Отправьте /study позже.",
    connectOptional: "По желанию можно подключить существующий аккаунт Pirate.",
    connectButton: "Подключить аккаунт Pirate",
    selectionUnavailable: "Выбор песни недоступен. Отправьте /study и выберите снова.",
    noReferenceAudio: "Практика чтения вслух; аудиопримера нет.",
    sessionExpired: "Срок этой практики истёк. Отправьте /study, чтобы начать снова.",
    resuming: "Продолжаем сохранённую практику.",
    shorterVoice:
      "Голосовое сообщение должно быть не длиннее минуты и не больше 512 КиБ. Попытка не использована. Ответьте на текущую строку более коротким голосовым сообщением или используйте /resume.",
    replyToLine:
      "Отправьте голосовой ответ именно на сообщение с текущей строкой, чтобы его можно было проверить. Попытка не использована. /resume покажет строку снова.",
    heard: "Распознано: {answer}",
    nothingClear: "(ничего не разобрано)",
    trySaying: "Попробуйте произнести: {words}",
    correct: "Верно.",
    rerecord: "Отправьте голосовое сообщение с этой строкой ещё раз. Попытка не использована.",
    incorrect: "Этот ответ неверный. Продолжите со строкой ниже.",
    voiceRequired:
      "Для этого урока нужен голосовой ответ на текущую строку. Текст не использует попытку. Используйте /resume или /cancel.",
    gradingTimeout:
      "Проверка голосового сообщения заняла слишком много времени. Продолжаем текущую практику.",
    gradingUnavailable:
      "Проверка голосовых сообщений временно недоступна. Попытка не использована. Продолжаем текущую практику.",
    answerUnavailable: "Не удалось принять ответ. Продолжаем текущую практику.",
    grantUnavailable: "Этот урок недоступен. Отправьте /study, чтобы начать снова.",
  },
  ka: {
    welcome:
      "კეთილი იყოს თქვენი მობრძანება — {community}. ივარჯიშეთ ინგლისურში: ხმამაღლა წაიკითხეთ სიმღერის სტრიქონები და უპასუხეთ ხმოვანი შეტყობინებებით. ეს მხოლოდ ვარჯიშია; ჯილდოები არ გაიცემა. თემის მფლობელს შეუძლია თქვენი შეტყობინებების წაკითხვა და ხმოვანი შეტყობინებების მოსმენა. რამდენიმე ბოტის მფლობელს შეუძლია მათ შორის თქვენი Telegram-ის ვინაობის დაკავშირება.",
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
    helperEnglish: "ინგლისური",
    helperRussian: "რუსული",
    helperGeorgian: "ქართული",
    helperChinese: "ჩინური",
    helperArabic: "არაბული",
    studyHelp:
      "მზა სიმღერას ირჩევთ /study-ით, აგრძელებთ /resume-ით და აჩერებთ /cancel-ით. ეს მხოლოდ ვარჯიშია: თითოეული სტრიქონი ხმამაღლა წაიკითხეთ და უპასუხეთ ხმოვანი შეტყობინებით. აუცილებელია ხმოვანი პასუხი. თემის მფლობელს შეუძლია თქვენი შეტყობინებების წაკითხვა და ხმოვანი შეტყობინებების მოსმენა. ანგარიშში შესვლა საჭირო არ არის.",
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
    complete:
      "{prefix}\n{identity}ვარჯიში დასრულებულია. პირველი ცდიდან სწორია {correct}/{total}; საჭირო ზღვარია {required}. ჯილდო ან ფონდის წილი არ მიგიღიათ.",
    card: "{prefix}\n{identity}მხოლოდ ვარჯიში. ბარათები: {total}; ზღვრის მისაღწევად პირველი ცდიდან საჭიროა {required} სწორი პასუხი.\nპროგრესი: {resolved}/{total}; პირველი ცდიდან სწორია: {correct}.\nხმამაღლა წაიკითხეთ:\n{line}\nამ შეტყობინებას უპასუხეთ ხმოვანი ჩანაწერით. /resume დავალებას იმეორებს; /cancel ვარჯიშს აჩერებს.",
    stopped:
      "ვარჯიში შეჩერებულია. პროგრესი შენახულია. სესიის ვადის გასვლამდე დაბრუნდით /resume-ით, ან /study-ით აირჩიეთ სიმღერა.",
    processing:
      "წინა ხმოვანი პასუხი ჯერ მუშავდება. დაელოდეთ ან ახალი გაკვეთილის დაწყებამდე გამოიყენეთ /cancel. ახალი პასუხი არ გაგზავნილა.",
    chooseSong: "აირჩიეთ სიმღერა:",
    noReadySongs: "აქ სავარჯიშოდ მზა სიმღერები ჯერ არ არის. დახმარებისთვის გამოიყენეთ /help.",
    selectionExpired: "სიმღერის არჩევის ვადა გავიდა. /study-ით აირჩიეთ ხელახლა.",
    songUnavailable: "ეს სიმღერა სავარჯიშოდ მზად არ არის. /study-ით აირჩიეთ სხვა.",
    personaLine: "პერსონა: {persona}",
    practiceOnly: "ეს გაკვეთილი მხოლოდ ვარჯიშია. ამ გაკვეთილში ჯილდოები არ გაიცემა.",
    ageQuestion:
      "ეს გაკვეთილი მხოლოდ ვარჯიშია. ამ გაკვეთილში ჯილდოები არ გაიცემა. სტრიქონებს ხმამაღლა წაიკითხავთ და ხმოვან შეტყობინებებს გაგზავნით. თემის მფლობელს შეუძლია თქვენი შეტყობინებების წაკითხვა და ხმოვანი შეტყობინებების მოსმენა. Pirate თქვენთვის დახურულ სავარჯიშო პროფილს შეინახავს, რათა პროგრესი ამ ბოტში გაგრძელდეს. ანგარიშში შესვლა საჭირო არ არის. ხართ თუ არა 16 წლის ან მეტის?",
    ageYes: "16 წლის ან მეტის ვარ",
    ageNo: "16 წელზე ნაკლების ვარ",
    under16: "ამ ბოტში ვარჯიში 16 წლიდანაა შესაძლებელი. პროფილი არ შექმნილა.",
    chooseFirst: "მზა სიმღერის ასარჩევად გაგზავნეთ /study.",
    practiceUnavailable: "ვარჯიშის დაწყება ახლა ვერ ხერხდება. მოგვიანებით გაგზავნეთ /study.",
    connectOptional: "სურვილისამებრ შეგიძლიათ არსებული Pirate-ის ანგარიშის დაკავშირება.",
    connectButton: "Pirate-ის ანგარიშის დაკავშირება",
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
    trySaying: "სცადეთ თქვათ: {words}",
    correct: "სწორია.",
    rerecord: "ეს სტრიქონი ხელახლა ჩაწერეთ. ცდა არ გამოყენებულა.",
    incorrect: "ეს პასუხი არასწორი იყო. გააგრძელეთ ქვემოთ ნაჩვენები სტრიქონით.",
    voiceRequired:
      "ამ გაკვეთილს მიმდინარე სტრიქონზე ხმოვანი პასუხი სჭირდება. ტექსტი ცდას არ იყენებს. გამოიყენეთ /resume ან /cancel.",
    gradingTimeout: "ჩანაწერის შემოწმება დიდხანს გაგრძელდა. მიმდინარე ვარჯიშს ვაგრძელებთ.",
    gradingUnavailable:
      "ხმოვანი პასუხების შემოწმება დროებით მიუწვდომელია. ცდა არ გამოყენებულა. მიმდინარე ვარჯიშს ვაგრძელებთ.",
    answerUnavailable: "პასუხის მიღება ვერ მოხერხდა. მიმდინარე ვარჯიშს ვაგრძელებთ.",
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
