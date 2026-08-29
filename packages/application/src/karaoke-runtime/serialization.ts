import type {
  KaraokeLineScore,
  KaraokeRecognizedWord,
  KaraokeSessionSummary,
  KaraokeTimingCalibration,
  KaraokeTimingCalibrationReason,
  ScorableKaraokeLine,
  ScorableKaraokeWord,
} from "./scoring";
import type {
  KaraokePendingCommit,
  KaraokeScoringSttProvider,
  KaraokeSessionState,
  KaraokeSessionStatus,
} from "./session";
import type { KaraokeSessionHostSnapshot } from "./session-host";

export type JsonKaraokeScoringPolicy =
  | { kind: "disabled" }
  | {
      kind: "enabled";
      provider: KaraokeScoringSttProvider;
      model: string;
      retention: "not_stored";
      voiceCoachEnabled?: boolean;
    };

export type PublicKaraokeScoringPolicy =
  | { kind: "disabled" }
  | {
      kind: "enabled";
      provider: KaraokeScoringSttProvider;
      model: string;
      retention: "not_stored";
      voice_coach_enabled?: boolean;
    };

export type JsonKaraokeSessionStatus = KaraokeSessionStatus;

export type StoredKaraokeSessionPolicy = JsonKaraokeScoringPolicy;

export type StoredKaraokeRecognizedWord = KaraokeRecognizedWord;

export type StoredKaraokeScorableLine = ScorableKaraokeLine;
export type StoredKaraokeScorableWord = ScorableKaraokeWord;

export interface StoredKaraokeSessionState
  extends Omit<KaraokeSessionState, "assignmentLocks" | "scoringPolicy"> {
  assignmentLocks: string[];
  scoringPolicy: StoredKaraokeSessionPolicy;
}

export interface StoredKaraokeSessionSnapshot {
  state: StoredKaraokeSessionState;
  lastClientSequence: number | null;
  lastSttSequence: number | null;
  serverSequence: number;
}

export type KaraokeSnapshotValidationErrorCode =
  | "invalid_status"
  | "invalid_policy"
  | "invalid_sequence"
  | "invalid_locks"
  | "invalid_range"
  | "invalid_score"
  | "invalid_watermark"
  | "invalid_pending_commit"
  | "unknown_line_reference"
  | "missing_session_id"
  | "missing_attempt_id"
  | "missing_lines"
  | "missing_summary";

export class KaraokeSnapshotValidationError extends Error {
  override readonly name = "KaraokeSnapshotValidationError";

  constructor(
    readonly code: KaraokeSnapshotValidationErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
  }
}

const KARAOKE_SESSION_STATUSES: readonly JsonKaraokeSessionStatus[] = [
  "idle",
  "recording",
  "paused",
  "finalizing",
  "finalized",
  "aborted",
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireString(input: Record<string, unknown>, key: string, path: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new KaraokeSnapshotValidationError(
      key === "sessionId"
        ? "missing_session_id"
        : key === "attemptId"
          ? "missing_attempt_id"
          : "invalid_policy",
      path,
      `${key} must be a non-empty string`,
    );
  }
  return value;
}

function requireStringArray(input: Record<string, unknown>, key: string, path: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new KaraokeSnapshotValidationError("invalid_locks", path, `${key} must be a string[]`);
  }
  return value as string[];
}

function requireValidRange(
  startMs: unknown,
  endMs: unknown,
  path: string,
): { startMs: number; endMs: number } {
  if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs) || endMs < startMs) {
    throw new KaraokeSnapshotValidationError(
      "invalid_range",
      path,
      `startMs and endMs must be finite numbers with endMs >= startMs`,
    );
  }
  return { endMs, startMs };
}

const KARAOKE_SCORING_STT_PROVIDERS: readonly KaraokeScoringSttProvider[] = ["elevenlabs"];

