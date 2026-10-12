// Ordering/error unit proposal. Native producer authority is covered by the
// genuine separately queued PG fixtures, not by these deterministic stubs.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { GuestResourceAdmissionPolicy } from "./guest-learning-resource-admission.ts";
import type { ParticipationOperationIdentity } from "./guest-participation-authority.ts";
import type { OwnerAwareStudyV2Store } from "./guest-study-ports.ts";
import { LearnerAudioStorageOutcomeUnknown } from "./learner-audio-io-outcome.ts";
import {
  makeOwnerGuestStudyService,
  type OwnerStudyProviderInvocation,
} from "./owner-guest-study-service.ts";
import {
  makeOwnerSpokenSuccessProtocol,
  type OwnerSpokenPreArchiveSuccess,
} from "./owner-spoken-success-protocol.ts";
import { finalAnswer, success, transcript, uncertain } from "./owner-study-service.test-fixture.ts";
import { Clock, IdGen } from "./ports.ts";

const policy: GuestResourceAdmissionPolicy = {
  version: "fixture-resource-v1",
  costPolicyVersion: "fixture-cost-v1",
  maximumOwnerActiveSessions: 2,
  maximumOwnerReservedPaidCallsPerRollingDay: 60,
  maximumGlobalActiveSessions: 100,
  maximumGlobalPaidCallsPerRollingDay: 1000,
  maximumGlobalCostMicrosPerRollingDay: "1000000",
  maximumOwnerCostMicrosPerRollingDay: "100000",
  maximumTrustedEdgeSessionsPerWindow: 10,
  trustedEdgeWindowSeconds: 60,
  maximumProviderCallCostMicros: "10",
};
const access = {
  kind: "guest" as const,
  ownerId: "owner-original",
  credentialId: "credential-original",
  origin: "https://community.example",
  leaseUntil: "2026-10-12T13:00:00.000Z",
};
const input = {
  access,
  communityId: "community-original",
  sessionId: "session-original",
  sessionItemId: "item-0",
  idempotencyKey: "original-answer-key",
  attemptNumber: 1,
  audio: new Uint8Array([1, 2, 3]),
  audioContentType: "audio/webm",
  audioDurationMs: 1000,
};
const committed = <A>(operation: ParticipationOperationIdentity, outcomeId: string, result: A) => ({
  state: "completed" as const,
  operation,
  outcomeId,
  result,
});

