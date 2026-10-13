// PROPOSAL ONLY. Boundary/status tests use deterministic service outputs;
// genuine DB/proof/provider acceptance is owned by their separate actual gates.
import { expect, test } from "bun:test";
import {
  type BrowserParticipationContext,
  ControlPlaneTransactionOutcomeUnknown,
  GuestParticipationStoreRejected,
  LearnerAudioStorageOutcomeUnknown,
  type ParticipationOperationIdentity,
} from "@pirate/application/use-cases/guest-learning";
import { finalAnswer } from "@pirate/application/use-cases/guest-learning-test-fixture";
import {
  GuestBadRequest,
  GuestPendingConflict,
  GuestStudyAnswerResultV1,
  GuestStudyPreparedContentV1,
  GuestStudySessionV1,
  InternalError,
  RateLimited,
  toErrorBody,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  type GuestLearningControllerServices,
  makeGuestLearningControllers,
} from "./guest-learning-controllers.ts";
import type { DecodedRequest } from "./transport.ts";

const origin = "https://community.example",
  owner = "owner-original",
  id = "A".repeat(22);
const access = {
  kind: "guest",
  ownerId: owner,
  credentialId: id,
  origin,
  leaseUntil: "2026-10-13T23:00:00.000Z",
} as const;
const recoveryAccess = { kind: "guest", ownerId: owner, credentialId: id, origin } as const;
const proof = {
  ownerId: owner,
  credentialId: id,
  origin,
  state: "confirmed",
  leaseUntil: access.leaseUntil,
  pendingExpiresAt: null,
  predecessorCredentialId: null,
} as const;
const base = { origin, provedCredentials: [proof], provedIntents: [] };
const learning = (
  operation: "start" | "read" | "answer" | "operation_result",
): BrowserParticipationContext => {
  if (operation === "start")
    return {
      ...base,
      authority: "learning",
      operation,
      selected: proof,
      access,
      originAndCsrfChecked: true,
    };
  if (operation === "answer")
    return { ...base, authority: "learning", operation, access, originAndCsrfChecked: true };
  return { ...base, authority: "learning", operation, access };
};
const recovery = (
  operation: "participations" | "retention" | "delete_audio",
): BrowserParticipationContext =>
  operation === "participations"
    ? { ...base, authority: "recovery", operation, access: recoveryAccess }
    : {
        ...base,
        authority: "recovery",
        operation,
        access: recoveryAccess,
        originAndCsrfChecked: true,
      };
const operation = (
  kind: ParticipationOperationIdentity["kind"],
  key: string,
): ParticipationOperationIdentity => ({
  sourceOwnerId: owner,
  kind,
  idempotencyKey: key,
  requestHash: "a".repeat(64),
});
const completed = <A>(op: ParticipationOperationIdentity, result: A) => ({
  state: "completed" as const,
  operation: op,
  outcomeId: "original-outcome",
  result,
});
const unavailable = () =>
  Effect.fail(new GuestParticipationStoreRejected({ reason: "resource-policy-unavailable" }));