function deserializeScoringPolicy(value: unknown, path: string): StoredKaraokeSessionPolicy {
  if (!isPlainRecord(value)) {
    throw new KaraokeSnapshotValidationError("invalid_policy", path, "policy must be an object");
  }
  if (value.kind === "disabled") {
    return { kind: "disabled" };
  }
  if (value.kind === "enabled") {
    if (value.retention !== "not_stored") {
      throw new KaraokeSnapshotValidationError(
        "invalid_policy",
        `${path}.retention`,
        `retention must be "not_stored"`,
      );
    }
    if (typeof value.provider !== "string" || value.provider.length === 0) {
      throw new KaraokeSnapshotValidationError(
        "invalid_policy",
        `${path}.provider`,
        `provider must be a non-empty string`,
      );
    }
    if (!KARAOKE_SCORING_STT_PROVIDERS.includes(value.provider as KaraokeScoringSttProvider)) {
      throw new KaraokeSnapshotValidationError(
        "invalid_policy",
        `${path}.provider`,
        `provider must be one of ${KARAOKE_SCORING_STT_PROVIDERS.join(", ")}`,
      );
    }
    if (typeof value.model !== "string" || value.model.length === 0) {
      throw new KaraokeSnapshotValidationError(
        "invalid_policy",
        `${path}.model`,
        `model must be a non-empty string`,
      );
    }
    const policy: StoredKaraokeSessionPolicy = {
      kind: "enabled",
      model: value.model,
      provider: value.provider as KaraokeScoringSttProvider,
      retention: "not_stored",
    };
    if (typeof value.voiceCoachEnabled === "boolean") {
      policy.voiceCoachEnabled = value.voiceCoachEnabled;
    }
    return policy;
  }
  throw new KaraokeSnapshotValidationError(
    "invalid_policy",
    `${path}.kind`,
    `policy kind must be "disabled" or "enabled"`,
  );
}

function serializeScoringPolicy(policy: StoredKaraokeSessionPolicy): JsonKaraokeScoringPolicy {
  if (policy.kind === "disabled") {
    return { kind: "disabled" };
  }
  const json: {
    kind: "enabled";
    provider: KaraokeScoringSttProvider;
    model: string;
    retention: "not_stored";
    voiceCoachEnabled?: boolean;
  } = {
    kind: "enabled",
    model: policy.model,
    provider: policy.provider,
    retention: "not_stored",
  };
  if (policy.voiceCoachEnabled !== undefined) {
    json.voiceCoachEnabled = policy.voiceCoachEnabled;
  }
  return json;
}

function deserializeRecognizedWord(value: unknown, path: string): KaraokeRecognizedWord {
  if (!isPlainRecord(value)) {
    throw new KaraokeSnapshotValidationError("invalid_range", path, "word must be an object");
  }
  const text = typeof value.text === "string" ? value.text : "";
  const range = requireValidRange(value.startMs, value.endMs, `${path}.range`);
  const word: KaraokeRecognizedWord = {
    endMs: range.endMs,
    startMs: range.startMs,
    text,
  };
  if (isFiniteNumber(value.confidence)) {
    word.confidence = value.confidence;
  }
  if (typeof value.final === "boolean") {
    word.final = value.final;
  }
  if (value.source === "stt" || value.source === "reference" || value.source === "manual") {
    word.source = value.source;
  }
  return word;
}

function deserializeScorableLine(value: unknown, path: string): ScorableKaraokeLine {
  if (!isPlainRecord(value)) {
    throw new KaraokeSnapshotValidationError("missing_lines", path, "line must be an object");
  }
  const range = requireValidRange(value.startMs, value.endMs, `${path}.range`);
  if (typeof value.lineId !== "string" || value.lineId.length === 0) {
    throw new KaraokeSnapshotValidationError("missing_lines", `${path}.lineId`, "lineId required");
  }
  if (!isFiniteNumber(value.lineIndex) || !isFiniteNumber(value.scoredLineIndex)) {
    throw new KaraokeSnapshotValidationError(
      "missing_lines",
      `${path}.lineIndex`,
      "lineIndex and scoredLineIndex must be finite numbers",
    );
  }
  if (typeof value.text !== "string") {
    throw new KaraokeSnapshotValidationError("missing_lines", `${path}.text`, "text required");
  }
  const wordsValue = value.words;
  if (!Array.isArray(wordsValue)) {
    throw new KaraokeSnapshotValidationError(
      "missing_lines",
      `${path}.words`,
      "words must be an array",
    );
  }
  const words: ScorableKaraokeWord[] = wordsValue.map((w, i) => {
    if (!isPlainRecord(w)) {
      throw new KaraokeSnapshotValidationError(
        "invalid_range",
        `${path}.words[${i}]`,
        "word must be an object",
      );
    }
    const r = requireValidRange(w.startMs, w.endMs, `${path}.words[${i}].range`);
    if (typeof w.text !== "string") {
      throw new KaraokeSnapshotValidationError(
        "invalid_range",
        `${path}.words[${i}].text`,
        "text required",
      );
    }
    return { endMs: r.endMs, startMs: r.startMs, text: w.text };
  });

  return {
    endMs: range.endMs,
    lineId: value.lineId,
    lineIndex: value.lineIndex,
    scoredLineIndex: value.scoredLineIndex,
    startMs: range.startMs,
    text: value.text,
    words,
  };
}

