import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type KaraokeAttemptStore,
  type KaraokeSessionAuthority,
  makeKaraokeService,
} from "./karaoke-service.ts";
import { Clock, IdGen } from "./ports.ts";

describe("Karaoke service", () => {
  test("creates a bounded single-use realtime session with the public retention split", async () => {
    let reserved: Parameters<KaraokeAttemptStore["reserveSession"]>[0] | null = null;
    const unused = () => Effect.die("unused Karaoke store operation");
    const store: KaraokeAttemptStore = {
      finalizeAttempt: unused,
      getAttempt: unused,
      getLeaderboard: unused,
      reconcileRecording: unused,
      reserveSession: (input) => {
        reserved = input;
        return Effect.succeed({
          accountId: input.accountId,
          artifactId: input.artifactId,
          attemptId: input.attemptId,
          audioRevision: 4,
          communityId: input.communityId,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          karaokeRevisionId: "revision-1",
          lines: [],
          lyricsRevision: 3,
          personaId: "persona-1",
          playbackKind: "full_mix",
          postId: input.postId,
          qualificationPolicyVersionId: "karaoke_qualification_v2@1",
          requestHash: input.requestHash,
          scoringModel: "scribe_v2_realtime",
          scoringProvider: "elevenlabs",
          scoringVersion: 5,
          sessionId: input.sessionId,
          timezone: "UTC",
        } satisfies KaraokeSessionAuthority);
      },
    };
    const service = makeKaraokeService({
      publicOrigin: "https://api.example.test",
      runtime: {
        initialize: () =>
          Effect.succeed({ token: "one time", tokenExpiresAt: Date.UTC(2026, 7, 29, 10, 5) }),
      },
      store,
    });
    let id = 0;
    const result = await Effect.runPromise(
      service
        .createAttempt({
          accountId: "account-1",
          clientContext: { headphones: true, platform: "web" },
          communityId: "community-1",
          idempotencyKey: "request-1",
          personaId: null,
          postId: "post-1",
          timezone: "UTC",
        })
        .pipe(
          Effect.provideService(Clock, { now: Effect.succeed(Date.UTC(2026, 7, 29, 10)) }),
          Effect.provideService(IdGen, { next: Effect.sync(() => String(++id)) }),
        ),
    );

    expect(reserved).toMatchObject({
      artifactId: "learner_audio_2",
      attemptId: "karaoke_attempt_1",
      sessionId: "karaoke_session_3",
    });
    expect(result.websocket_url).toBe(
      "wss://api.example.test/karaoke/realtime/karaoke_session_3?token=one%20time",
    );
    expect(result.scoring_policy).toMatchObject({
      platform_retention: "private_learning",
      provider_retention: "not_stored",
      provider: "elevenlabs",
    });
    expect(result.session_expires_at - Date.UTC(2026, 7, 29, 10)).toBe(30 * 60 * 1_000);
  });
});
