import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
} from "./errors.ts";
import { PersonaIdV1 } from "./personas.ts";

export const KaraokeScoringProvider = Schema.Literal("elevenlabs");

export const KaraokeTimingTrend = Schema.Literals(["early", "late", "mixed", "on_time"]);
export const KaraokeCompletionReason = Schema.Literals([
  "completed",
  "session_error",
  "provider_unavailable",
  "abandoned",
]);

export const KaraokeScoringPolicy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({
    kind: Schema.Literal("enabled"),
    provider: KaraokeScoringProvider,
    model: Schema.String,
    provider_retention: Schema.Literal("not_stored"),
    platform_retention: Schema.Literal("private_learning"),
    voice_coach_enabled: Schema.optional(Schema.Boolean),
  }),
]);

export type KaraokeScoringPolicy = Schema.Schema.Type<typeof KaraokeScoringPolicy>;

export const KaraokeSession = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("karaoke_session"),
  attempt: Schema.String,
  persona_id: PersonaIdV1,
  protocol_version: Schema.Literal(1),
  websocket_url: Schema.String,
  token_expires_at: Schema.Number,
  session_expires_at: Schema.Number,
  scoring_policy: KaraokeScoringPolicy,
});

export type KaraokeSession = Schema.Schema.Type<typeof KaraokeSession>;

export const KaraokeTimingCalibration = Schema.Struct({
  state: Schema.Literals(["calibrated", "uncalibrated"]),
  reason: Schema.NullOr(
    Schema.Literals(["insufficient_evidence", "offset_out_of_range", "incoherent_residuals"]),
  ),
  offset_ms: Schema.Number,
  raw_offset_ms: Schema.Number,
  residual_spread_ms: Schema.Number,
  measured_line_count: Schema.Number,
  matched_word_count: Schema.Number,
});

export const KaraokeLineDiagnostic = Schema.Struct({
  line_id: Schema.String,
  finalized_reason: Schema.Literals([
    "line_end",
    "asr_final",
    "timeout",
    "seek",
    "session_end",
    "provider_failed",
  ]),
  recognized_word_count: Schema.Number,
  score: Schema.Number,
  text_score: Schema.Number,
  timing_score: Schema.NullOr(Schema.Number),
  confidence_score: Schema.NullOr(Schema.Number),
  median_signed_delta_ms: Schema.NullOr(Schema.Number),
  expected_word_count: Schema.Number,
  recognized_expected_word_positions: Schema.Array(Schema.Number),
  missed_expected_word_positions: Schema.Array(Schema.Number),
});

/** Derived scoring evidence only. It never contains transcript, words, or audio. */
export const KaraokeScoringDiagnostics = Schema.Struct({
  schema_version: Schema.Literal(1),
  scoring_version: Schema.Number,
  timing_calibration: KaraokeTimingCalibration,
  line_diagnostics: Schema.Array(KaraokeLineDiagnostic),
});

export const KaraokeAttempt = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("karaoke_attempt"),
  session_id: Schema.String,
  attempt_id: Schema.String,
  persona_id: PersonaIdV1,
  post_id: Schema.String,
  community_id: Schema.String,
  karaoke_revision_id: Schema.String,
  scoring_version: Schema.Number,
  scoring_provider: Schema.String,
  scoring_model: Schema.String,
  final_score: Schema.Number,
  lyrics_score: Schema.Number,
  timing_score: Schema.NullOr(Schema.Number),
  timing_trend: KaraokeTimingTrend,
  scored_line_count: Schema.Number,
  line_count: Schema.Number,
  uncertain_line_count: Schema.Number,
  no_recognition_line_count: Schema.Number,
  low_confidence_line_count: Schema.Number,
  completion_reason: KaraokeCompletionReason,
  rank_eligible: Schema.Boolean,
  activity_date: Schema.String,
  completed_at: Schema.String,
  created_at: Schema.String,
  recording_state: Schema.Literals(["pending", "stored", "failed", "deleted"]),
  scoring_diagnostics: Schema.optional(Schema.NullOr(KaraokeScoringDiagnostics)),
});

export type KaraokeAttempt = Schema.Schema.Type<typeof KaraokeAttempt>;

export const KaraokeClientContext = Schema.Struct({
  headphones: Schema.optional(Schema.Boolean),
  input_device_kind: Schema.optional(
    Schema.Literals(["bluetooth", "built_in", "unknown", "usb", "wired"]),
  ),
  platform: Schema.optional(
    Schema.Literals(["android", "ios", "linux", "macos", "web", "windows"]),
  ),
});

export const KaraokeAttemptCreate = Schema.Struct({
  persona_id: Schema.optional(PersonaIdV1),
  timezone: Schema.optional(Schema.NullOr(Schema.String)),
  client_context: Schema.optional(KaraokeClientContext),
});