const prepared = {
  object: "guest_study_prepared_content_v1",
  availability: {
    state: "ready",
    available_exercise_types: ["say_it_back"],
    learning_language: "en",
    target_languages: [],
    learner_bands: [],
  },
  disclosure: { version: "fixture-v1", text: "Owned fixture." },
  reward_preview: null,
} as const;
const publicPrepared = Schema.decodeUnknownSync(GuestStudyPreparedContentV1)(prepared);
const guestSession = Schema.decodeUnknownSync(GuestStudySessionV1)(finalAnswer.answer.session);
const guestAnswer = Schema.decodeUnknownSync(GuestStudyAnswerResultV1)(finalAnswer.answer);
const guestSource = { kind: "guest", ownerId: owner } as const;
const ownedAnswer = {
  source: guestSource,
  answer: guestAnswer,
  participation: guestAnswer.participation,
};
const startBody = {
  idempotency_key: "start-key",
  expected_owner_id: owner,
  target_language: null,
  learner_band: null,
  timezone: "UTC",
  reward_mode: "practice_only",
  reward_preview_terms_hash: null,
  disclosure: { version: "fixture-v1", accepted: true },
} as const;
const path = {
  communityId: "community-original",
  postId: "post-original",
  sessionId: "session-original",
  sessionItemId: "item-0",
};
function request(
  context: BrowserParticipationContext | undefined,
  values: Partial<DecodedRequest> = {},
): DecodedRequest {
  return {
    principal: null,
    params: undefined,
    query: undefined,
    body: undefined,
    ...(context === undefined ? {} : { browserParticipation: context }),
    ...values,
  };
}
function services(
  overrides: Partial<GuestLearningControllerServices> = {},
  study: Partial<GuestLearningControllerServices["study"]> = {},
): GuestLearningControllerServices {
  return {
    study: {
      getPreparedContent: () => Effect.succeed(publicPrepared),
      getSession: () => Effect.succeed(guestSession),
      findStartOperation: () => Effect.succeed({ state: "pending_confirmation", session: null }),
      startSession: (input) =>
        Effect.succeed({
          kind: "start" as const,
          outcome: completed(operation("study_start", input.body.idempotency_key), {
            source: guestSource,
            session: guestSession,
          }),
        }),
      submitAnswer: (input) =>
        Effect.succeed({
          state: "pending_confirmation",
          operation: operation("study_answer", input.idempotencyKey),
          outcomeId: null,
        }),
      submitSpokenAnswer: (input) =>
        Effect.succeed(completed(operation("study_answer", input.idempotencyKey), ownedAnswer)),
      ...study,
    },
    participations: { list: () => Effect.succeed({ items: [], nextCursor: null }) },
    retention: {
      set: (input) =>
        Effect.succeed(
          completed(input.operation, {
            mode: input.mode,
            effective_at: "2026-10-12T12:00:00.000Z",
          }),
        ),
    },
    deletion: {
      prepareBatch: unavailable,
      confirmBatch: unavailable,
      failBatch: unavailable,
      findOperation: (input) =>
        Effect.succeed({
          operation: {
            operation_kind: "learner_audio_deletion",
            idempotency_key: input.idempotencyKey,
            operation_id: null,
          },
          state: "pending",
          deleted_count: 0,
          remaining_count: 0,
          provider_disposition: "unknown",
        }),
    },
    deletionIo: { executeBatch: unavailable },
    clock: { now: Effect.succeed(Date.parse("2026-10-12T12:00:00.000Z")) },
    ids: { next: Effect.succeed("fixture-id") },
    retryAfterSeconds: 2,
    ...overrides,
  };
}
const pendingCommit = () =>
  new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "private-test",
    limitMs: 1,
    elapsedMs: 1,
  });
async function caught(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected refusal");
}

test("public prepared is strict/no-store, emits no credential and requires no browser authority", async () => {
  const c = makeGuestLearningControllers(services());
  const r = await c.dispatch(
    "GetPublicStudyPreparedContentV1",
    request(undefined, {
      params: { communityId: path.communityId, postId: path.postId },
      query: {},
    }),
  );
  expect(r.body).toEqual(prepared);
  expect(new Headers(r.responseHeaders).get("cache-control")).toBe("private, no-store");
  expect(new Headers(r.responseHeaders).has("set-cookie")).toBe(false);
  const invalid = makeGuestLearningControllers(
    services(
      {},
      { getPreparedContent: () => Effect.succeed({ ...publicPrepared, leaseToken: "private" }) },
    ),
  );
  expect(
    (await caught(
      invalid.dispatch(
        "GetPublicStudyPreparedContentV1",
        request(undefined, {
          params: { communityId: path.communityId, postId: path.postId },
          query: {},
        }),
      ),
    )) instanceof InternalError,
  ).toBe(true);
});