function deserializeLineScore(
  value: unknown,
  path: string,
  knownLineIds: ReadonlySet<string>,
): KaraokeLineScore {
  if (!isPlainRecord(value)) {
    throw new KaraokeSnapshotValidationError("invalid_score", path, "line score must be an object");
  }
  if (typeof value.lineId !== "string" || !knownLineIds.has(value.lineId)) {
    throw new KaraokeSnapshotValidationError(
      "unknown_line_reference",
      `${path}.lineId`,
      "lineId must reference a known line",
    );
  }
  if (!isFiniteNumber(value.score) || value.score < 0 || value.score > 1) {
    throw new KaraokeSnapshotValidationError(
      "invalid_score",
      `${path}.score`,
      "score must be in [0, 1]",
    );
  }
  if (!isFiniteNumber(value.lineIndex) || !isFiniteNumber(value.scoredLineIndex)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_score",
      `${path}.lineIndex`,
      "lineIndex and scoredLineIndex must be finite",
    );
  }
  const textScoreValue = value.textScore;
  if (!isPlainRecord(textScoreValue)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_score",
      `${path}.textScore`,
      "textScore must be an object",
    );
  }
  const textScore: KaraokeLineScore["textScore"] = {
    confidenceMean: isFiniteNumber(textScoreValue.confidenceMean)
      ? textScoreValue.confidenceMean
      : null,
    keywordCoverage: isFiniteNumber(textScoreValue.keywordCoverage)
      ? textScoreValue.keywordCoverage
      : 0,
    missedWords: Array.isArray(textScoreValue.missedWords)
      ? textScoreValue.missedWords.filter((m): m is string => typeof m === "string")
      : [],
    phoneticAvailable: textScoreValue.phoneticAvailable === true,
    phoneticCoverage: isFiniteNumber(textScoreValue.phoneticCoverage)
      ? textScoreValue.phoneticCoverage
      : 0,
    phoneticQuality: isFiniteNumber(textScoreValue.phoneticQuality)
      ? textScoreValue.phoneticQuality
      : 0,
    score: isFiniteNumber(textScoreValue.score) ? textScoreValue.score : 0,
    wer: isFiniteNumber(textScoreValue.wer) ? textScoreValue.wer : 0,
  };
  const finalizedReason = value.finalizedReason;
  if (
    finalizedReason !== "line_end" &&
    finalizedReason !== "asr_final" &&
    finalizedReason !== "timeout" &&
    finalizedReason !== "seek" &&
    finalizedReason !== "session_end" &&
    finalizedReason !== "provider_failed"
  ) {
    throw new KaraokeSnapshotValidationError(
      "invalid_score",
      `${path}.finalizedReason`,
      "finalizedReason must be a known value",
    );
  }
  const score: KaraokeLineScore = {
    confidenceScore: isFiniteNumber(value.confidenceScore) ? value.confidenceScore : null,
    finalizedReason,
    lineId: value.lineId,
    lineIndex: value.lineIndex,
    recognizedWords: Array.isArray(value.recognizedWords)
      ? value.recognizedWords.map((w, i) =>
          deserializeRecognizedWord(w, `${path}.recognizedWords[${i}]`),
        )
      : [],
    score: value.score,
    scoredLineIndex: value.scoredLineIndex,
    textScore,
    timingScore: null,
    transcript: typeof value.transcript === "string" ? value.transcript : "",
    uncertain: value.uncertain === true,
  };
  if (isPlainRecord(value.timingScore)) {
    const ts = value.timingScore;
    if (
      isFiniteNumber(ts.score) &&
      isFiniteNumber(ts.meanAbsDeltaMs) &&
      isFiniteNumber(ts.signedMeanDeltaMs) &&
      isFiniteNumber(ts.matchedWordCount)
    ) {
      const trend = ts.timingTrend;
      if (trend === "early" || trend === "late" || trend === "mixed" || trend === "on_time") {
        score.timingScore = {
          matchedWordCount: ts.matchedWordCount,
          meanAbsDeltaMs: ts.meanAbsDeltaMs,
          // Snapshots written before v4 carry only the means. Falling back to
          // them keeps an in-flight session resumable across the deploy instead
          // of dropping its timing evidence.
          medianAbsDeltaMs: isFiniteNumber(ts.medianAbsDeltaMs)
            ? ts.medianAbsDeltaMs
            : ts.meanAbsDeltaMs,
          medianSignedDeltaMs: isFiniteNumber(ts.medianSignedDeltaMs)
            ? ts.medianSignedDeltaMs
            : ts.signedMeanDeltaMs,
          score: ts.score,
          signedMeanDeltaMs: ts.signedMeanDeltaMs,
          timingTrend: trend,
        };
      }
    }
  }
  return score;
}

