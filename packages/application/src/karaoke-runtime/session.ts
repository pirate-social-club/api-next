import {
  aggregateKaraokeSession,
  bucketRecognizedWordsIntoLines,
  KARAOKE_LINE_WINDOW_LEAD_MS,
  type KaraokeLineScore,
  type KaraokeRecognizedWord,
  type KaraokeSessionSummary,
  type ScorableKaraokeLine,
  scoreKaraokeLine,
} from "./scoring";

export type KaraokeSessionStatus =
  | "idle"
  | "recording"
  | "paused"
  | "finalizing"
  | "finalized"
  | "aborted";

export type KaraokeScoringSttProvider = "elevenlabs";

export type KaraokeScoringPolicy =
  | { kind: "disabled" }
  | {
      kind: "enabled";
      provider: KaraokeScoringSttProvider;
      model: string;
      retention: "not_stored";
      voiceCoachEnabled?: boolean;
    };

/**
 * An explicit STT commit the host has issued and is waiting to be acknowledged.
 * Persisted so a restored DO can recognize that the acknowledgment can never
 * arrive on a new provider stream (different `streamGeneration`) and expire it.
 */
export interface KaraokePendingCommit {
  /** Locally minted id correlating this commit to its acknowledgment/failure. */
  commitId: string;
  /**
   * Opaque per-stream id minted in the adapter's start(). MUST be a fresh value
   * each stream (e.g. UUID) so a pending commit from an evicted stream can never
   * be matched by a new stream — a numeric counter restarting at 1 would collide.
   */
  streamGeneration: string;
  /** Song-time frontier (ms) the commit covers; the ack advances the watermark here. */
  frontierMs: number;
  /** When the commit was requested (epoch ms), for the grace/terminal timeout. */
  requestedAtEpochMs: number;
  /** Lines awaiting this commit's acknowledgment (non-empty, known line ids). */
  lineIds: readonly string[];
}

export interface KaraokeSessionState {
  status: KaraokeSessionStatus;
  sessionId: string;
  attemptId: string;
  lines: readonly ScorableKaraokeLine[];
  scoringPolicy: KaraokeScoringPolicy;
  currentTimeMs: number;
  recognizedWords: readonly KaraokeRecognizedWord[];
  finalizedLineScores: readonly KaraokeLineScore[];
  assignmentLocks: ReadonlySet<string>;
  summary: KaraokeSessionSummary | null;
  /** STT completeness frontier (ms): the furthest song time acknowledged by a commit. */
  sttWatermarkMs: number;
  /** The in-flight explicit commit, if any (second-gate + recovery). */
  pendingCommit: KaraokePendingCommit | null;
  errorCode?: string;
}

export type KaraokeSessionEvent =
  | { type: "start"; audioTimeMs: number }
  | { type: "playback_sync"; audioTimeMs: number; playing: boolean }
  | { type: "pause"; audioTimeMs: number }
  | { type: "resume"; audioTimeMs: number }
  | { type: "seek"; audioTimeMs: number }
  | { type: "stt_partial"; words: KaraokeRecognizedWord[] }
  // A committed final. `commitId`/`streamGeneration` correlate it to the pending
  // commit it acknowledges (the reducer ignores stale acks from old streams);
  // `coverageMs` is the frontier the ack advances the watermark to.
  | {
      type: "stt_final";
      words: KaraokeRecognizedWord[];
      coverageMs?: number;
      commitId?: string;
      streamGeneration?: string;
    }
  // Host → reducer: an explicit commit was sent for `lineIds` up to `frontierMs`.
  | {
      type: "commit_sent";
      commitId: string;
      streamGeneration: string;
      frontierMs: number;
      requestedAtEpochMs: number;
      lineIds: string[];
    }
  // Host → reducer: a specific in-flight commit cannot complete (grace timeout or
  // provider/stream failure). Carries commitId+streamGeneration so the reducer can
  // ignore stale failures; the affected lines are taken from the matched pending
  // commit (never caller-supplied) so a malformed event cannot finalize unrelated lines.
  | {
      type: "commit_failed";
      reason: "timeout" | "provider_failed";
      commitId: string;
      streamGeneration: string;
    }
  | { type: "line_boundary"; lineId: string; audioTimeMs: number }
  | { type: "finish"; audioTimeMs: number }
  | { type: "abort"; code: string };

