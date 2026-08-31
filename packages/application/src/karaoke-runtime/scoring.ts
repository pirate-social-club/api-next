import {
  latinLettersOnly,
  phonemeSimilarity,
  phoneticKey,
  wordToApproxArpabet,
} from "@pirate/domain";

export { phoneticStreamSimilarity } from "@pirate/domain";

export const KARAOKE_LINE_WINDOW_LEAD_MS = 300;
export const KARAOKE_LINE_WINDOW_TRAIL_MS = 800;

/**
 * Version of the explicitly-versioned scoring contract. Persisted attempts are only
 * ranked against attempts scored by the same version (see the karaoke-rankings spec),
 * so this MUST be bumped whenever a change to the scoring algorithm or weights would
 * move scores. v1 = the first explicitly versioned contract — the number is a contract
 * marker, NOT an encoding of the current weights.
 * v2 = g-drop normalization ("in'" → "ing") now also fires before trailing punctuation.
 * v3 = timing remains measured for diagnostics but is excluded while clock calibration is repaired.
 * v4 = timing scores again, on a repaired and forgiving basis: order-preserving word
 *      alignment, median-robust per-line deltas, a wide session calibration range, a
 *      soft scoring curve with a floor, and an explicit calibration verdict. When timing
 *      cannot be trusted it is replaced by a NEUTRAL value at full weight rather than
 *      dropped (dropping it renormalized text upward, which rewarded sabotaging timing).
 * v5 = words ending in -ied derive their phones from the corresponding -y form plus D,
 *      fixing approximations such as tried (T-R-AY-D) that previously invented IH-EH.
 */
export const KARAOKE_SCORING_VERSION = 5;
export const KARAOKE_TIMING_SCORING_ENABLED = true;

export type KaraokeTimingTrend = "early" | "late" | "mixed" | "on_time";

/**
 * Why a session's timing did or did not count.
 *
 * `uncalibrated` is decided from measurement-integrity signals (evidence volume,
 * whether the session's offset is inside the physically plausible capture+STT
 * range, whether residuals are coherent) — NEVER from how low the timing score
 * came out. A score-based bail-out would be gameable: sing lyrics accurately but
 * deliberately off-beat, timing gets discarded, and the take is graded on lyrics
 * alone. See `TIMING_NEUTRAL_SCORE` for the other half of that defence.
 */
export type KaraokeTimingCalibrationState = "calibrated" | "uncalibrated";

export type KaraokeTimingCalibrationReason =
  /** Too few well-measured lines/words to estimate a session offset at all. */
  | "insufficient_evidence"
  /** The session offset exceeds any plausible capture+STT latency — the word
   *  clock is not mapped into song time correctly (a stream/segment mapping bug,
   *  not a singer). */
  | "offset_out_of_range"
  /** Residuals stay wide after removing the offset: the deltas are noise rather
   *  than a performance (bad word pairing, per-commit timestamp resets, stalls). */
  | "incoherent_residuals";

export interface KaraokeTimingCalibration {
  state: KaraokeTimingCalibrationState;
  reason: KaraokeTimingCalibrationReason | null;
  /** Offset actually removed before scoring (clamped into the plausible range). */
  offsetMs: number;
  /** Offset as estimated, before clamping — the diagnostic that tells us whether
   *  the clock mapping is drifting, and by how much. */
  rawOffsetMs: number;
  /** Median |residual| after offset removal — the session's timing "sloppiness". */
  residualSpreadMs: number;
  measuredLineCount: number;
  matchedWordCount: number;
}

export interface ScorableKaraokeWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface ScorableKaraokeLine {
  lineId: string;
  lineIndex: number;
  scoredLineIndex: number;
  text: string;
  startMs: number;
  endMs: number;
  words: ScorableKaraokeWord[];
}

export interface KaraokeRecognizedWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number | null;
  final?: boolean;
  source?: "stt" | "reference" | "manual";
}

export interface KaraokeLineBucket {
  lineId: string;
  lineIndex: number;
  scoredLineIndex: number;
  expectedLine: ScorableKaraokeLine;
  windowStartMs: number;
  windowEndMs: number;
  recognizedWords: KaraokeRecognizedWord[];
  transcript: string;
  confidenceMean: number | null;
  finalizedReason:
    | "line_end"
    | "asr_final"
    | "timeout"
    | "seek"
    | "session_end"
    | "provider_failed";
}

export interface KaraokeTextScore {
  score: number;
  wer: number;
  keywordCoverage: number;
  phoneticQuality: number;
  phoneticCoverage: number;
  phoneticAvailable: boolean;
  confidenceMean: number | null;
  missedWords: string[];
}

export interface KaraokeTimingScore {
  score: number;
  meanAbsDeltaMs: number;
  signedMeanDeltaMs: number;
  /**
   * Median-based counterparts of the two means above. Scoring and session
   * calibration use THESE: one mis-paired word (or one word clipped by a
   * reconnect) moves a mean by hundreds of ms but barely moves a median, and a
   * singer must not lose a line to a single measurement artefact.
   */
  medianAbsDeltaMs: number;
  medianSignedDeltaMs: number;
  matchedWordCount: number;
  timingTrend: KaraokeTimingTrend;
}

export interface KaraokeLineScore {
  lineId: string;
  lineIndex: number;
  scoredLineIndex: number;
  transcript: string;
  recognizedWords: KaraokeRecognizedWord[];
  textScore: KaraokeTextScore;
  timingScore: KaraokeTimingScore | null;
  confidenceScore: number | null;
  score: number;
  finalizedReason: KaraokeLineBucket["finalizedReason"];
  /**
   * The line could not be reliably measured (provider/stream failure), as
   * opposed to being sung poorly. Uncertain lines are excluded from the
   * performance averages so an infrastructure failure never penalizes the singer.
   */
  uncertain: boolean;
}

