export type StudyAnswer =
  | Readonly<{ kind: "text_response"; text: string }>
  | Readonly<{ kind: "single_select"; choiceKey: string }>;

export type StudyAnswerKey =
  | Readonly<{
      kind: "text_response";
      comparison: "unicode_casefold_whitespace_v1";
      acceptedAnswers: readonly [string, ...string[]];
    }>
  | Readonly<{ kind: "single_select"; correctChoiceKey: string }>;

export type StudyItemCompletion = Readonly<{
  presentationCount: number;
  firstPassOutcome: "correct" | "incorrect" | null;
}>;

export type StudyQualificationEvaluation = Readonly<{
  qualifyingExerciseCount: number;
  firstPassCorrect: number;
  requiredCorrect: number;
  scoreBps: number;
  qualifies: boolean;
}>;

export type KaraokeQualificationInput = Readonly<{
  completionReason: "completed" | "session_error" | "provider_unavailable" | "abandoned";
  scoredLineCount: number;
  lineCount: number;
  finalScoreBps: number;
}>;

export type KaraokeQualificationEvaluation = Readonly<{
  scoredLineCount: number;
  lineCount: number;
  coverageBps: number;
  finalScoreBps: number;
  qualifies: boolean;
}>;

export type ActivityStreakProjection = Readonly<{
  current: number;
  best: number;
  startedDay: string;
  lastDay: string;
  totalDays: number;
  activeUntilAt: string;
}>;

export class QualificationEvidenceInvalid extends Error {
  readonly _tag = "QualificationEvidenceInvalid";

  constructor(
    readonly reason:
      | "answer-kind"
      | "empty-study-session"
      | "invalid-count"
      | "invalid-day"
      | "unanswered-study-item",
  ) {
    super(reason);
  }
}

const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

const canonicalWhitespace = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("und").trim().replaceAll(/\s+/gu, " ");

export function gradeStudyAnswer(answer: StudyAnswer, answerKey: StudyAnswerKey): boolean {
  if (answer.kind !== answerKey.kind) {
    throw new QualificationEvidenceInvalid("answer-kind");
  }
  if (answer.kind === "single_select" && answerKey.kind === "single_select") {
    return answer.choiceKey === answerKey.correctChoiceKey;
  }
  if (answer.kind === "text_response" && answerKey.kind === "text_response") {
    const candidate = canonicalWhitespace(answer.text);
    return answerKey.acceptedAnswers.some(
      (accepted) => canonicalWhitespace(accepted) === candidate,
    );
  }
  throw new QualificationEvidenceInvalid("answer-kind");
}

export const requiredStudyCorrect = (qualifyingExerciseCount: number): number => {
  if (!Number.isSafeInteger(qualifyingExerciseCount) || qualifyingExerciseCount <= 0) {
    throw new QualificationEvidenceInvalid("empty-study-session");
  }
  return Math.max(1, Math.ceil((7 * qualifyingExerciseCount) / 10));
};

export function evaluateStudyQualification(
  items: readonly StudyItemCompletion[],
): StudyQualificationEvaluation {
  const qualifyingExerciseCount = items.length;
  const requiredCorrect = requiredStudyCorrect(qualifyingExerciseCount);
  let firstPassCorrect = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.presentationCount) || item.presentationCount <= 0) {
      throw new QualificationEvidenceInvalid("invalid-count");
    }
    if (item.firstPassOutcome === null) {
      throw new QualificationEvidenceInvalid("unanswered-study-item");
    }
    if (item.firstPassOutcome === "correct") firstPassCorrect += 1;
  }
  const scoreBps = Math.floor((10_000 * firstPassCorrect) / qualifyingExerciseCount);
  return {
    qualifyingExerciseCount,
    firstPassCorrect,
    requiredCorrect,
    scoreBps,
    qualifies: firstPassCorrect >= requiredCorrect,
  };
}

export function evaluateKaraokeQualification(
  input: KaraokeQualificationInput,
): KaraokeQualificationEvaluation {
  if (
    !Number.isSafeInteger(input.scoredLineCount) ||
    !Number.isSafeInteger(input.lineCount) ||
    !Number.isSafeInteger(input.finalScoreBps) ||
    input.scoredLineCount < 0 ||
    input.lineCount <= 0 ||
    input.scoredLineCount > input.lineCount ||
    input.finalScoreBps < 0 ||
    input.finalScoreBps > 10_000
  ) {
    throw new QualificationEvidenceInvalid("invalid-count");
  }
  const coverageBps = Math.floor((10_000 * input.scoredLineCount) / input.lineCount);
  return {
    scoredLineCount: input.scoredLineCount,
    lineCount: input.lineCount,
    coverageBps,
    finalScoreBps: input.finalScoreBps,
    qualifies:
      input.completionReason === "completed" &&
      input.scoredLineCount >= 5 &&
      coverageBps >= 8_500 &&
      input.finalScoreBps >= 7_000,
  };
}

const parseDateParts = (date: string): readonly [number, number, number] => {
  if (!canonicalDatePattern.test(date)) throw new QualificationEvidenceInvalid("invalid-day");
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new QualificationEvidenceInvalid("invalid-day");
  }
  return [year, month, day];
};

const addCalendarDays = (date: string, days: number): string => {
  const [year, month, day] = parseDateParts(date);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(
    next.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
};

const calendarDistance = (left: string, right: string): number => {
  const [leftYear, leftMonth, leftDay] = parseDateParts(left);
  const [rightYear, rightMonth, rightDay] = parseDateParts(right);
  return Math.round(
    (Date.UTC(rightYear, rightMonth - 1, rightDay) - Date.UTC(leftYear, leftMonth - 1, leftDay)) /
      86_400_000,
  );
};

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new QualificationEvidenceInvalid("invalid-day");
  }
};

const dateAt = (formatter: Intl.DateTimeFormat, instant: number): string => {
  const parts = new Map(
    formatter
      .formatToParts(new Date(instant))
      .filter(({ type }) => type === "year" || type === "month" || type === "day")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
};

/** Earliest real instant belonging to a local calendar day, including skipped-midnight zones. */
const startOfLocalDay = (date: string, timezone: string): string => {
  const formatter = formatterFor(timezone);
  const [year, month, day] = parseDateParts(date);
  const center = Date.UTC(year, month - 1, day);
  let lower = center - 36 * 60 * 60 * 1_000;
  let upper = center + 36 * 60 * 60 * 1_000;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (dateAt(formatter, middle) < date) lower = middle;
    else upper = middle;
  }
  if (dateAt(formatter, upper) !== date) {
    throw new QualificationEvidenceInvalid("invalid-day");
  }
  return new Date(upper).toISOString();
};

export function recomputeActivityStreak(
  unorderedDays: readonly string[],
  timezone: string,
): ActivityStreakProjection | null {
  const days = [...new Set(unorderedDays)].sort();
  if (days.length === 0) return null;
  for (const day of days) parseDateParts(day);

  let best = 1;
  let runStart = days[0] as string;
  let runLength = 1;
  let latestRunStart = runStart;
  for (let index = 1; index < days.length; index += 1) {
    const previous = days[index - 1] as string;
    const current = days[index] as string;
    if (calendarDistance(previous, current) === 1) {
      runLength += 1;
    } else {
      runStart = current;
      runLength = 1;
    }
    if (runLength > best) best = runLength;
    latestRunStart = runStart;
  }
  const lastDay = days.at(-1) as string;
  return {
    current: runLength,
    best,
    startedDay: latestRunStart,
    lastDay,
    totalDays: days.length,
    activeUntilAt: startOfLocalDay(addCalendarDays(lastDay, 2), timezone),
  };
}