function fixture(
  options: Readonly<{
    reserve?: "unknown" | "completed" | "pending";
    invocation?: OwnerStudyProviderInvocation;
    checkpointUnknown?: boolean;
    missingCheckpoint?: boolean;
    archiveUnknown?: boolean;
    afterProvider?: () => void;
    recoverBefore?: boolean;
    recoverAfterReserve?: boolean;
    transcriberAvailable?: boolean;
    publicVisible?: boolean;
  }> = {},
) {
  const trace: string[] = [];
  let accepted: OwnerSpokenPreArchiveSuccess | null = null;
  let operation: ParticipationOperationIdentity = success.operation;
  let failed: Parameters<OwnerAwareStudyV2Store["failSpokenAnswer"]>[0] | null = null;
  const item = finalAnswer.answer.session.items[0];
  if (item === undefined) throw new Error("retained concrete fixture item required");
  const store: OwnerAwareStudyV2Store = {
    getAvailability: () => Effect.succeed({ state: "unavailable", reason: "policy_blocked" }),
    startSession: (received) =>
      Effect.succeed({ state: "known_aborted", operation: received.operation }),
    getSession: () =>
      Effect.succeed({
        source: success.source,
        session: finalAnswer.answer.session,
      }),
    findStartOperation: () => Effect.succeed({ state: "pending_confirmation", session: null }),
    submitAnswer: (received) =>
      Effect.succeed(committed(received.operation, "actual-answer-operation", finalAnswer)),
    loadSpokenAnswerContext: () =>
      Effect.succeed({
        source: success.source,
        context: {
          item,
          referenceText: transcript.transcript,
          dominantLanguage: null,
          languageProvenance: { kind: "no_authoritative_evidence" },
        },
      }),
    reserveSpokenAnswer: (received) =>
      Effect.gen(function* () {
        trace.push("reserve");
        operation = received.operation;
        if (options.reserve === "unknown") return yield* uncertain();
        if (options.reserve === "completed")
          return { state: "completed" as const, result: finalAnswer };
        if (options.reserve === "pending")
          return { state: "pending_confirmation" as const, operation: received.operation };
        expect(received.providerRetention).toBe("stored");
        expect(received.resourceReservationId).toBe("original-resource");
        return {
          state: "reserved" as const,
          commandId: "original-command",
          leaseToken: "original-internal-lease",
          attemptId: "original-attempt",
          artifactId: "original-artifact",
          resourceReservationId: "original-resource",
          deletionFenceRevision: 7,
        };
      }),
    failSpokenAnswer: (received) =>
      Effect.sync(() => {
        trace.push("fail");
        failed = received;
        return committed(received.operation, "original-call", undefined);
      }),
    persistSuccessfulSpokenResult: (received) =>
      Effect.sync(() => {
        trace.push("ack");
        expect(received.checkpoint.result.archive).toEqual({
          state: "stored",
          objectRef: "actual-observed-object",
        });
        return committed(received.checkpoint.operation, "actual-checkpoint", {
          checkpointId: "actual-checkpoint",
        });
      }),
    completeSpokenAnswer: (received) =>
      Effect.sync(() => {
        trace.push("finalize");
        expect(received.checkpointId).toBe("actual-checkpoint");
        return committed(received.operation, "actual-answer-operation", finalAnswer);
      }),
  };
  const protocol = makeOwnerSpokenSuccessProtocol(
    {
      persistBeforeArchive: (received) =>
        Effect.gen(function* () {
          trace.push("persist");
          expect(received.result).not.toHaveProperty("archive");
          accepted = received;
          if (options.checkpointUnknown) return yield* uncertain();
          return committed(received.operation, "actual-checkpoint", {
            checkpointId: "actual-checkpoint",
          });
        }),
      findBeforeArchive: () =>
        Effect.sync(() => {
          trace.push("read-checkpoint");
          return options.missingCheckpoint || accepted === null
            ? null
            : { checkpointId: "actual-checkpoint", success: accepted };
        }),
    },
    store,
    {
      store: (received) =>
        Effect.gen(function* () {
          trace.push("archive");
          expect(received.resourceReservationId).toBe("original-resource");
          expect(received.deletionFenceRevision).toBe(7);
          if (options.archiveUnknown)
            return yield* new LearnerAudioStorageOutcomeUnknown({
              uploadAttemptId: "private-original-upload",
            });
          return {
            state: "stored" as const,
            objectRef: "actual-observed-object",
          };
        }),
    },
  );
  const service = makeOwnerGuestStudyService({
    store,
    prepared: {
      get: () =>
        Effect.succeed({
          object: "guest_study_prepared_content_v1",
          availability: { state: "unavailable", reason: "policy_blocked" },
          disclosure: {
            version: "fixture-disclosure",
            text: "Fixture disclosure",
          },
          reward_preview: null,
        }),
    },
    atomicStarter: {
      startPreparedSession: (received) =>
        Effect.succeed({
          kind: "start",
          outcome: { state: "known_aborted", operation: received.operation },
        }),
    },
    dispatchContext: {
      resolveAnswerSource: () => Effect.succeed(success.source),
      load: () =>
        Effect.sync(() => {
          trace.push("context");
          return {
            source: success.source,
            context: {
              item,
              referenceText: transcript.transcript,
              dominantLanguage: null,
              languageProvenance: {
                kind: "no_authoritative_evidence" as const,
              },
            },
            resourceReservationId: "original-resource",
            deletionFenceRevision: 7,
          };
        }),
      findAnswerOutcome: () =>
        Effect.sync(() => {
          trace.push("original-operation");
          return committed(operation, "actual-original-operation-id", finalAnswer);
        }),
    },
    resourcePolicy: policy,
    rerecordEnabled: true,
    transcriber: {
      available: options.transcriberAvailable !== false,
      providerRetention: "stored",
      invoke: () =>
        Effect.sync(() => {
          trace.push("provider");
          options.afterProvider?.();
          return (
            options.invocation ?? {
              state: "completed" as const,
              result: transcript,
            }
          );
        }),
    },
    success: protocol,
    visibility: { isPublic: () => Effect.succeed(options.publicVisible !== false) },
    recovery: {
      findForAudio: (received) =>
        Effect.sync(() => {
          if (!options.recoverBefore && !options.recoverAfterReserve) return null;
          if (options.recoverAfterReserve && trace.length === 0) return null;
          const saved: OwnerSpokenPreArchiveSuccess = {
            ...success,
            operation: { ...success.operation, idempotencyKey: received.idempotencyKey },
            commandId: "original-command",
            resourceReservationId: "original-resource",
            deletionFenceRevision: 7,
            result: {
              ...success.result,
              commandId: "original-command",
              leaseToken: "original-internal-lease",
              artifactId: "original-artifact",
              attemptId: "original-attempt",
              audioDigest: received.audioDigest,
              audioByteSize: received.audioByteSize,
              audioContentType: received.audioContentType,
              audioDurationMs: received.audioDurationMs,
              sessionId: received.sessionId,
              sessionItemId: received.sessionItemId,
              communityId: received.communityId,
              attemptNumber: received.attemptNumber,
            },
          };
          return { checkpointId: "actual-checkpoint", success: saved };
        }),
    },
  });
  let nextId = 0;
  const run = <A, E>(effect: Effect.Effect<A, E, Clock | IdGen>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock, {
          now: Effect.succeed(Date.parse("2026-10-12T12:00:00.000Z")),
        }),
        Effect.provideService(IdGen, {
          next: Effect.sync(() => String(++nextId)),
        }),
      ),
    );
  return {
    service,
    trace,
    run,
    failed: () => failed,
    accepted: () => accepted,
  };
}