export type KaraokeSessionEffect =
  | { type: "emit_line_score"; score: KaraokeLineScore }
  | { type: "emit_summary"; summary: KaraokeSessionSummary }
  | { type: "lock_line_assignment"; lineId: string }
  | { type: "release_line_assignments"; afterAudioTimeMs: number }
  | { type: "discard_audio"; beforeAudioTimeMs?: number }
  // Reducer → host: lines are due but not yet STT-covered; the host should issue
  // an explicit commit up to `frontierMs` (subject to the provider audio floor).
  | { type: "request_stt_commit"; frontierMs: number; lineIds: string[] }
  | { type: "pause_audio_stream" }
  | { type: "resume_audio_stream" }
  | { type: "close_stt_stream" };

export interface KaraokeSessionReduction {
  state: KaraokeSessionState;
  effects: KaraokeSessionEffect[];
}

export function createKaraokeSessionState(input: {
  sessionId: string;
  attemptId: string;
  lines: readonly ScorableKaraokeLine[];
  scoringPolicy: KaraokeScoringPolicy;
  initialTimeMs?: number;
}): KaraokeSessionState {
  return {
    assignmentLocks: new Set(),
    attemptId: input.attemptId,
    currentTimeMs: input.initialTimeMs ?? 0,
    finalizedLineScores: [],
    lines: [...input.lines].sort((a, b) => a.scoredLineIndex - b.scoredLineIndex),
    pendingCommit: null,
    recognizedWords: [],
    scoringPolicy: input.scoringPolicy,
    sessionId: input.sessionId,
    status: "idle",
    sttWatermarkMs: 0,
    summary: null,
  };
}

function cloneState(state: KaraokeSessionState): KaraokeSessionState {
  return {
    ...state,
    assignmentLocks: new Set(state.assignmentLocks),
    finalizedLineScores: [...state.finalizedLineScores],
    lines: [...state.lines],
    recognizedWords: [...state.recognizedWords],
  };
}

function lineById(state: KaraokeSessionState, lineId: string): ScorableKaraokeLine | null {
  return state.lines.find((line) => line.lineId === lineId) ?? null;
}

function lockedWith(state: KaraokeSessionState, lineId: string): Set<string> {
  const locks = new Set(state.assignmentLocks);
  locks.add(lineId);
  return locks;
}

function unlockedAfterTime(state: KaraokeSessionState, audioTimeMs: number): Set<string> {
  const locks = new Set<string>();

  for (const lineId of state.assignmentLocks) {
    const line = lineById(state, lineId);
    if (line && line.endMs <= audioTimeMs) {
      locks.add(lineId);
    }
  }

  return locks;
}