test("acknowledged practice start returns201 original guest source; missing trusted edge cannot start", async () => {
  let calls = 0;
  const c = makeGuestLearningControllers(
    services(
      {},
      {
        startSession: (input) => {
          calls++;
          expect(input.trustedEdge.kind).toBe("trusted_edge");
          expect(input.trustedEdge.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
          expect(input.body.reward_mode).toBe("practice_only");
          return Effect.succeed({
            kind: "start" as const,
            outcome: completed(operation("study_start", input.body.idempotency_key), {
              source: guestSource,
              session: guestSession,
            }),
          });
        },
      },
    ),
  );
  const input = request(learning("start"), {
    params: { communityId: path.communityId, postId: path.postId },
    body: startBody,
    edgeClientIp: "192.0.2.1",
  });
  const r = await c.dispatch("StartGuestStudySessionV1", input);
  expect(r.status).toBe(201);
  expect(r.body).toEqual(guestSession);
  expect(new Headers(r.responseHeaders).has("set-cookie")).toBe(false);
  expect(calls).toBe(1);
  const { edgeClientIp: _, ...noEdge } = input;
  expect(
    (await caught(c.dispatch("StartGuestStudySessionV1", noEdge))) instanceof InternalError,
  ).toBe(true);
  expect(calls).toBe(1);
});

test("unknown and known abort/refusal retain distinct public outcomes; neither becomes201 or participation", async () => {
  const input = request(learning("start"), {
    params: { communityId: path.communityId, postId: path.postId },
    body: startBody,
    edgeClientIp: "192.0.2.1",
  });
  const unknown = makeGuestLearningControllers(
    services({}, { startSession: () => Effect.fail(pendingCommit()) }),
  );
  const pending = await caught(unknown.dispatch("StartGuestStudySessionV1", input));
  expect(pending instanceof GuestPendingConflict).toBe(true);
  if (!(pending instanceof GuestPendingConflict)) throw new Error("Expected pending");
  expect(pending.details.operation).toEqual({
    operation_kind: "study_start",
    idempotency_key: "start-key",
    operation_id: null,
  });
  const aborted = makeGuestLearningControllers(
    services(
      {},
      {
        startSession: () =>
          Effect.succeed({
            kind: "start",
            outcome: { state: "known_aborted", operation: operation("study_start", "start-key") },
          }),
      },
    ),
  );
  expect(
    (await caught(aborted.dispatch("StartGuestStudySessionV1", input))) instanceof InternalError,
  ).toBe(true);
  const limited = makeGuestLearningControllers(
    services(
      {},
      {
        startSession: () =>
          Effect.succeed({
            kind: "resource_refused" as const,
            operationId: "actual-refusal",
            outcome: completed(operation("study_start", "start-key"), {
              state: "rate_limited" as const,
              retryAfterSeconds: 2,
            }),
          }),
      },
    ),
  );
  const error = await caught(limited.dispatch("StartGuestStudySessionV1", input));
  expect(error instanceof RateLimited).toBe(true);
  if (!(error instanceof RateLimited)) throw new Error("Expected rate refusal");
  expect(error.retry_after_seconds).toBe(2);
});

test("start lookup passes actual owner/path/key; only its serialized witness can say not_started", async () => {
  let calls = 0;
  const c = makeGuestLearningControllers(
    services(
      {},
      {
        findStartOperation: (input) => {
          calls++;
          expect(input).toEqual({
            access,
            sourceOwnerId: owner,
            communityId: path.communityId,
            postId: path.postId,
            idempotencyKey: "original-key",
          });
          return Effect.succeed({ state: "not_started", session: null });
        },
      },
    ),
  );
  const input = request(learning("operation_result"), {
    params: { communityId: path.communityId, postId: path.postId, idempotencyKey: "original-key" },
  });
  expect((await c.dispatch("GetGuestStudyStartOperationV1", input)).body).toEqual({
    state: "not_started",
    session: null,
  });
  expect(calls).toBe(1);
  const unknown = makeGuestLearningControllers(
    services({}, { findStartOperation: () => Effect.fail(pendingCommit()) }),
  );
  expect(
    (await caught(unknown.dispatch("GetGuestStudyStartOperationV1", input))) instanceof
      InternalError,
  ).toBe(true);
});

test("spoken exact bytes/limits reach service; pending storage error exposes only original operation, JSON cannot masquerade as audio", async () => {
  let calls = 0;
  const c = makeGuestLearningControllers(
    services(
      {},
      {
        submitSpokenAnswer: (input) => {
          calls++;
          expect(input.audio).toEqual(new Uint8Array([1, 2, 3]));
          expect(input.audioDurationMs).toBe(60000);
          return Effect.fail(
            new LearnerAudioStorageOutcomeUnknown({ uploadAttemptId: "must-never-leak-upload" }),
          );
        },
      },
    ),
  );
  const input = request(learning("answer"), {
    params: {
      communityId: path.communityId,
      sessionId: path.sessionId,
      sessionItemId: path.sessionItemId,
    },
    headers: {
      "content-type": "audio/webm",
      "idempotency-key": "answer-original",
      "x-study-attempt-number": "1",
      "x-audio-duration-ms": "60000",
    },
    body: new Uint8Array([1, 2, 3]),
  });
  const error = await caught(c.dispatch("SubmitGuestStudyAnswerV1", input));
  expect(error instanceof GuestPendingConflict).toBe(true);
  if (!(error instanceof GuestPendingConflict)) throw new Error("Expected storage pending");
  expect(error.details.reason_code).toBe("learning_finalization_pending");
  expect(error.details.operation).toEqual({
    operation_kind: "study_answer",
    idempotency_key: "answer-original",
    operation_id: null,
  });
  expect(JSON.stringify(toErrorBody(error)).includes("must-never-leak-upload")).toBe(false);
  expect(calls).toBe(1);
  expect(
    (await caught(
      c.dispatch("SubmitGuestStudyAnswerV1", { ...input, body: new Uint8Array(524289) }),
    )) instanceof GuestBadRequest,
  ).toBe(true);
  expect(
    (await caught(
      c.dispatch("SubmitGuestStudyAnswerV1", {
        ...input,
        body: { kind: "single_select", choice_key: "a" },
      }),
    )) instanceof GuestBadRequest,
  ).toBe(true);
  expect(calls).toBe(1);
  const json = makeGuestLearningControllers(services());
  const queued = await caught(
    json.dispatch("SubmitGuestStudyAnswerV1", {
      ...input,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "json-original",
        "x-study-attempt-number": "1",
      },
      body: { kind: "single_select", choice_key: "a" },
    }),
  );
  expect(queued instanceof GuestPendingConflict).toBe(true);
});