export const KaraokeAttemptCreateHeaders = Schema.Struct({
  "idempotency-key": Schema.String,
});

export type KaraokeAttemptCreateRequest = Schema.Schema.Type<typeof KaraokeAttemptCreate>;

export const KaraokePlaybackKind = Schema.Literal("full_mix");

export const KaraokePlaybackAudio = Schema.Struct({
  kind: KaraokePlaybackKind,
  ref: Schema.String,
});

export const KaraokePayloadWord = Schema.Struct({
  text: Schema.String,
  start_ms: Schema.Number,
  end_ms: Schema.Number,
});

export const KaraokePayloadLine = Schema.Struct({
  id: Schema.String,
  index: Schema.Number,
  kind: Schema.Literal("lyric"),
  text: Schema.String,
  start_ms: Schema.Number,
  end_ms: Schema.Number,
  words: Schema.NonEmptyArray(KaraokePayloadWord),
});

export const KaraokeReadiness = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "not_a_song",
      "lyrics_not_accepted",
      "alignment_unavailable",
      "line_catalog_missing",
      "invalid_timed_lyrics",
    ]),
  }),
  Schema.Struct({
    state: Schema.Literal("processing"),
    reason: Schema.Literal("alignment_pending"),
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    object: Schema.Literal("song_karaoke_payload"),
    community_id: Schema.String,
    post_id: Schema.String,
    title: Schema.String,
    karaoke_revision_id: Schema.String,
    playback_audio: KaraokePlaybackAudio,
    playback_kind: KaraokePlaybackKind,
    karaoke_lines: Schema.NonEmptyArray(KaraokePayloadLine),
  }),
]);

export type KaraokeReadiness = Schema.Schema.Type<typeof KaraokeReadiness>;

export const KaraokeLeaderboardIdentity = Schema.Struct({
  visibility: Schema.Literals(["visible", "anonymized"]),
  display_name: Schema.NullOr(Schema.String),
  handle: Schema.NullOr(Schema.String),
  avatar_ref: Schema.NullOr(Schema.String),
});

export const KaraokeLeaderboardEntry = Schema.Struct({
  rank: Schema.Number,
  top_percent: Schema.Number,
  score: Schema.Number,
  reached_at: Schema.String,
  identity: KaraokeLeaderboardIdentity,
  is_viewer: Schema.Boolean,
});

export const KaraokeSongLeaderboard = Schema.Struct({
  object: Schema.Literal("karaoke_song_leaderboard"),
  post_id: Schema.String,
  community_id: Schema.String,
  scope: Schema.Literal("all_time"),
  period_start: Schema.optional(Schema.NullOr(Schema.String)),
  period_end: Schema.optional(Schema.NullOr(Schema.String)),
  karaoke_revision_id: Schema.String,
  scoring_version: Schema.Number,
  scoring_provider: Schema.String,
  scoring_model: Schema.String,
  total_ranked: Schema.Number,
  entries: Schema.Array(KaraokeLeaderboardEntry),
  viewer_rank: Schema.NullOr(Schema.Number),
  viewer_top_percent: Schema.NullOr(Schema.Number),
  viewer_best_score: Schema.NullOr(Schema.Number),
  viewer_best_reached_at: Schema.NullOr(Schema.String),
  viewer_eligible_attempt_count: Schema.Number,
});

export type KaraokeSongLeaderboard = Schema.Schema.Type<typeof KaraokeSongLeaderboard>;

export const KaraokeLeaderboardQuery = Schema.Struct({
  limit: Schema.optional(Schema.String),
});

export type KaraokeLeaderboardQuery = Schema.Schema.Type<typeof KaraokeLeaderboardQuery>;

export const CreateKaraokeAttempt = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts/:postId/karaoke/attempts",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ communityId: Schema.String, postId: Schema.String }),
    headers: KaraokeAttemptCreateHeaders,
    body: KaraokeAttemptCreate,
    bodyRequired: false,
  },
  response: KaraokeSession,
  successStatus: 201,
  errors: [AuthError, BadRequest, Conflict, NotFound, ProviderUnavailable, RateLimited],
});

export const GetKaraokeReadiness = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/karaoke",
  auth: Auth.userOrAdmin(),
  request: {
    path: Schema.Struct({ communityId: Schema.String, postId: Schema.String }),
  },
  response: KaraokeReadiness,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const GetKaraokeAttempt = endpoint({
  method: "GET",
  path: "/communities/:communityId/karaoke/attempts/:attemptId",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ communityId: Schema.String, attemptId: Schema.String }),
  },
  response: KaraokeAttempt,
  successStatus: 200,
  errors: [AuthError, NotFound, InternalError],
});

export const GetKaraokeLeaderboard = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/karaoke/leaderboard",
  auth: Auth.user(),
  request: {
    path: Schema.Struct({ communityId: Schema.String, postId: Schema.String }),
    query: KaraokeLeaderboardQuery,
  },
  response: KaraokeSongLeaderboard,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const KARAOKE_TRANSPORT_PROTOCOL_VERSION = 1 as const;
