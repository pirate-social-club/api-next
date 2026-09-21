import { expect } from "bun:test";
import {
  aggregateKaraokeSession,
  buildKaraokeScoringDiagnostics,
  type KaraokeLineScore,
} from "@pirate/application";
import { Effect } from "effect";
import type {
  KaraokeActivityTimes,
  StudyActivityTimes,
} from "./activity-participation-composed.pg-fixture.ts";
import {
  COMMUNITY_ID,
  digest,
  LYRIC_LINES,
  POST_ID,
} from "./activity-participation-composed.pg-fixture.ts";
import type { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import type { ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";

export type Runtime = ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
type StudyRepository = ReturnType<typeof makeControlPlaneStudyV2Repository>;
type KaraokeRepository = ReturnType<typeof makeControlPlaneKaraokeRepository>;
type SpokenCommand = Parameters<StudyRepository["completeSpokenAnswer"]>[0];

const run = <A, E>(runtime: Runtime, effect: Effect.Effect<A, E, ControlPlaneDb>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));

export const makeStudyDriver = (
  runtime: Runtime,
  study: StudyRepository,
  times: StudyActivityTimes = {
    acceptedAt: "2026-09-01T12:05:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
  },
) => {
  const answerSpoken = async (input: {
    readonly accountId: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
    readonly attemptNumber: number;
    readonly correct: boolean;
    readonly commandId: string;
  }) => {
    const audioDigest = await digest(input.commandId);
    const idempotencyKey = `composed-spoken-${input.commandId}`;
    const requestHash = await digest(`composed-request-${input.commandId}`);
    await run(
      runtime,
      study.loadSpokenAnswerContext({
        accountId: input.accountId,
        communityId: COMMUNITY_ID,
        idempotencyKey,
        sessionId: input.sessionId,
        sessionItemId: input.sessionItemId,
      }),
    );
    const reservation = await run(
      runtime,
      study.reserveSpokenAnswer({
        accountId: input.accountId,
        attemptNumber: input.attemptNumber,
        audioByteSize: 100,
        audioContentType: "audio/webm",
        audioDigest,
        audioDurationMs: 1000,
        attemptId: `composed-attempt-${input.commandId}`,
        artifactId: `composed-artifact-${input.commandId}`,
        commandId: `composed-command-${input.commandId}`,
        idempotencyKey,
        leaseToken: `composed-lease-${input.commandId}`,
        providerRetention: "stored",
        requestHash,
        sessionId: input.sessionId,
        sessionItemId: input.sessionItemId,
      }),
    );
    if (reservation.state === "completed") {
      throw new Error("fixture reservation unexpectedly completed");
    }
    const command = {
      accountId: input.accountId,
      acceptedAt: times.acceptedAt,
      archive: {
        state: "stored" as const,
        objectRef: `learner-audio/study/${reservation.attemptId}/${audioDigest}`,
      },
      artifactId: reservation.artifactId,
      attemptId: reservation.attemptId,
      attemptNumber: input.attemptNumber,
      audioByteSize: 100,
      audioContentType: "audio/webm",
      audioDigest,
      audioDurationMs: 1000,
      commandId: reservation.commandId,
      leaseToken: reservation.leaseToken,
      communityId: COMMUNITY_ID,
      grade: {
        correct: input.correct,
        matchKind: input.correct ? ("exact" as const) : ("none" as const),
        heardTranscript: input.correct ? LYRIC_LINES[0] : "unrecognized murmur",
        matched: [],
        missing: [],
        extra: [],
        substituted: [],
        policyRevision: "script_aware_token_phonetic_v2",
      },
      providerDetectedLanguage: "en",
      providerDetectedLanguageConfidence: 0.99,
      qualificationId: `composed-qualification-${input.commandId}`,
      requestHash,
      sessionId: input.sessionId,
      sessionItemId: input.sessionItemId,
    } satisfies SpokenCommand;
    const result = await run(runtime, study.completeSpokenAnswer(command));
    return { command, result };
  };

  const startSession = (accountId: string, personaId: string, suffix: string) =>
    run(
      runtime,
      study.startSession({
        accountId,
        communityId: COMMUNITY_ID,
        createdAt: times.createdAt,
        idempotencyKey: `composed-study-${suffix}`,
        learnerBand: null,
        personaId,
        postId: POST_ID,
        requestHash: "5".repeat(64),
        sessionId: `composed-session-${suffix}`,
        targetLanguage: null,
        timezone: "UTC",
      }),
    );

  const completeSession = async (accountId: string, personaId: string, suffix: string) => {
    const session = await startSession(accountId, personaId, suffix);
    expect(session.items).toHaveLength(4);
    const itemId = (index: number) => session.items[index]?.session_item_id ?? "";
    await answerSpoken({
      accountId,
      sessionId: session.session_id,
      sessionItemId: itemId(0),
      attemptNumber: 1,
      correct: false,
      commandId: `${suffix}-miss`,
    });
    for (const index of [1, 2, 3]) {
      await answerSpoken({
        accountId,
        sessionId: session.session_id,
        sessionItemId: itemId(index),
        attemptNumber: 1,
        correct: true,
        commandId: `${suffix}-card-${index}`,
      });
    }
    const final = await answerSpoken({
      accountId,
      sessionId: session.session_id,
      sessionItemId: itemId(0),
      attemptNumber: 2,
      correct: true,
      commandId: `${suffix}-retry`,
    });
    return { session, final };
  };

  return {
    answerSpoken,
    completeSession,
    replaySpokenCommand: (command: SpokenCommand) =>
      run(runtime, study.completeSpokenAnswer(command)),
    startSession,
  };
};

export const makeKaraokeDriver = (
  runtime: Runtime,
  repository: KaraokeRepository,
  times: KaraokeActivityTimes = {
    completedAt: "2026-09-01T13:10:00.000Z",
    createdAt: "2026-09-01T13:00:00.000Z",
    expiresAt: "2026-09-01T13:30:00.000Z",
  },
) => {
  const qualifyingLineScores = (
    authority: Effect.Success<ReturnType<KaraokeRepository["reserveSession"]>>,
  ) =>
    authority.lines.map(
      (line, index): KaraokeLineScore => ({
        confidenceScore: 0.9,
        finalizedReason: "asr_final",
        lineId: line.id,
        lineIndex: index,
        recognizedWords: line.words.map((word) => ({
          confidence: 0.9,
          endMs: word.end_ms,
          final: true,
          startMs: word.start_ms,
          text: word.text,
        })),
        score: 0,
        scoredLineIndex: index,
        textScore: {
          confidenceMean: 0.9,
          keywordCoverage: 0.95,
          missedWords: [],
          phoneticAvailable: true,
          phoneticCoverage: 0.95,
          phoneticQuality: 0.95,
          score: 0.95,
          wer: 0.05,
        },
        timingScore: {
          matchedWordCount: line.words.length,
          meanAbsDeltaMs: 0,
          medianAbsDeltaMs: 0,
          medianSignedDeltaMs: 0,
          score: 0,
          signedMeanDeltaMs: 0,
          timingTrend: "on_time" as const,
        },
        transcript: line.text,
        uncertain: false,
      }),
    );

  const reserve = (accountId: string, personaId: string, suffix: string) =>
    run(
      runtime,
      repository.reserveSession({
        accountId,
        artifactId: `composed-karaoke-artifact-${suffix}`,
        attemptId: `composed-karaoke-attempt-${suffix}`,
        clientContext: undefined,
        communityId: COMMUNITY_ID,
        createdAt: times.createdAt,
        expiresAt: times.expiresAt,
        idempotencyKey: `composed-karaoke-${suffix}`,
        personaId,
        postId: POST_ID,
        requestHash: "6".repeat(64),
        sessionId: `composed-karaoke-session-${suffix}`,
        timezone: "UTC",
      }),
    );

  const finish = async (
    authority: Effect.Success<ReturnType<KaraokeRepository["reserveSession"]>>,
    qualificationId: string,
  ) => {
    const summary = aggregateKaraokeSession({ lineScores: qualifyingLineScores(authority) });
    return await run(
      runtime,
      repository.finalizeAttempt({
        authority,
        completedAt: times.completedAt,
        completionReason: "completed",
        qualificationId,
        diagnostics: buildKaraokeScoringDiagnostics(authority, summary),
        summary,
        transportFacts: {
          schema_version: 1,
          reconnect_count: 0,
          pause_count: 0,
          seek_count: 0,
          epoch_count: 1,
          dropped_frame_count: 0,
          late_frame_count: 0,
          mic_sample_rate: 16000,
          provider_commit_latency_p50_ms: null,
          provider_commit_latency_p95_ms: null,
        },
      }),
    );
  };

  return { finish, reserve };
};