const TIMING_CALIBRATION_REASONS: readonly KaraokeTimingCalibrationReason[] = [
  "insufficient_evidence",
  "offset_out_of_range",
  "incoherent_residuals",
];

/**
 * Tolerant by design: a snapshot written before v4 has no calibration block, and
 * a resumed session must not fail to deserialize over a diagnostic. Absent or
 * malformed input reads as "uncalibrated, not enough evidence", which is the
 * safe interpretation — timing then contributes its neutral value rather than a
 * value we cannot vouch for.
 */
function deserializeTimingCalibration(value: unknown): KaraokeTimingCalibration {
  const fallback: KaraokeTimingCalibration = {
    matchedWordCount: 0,
    measuredLineCount: 0,
    offsetMs: 0,
    rawOffsetMs: 0,
    reason: "insufficient_evidence",
    residualSpreadMs: 0,
    state: "uncalibrated",
  };
  if (!isPlainRecord(value)) {
    return fallback;
  }
  const state = value.state === "calibrated" ? "calibrated" : "uncalibrated";
  const reason = TIMING_CALIBRATION_REASONS.find((candidate) => candidate === value.reason) ?? null;

  return {
    matchedWordCount: isFiniteNumber(value.matchedWordCount) ? value.matchedWordCount : 0,
    measuredLineCount: isFiniteNumber(value.measuredLineCount) ? value.measuredLineCount : 0,
    offsetMs: isFiniteNumber(value.offsetMs) ? value.offsetMs : 0,
    rawOffsetMs: isFiniteNumber(value.rawOffsetMs) ? value.rawOffsetMs : 0,
    reason: state === "calibrated" ? null : (reason ?? "insufficient_evidence"),
    residualSpreadMs: isFiniteNumber(value.residualSpreadMs) ? value.residualSpreadMs : 0,
    state,
  };
}

export function serializeKaraokeScoringPolicy(
  policy: StoredKaraokeSessionPolicy,
): JsonKaraokeScoringPolicy {
  return serializeScoringPolicy(policy);
}

export function deserializeKaraokeScoringPolicy(
  value: unknown,
  path = "scoringPolicy",
): StoredKaraokeSessionPolicy {
  return deserializeScoringPolicy(value, path);
}

export function serializeKaraokeScoringPolicyForApi(
  policy: StoredKaraokeSessionPolicy | JsonKaraokeScoringPolicy,
): PublicKaraokeScoringPolicy {
  if (policy.kind === "disabled") {
    return { kind: "disabled" };
  }
  const result: {
    kind: "enabled";
    provider: KaraokeScoringSttProvider;
    model: string;
    retention: "not_stored";
    voice_coach_enabled?: boolean;
  } = {
    kind: "enabled",
    model: policy.model,
    provider: policy.provider,
    retention: "not_stored",
  };
  if (policy.voiceCoachEnabled !== undefined) {
    result.voice_coach_enabled = policy.voiceCoachEnabled;
  }
  return result;
}