interface KaraokeLineDiagnostic {
  lineId: string;
  finalizedReason: KaraokeLineBucket["finalizedReason"];
  recognizedWordCount: number;
  score: number;
  textScore: number;
  timingScore: number | null;
  confidenceScore: number | null;
  medianSignedDeltaMs: number | null;
}

export interface KaraokeSessionSummary {
  finalScore: number;
  lyricsScore: number;
  timingScore: number | null;
  confidenceMean: number | null;
  lineCount: number;
  scoredLineCount: number;
  noRecognitionLineCount: number;
  /**
   * Lines that could not be reliably measured (provider/stream failure), as
   * opposed to lines simply sung poorly or left silent. These are excluded from
   * the performance averages, so surfacing them as an infrastructure caveat is
   * honest; do NOT conflate this with `noRecognitionLineCount` (which counts
   * genuine silence/failed recognition too).
   */
  uncertainLineCount: number;
  phoneticUnavailableLineCount: number;
  lowConfidenceLineCount: number;
  timingTrend: KaraokeTimingTrend;
  /**
   * Why timing did or did not contribute to `finalScore`. Persist this: it is the
   * production signal that tells us whether the clock mapping is healthy, and it
   * is the only way to tell "timing was perfect" apart from "timing was skipped".
   */
  timingCalibration: KaraokeTimingCalibration;
  /** Derived-only diagnostics. Never includes transcripts, recognized text, or audio. */
  lineDiagnostics?: KaraokeLineDiagnostic[];
  strongestLines: KaraokeLineScore[];
  weakestLines: KaraokeLineScore[];
  missedWords: string[];
}

const SIMILARITY_COVERAGE_THRESHOLD = 0.72;
// Residual (post-calibration) deviation that is fully forgiven. STT word
// boundaries are themselves only accurate to ~100-150ms, and a listener cannot
// hear a shift this small, so charging for it grades the transcriber, not the
// singer.
const TIMING_FORGIVEN_RESIDUAL_MS = 150;
// Residual beyond the forgiven band at which timing scores 0.5. The curve is
// rational rather than linear so it decays gently near the knee and never
// reaches 0 — a real, measured line always keeps some credit.
const TIMING_RESIDUAL_HALF_SCORE_MS = 450;
// Floor for a line with genuine matched evidence. Even badly-timed singing is
// singing; a hard 0 was what made a near-complete take read as 0% timing.
const TIMING_SCORE_FLOOR = 0.15;
const TIMING_ON_TIME_MS = 90;
const TIMING_MIXED_SIGN_MS = 120;
// A trend is only "mixed" when neither direction dominates. Without this a
// single opposite-sign line made a strongly-offset session report "mixed",
// which is what led the v3 investigation away from the offset explanation.
const TIMING_TREND_DOMINANCE = 0.7;
const LOW_CONFIDENCE_THRESHOLD = 0.5;
// Keeps unrelated words from jumping to a nearby overlapping line solely because the timing is close.
const BUCKETIZER_TEXT_MISMATCH_PENALTY_MS = 250;
// Per-line line-score weights. Text dominates; timing has real but secondary
// leverage (pitch will claim weight here later). Timing only judges *consistency*
// after the session's systematic offset is removed (see applyTimingOffsetCompensation).
const TEXT_SCORE_WEIGHT = 0.65;
const TIMING_SCORE_WEIGHT = 0.3;
const CONFIDENCE_SCORE_WEIGHT = 0.05;
// A whole performance carries a constant lead/lag — capture+STT+playback latency
// plus the singer naturally sitting just off the beat. That systematic offset is
// NOT bad singing, so it is estimated per-song and removed before judging timing.
//
// The v3 ceiling was 250ms, which is BELOW the real end-to-end lag of the capture
// path (worklet buffering + upload + provider-side windowing routinely lands in
// the 400-800ms range). A take with an 700ms systematic lag therefore kept ~450ms
// of "uncompensated" residual after clamping, cleared the old 575ms linear window,
// and scored ~0 on every line — a near-complete take reading 0% timing. 1200ms
// covers the plausible physical range with headroom.
const TIMING_CALIBRATION_CEILING_MS = 1200;
// Beyond the ceiling the word clock is not mapped into song time correctly; that
// is a measurement fault, not a performance, so the session is reported
// `uncalibrated` instead of being scored against an offset we know is wrong.
// Lines below this text score are treated as bad evidence and excluded from the
// offset estimate (their word matches — and thus deltas — are unreliable).
const TIMING_OFFSET_MIN_TEXT_SCORE = 0.5;
// Minimum evidence before a session offset is trustworthy enough to score against.
const TIMING_CALIBRATION_MIN_LINES = 3;
const TIMING_CALIBRATION_MIN_WORDS = 8;
// Median residual above which the deltas are noise rather than a performance
// (mis-paired words, per-commit timestamp resets, capture stalls). Deliberately
// wide: this is an integrity backstop, not a judgement of sloppy singing.
const TIMING_INCOHERENT_RESIDUAL_MS = 900;
// Substituted for timing (at FULL timing weight) whenever timing could not be
// trusted. Renormalizing the weights instead — which is what v3 did — pushed text
// from 65% to 93% of the line score, so a take with accurate lyrics and
// deliberately sabotaged timing scored HIGHER than one with honest timing.
// Holding the weight and substituting a good-but-not-perfect value removes that
// incentive while never punishing a singer for our own measurement failure.
const TIMING_NEUTRAL_SCORE = 0.85;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function midpointMs(value: { startMs: number; endMs: number }): number {
  return (value.startMs + value.endMs) / 2;
}

