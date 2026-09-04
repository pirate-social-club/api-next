import type {
  KaraokeAttempt,
  KaraokeAttemptCreateRequest,
  KaraokeSession,
  KaraokeSongLeaderboard,
} from "@pirate/contracts";
import { Data, Effect } from "effect";
import type { KaraokeSessionSummary } from "./karaoke-runtime/index.ts";
import { Clock, IdGen } from "./ports.ts";
import { canonicalBodyHash } from "./use-cases/content/common.ts";

export class KaraokeCommandRejected extends Data.TaggedError("KaraokeCommandRejected")<{
  readonly reason:
    | "idempotency-conflict"
    | "invalid-input"
    | "not-found"
    | "provider-unavailable"
    | "session-expired";
}> {}

export class KaraokeStoreFailed extends Data.TaggedError("KaraokeStoreFailed")<{
  readonly reason: "constraint" | "invalid-row" | "unavailable";
}> {}

export type KaraokeFailure = KaraokeCommandRejected | KaraokeStoreFailed;

export type KaraokeRuntimeLine = Readonly<{
  id: string;
  index: number;
  kind: "lyric";
  text: string;
  start_ms: number;
  end_ms: number;
  words: readonly Readonly<{ text: string; start_ms: number; end_ms: number }>[];
}>;

export type KaraokeSessionAuthority = Readonly<{
  accountId: string;
  artifactId: string;
  attemptId: string;
  audioRevision: number;
  communityId: string;
  createdAt: string;
  expiresAt: string;
  karaokeRevisionId: string;
  lines: readonly KaraokeRuntimeLine[];
  lyricsRevision: number;
  personaId: string;
  playbackKind: "full_mix";
  postId: string;
  qualificationPolicyVersionId: string;
  requestHash: string;
  scoringModel: "scribe_v2_realtime";
  scoringProvider: "elevenlabs";
  scoringVersion: 5;
  sessionId: string;
  timezone: string;
}>;

export type KaraokeTransportFacts = Readonly<{
  schema_version: 1;
  reconnect_count: number;
  pause_count: number;
  seek_count: number;
  epoch_count: number;
  dropped_frame_count: number;
  late_frame_count: number;
  mic_sample_rate: 16000;
  provider_commit_latency_p50_ms: number | null;
  provider_commit_latency_p95_ms: number | null;
}>;

export type KaraokeRecordingResult =
  | Readonly<{
      state: "stored";
      objectRef: string;
      contentSha256: string;
      byteSize: number;
      durationMs: number;
    }>
  | Readonly<{
      state: "failed";
      failureKind: "multipart_aborted" | "multipart_failed" | "reconciliation_failed";
    }>;

export type KaraokeProviderRetention = "not_stored" | "stored";

export interface KaraokeAttemptStore {
  readonly reserveSession: (input: {
    readonly accountId: string;
    readonly attemptId: string;
    readonly artifactId: string;
    readonly clientContext: KaraokeAttemptCreateRequest["client_context"];
    readonly communityId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly idempotencyKey: string;
    readonly personaId: string;
    readonly postId: string;
    readonly requestHash: string;
    readonly sessionId: string;
    readonly timezone: string | null;
  }) => Effect.Effect<KaraokeSessionAuthority, KaraokeFailure>;
  readonly getAttempt: (input: {
    readonly accountId: string;
    readonly attemptId: string;
    readonly communityId: string;
  }) => Effect.Effect<KaraokeAttempt | null, KaraokeFailure>;
  readonly getLeaderboard: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly limit: number;
    readonly postId: string;
  }) => Effect.Effect<KaraokeSongLeaderboard, KaraokeFailure>;
  readonly finalizeAttempt: (input: {
    readonly authority: KaraokeSessionAuthority;
    readonly completedAt: string;
    readonly completionReason: "completed" | "session_error" | "provider_unavailable" | "abandoned";
    readonly diagnostics: unknown;
    readonly qualificationId: string;
    readonly summary: KaraokeSessionSummary;
    readonly transportFacts: KaraokeTransportFacts;
  }) => Effect.Effect<KaraokeAttempt, KaraokeFailure>;
  readonly reconcileRecording: (input: {
    readonly accountId: string;
    readonly artifactId: string;
    readonly attemptId: string;
    readonly reconciledAt: string;
    readonly providerRetention: KaraokeProviderRetention;
    readonly result: KaraokeRecordingResult;
    readonly sessionId: string;
  }) => Effect.Effect<void, KaraokeFailure>;
}

export interface KaraokeRuntimeGateway {
  readonly initialize: (authority: KaraokeSessionAuthority) => Effect.Effect<
    Readonly<{
      providerRetention: KaraokeProviderRetention;
      token: string;
      tokenExpiresAt: number;
    }>,
    KaraokeFailure
  >;
}

const rejected = (reason: KaraokeCommandRejected["reason"]) =>
  new KaraokeCommandRejected({ reason });

const instant = (milliseconds: number): string => new Date(milliseconds).toISOString();

export const makeKaraokeService = (input: {
  readonly publicOrigin: string;
  readonly runtime: KaraokeRuntimeGateway;
  readonly store: KaraokeAttemptStore;
}) => ({
  createAttempt: (command: {
    readonly accountId: string;
    readonly clientContext: KaraokeAttemptCreateRequest["client_context"];
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly personaId: string;
    readonly postId: string;
    readonly timezone: string | null;
  }) =>
    Effect.gen(function* () {
      const requestHash = yield* canonicalBodyHash({
        ...command,
        clientContext: command.clientContext ?? null,
      }).pipe(Effect.mapError(() => rejected("invalid-input")));
      const ids = yield* IdGen;
      const clock = yield* Clock;
      const now = yield* clock.now;
      const authority = yield* input.store.reserveSession({
        ...command,
        accountId: command.accountId,
        attemptId: `karaoke_attempt_${yield* ids.next}`,
        artifactId: `learner_audio_${yield* ids.next}`,
        createdAt: instant(now),
        expiresAt: instant(now + 30 * 60 * 1_000),
        requestHash,
        sessionId: `karaoke_session_${yield* ids.next}`,
      });
      const credential = yield* input.runtime.initialize(authority);
      const websocketOrigin = input.publicOrigin.replace(/^http/iu, "ws");
      return {
        id: authority.sessionId,
        object: "karaoke_session",
        attempt: authority.attemptId,
        persona_id: authority.personaId,
        protocol_version: 1,
        websocket_url: `${websocketOrigin}/karaoke/realtime/${encodeURIComponent(authority.sessionId)}?token=${encodeURIComponent(credential.token)}`,
        token_expires_at: credential.tokenExpiresAt,
        session_expires_at: Date.parse(authority.expiresAt),
        scoring_policy: {
          kind: "enabled",
          provider: authority.scoringProvider,
          model: authority.scoringModel,
          provider_retention: credential.providerRetention,
          platform_retention: "private_learning",
          voice_coach_enabled: false,
        },
      } satisfies KaraokeSession;
    }),
  getAttempt: input.store.getAttempt,
  getLeaderboard: input.store.getLeaderboard,
});