function validateStateShape(
  state: Record<string, unknown>,
  statePath: string,
): {
  lines: ScorableKaraokeLine[];
  recognizedWords: KaraokeRecognizedWord[];
  finalizedLineScores: KaraokeLineScore[];
  summary: KaraokeSessionSummary | null;
} {
  if (!Array.isArray(state.lines)) {
    throw new KaraokeSnapshotValidationError(
      "missing_lines",
      `${statePath}.lines`,
      "lines must be an array",
    );
  }
  const lines = state.lines.map((l, i) => deserializeScorableLine(l, `${statePath}.lines[${i}]`));
  const knownLineIds = new Set(lines.map((l) => l.lineId));

  if (!Array.isArray(state.recognizedWords)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_range",
      `${statePath}.recognizedWords`,
      "recognizedWords must be an array",
    );
  }
  const recognizedWords = state.recognizedWords.map((w, i) =>
    deserializeRecognizedWord(w, `${statePath}.recognizedWords[${i}]`),
  );

  if (!Array.isArray(state.finalizedLineScores)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_score",
      `${statePath}.finalizedLineScores`,
      "finalizedLineScores must be an array",
    );
  }
  const finalizedLineScores = state.finalizedLineScores.map((s, i) =>
    deserializeLineScore(s, `${statePath}.finalizedLineScores[${i}]`, knownLineIds),
  );

  let summary: KaraokeSessionSummary | null = null;
  if (state.summary !== null && state.summary !== undefined) {
    if (!isPlainRecord(state.summary)) {
      throw new KaraokeSnapshotValidationError(
        "missing_summary",
        `${statePath}.summary`,
        "summary must be an object or null",
      );
    }
    summary = {
      confidenceMean: isFiniteNumber(state.summary.confidenceMean)
        ? state.summary.confidenceMean
        : null,
      finalScore: isFiniteNumber(state.summary.finalScore) ? state.summary.finalScore : 0,
      lineCount: isFiniteNumber(state.summary.lineCount) ? state.summary.lineCount : 0,
      lineDiagnostics: Array.isArray(state.summary.lineDiagnostics)
        ? state.summary.lineDiagnostics.flatMap((value) => {
            if (
              !isPlainRecord(value) ||
              typeof value.lineId !== "string" ||
              typeof value.finalizedReason !== "string" ||
              !isFiniteNumber(value.recognizedWordCount) ||
              !isFiniteNumber(value.score) ||
              !isFiniteNumber(value.textScore)
            ) {
              return [];
            }
            const finalizedReason = value.finalizedReason;
            if (
              finalizedReason !== "line_end" &&
              finalizedReason !== "asr_final" &&
              finalizedReason !== "timeout" &&
              finalizedReason !== "seek" &&
              finalizedReason !== "session_end" &&
              finalizedReason !== "provider_failed"
            ) {
              return [];
            }
            return [
              {
                confidenceScore: isFiniteNumber(value.confidenceScore)
                  ? value.confidenceScore
                  : null,
                finalizedReason,
                lineId: value.lineId,
                medianSignedDeltaMs: isFiniteNumber(value.medianSignedDeltaMs)
                  ? value.medianSignedDeltaMs
                  : null,
                recognizedWordCount: value.recognizedWordCount,
                score: value.score,
                textScore: value.textScore,
                timingScore: isFiniteNumber(value.timingScore) ? value.timingScore : null,
              },
            ];
          })
        : [],
      lowConfidenceLineCount: isFiniteNumber(state.summary.lowConfidenceLineCount)
        ? state.summary.lowConfidenceLineCount
        : 0,
      lyricsScore: isFiniteNumber(state.summary.lyricsScore) ? state.summary.lyricsScore : 0,
      missedWords: Array.isArray(state.summary.missedWords)
        ? state.summary.missedWords.filter((m): m is string => typeof m === "string")
        : [],
      noRecognitionLineCount: isFiniteNumber(state.summary.noRecognitionLineCount)
        ? state.summary.noRecognitionLineCount
        : 0,
      uncertainLineCount: isFiniteNumber(state.summary.uncertainLineCount)
        ? state.summary.uncertainLineCount
        : 0,
      phoneticUnavailableLineCount: isFiniteNumber(state.summary.phoneticUnavailableLineCount)
        ? state.summary.phoneticUnavailableLineCount
        : 0,
      scoredLineCount: isFiniteNumber(state.summary.scoredLineCount)
        ? state.summary.scoredLineCount
        : 0,
      strongestLines: Array.isArray(state.summary.strongestLines)
        ? state.summary.strongestLines.map((l, i) =>
            deserializeLineScore(l, `${statePath}.summary.strongestLines[${i}]`, knownLineIds),
          )
        : [],
      timingCalibration: deserializeTimingCalibration(state.summary.timingCalibration),
      timingScore: isFiniteNumber(state.summary.timingScore) ? state.summary.timingScore : null,
      timingTrend:
        state.summary.timingTrend === "early" ||
        state.summary.timingTrend === "late" ||
        state.summary.timingTrend === "mixed" ||
        state.summary.timingTrend === "on_time"
          ? state.summary.timingTrend
          : "on_time",
      weakestLines: Array.isArray(state.summary.weakestLines)
        ? state.summary.weakestLines.map((l, i) =>
            deserializeLineScore(l, `${statePath}.summary.weakestLines[${i}]`, knownLineIds),
          )
        : [],
    };
  }

  return { finalizedLineScores, lines, recognizedWords, summary };
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Missing (legacy snapshots predating pendingCommit) → null default.
// Present-but-malformed → throw, so corruption is never silently dropped.
function deserializePendingCommit(
  value: unknown,
  knownLineIds: ReadonlySet<string>,
  path: string,
): KaraokePendingCommit | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainRecord(value)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_pending_commit",
      path,
      "pendingCommit must be an object or null",
    );
  }
  if (typeof value.commitId !== "string" || value.commitId.length === 0) {
    throw new KaraokeSnapshotValidationError(
      "invalid_pending_commit",
      `${path}.commitId`,
      "commitId must be a non-empty string",
    );
  }
  if (typeof value.streamGeneration !== "string" || value.streamGeneration.length === 0) {
    throw new KaraokeSnapshotValidationError(
      "invalid_pending_commit",
      `${path}.streamGeneration`,
      "streamGeneration must be a non-empty string",
    );
  }
  if (!isSafeNonNegativeInt(value.frontierMs)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_pending_commit",
      `${path}.frontierMs`,
      "frontierMs must be a non-negative safe integer",
    );
  }
  if (!isSafeNonNegativeInt(value.requestedAtEpochMs)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_pending_commit",
      `${path}.requestedAtEpochMs`,
      "requestedAtEpochMs must be a non-negative safe integer",
    );
  }
  if (!Array.isArray(value.lineIds) || value.lineIds.length === 0) {
    throw new KaraokeSnapshotValidationError(
      "invalid_pending_commit",
      `${path}.lineIds`,
      "lineIds must be a non-empty array",
    );
  }
  const lineIds: string[] = [];
  const seen = new Set<string>();
  for (const id of value.lineIds) {
    if (typeof id !== "string" || !knownLineIds.has(id)) {
      throw new KaraokeSnapshotValidationError(
        "invalid_pending_commit",
        `${path}.lineIds`,
        "lineIds must reference known lines",
      );
    }
    if (seen.has(id)) {
      throw new KaraokeSnapshotValidationError(
        "invalid_pending_commit",
        `${path}.lineIds`,
        "lineIds must be unique",
      );
    }
    seen.add(id);
    lineIds.push(id);
  }
  return {
    commitId: value.commitId,
    frontierMs: value.frontierMs,
    lineIds,
    requestedAtEpochMs: value.requestedAtEpochMs,
    streamGeneration: value.streamGeneration,
  };
}