test("unknown reserve COMMIT stays original pending and cannot invoke provider", async () => {
  const f = fixture({ reserve: "unknown" });
  const answer = await f.run(f.service.submitSpokenAnswer(input));
  expect(answer.state).toBe("pending_confirmation");
  if (answer.state !== "pending_confirmation") throw new Error();
  expect(answer.outcomeId).toBeNull();
  expect(f.trace).toEqual(["context", "reserve"]);
});
test("original completed reservation returns native operation ID without another provider call", async () => {
  const f = fixture({ reserve: "completed" });
  const answer = await f.run(f.service.submitSpokenAnswer(input));
  expect(answer.state).toBe("completed");
  if (answer.state !== "completed") throw new Error();
  expect(answer.outcomeId).toBe("actual-original-operation-id");
  expect(answer.result).toEqual(finalAnswer);
  expect(f.trace).toEqual(["context", "reserve", "original-operation"]);
});
test("provider timeout remains unknown with captured original lease/reservation and no archive", async () => {
  const f = fixture({
    invocation: {
      state: "failed",
      reason: "timeout",
      providerDisposition: "unknown",
    },
  });
  const answer = await f.run(f.service.submitSpokenAnswer(input));
  expect(answer.state).toBe("pending_confirmation");
  expect(f.failed()).toMatchObject({
    providerDisposition: "unknown",
    commandId: "original-command",
    leaseToken: "original-internal-lease",
    resourceReservationId: "original-resource",
  });
  expect(f.trace).toEqual(["context", "reserve", "provider", "fail"]);
});
test("valid provider result follows actual protocol persist/read/archive/ACK/finalize with true stored retention", async () => {
  const f = fixture();
  const answer = await f.run(f.service.submitSpokenAnswer(input));
  expect(answer.state).toBe("completed");
  expect(f.trace).toEqual([
    "context",
    "reserve",
    "provider",
    "persist",
    "read-checkpoint",
    "archive",
    "ack",
    "finalize",
  ]);
  expect(f.accepted()?.result).toMatchObject({
    rerecordEnabled: true,
    leaseToken: "original-internal-lease",
    artifactId: "original-artifact",
  });
  expect(f.accepted()?.result).not.toHaveProperty("archive");
});
test("unknown checkpoint COMMIT cannot proceed to storage or invent archive failed", async () => {
  const f = fixture({ checkpointUnknown: true });
  const answer = await f.run(f.service.submitSpokenAnswer(input));
  expect(answer.state).toBe("pending_confirmation");
  expect(f.trace).toEqual(["context", "reserve", "provider", "persist"]);
});
test("missing accepted checkpoint refuses before storage and cannot late-create an ACK", async () => {
  const f = fixture({ missingCheckpoint: true });
  await expect(f.run(f.service.submitSpokenAnswer(input))).rejects.toMatchObject({
    _tag: "GuestParticipationStoreRejected",
  });
  expect(f.trace).toEqual(["context", "reserve", "provider", "persist", "read-checkpoint"]);
});
test("uncertain actual archive preserves distinct private failure and retained success, never ACK/finalize", async () => {
  const f = fixture({ archiveUnknown: true });
  await expect(f.run(f.service.submitSpokenAnswer(input))).rejects.toMatchObject({
    _tag: "LearnerAudioStorageOutcomeUnknown",
  });
  expect(f.accepted()).not.toBeNull();
  expect(f.trace).toEqual([
    "context",
    "reserve",
    "provider",
    "persist",
    "read-checkpoint",
    "archive",
  ]);
});
test("valid text above retained grade cardinality refuses truncation and keeps call pending", async () => {
  const f = fixture({
    invocation: {
      state: "completed",
      result: {
        transcript: `${transcript.transcript} ${Array.from({ length: 257 }, (_, n) => `word${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`).join(" ")}`,
        detectedLanguage: "en",
        detectedLanguageConfidence: 0.99,
      },
    },
  });
  const answer = await f.run(f.service.submitSpokenAnswer(input));
  expect(answer.state).toBe("pending_confirmation");
  expect(f.failed()?.providerDisposition).toBe("unknown");
  expect(f.trace).toEqual(["context", "reserve", "provider", "fail"]);
});
test("oversize audio refuses before authority query/reservation/provider", async () => {
  const f = fixture();
  await expect(
    f.run(f.service.submitSpokenAnswer({ ...input, audio: new Uint8Array(524289) })),
  ).rejects.toMatchObject({
    _tag: "OwnerGuestStudyCommandRejected",
    reason: "invalid-input",
  });
  expect(f.trace).toEqual([]);
});

test("same audio accepted checkpoint resumes before current context/config/provider with original facts", async () => {
  const f = fixture({ recoverBefore: true, transcriberAvailable: false });
  const result = await f.run(f.service.submitSpokenAnswer(input));
  expect(result.state).toBe("completed");
  expect(f.trace).toEqual(["persist", "read-checkpoint", "archive", "ack", "finalize"]);
  expect(f.accepted()?.result).toMatchObject({
    acceptedAt: success.result.acceptedAt,
    leaseToken: "original-internal-lease",
    grade: success.result.grade,
    rerecordAssessment: success.result.rerecordAssessment,
  });
  expect(f.accepted()?.operation.requestHash).toBe(success.operation.requestHash);
});
test("checkpoint committed between first read and pending reservation resumes without provider redispatch", async () => {
  const f = fixture({ reserve: "pending", recoverAfterReserve: true });
  const result = await f.run(f.service.submitSpokenAnswer(input));
  expect(result.state).toBe("completed");
  expect(f.trace).toEqual([
    "context",
    "reserve",
    "persist",
    "read-checkpoint",
    "archive",
    "ack",
    "finalize",
  ]);
});
test("uncertain retained checkpoint archive stays private unknown on retry without a provider call", async () => {
  const f = fixture({ recoverBefore: true, archiveUnknown: true });
  const failure = await f.run(f.service.submitSpokenAnswer(input).pipe(Effect.flip));
  expect(failure).toMatchObject({ _tag: "LearnerAudioStorageOutcomeUnknown" });
  expect(f.trace).toEqual(["persist", "read-checkpoint", "archive"]);
});