test("retention sets future mode under canonical original key; explicit read store supplies bounded list", async () => {
  let listCalls = 0;
  const c = makeGuestLearningControllers(
    services({
      participations: {
        list: (input) => {
          listCalls++;
          expect(input).toEqual({ access: recoveryAccess, cursor: null, limit: 25 });
          return Effect.succeed({ items: [], nextCursor: null });
        },
      },
    }),
  );
  expect(
    (
      await c.dispatch(
        "ListGuestParticipationsV1",
        request(recovery("participations"), { query: {} }),
      )
    ).body,
  ).toEqual({ items: [], next_cursor: null });
  expect(listCalls).toBe(1);
  const r = await c.dispatch(
    "SetGuestLearningRetentionV1",
    request(recovery("retention"), {
      body: { idempotency_key: "retention-original", mode: "ephemeral" },
    }),
  );
  expect(r.body).toEqual({ mode: "ephemeral", effective_at: "2026-10-12T12:00:00.000Z" });
  expect(new Headers(r.responseHeaders).has("set-cookie")).toBe(false);
});

test("unknown deletion looks up same original key, exposes202 separately from completed200, no batch/object fields", async () => {
  let reads = 0;
  const baseline = services();
  const c = makeGuestLearningControllers(
    services({
      deletionIo: { executeBatch: () => Effect.fail(pendingCommit()) },
      deletion: {
        ...baseline.deletion,
        findOperation: (input) => {
          reads++;
          expect(input).toEqual({
            access: recoveryAccess,
            sourceOwnerId: owner,
            idempotencyKey: "delete-original",
          });
          return Effect.succeed({
            operation: {
              operation_kind: "learner_audio_deletion",
              idempotency_key: "delete-original",
              operation_id: "original-delete",
            },
            state: "pending",
            deleted_count: 0,
            remaining_count: 1,
            provider_disposition: "unknown",
          });
        },
      },
    }),
  );
  const input = request(recovery("delete_audio"), {
    headers: { "idempotency-key": "delete-original" },
  });
  const pending = await c.dispatch("DeleteGuestLearnerAudioV1", input);
  expect(pending.status).toBe(202);
  expect(reads).toBe(1);
  expect(new Headers(pending.responseHeaders).has("set-cookie")).toBe(false);
  const finished = makeGuestLearningControllers(
    services({
      deletionIo: {
        executeBatch: (input) =>
          Effect.succeed(
            completed(input.operation, {
              operation: {
                operation_kind: "learner_audio_deletion",
                idempotency_key: input.operation.idempotencyKey,
                operation_id: "original-outcome",
              },
              state: "completed",
              deleted_count: 1,
              remaining_count: 0,
              provider_disposition: "not_stored",
            }),
          ),
      },
    }),
  );
  const done = await finished.dispatch("DeleteGuestLearnerAudioV1", input);
  expect(done.status).toBe(200);
  expect(JSON.stringify(done.body).includes("objectRef")).toBe(false);
  expect(JSON.stringify(done.body).includes("leaseToken")).toBe(false);
});

test("account authority cannot expose ordinary sessions or fabricate bound guest source", async () => {
  let calls = 0;
  const c = makeGuestLearningControllers(
    services(
      {},
      {
        getSession: () => {
          calls++;
          return Effect.succeed(guestSession);
        },
      },
    ),
  );
  const account: BrowserParticipationContext = {
    ...base,
    authority: "learning",
    operation: "read",
    access: { kind: "account", accountId: "ordinary-account", sessionBinding: "protected-binding" },
  };
  expect(
    (await caught(
      c.dispatch(
        "GetGuestStudySessionV1",
        request(account, { params: { communityId: path.communityId, sessionId: path.sessionId } }),
      ),
    )) instanceof InternalError,
  ).toBe(true);
  expect(calls).toBe(0);
});

test("completed deletion body must identify its enclosing original durable outcome", async () => {
  const c = makeGuestLearningControllers(
    services({
      deletionIo: {
        executeBatch: (input) =>
          Effect.succeed(
            completed(input.operation, {
              operation: {
                operation_kind: "learner_audio_deletion",
                idempotency_key: input.operation.idempotencyKey,
                operation_id: "different-command",
              },
              state: "completed",
              deleted_count: 1,
              remaining_count: 0,
              provider_disposition: "not_stored",
            }),
          ),
      },
    }),
  );
  expect(
    (await caught(
      c.dispatch(
        "DeleteGuestLearnerAudioV1",
        request(recovery("delete_audio"), {
          headers: { "idempotency-key": "delete-original" },
        }),
      ),
    )) instanceof InternalError,
  ).toBe(true);
});