function mergeRecognizedWords(
  existing: readonly KaraokeRecognizedWord[],
  incoming: readonly KaraokeRecognizedWord[],
): KaraokeRecognizedWord[] {
  const merged = new Map<string, KaraokeRecognizedWord>();

  for (const word of [...existing, ...incoming]) {
    const key = `${word.startMs}:${word.endMs}:${word.text}`;
    const previous = merged.get(key);

    if (previous?.final && !word.final) {
      continue;
    }

    merged.set(key, word);
  }

  return [...merged.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function scoreLineFromState(
  state: KaraokeSessionState,
  line: ScorableKaraokeLine,
  finalizedReason: Parameters<typeof bucketRecognizedWordsIntoLines>[0]["finalizedReason"],
): KaraokeLineScore {
  const buckets = bucketRecognizedWordsIntoLines({
    assignmentLocks: state.assignmentLocks,
    lines: [line],
    nowMs: state.currentTimeMs,
    words: state.recognizedWords,
    ...(finalizedReason === undefined ? {} : { finalizedReason }),
  });
  const bucket = buckets[0];
  if (bucket === undefined) throw new Error("Karaoke line bucket is missing");

  return scoreKaraokeLine({ bucket });
}

function replaceLineScore(
  scores: readonly KaraokeLineScore[],
  score: KaraokeLineScore,
): KaraokeLineScore[] {
  return [...scores.filter((existing) => existing.lineId !== score.lineId), score].sort(
    (a, b) => a.scoredLineIndex - b.scoredLineIndex,
  );
}

function finalizeLine(
  state: KaraokeSessionState,
  lineId: string,
  finalizedReason: Parameters<typeof bucketRecognizedWordsIntoLines>[0]["finalizedReason"],
): { effects: KaraokeSessionEffect[]; state: KaraokeSessionState } {
  const line = lineById(state, lineId);

  if (!line || state.assignmentLocks.has(lineId)) {
    return { effects: [], state };
  }

  const score = scoreLineFromState(state, line, finalizedReason);
  const nextState = {
    ...state,
    assignmentLocks: lockedWith(state, lineId),
    finalizedLineScores: replaceLineScore(state.finalizedLineScores, score),
  };

  return {
    effects: [
      { lineId, type: "lock_line_assignment" },
      { score, type: "emit_line_score" },
      { beforeAudioTimeMs: line.endMs, type: "discard_audio" },
    ],
    state: nextState,
  };
}

// Grace window (song time): if STT coverage has not reached a due line within
// this long after the playback clock passed its end, finalize it anyway so the
// game never stalls. Measured in SONG time, so a pause freezes the grace clock —
// a paused singer is not "timing out"; finalization resumes when playback does.
// Must exceed the client's playback_sync tick interval (DEFAULT 1000ms). A line
// is only added to deferredLineIds (which drives request_stt_commit) while it is
// due-but-not-grace-elapsed; if the grace window [endMs, endMs+grace] is shorter
// than the tick interval it can fall entirely between two playback_sync ticks,
// so the line is never seen while deferrable → no commit is ever requested → it
// times out with no words (false miss). At 2000ms the window spans ~2 ticks, so
// at least one tick always lands inside it: the line is deferred, a commit is
// requested, and the ~240ms ack covers it well within the window. (Verified:
// 600ms produced misses on lines whose windows fell between ticks.)
const KARAOKE_FINALIZE_GRACE_MS = 2_000;

interface FinalizeDueResult {
  effects: KaraokeSessionEffect[];
  state: KaraokeSessionState;
  /** Lines due by playback but still awaiting STT coverage (and within grace). */
  deferredLineIds: string[];
}

/**
 * Second gate: a line finalizes only once the playback clock has passed its end
 * AND STT coverage (the watermark) has reached it — or the grace window elapsed.
 * Lines that are due but not yet covered are reported as `deferredLineIds` so the
 * caller can ask the host to commit (advancing the watermark). `force` finalizes
 * every due line regardless of the gate (terminal session sweep).
 */
function finalizeDueLines(
  state: KaraokeSessionState,
  audioTimeMs: number,
  coveredReason: Parameters<typeof bucketRecognizedWordsIntoLines>[0]["finalizedReason"],
  options: { force?: boolean } = {},
): FinalizeDueResult {
  let nextState = state;
  const effects: KaraokeSessionEffect[] = [];
  const deferredLineIds: string[] = [];

  for (const line of state.lines) {
    if (line.endMs > audioTimeMs || nextState.assignmentLocks.has(line.lineId)) {
      continue;
    }
    const covered = line.endMs <= nextState.sttWatermarkMs;
    const graceElapsed = audioTimeMs - line.endMs >= KARAOKE_FINALIZE_GRACE_MS;
    if (!options.force && !covered && !graceElapsed) {
      deferredLineIds.push(line.lineId);
      continue;
    }
    // Covered (or forced) → the requested reason; grace-forced uncovered → timeout.
    const reason = options.force || covered ? coveredReason : "timeout";
    const finalized = finalizeLine(nextState, line.lineId, reason);
    nextState = finalized.state;
    effects.push(...finalized.effects);
  }

  return { deferredLineIds, effects, state: nextState };
}

function commitRequestEffects(
  deferredLineIds: readonly string[],
  frontierMs: number,
): KaraokeSessionEffect[] {
  return deferredLineIds.length > 0
    ? [{ frontierMs, lineIds: [...deferredLineIds], type: "request_stt_commit" }]
    : [];
}

function finalizeSession(state: KaraokeSessionState): KaraokeSessionReduction {
  const due = finalizeDueLines(state, Number.POSITIVE_INFINITY, "session_end", { force: true });
  const summary = aggregateKaraokeSession({ lineScores: due.state.finalizedLineScores });

  return {
    effects: [{ type: "close_stt_stream" }, ...due.effects, { summary, type: "emit_summary" }],
    state: {
      ...due.state,
      status: "finalized",
      summary,
    },
  };
}

export function reduceKaraokeSession(
  currentState: KaraokeSessionState,
  event: KaraokeSessionEvent,
): KaraokeSessionReduction {
  const state = cloneState(currentState);
  const effects: KaraokeSessionEffect[] = [];

  if (state.status === "finalized" || state.status === "aborted") {
    return { effects, state };
  }

  switch (event.type) {
    case "start":
      if (state.scoringPolicy.kind === "disabled") {
        return {
          effects,
          state: {
            ...state,
            currentTimeMs: event.audioTimeMs,
            status: "aborted",
            errorCode: "karaoke_scoring_disabled",
          },
        };
      }

      return {
        effects: [{ type: "resume_audio_stream" }],
        state: {
          ...state,
          currentTimeMs: event.audioTimeMs,
          status: "recording",
        },
      };

    case "playback_sync": {
      const syncedState = {
        ...state,
        currentTimeMs: event.audioTimeMs,
        // Once finishing, a stray playback event must not revert to recording.
        status:
          state.status === "finalizing"
            ? "finalizing"
            : event.playing && state.status !== "idle"
              ? "recording"
              : !event.playing && state.status === "recording"
                ? "paused"
                : state.status,
      } satisfies KaraokeSessionState;
      if (!event.playing) {
        return { effects: [], state: syncedState };
      }
      const due = finalizeDueLines(syncedState, event.audioTimeMs, "line_end");
      return {
        effects: [...commitRequestEffects(due.deferredLineIds, event.audioTimeMs), ...due.effects],
        state: due.state,
      };
    }

    case "pause":
      return {
        effects: [{ type: "pause_audio_stream" }],
        state: {
          ...state,
          currentTimeMs: event.audioTimeMs,
          status: state.status === "recording" ? "paused" : state.status,
        },
      };

    case "resume":
      return {
        effects: [{ type: "resume_audio_stream" }],
        state: {
          ...state,
          currentTimeMs: event.audioTimeMs,
          status: state.status === "paused" || state.status === "idle" ? "recording" : state.status,
        },
      };

    case "seek": {
      const assignmentLocks = unlockedAfterTime(state, event.audioTimeMs);
      const recognizedWordCutoffMs = Math.max(0, event.audioTimeMs - KARAOKE_LINE_WINDOW_LEAD_MS);
      // A commit whose frontier is past the seek point covers audio that no
      // longer applies — drop it so its (now stale) ack cannot advance the
      // watermark or finalize released lines.
      const pendingCommit =
        state.pendingCommit && state.pendingCommit.frontierMs > event.audioTimeMs
          ? null
          : state.pendingCommit;
      return {
        effects: [
          { afterAudioTimeMs: event.audioTimeMs, type: "release_line_assignments" },
          { beforeAudioTimeMs: event.audioTimeMs, type: "discard_audio" },
        ],
        state: {
          ...state,
          assignmentLocks,
          currentTimeMs: event.audioTimeMs,
          finalizedLineScores: state.finalizedLineScores.filter((score) => {
            const line = lineById(state, score.lineId);
            return Boolean(line && line.endMs <= event.audioTimeMs);
          }),
          pendingCommit,
          recognizedWords: state.recognizedWords.filter(
            (word) => word.endMs <= recognizedWordCutoffMs,
          ),
          // Rewind the completeness frontier to the seek point; audio after it is discarded.
          sttWatermarkMs: Math.min(state.sttWatermarkMs, event.audioTimeMs),
        },
      };
    }

    case "stt_partial":
      return {
        effects,
        state: {
          ...state,
          recognizedWords: mergeRecognizedWords(state.recognizedWords, event.words),
        },
      };

    case "stt_final": {
      const pending = state.pendingCommit;
      const hasCommitMeta =
        typeof event.commitId === "string" && typeof event.streamGeneration === "string";
      if (hasCommitMeta) {
        // A commit-tagged final MUST exactly match the pending pair. Anything else
        // — stale generation, an old/wrong commitId on the current stream, or no
        // pending commit (e.g. a duplicate ack) — is dropped entirely: it neither
        // merges (possibly stale) words nor advances the watermark.
        const matches =
          pending !== null &&
          event.commitId === pending.commitId &&
          event.streamGeneration === pending.streamGeneration;
        if (!matches) {
          return { effects, state };
        }
        const acked: KaraokeSessionState = {
          ...state,
          pendingCommit: null,
          recognizedWords: mergeRecognizedWords(
            state.recognizedWords,
            event.words.map((word) => ({ ...word, final: true })),
          ),
          // Advance to the frontier the adapter actually committed — never the
          // event's self-reported coverage, which could overstate it.
          sttWatermarkMs: Math.max(state.sttWatermarkMs, pending.frontierMs),
        };
        const dueAcked = finalizeDueLines(acked, acked.currentTimeMs, "asr_final");
        return {
          effects: [
            ...commitRequestEffects(dueAcked.deferredLineIds, acked.currentTimeMs),
            ...dueAcked.effects,
          ],
          state: dueAcked.state,
        };
      }
      // Uncorrelated current-stream final (no commit metadata): merge words and
      // optionally advance the watermark from coverageMs (e.g. deliveredAtAudioMs
      // passed by the test harness to simulate coverage without a commit cycle).
      const merged: KaraokeSessionState = {
        ...state,
        recognizedWords: mergeRecognizedWords(
          state.recognizedWords,
          event.words.map((word) => ({ ...word, final: true })),
        ),
        sttWatermarkMs:
          event.coverageMs != null
            ? Math.max(state.sttWatermarkMs, event.coverageMs)
            : state.sttWatermarkMs,
      };
      const due = finalizeDueLines(merged, merged.currentTimeMs, "asr_final");
      return {
        effects: [
          ...commitRequestEffects(due.deferredLineIds, merged.currentTimeMs),
          ...due.effects,
        ],
        state: due.state,
      };
    }

    case "line_boundary": {
      const boundaryState = {
        ...state,
        currentTimeMs: event.audioTimeMs,
      };
      // Gated finalize (waits for watermark/grace); the host commits up to the
      // boundary in response to the request_stt_commit effect.
      const due = finalizeDueLines(boundaryState, event.audioTimeMs, "line_end");
      return {
        effects: [...commitRequestEffects(due.deferredLineIds, event.audioTimeMs), ...due.effects],
        state: due.state,
      };
    }

    case "finish": {
      const finishing: KaraokeSessionState = {
        ...state,
        currentTimeMs: event.audioTimeMs,
        status: "finalizing",
      };
      // Do not summarize while a commit is still pending: the host drains it
      // (awaits the ack or terminal timeout) and re-issues finish.
      if (state.pendingCommit) {
        return { effects, state: finishing };
      }
      return finalizeSession(finishing);
    }

    case "commit_sent":
      return {
        effects,
        state: {
          ...state,
          pendingCommit: {
            commitId: event.commitId,
            frontierMs: event.frontierMs,
            lineIds: [...event.lineIds],
            requestedAtEpochMs: event.requestedAtEpochMs,
            streamGeneration: event.streamGeneration,
          },
        },
      };

    case "commit_failed": {
      const pending = state.pendingCommit;
      // Ignore stale/mismatched failures (idempotent: a repeated failure for an
      // already-cleared commit is a no-op).
      if (
        !pending ||
        pending.commitId !== event.commitId ||
        pending.streamGeneration !== event.streamGeneration
      ) {
        return { effects, state };
      }
      let nextState: KaraokeSessionState = { ...state, pendingCommit: null };
      const failEffects: KaraokeSessionEffect[] = [];
      // Finalize the lines from the MATCHED pending commit, never caller-supplied.
      for (const lineId of pending.lineIds) {
        if (nextState.assignmentLocks.has(lineId)) continue;
        // provider_failed marks the line uncertain (measurement failure, not poor
        // singing); timeout scores available evidence as sung.
        const finalized = finalizeLine(nextState, lineId, event.reason);
        nextState = finalized.state;
        failEffects.push(...finalized.effects);
      }
      return { effects: failEffects, state: nextState };
    }

    case "abort":
      return {
        effects: [{ type: "close_stt_stream" }],
        state: {
          ...state,
          errorCode: event.code,
          status: "aborted",
        },
      };
  }
}