export const KARAOKE_BINARY_PROTOCOL_VERSION = 1 as const;
export const KARAOKE_BINARY_HEADER_BYTES = 28 as const;
export const KARAOKE_MAX_BINARY_FRAME_BYTES = 200_000 as const;

export interface KaraokeTransportEnvelope {
  protocolVersion: typeof KARAOKE_TRANSPORT_PROTOCOL_VERSION;
  sessionId: string;
  attemptId: string;
  sequence: number;
}

export interface KaraokeLineIdentity {
  lineId: string;
  lineIndex: number;
  scoredLineIndex: number;
}

export interface KaraokeRecognizedWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number | null;
  final?: boolean;
  source?: "stt" | "reference" | "manual";
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
  medianAbsDeltaMs: number;
  medianSignedDeltaMs: number;
  matchedWordCount: number;
  timingTrend: "early" | "late" | "mixed" | "on_time";
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
  finalizedReason:
    | "line_end"
    | "asr_final"
    | "timeout"
    | "seek"
    | "session_end"
    | "provider_failed";
  uncertain: boolean;
}

export interface KaraokeTimingCalibrationResult {
  state: "calibrated" | "uncalibrated";
  reason: "insufficient_evidence" | "offset_out_of_range" | "incoherent_residuals" | null;
  offsetMs: number;
  rawOffsetMs: number;
  residualSpreadMs: number;
  measuredLineCount: number;
  matchedWordCount: number;
}

export interface KaraokeLineDiagnostic {
  lineId: string;
  finalizedReason: KaraokeLineScore["finalizedReason"];
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
  uncertainLineCount: number;
  phoneticUnavailableLineCount: number;
  lowConfidenceLineCount: number;
  timingTrend: "early" | "late" | "mixed" | "on_time";
  timingCalibration: KaraokeTimingCalibrationResult;
  lineDiagnostics?: KaraokeLineDiagnostic[];
  strongestLines: KaraokeLineScore[];
  weakestLines: KaraokeLineScore[];
  missedWords: string[];
}

export type KaraokeClientEvent = KaraokeTransportEnvelope &
  (
    | { type: "start"; postId: string; startedAtAudioMs: number }
    | { type: "playback_sync"; audioTimeMs: number; playing: boolean }
    | { type: "pause"; audioTimeMs: number }
    | { type: "resume"; audioTimeMs: number }
    | { type: "seek"; audioTimeMs: number }
    | ({ type: "line_boundary"; audioTimeMs: number } & KaraokeLineIdentity)
    | { type: "finish"; audioTimeMs: number }
    | { type: "abort"; code: string }
  );

export type KaraokeStreamingSttEvent = KaraokeTransportEnvelope &
  (
    | {
        type: "stt_partial";
        deliveredAtAudioMs: number;
        text: string;
        words: KaraokeRecognizedWord[];
      }
    | {
        type: "stt_final";
        deliveredAtAudioMs: number;
        text: string;
        words: KaraokeRecognizedWord[];
      }
  );

export type KaraokeServerEvent = KaraokeTransportEnvelope & { eventId: string } & (
    | { type: "stt_partial"; text: string; words: KaraokeRecognizedWord[] }
    | { type: "stt_final"; text: string; words: KaraokeRecognizedWord[] }
    | { type: "line_score"; result: KaraokeLineScore }
    | { type: "summary"; summary: KaraokeSessionSummary }
    | { type: "session_error"; code: string; message?: string }
  );

/** Binary PCM is a WebSocket frame payload, not an API field and is omitted here. */
export interface KaraokeClientBinaryFrameHeader extends KaraokeTransportEnvelope {
  type: "audio_chunk";
  chunkId: number;
  sampleRate: 16000;
  songStartMs: number;
  songEndMs: number;
}

export type KaraokeSessionWebSocketMessage = KaraokeClientEvent | KaraokeServerEvent;

export type KaraokeTransportErrorCode =
  | "binary_invalid_sample_rate"
  | "binary_magic_mismatch"
  | "binary_odd_pcm_length"
  | "binary_oversized_frame"
  | "binary_truncated"
  | "binary_unknown_flags"
  | "binary_version_mismatch"
  | "invalid_event_payload"
  | "unsupported_protocol_version"
  | "session_identity_mismatch"
  | "non_monotonic_sequence"
  | "line_identity_mismatch"
  | "stt_adapter_start_failed"
  | "karaoke_scoring_disabled"
  | "session_not_recording"
  | "session_aborted";

export interface KaraokeTransportError {
  code: KaraokeTransportErrorCode;
  message: string;
  sequence?: number;
}

export interface KaraokeRuntimeBuild {
  version: string;
  gitSha: string;
}