// Missing → 0 default; present-but-invalid → throw.
function deserializeWatermark(value: unknown, path: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!isSafeNonNegativeInt(value)) {
    throw new KaraokeSnapshotValidationError(
      "invalid_watermark",
      path,
      "sttWatermarkMs must be a non-negative safe integer",
    );
  }
  return value;
}

function deserializeStatus(value: unknown, path: string): JsonKaraokeSessionStatus {
  if (
    typeof value !== "string" ||
    !KARAOKE_SESSION_STATUSES.includes(value as JsonKaraokeSessionStatus)
  ) {
    throw new KaraokeSnapshotValidationError(
      "invalid_status",
      path,
      `status must be one of: ${KARAOKE_SESSION_STATUSES.join(", ")}`,
    );
  }
  return value as JsonKaraokeSessionStatus;
}

function deserializeSequence(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  if (!isFiniteNumber(value) || value < 0) {
    throw new KaraokeSnapshotValidationError(
      "invalid_sequence",
      path,
      "sequence must be null or a non-negative finite number",
    );
  }
  return value;
}

export function serializeKaraokeSessionSnapshot(
  snapshot: KaraokeSessionHostSnapshot & { serverSequence?: number },
): StoredKaraokeSessionSnapshot {
  const state = snapshot.state;
  const serialized: StoredKaraokeSessionSnapshot = {
    lastClientSequence: snapshot.lastClientSequence,
    lastSttSequence: snapshot.lastSttSequence,
    serverSequence: snapshot.serverSequence ?? 0,
    state: {
      ...state,
      assignmentLocks: [...state.assignmentLocks].sort(),
      finalizedLineScores: [...state.finalizedLineScores],
      lines: [...state.lines],
      recognizedWords: [...state.recognizedWords],
      scoringPolicy: serializeScoringPolicy(state.scoringPolicy as StoredKaraokeSessionPolicy),
      summary: state.summary,
    },
  };
  return serialized;
}