function normalizeKaraokeText(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/\bwon['’]?t\b/gu, "will not")
    .replace(/\bcan['’]?t\b/gu, "can not")
    .replace(/\bain['’]?t\b/gu, "is not")
    .replace(/\blet['’]?s\b/gu, "let us")
    .replace(/\b(i|you|we|they)['’]?ve\b/gu, "$1 have")
    .replace(/\b(i|you|we|they)['’]?ll\b/gu, "$1 will")
    .replace(/\b(i|you|we|they)['’]?re\b/gu, "$1 are")
    .replace(/\b(i)['’]?m\b/gu, "$1 am")
    .replace(/\b(i|you|he|she|it|we|they)['’]?d\b/gu, "$1 would")
    .replace(/\b(it|that|there|here|what|who|how|where|when|why)['’]?s\b/gu, "$1 is")
    .replace(/\b([a-z]{3,})in['’](?=\P{L}|$)/gu, "$1ing")
    .replace(/\b['’]?til\b/gu, "till")
    .replace(/\b(?:ima|i['’]?ma|imma)\b/gu, "i am going to")
    .replace(/\btryna\b/gu, "trying to")
    .replace(/\b['’]?(?:cause|cuz|coz)\b/gu, "because")
    .replace(/\bya\b/gu, "you")
    .replace(/\by['’]?all\b/gu, "you all")
    .replace(/\bgonna\b/gu, "going to")
    .replace(/\bwanna\b/gu, "want to")
    .replace(/\bgotta\b/gu, "got to")
    .replace(/\bkinda\b/gu, "kind of")
    .replace(/['’]/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function tokenizeKaraokeText(value: string): string[] {
  const normalized = normalizeKaraokeText(value);

  if (!normalized) {
    return [];
  }

  return normalized.split(" ").filter((token) => token.length > 0);
}

function levenshteinDistance<T>(left: T[], right: T[]): number {
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  const prev = new Array<number>(right.length + 1);
  const curr = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= right.length; j += 1) {
      prev[j] = curr[j] ?? 0;
    }
  }

  return prev[right.length] ?? 0;
}

function keywordCoverage(expectedTokens: string[], transcriptTokens: string[]): number {
  if (expectedTokens.length === 0) {
    return transcriptTokens.length === 0 ? 1 : 0;
  }

  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "at",
    "is",
    "are",
    "it",
  ]);
  const expectedKeywords = expectedTokens.filter((token) => token.length >= 3 && !stop.has(token));
  const target = expectedKeywords.length > 0 ? expectedKeywords : expectedTokens;
  const transcriptSet = new Set(transcriptTokens);
  let hits = 0;

  for (const token of target) {
    if (transcriptSet.has(token)) {
      hits += 1;
    }
  }

  return hits / target.length;
}

function normalizedStringSimilarity(leftRaw: string, rightRaw: string): number {
  const left = leftRaw.trim();
  const right = rightRaw.trim();
  if (!left && !right) {
    return 1;
  }
  if (!left || !right) {
    return 0;
  }

  const dist = levenshteinDistance(left.split(""), right.split(""));
  const maxLen = Math.max(left.length, right.length);
  if (maxLen <= 0) {
    return 1;
  }

  return Math.max(0, 1 - dist / maxLen);
}

function pairSimilarity(expectedRaw: string, transcriptRaw: string): number {
  if (!expectedRaw || !transcriptRaw) {
    return 0;
  }
  if (expectedRaw === transcriptRaw) {
    return 1;
  }

  const expectedKey = phoneticKey(expectedRaw);
  const transcriptKey = phoneticKey(transcriptRaw);
  const phonemeScore = phonemeSimilarity(expectedRaw, transcriptRaw);
  if (expectedKey && transcriptKey && expectedKey === transcriptKey && phonemeScore >= 0.78) {
    return 0.99;
  }

  const keySimilarity = normalizedStringSimilarity(expectedKey, transcriptKey);
  const rawSimilarity = normalizedStringSimilarity(expectedRaw, transcriptRaw);
  const combined = phonemeScore * 0.6 + keySimilarity * 0.25 + rawSimilarity * 0.15;
  return Math.max(rawSimilarity * 0.8, combined);
}

function phoneticTokenSimilarity(
  expectedTokens: string[],
  transcriptTokens: string[],
): { quality: number; coverage: number; available: boolean } {
  const expectedWords = expectedTokens
    .map((token) => latinLettersOnly(token))
    .filter((token) => token.length > 0);
  const transcriptWords = transcriptTokens
    .map((token) => latinLettersOnly(token))
    .filter((token) => token.length > 0);

  if (expectedWords.length === 0) {
    return { quality: 0, coverage: 0, available: false };
  }

  const expectedSeq = expectedWords
    .map((word) => {
      const phones = wordToApproxArpabet(word);
      return phones.length > 0 ? phones.join("-") : phoneticKey(word);
    })
    .filter((value) => value.length > 0);
  const transcriptSeq = transcriptWords
    .map((word) => {
      const phones = wordToApproxArpabet(word);
      return phones.length > 0 ? phones.join("-") : phoneticKey(word);
    })
    .filter((value) => value.length > 0);

  if (expectedSeq.length === 0) {
    return { quality: 0, coverage: 0, available: false };
  }

  const seqDistance = levenshteinDistance(expectedSeq, transcriptSeq);
  const seqDenom = Math.max(expectedSeq.length, transcriptSeq.length);
  const seqQuality = seqDenom > 0 ? Math.max(0, 1 - seqDistance / seqDenom) : 1;

  let coverageHits = 0;
  let similaritySum = 0;
  for (const expectedWord of expectedWords) {
    let best = 0;
    for (const transcriptWord of transcriptWords) {
      const similarity = pairSimilarity(expectedWord, transcriptWord);
      if (similarity > best) {
        best = similarity;
      }
      if (best >= 0.995) {
        break;
      }
    }
    similaritySum += best;
    if (best >= SIMILARITY_COVERAGE_THRESHOLD) {
      coverageHits += 1;
    }
  }

  const averageBest = similaritySum / expectedWords.length;
  const quality = clamp01(averageBest * 0.7 + seqQuality * 0.3);
  const coverage = coverageHits / expectedWords.length;
  return { quality, coverage, available: true };
}

function confidenceValues(words: readonly KaraokeRecognizedWord[]): number[] {
  return words
    .map((word) =>
      typeof word.confidence === "number" && Number.isFinite(word.confidence)
        ? clamp01(word.confidence)
        : null,
    )
    .filter((value): value is number => value !== null);
}

function confidenceMean(words: readonly KaraokeRecognizedWord[]): number | null {
  const values = confidenceValues(words);

  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function transcriptFromWords(words: readonly KaraokeRecognizedWord[]): string {
  return words
    .flatMap((word) => tokenizeKaraokeText(word.text))
    .filter(Boolean)
    .join(" ");
}

function findMissedWords(expectedTokens: string[], transcriptTokens: string[]): string[] {
  const missed: string[] = [];

  for (const expectedToken of expectedTokens) {
    let best = 0;
    for (const transcriptToken of transcriptTokens) {
      best = Math.max(best, pairSimilarity(expectedToken, transcriptToken));
      if (best >= 0.995) {
        break;
      }
    }

    if (best < SIMILARITY_COVERAGE_THRESHOLD) {
      missed.push(expectedToken);
    }
  }

  return missed;
}

export function scoreKaraokeLineText(input: {
  expected: string;
  transcript: string;
  recognizedWords?: readonly KaraokeRecognizedWord[];
}): KaraokeTextScore {
  const expectedTokens = tokenizeKaraokeText(input.expected);
  const transcriptTokens = tokenizeKaraokeText(input.transcript);
  const editDistance = levenshteinDistance(expectedTokens, transcriptTokens);
  const wer =
    expectedTokens.length === 0
      ? transcriptTokens.length === 0
        ? 0
        : 1
      : editDistance / expectedTokens.length;
  const coverage = keywordCoverage(expectedTokens, transcriptTokens);
  const phonetic = phoneticTokenSimilarity(expectedTokens, transcriptTokens);

  const quality = Math.max(0, 1 - wer);
  const lexicalScore = quality * 0.45 + coverage * 0.2;
  const phoneticScore = phonetic.quality * 0.25 + phonetic.coverage * 0.1;
  const weighted = phonetic.available ? lexicalScore + phoneticScore : lexicalScore;
  const denom = phonetic.available ? 1 : 0.65;
  const score = clamp01(weighted / denom);

  return {
    confidenceMean: input.recognizedWords ? confidenceMean(input.recognizedWords) : null,
    keywordCoverage: coverage,
    missedWords: findMissedWords(expectedTokens, transcriptTokens),
    phoneticAvailable: phonetic.available,
    phoneticCoverage: phonetic.coverage,
    phoneticQuality: phonetic.quality,
    score,
    wer,
  };
}

function lineWindow(line: ScorableKaraokeLine): { endMs: number; startMs: number } {
  return {
    endMs: line.endMs + KARAOKE_LINE_WINDOW_TRAIL_MS,
    startMs: line.startMs - KARAOKE_LINE_WINDOW_LEAD_MS,
  };
}

function validRecognizedWord(word: KaraokeRecognizedWord): boolean {
  return Boolean(
    word.text.trim() &&
      Number.isFinite(word.startMs) &&
      Number.isFinite(word.endMs) &&
      word.endMs >= word.startMs,
  );
}

function closestExpectedWordDistance(
  line: ScorableKaraokeLine,
  recognizedWord: KaraokeRecognizedWord,
): number {
  const recognizedTokens = tokenizeKaraokeText(recognizedWord.text);
  const recognizedToken = recognizedTokens[0] ?? latinLettersOnly(recognizedWord.text);
  const recognizedMidpoint = midpointMs(recognizedWord);
  let best = Number.POSITIVE_INFINITY;

  for (const expectedWord of line.words) {
    const expectedTokens = tokenizeKaraokeText(expectedWord.text);
    const expectedToken = expectedTokens[0] ?? latinLettersOnly(expectedWord.text);
    const similarity =
      expectedToken && recognizedToken ? pairSimilarity(expectedToken, recognizedToken) : 0;
    const textPenalty =
      similarity >= SIMILARITY_COVERAGE_THRESHOLD ? 0 : BUCKETIZER_TEXT_MISMATCH_PENALTY_MS;
    const distance = Math.abs(midpointMs(expectedWord) - recognizedMidpoint) + textPenalty;
    best = Math.min(best, distance);
  }

  if (Number.isFinite(best)) {
    return best;
  }

  return Math.abs(midpointMs(line) - recognizedMidpoint);
}

export function bucketRecognizedWordsIntoLines(input: {
  lines: readonly ScorableKaraokeLine[];
  words: readonly KaraokeRecognizedWord[];
  nowMs: number;
  assignmentLocks?: ReadonlySet<string>;
  finalizedReason?: KaraokeLineBucket["finalizedReason"];
}): KaraokeLineBucket[] {
  const buckets = input.lines.map((line) => {
    const window = lineWindow(line);

    return {
      expectedLine: line,
      lineId: line.lineId,
      lineIndex: line.lineIndex,
      recognizedWords: [] as KaraokeRecognizedWord[],
      scoredLineIndex: line.scoredLineIndex,
      windowEndMs: window.endMs,
      windowStartMs: window.startMs,
    };
  });

  for (const word of input.words) {
    if (!validRecognizedWord(word)) {
      continue;
    }

    const wordMidpoint = midpointMs(word);
    let bestBucketIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [index, bucket] of buckets.entries()) {
      if (input.assignmentLocks?.has(bucket.lineId)) {
        continue;
      }

      if (wordMidpoint < bucket.windowStartMs || wordMidpoint > bucket.windowEndMs) {
        continue;
      }

      const distance = closestExpectedWordDistance(bucket.expectedLine, word);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestBucketIndex = index;
      }
    }

    if (bestBucketIndex >= 0) {
      buckets[bestBucketIndex]?.recognizedWords.push(word);
    }
  }

  return buckets.map((bucket) => {
    const recognizedWords = [...bucket.recognizedWords].sort((a, b) => a.startMs - b.startMs);
    const finalizedReason =
      input.finalizedReason ?? (input.nowMs >= bucket.windowEndMs ? "line_end" : "asr_final");

    return {
      ...bucket,
      confidenceMean: confidenceMean(recognizedWords),
      finalizedReason,
      recognizedWords,
      transcript: transcriptFromWords(recognizedWords),
    };
  });
}

function wordSimilarity(
  expectedWord: ScorableKaraokeWord,
  recognizedWord: KaraokeRecognizedWord,
): number {
  const expectedToken =
    tokenizeKaraokeText(expectedWord.text)[0] ?? latinLettersOnly(expectedWord.text);
  if (!expectedToken) {
    return 0;
  }
  const recognizedTokens = tokenizeKaraokeText(recognizedWord.text);
  const recognizedFallback = latinLettersOnly(recognizedWord.text);

  return Math.max(
    0,
    ...recognizedTokens.map((recognizedToken) => pairSimilarity(expectedToken, recognizedToken)),
    recognizedFallback ? pairSimilarity(expectedToken, recognizedFallback) : 0,
  );
}

// Cost of skipping a word on either side during alignment. Low enough that a
// dropped or ad-libbed word just opens a gap instead of forcing a bad pairing.
const ALIGNMENT_GAP_PENALTY = 0.3;
// Charged for pairing two words that do not actually sound alike. Alignment may
// still step past them, but such a pair never yields a timing delta.
const ALIGNMENT_MISMATCH_PENALTY = 0.25;

/**
 * Pairs expected words with recognized words in ORDER (Needleman-Wunsch).
 *
 * The previous matcher let every expected word independently pick its
 * best-looking match anywhere in the line, so a lyric with a repeated word
 * ("oh… oh…", "love… love…") happily paired the first occurrence with the last.
 * The text score never noticed — the same tokens were present either way — but
 * the timing deltas it produced were near-random in sign and magnitude, which is
 * exactly the incoherence that made timing untrustworthy. Order-preserving
 * alignment cannot cross pairs, so a repeat matches its own occurrence.
 */
function alignWords(
  expectedWords: readonly ScorableKaraokeWord[],
  recognizedWords: readonly KaraokeRecognizedWord[],
): { expected: ScorableKaraokeWord; recognized: KaraokeRecognizedWord }[] {
  const rows = expectedWords.length;
  const cols = recognizedWords.length;
  if (rows === 0 || cols === 0) {
    return [];
  }

  const similarity: number[][] = expectedWords.map((expectedWord) =>
    recognizedWords.map((recognizedWord) => wordSimilarity(expectedWord, recognizedWord)),
  );
  // best[i][j] = best alignment score for the first i expected and j recognized words.
  const best: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let i = 1; i <= rows; i += 1) {
    best[i]![0] = best[i - 1]![0]! - ALIGNMENT_GAP_PENALTY;
  }
  for (let j = 1; j <= cols; j += 1) {
    best[0]![j] = best[0]![j - 1]! - ALIGNMENT_GAP_PENALTY;
  }

  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      const sim = similarity[i - 1]![j - 1]!;
      const pairValue = sim >= SIMILARITY_COVERAGE_THRESHOLD ? sim : -ALIGNMENT_MISMATCH_PENALTY;
      best[i]![j] = Math.max(
        best[i - 1]![j - 1]! + pairValue,
        best[i - 1]![j]! - ALIGNMENT_GAP_PENALTY,
        best[i]![j - 1]! - ALIGNMENT_GAP_PENALTY,
      );
    }
  }

  const pairs: { expected: ScorableKaraokeWord; recognized: KaraokeRecognizedWord }[] = [];
  let i = rows;
  let j = cols;
  while (i > 0 && j > 0) {
    const sim = similarity[i - 1]![j - 1]!;
    const pairValue = sim >= SIMILARITY_COVERAGE_THRESHOLD ? sim : -ALIGNMENT_MISMATCH_PENALTY;
    if (best[i]![j] === best[i - 1]![j - 1]! + pairValue) {
      // Only a real (sound-alike) pair produces a timing observation.
      if (sim >= SIMILARITY_COVERAGE_THRESHOLD) {
        pairs.push({ expected: expectedWords[i - 1]!, recognized: recognizedWords[j - 1]! });
      }
      i -= 1;
      j -= 1;
      continue;
    }
    if (best[i]![j] === best[i - 1]![j]! - ALIGNMENT_GAP_PENALTY) {
      i -= 1;
      continue;
    }
    j -= 1;
  }

  return pairs.reverse();
}

function timingTrendFromDeltas(deltas: readonly number[]): KaraokeTimingTrend {
  if (deltas.length === 0) {
    return "on_time";
  }

  const signedMean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const earlyCount = deltas.filter((delta) => delta < -TIMING_MIXED_SIGN_MS).length;
  const lateCount = deltas.filter((delta) => delta > TIMING_MIXED_SIGN_MS).length;
  const directional = earlyCount + lateCount;

  if (Math.abs(signedMean) <= TIMING_ON_TIME_MS) {
    return earlyCount > 0 && lateCount > 0 ? "mixed" : "on_time";
  }
  // "mixed" must mean genuinely erratic. A dominant direction with a stray
  // opposite outlier is a consistent lead/lag and has to be reported as such —
  // reporting it as "mixed" is what hid the systematic-offset explanation behind
  // an apparent incoherence.
  const dominant = Math.max(earlyCount, lateCount);
  if (
    earlyCount > 0 &&
    lateCount > 0 &&
    directional > 0 &&
    dominant / directional < TIMING_TREND_DOMINANCE
  ) {
    return "mixed";
  }

  return signedMean < 0 ? "early" : "late";
}

/**
 * Converts a residual deviation (ms, already offset-compensated) into a score.
 *
 * Forgiving by construction: everything inside the STT's own resolution is free,
 * the decay past that is gradual rather than a cliff, and a measured line keeps a
 * floor. The old linear `1 - residual/575` hit exactly 0 at 575ms and stayed
 * there, so one bad calibration turned every line into a zero.
 */
function timingScoreFromResidual(residualMs: number): number {
  if (!Number.isFinite(residualMs)) {
    return TIMING_SCORE_FLOOR;
  }
  const excess = Math.max(0, Math.abs(residualMs) - TIMING_FORGIVEN_RESIDUAL_MS);
  const decayed = 1 / (1 + (excess / TIMING_RESIDUAL_HALF_SCORE_MS) ** 2);

  return clamp01(TIMING_SCORE_FLOOR + (1 - TIMING_SCORE_FLOOR) * decayed);
}

export function scoreKaraokeLineTiming(input: {
  expectedLine: ScorableKaraokeLine;
  recognizedWords: readonly KaraokeRecognizedWord[];
}): KaraokeTimingScore | null {
  const deltas = alignWords(input.expectedLine.words, input.recognizedWords)
    .map((pair) => pair.recognized.startMs - pair.expected.startMs)
    .filter((delta) => Number.isFinite(delta));

  if (deltas.length === 0) {
    return null;
  }

  const meanAbsDeltaMs = deltas.reduce((sum, value) => sum + Math.abs(value), 0) / deltas.length;
  const signedMeanDeltaMs = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const medianSignedDeltaMs = median(deltas);
  const medianAbsDeltaMs = median(deltas.map((delta) => Math.abs(delta)));

  return {
    matchedWordCount: deltas.length,
    meanAbsDeltaMs,
    medianAbsDeltaMs,
    medianSignedDeltaMs,
    // Live, pre-calibration score. The session offset is not known until the
    // performance ends, so this is the uncompensated read; the final summary
    // recomputes every line against the calibrated offset.
    score: timingScoreFromResidual(medianAbsDeltaMs),
    signedMeanDeltaMs,
    timingTrend: timingTrendFromDeltas(deltas),
  };
}

/**
 * How a line's timing enters its score.
 *
 * - `measured`  — a trustworthy timing observation; score it.
 * - `neutral`   — the line HAS singing evidence but timing could not be trusted
 *                 (session uncalibrated, too few matched words). Timing keeps its
 *                 full weight at a neutral value, so a measurement failure never
 *                 reweights the remaining components.
 * - `absent`    — no recognized words at all (silence, miss). There is nothing to
 *                 be neutral about; timing drops out and the remaining weights
 *                 renormalize, exactly as before.
 */
type LineTimingContribution =
  | { kind: "measured"; score: number }
  | { kind: "neutral" }
  | { kind: "absent" };

// Text dominates; confidence contributes only when measured. Weights are
// normalized by available weight so a missing component never zeros the line.
function combineLineScore(input: {
  textScore: number;
  timing: LineTimingContribution;
  confidenceScore: number | null;
}): number {
  const timingScore = input.timing.kind === "measured" ? input.timing.score : TIMING_NEUTRAL_SCORE;
  const parts = [
    { available: true, score: input.textScore, weight: TEXT_SCORE_WEIGHT },
    { available: input.timing.kind !== "absent", score: timingScore, weight: TIMING_SCORE_WEIGHT },
    {
      available: input.confidenceScore !== null,
      score: input.confidenceScore ?? 0,
      weight: CONFIDENCE_SCORE_WEIGHT,
    },
  ];
  const availableWeight = parts.filter((p) => p.available).reduce((sum, p) => sum + p.weight, 0);
  const weighted = parts.filter((p) => p.available).reduce((sum, p) => sum + p.score * p.weight, 0);
  return availableWeight > 0 ? clamp01(weighted / availableWeight) : 0;
}

function lineTimingContribution(input: {
  timingScore: KaraokeTimingScore | null;
  recognizedWordCount: number;
  calibrated: boolean;
  score?: number;
}): LineTimingContribution {
  if (input.recognizedWordCount === 0) {
    return { kind: "absent" };
  }
  if (!input.calibrated || !input.timingScore) {
    return { kind: "neutral" };
  }

  return { kind: "measured", score: input.score ?? input.timingScore.score };
}

export function scoreKaraokeLine(input: { bucket: KaraokeLineBucket }): KaraokeLineScore {
  const textScore = scoreKaraokeLineText({
    expected: input.bucket.expectedLine.text,
    recognizedWords: input.bucket.recognizedWords,
    transcript: input.bucket.transcript,
  });
  const timingScore = scoreKaraokeLineTiming({
    expectedLine: input.bucket.expectedLine,
    recognizedWords: input.bucket.recognizedWords,
  });
  const confidenceScore = input.bucket.confidenceMean;

  return {
    confidenceScore,
    finalizedReason: input.bucket.finalizedReason,
    lineId: input.bucket.lineId,
    lineIndex: input.bucket.lineIndex,
    recognizedWords: input.bucket.recognizedWords,
    score: combineLineScore({
      confidenceScore,
      textScore: textScore.score,
      // Live scoring runs before the session offset exists, so treat the line as
      // provisionally calibrated and let the final summary correct it.
      timing: lineTimingContribution({
        calibrated: KARAOKE_TIMING_SCORING_ENABLED,
        recognizedWordCount: input.bucket.recognizedWords.length,
        timingScore,
      }),
    }),
    scoredLineIndex: input.bucket.scoredLineIndex,
    textScore,
    timingScore,
    transcript: input.bucket.transcript,
    uncertain: input.bucket.finalizedReason === "provider_failed",
  };
}

// Median helper (used for the robust session timing offset).
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * Removes the performance's systematic timing offset before judging timing.
 *
 * A whole song carries a constant lead/lag (capture+STT+playback latency, plus a
 * singer naturally sitting just off the beat). Scoring raw `meanAbsDelta` treats
 * that constant as bad singing and drags an otherwise-clean vocal down. We
 * estimate the offset as the median of per-line signed deltas (robust to a few
 * wild lines), clamp it, and re-score each line's timing against the *residual*
 * deviation — keeping each line's internal spread (sloppiness) but forgiving the
 * shared shift. Returns adjusted line scores (timing score + overall recomputed).
 */
export function applyTimingOffsetCompensation(lineScores: readonly KaraokeLineScore[]): {
  offsetMs: number;
  lineScores: KaraokeLineScore[];
  calibration: KaraokeTimingCalibration;
} {
  // Estimate the offset only from well-measured lines — a mis-recognized or
  // uncertain line's delta is noise and must not shift the whole song's
  // calibration. (The offset is still APPLIED to every line; only the estimate
  // is restricted to good evidence.)
  const evidence = lineScores.filter(
    (ls) =>
      !ls.uncertain &&
      ls.recognizedWords.length > 0 &&
      ls.textScore.score >= TIMING_OFFSET_MIN_TEXT_SCORE &&
      ls.timingScore !== null &&
      ls.timingScore.matchedWordCount >= 2 &&
      Number.isFinite(ls.timingScore.medianSignedDeltaMs),
  );
  const signedDeltas = evidence.map((ls) => ls.timingScore!.medianSignedDeltaMs);
  const matchedWordCount = evidence.reduce((sum, ls) => sum + ls.timingScore!.matchedWordCount, 0);

  const uncalibrated = (
    reason: KaraokeTimingCalibrationReason,
    rawOffsetMs: number,
    residualSpreadMs: number,
  ): {
    offsetMs: number;
    lineScores: KaraokeLineScore[];
    calibration: KaraokeTimingCalibration;
  } => ({
    calibration: {
      matchedWordCount,
      measuredLineCount: evidence.length,
      offsetMs: 0,
      rawOffsetMs,
      reason,
      residualSpreadMs,
      state: "uncalibrated",
    },
    // Timing is not scored, so leave the raw per-line timing diagnostics intact
    // and re-score each line with a neutral timing contribution.
    lineScores: lineScores.map((ls) => ({
      ...ls,
      score: combineLineScore({
        confidenceScore: ls.confidenceScore,
        textScore: ls.textScore.score,
        timing: lineTimingContribution({
          calibrated: false,
          recognizedWordCount: ls.recognizedWords.length,
          timingScore: ls.timingScore,
        }),
      }),
    })),
    offsetMs: 0,
  });

  if (
    evidence.length < TIMING_CALIBRATION_MIN_LINES ||
    matchedWordCount < TIMING_CALIBRATION_MIN_WORDS
  ) {
    return uncalibrated(
      "insufficient_evidence",
      signedDeltas.length > 0 ? median(signedDeltas) : 0,
      0,
    );
  }

  const rawOffsetMs = median(signedDeltas);
  if (Math.abs(rawOffsetMs) > TIMING_CALIBRATION_CEILING_MS) {
    // Past the plausible capture+STT lag the word clock simply is not mapped into
    // song time. That is an infrastructure fault; it must be reported, not
    // charged to the singer.
    return uncalibrated(
      "offset_out_of_range",
      rawOffsetMs,
      median(signedDeltas.map((delta) => Math.abs(delta - rawOffsetMs))),
    );
  }

  const offsetMs = rawOffsetMs;
  const residualSpreadMs = median(signedDeltas.map((delta) => Math.abs(delta - offsetMs)));
  if (residualSpreadMs > TIMING_INCOHERENT_RESIDUAL_MS) {
    return uncalibrated("incoherent_residuals", rawOffsetMs, residualSpreadMs);
  }

  const adjusted = lineScores.map((ls) => {
    const timing = ls.timingScore;
    if (!timing) {
      return {
        ...ls,
        score: combineLineScore({
          confidenceScore: ls.confidenceScore,
          textScore: ls.textScore.score,
          timing: lineTimingContribution({
            calibrated: true,
            recognizedWordCount: ls.recognizedWords.length,
            timingScore: null,
          }),
        }),
      };
    }
    // Within-line spread (sloppiness) is the part of the line's median |delta|
    // not explained by the line's own median delta; that is preserved. The
    // systematic component is replaced by the residual after removing the
    // session offset.
    const withinLineSpread = Math.max(
      0,
      timing.medianAbsDeltaMs - Math.abs(timing.medianSignedDeltaMs),
    );
    const compensatedResidual = withinLineSpread + Math.abs(timing.medianSignedDeltaMs - offsetMs);
    const compensatedTimingScore = timingScoreFromResidual(compensatedResidual);
    const nextTiming: KaraokeTimingScore = { ...timing, score: compensatedTimingScore };
    return {
      ...ls,
      score: combineLineScore({
        confidenceScore: ls.confidenceScore,
        textScore: ls.textScore.score,
        timing: lineTimingContribution({
          calibrated: KARAOKE_TIMING_SCORING_ENABLED,
          recognizedWordCount: ls.recognizedWords.length,
          score: compensatedTimingScore,
          timingScore: nextTiming,
        }),
      }),
      timingScore: nextTiming,
    };
  });

  return {
    calibration: {
      matchedWordCount,
      measuredLineCount: evidence.length,
      offsetMs,
      rawOffsetMs,
      reason: null,
      residualSpreadMs,
      state: "calibrated",
    },
    lineScores: adjusted,
    offsetMs,
  };
}

function aggregateTimingTrend(
  lineScores: readonly KaraokeLineScore[],
  calibration: KaraokeTimingCalibration,
): KaraokeTimingTrend {
  // Directional feedback must describe the same residuals that timing scoring
  // judges. The raw deltas still include capture/STT latency; telling a singer
  // to correct that system offset would contradict a compensated perfect score.
  // Preserve the raw diagnostic only when calibration failed—the UI suppresses
  // guidance for those takes because there is no trustworthy offset.
  const offsetMs = calibration.state === "calibrated" ? calibration.offsetMs : 0;
  const deltas = lineScores
    .map((lineScore) => lineScore.timingScore?.medianSignedDeltaMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => value - offsetMs);

  return timingTrendFromDeltas(deltas);
}

function uniqueMissedWords(lineScores: readonly KaraokeLineScore[]): string[] {
  const seen = new Set<string>();
  const missed: string[] = [];

  for (const lineScore of lineScores) {
    for (const word of lineScore.textScore.missedWords) {
      if (seen.has(word)) {
        continue;
      }
      seen.add(word);
      missed.push(word);
    }
  }

  return missed;
}

export function aggregateKaraokeSession(input: {
  lineScores: readonly KaraokeLineScore[];
}): KaraokeSessionSummary {
  // Remove the performance's systematic timing offset before aggregating, so a
  // consistent lead/lag (latency + sitting just off the beat) is not scored as
  // bad singing. Live per-line scores stay raw; the final summary uses these.
  const { calibration, lineScores: compensatedLineScores } = applyTimingOffsetCompensation(
    input.lineScores,
  );
  const lineScores = [...compensatedLineScores].sort(
    (a, b) => a.scoredLineIndex - b.scoredLineIndex,
  );
  // Uncertain (measurement-failed) lines never contribute to the performance
  // averages — an infrastructure failure must not read as poor singing.
  const measuredLineScores = lineScores.filter((lineScore) => !lineScore.uncertain);
  const scoredLineScores = measuredLineScores.filter(
    (lineScore) => lineScore.recognizedWords.length > 0,
  );
  const scoreSource = scoredLineScores.length > 0 ? scoredLineScores : measuredLineScores;
  const finalScore =
    scoreSource.length > 0
      ? scoreSource.reduce((sum, lineScore) => sum + lineScore.score, 0) / scoreSource.length
      : 0;
  const lyricsScore =
    scoreSource.length > 0
      ? scoreSource.reduce((sum, lineScore) => sum + lineScore.textScore.score, 0) /
        scoreSource.length
      : 0;
  const timingScores = scoreSource
    .map((lineScore) => lineScore.timingScore?.score)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const confidenceScores = scoreSource
    .map((lineScore) => lineScore.confidenceScore)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const strongestLines = [...scoreSource].sort((a, b) => b.score - a.score).slice(0, 3);
  const weakestLines = [...scoreSource].sort((a, b) => a.score - b.score).slice(0, 3);
  const lineDiagnostics = lineScores.map((lineScore) => ({
    confidenceScore: lineScore.confidenceScore,
    finalizedReason: lineScore.finalizedReason,
    lineId: lineScore.lineId,
    medianSignedDeltaMs: lineScore.timingScore?.medianSignedDeltaMs ?? null,
    recognizedWordCount: lineScore.recognizedWords.length,
    score: lineScore.score,
    textScore: lineScore.textScore.score,
    timingScore: lineScore.timingScore?.score ?? null,
  }));

  return {
    confidenceMean:
      confidenceScores.length > 0
        ? confidenceScores.reduce((sum, value) => sum + value, 0) / confidenceScores.length
        : null,
    finalScore: clamp01(finalScore),
    lineCount: lineScores.length,
    lineDiagnostics,
    lowConfidenceLineCount: lineScores.filter(
      (lineScore) =>
        lineScore.confidenceScore !== null && lineScore.confidenceScore < LOW_CONFIDENCE_THRESHOLD,
    ).length,
    lyricsScore: clamp01(lyricsScore),
    missedWords: uniqueMissedWords(lineScores),
    noRecognitionLineCount: lineScores.filter((lineScore) => lineScore.recognizedWords.length === 0)
      .length,
    uncertainLineCount: lineScores.filter((lineScore) => lineScore.uncertain).length,
    phoneticUnavailableLineCount: lineScores.filter(
      (lineScore) => !lineScore.textScore.phoneticAvailable,
    ).length,
    scoredLineCount: scoredLineScores.length,
    strongestLines,
    timingCalibration: calibration,
    // Null means "not part of your score" — either the kill switch is off or the
    // session could not be calibrated. The reason is in `timingCalibration`.
    timingScore:
      KARAOKE_TIMING_SCORING_ENABLED &&
      calibration.state === "calibrated" &&
      timingScores.length > 0
        ? timingScores.reduce((sum, value) => sum + value, 0) / timingScores.length
        : null,
    timingTrend: aggregateTimingTrend(lineScores, calibration),
    weakestLines,
  };
}