export function deserializeKaraokeSessionSnapshot(
  value: unknown,
  path = "snapshot",
): KaraokeSessionHostSnapshot & { serverSequence: number } {
  if (!isPlainRecord(value)) {
    throw new KaraokeSnapshotValidationError(
      "missing_session_id",
      path,
      "snapshot must be an object",
    );
  }
  if (!isPlainRecord(value.state)) {
    throw new KaraokeSnapshotValidationError(
      "missing_session_id",
      `${path}.state`,
      "state must be an object",
    );
  }
  const state = value.state;

  const sessionId = requireString(state, "sessionId", `${path}.state.sessionId`);
  const attemptId = requireString(state, "attemptId", `${path}.state.attemptId`);
  const status = deserializeStatus(state.status, `${path}.state.status`);
  const currentTimeMs = isFiniteNumber(state.currentTimeMs) ? state.currentTimeMs : 0;
  const scoringPolicy = deserializeScoringPolicy(
    state.scoringPolicy,
    `${path}.state.scoringPolicy`,
  );
  const assignmentLocks = new Set(
    requireStringArray(state, "assignmentLocks", `${path}.state.assignmentLocks`),
  );
  const validated = validateStateShape(state, `${path}.state`);
  const lastClientSequence = deserializeSequence(
    value.lastClientSequence,
    `${path}.lastClientSequence`,
  );
  const lastSttSequence = deserializeSequence(value.lastSttSequence, `${path}.lastSttSequence`);
  const serverSequence = deserializeSequence(value.serverSequence, `${path}.serverSequence`);
  if (serverSequence === null) {
    throw new KaraokeSnapshotValidationError(
      "invalid_sequence",
      `${path}.serverSequence`,
      "serverSequence must be a non-negative finite number",
    );
  }

  const knownLineIds = new Set(validated.lines.map((line) => line.lineId));
  const restoredState: KaraokeSessionState = {
    assignmentLocks,
    attemptId,
    currentTimeMs,
    finalizedLineScores: validated.finalizedLineScores,
    lines: validated.lines,
    pendingCommit: deserializePendingCommit(
      state.pendingCommit,
      knownLineIds,
      `${path}.state.pendingCommit`,
    ),
    recognizedWords: validated.recognizedWords,
    scoringPolicy,
    sessionId,
    status,
    sttWatermarkMs: deserializeWatermark(state.sttWatermarkMs, `${path}.state.sttWatermarkMs`),
    summary: validated.summary,
  };
  if (typeof state.errorCode === "string" && state.errorCode.length > 0) {
    restoredState.errorCode = state.errorCode;
  }

  return {
    lastClientSequence,
    lastSttSequence,
    serverSequence,
    state: restoredState,
  };
}
