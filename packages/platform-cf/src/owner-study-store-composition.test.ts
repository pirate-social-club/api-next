// Ordinary projection/tuple regression proposal. These deterministic delegates
// do not claim database authorization or monetary accounting has been executed.
import { expect, test } from "bun:test";
import {
  GuestParticipationStoreRejected,
  type OwnerAwareStudyV2Store,
  type StudyV2Store,
  StudyV2StoreFailed,
} from "@pirate/application";
import { StudyAnswerResultV2, StudySessionV2 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { finalAnswer } from "../../application/src/owner-study-service.test-fixture.ts";
import { composeOwnerAwareStudyV2Store } from "./owner-study-store-composition.ts";

const {
  actor: _actor,
  owner_id: _owner,
  expires_at: _expires,
  reward_mode: _mode,
  reward_terms: _terms,
  participation: _sessionParticipation,
  ...ordinaryFields
} = finalAnswer.answer.session;
const ordinarySession = Schema.decodeUnknownSync(StudySessionV2, { onExcessProperty: "error" })({
  ...ordinaryFields,
  object: "study_session_v2",
  persona_id: "original-account-persona",
});
const { participation: _answerParticipation, ...ordinaryAnswerFields } = finalAnswer.answer;
const ordinaryAnswer = Schema.decodeUnknownSync(StudyAnswerResultV2, { onExcessProperty: "error" })(
  {
    ...ordinaryAnswerFields,
    object: "study_answer_result_v2",
    session: ordinarySession,
  },
);
const account = {
  kind: "ordinary_account" as const,
  accountId: "canonical-account",
  sessionBinding: "a".repeat(64),
};
const access = {
  kind: "account" as const,
  accountId: account.accountId,
  sessionBinding: account.sessionBinding,
};
const source = {
  kind: "account" as const,
  ownerId: "original-account-owner",
  accountId: account.accountId,
  personaId: "original-account-persona",
};
const answerInput = {
  access,
  source,
  operation: {
    sourceOwnerId: source.ownerId,
    kind: "study_answer" as const,
    idempotencyKey: "original-answer",
    requestHash: "b".repeat(64),
  },
  acceptedAt: "2026-10-12T12:00:00.000Z",
  answer: { kind: "single_select" as const, choice_key: "a" },
  attemptId: "new-candidate-ignored-on-replay",
  attemptNumber: 1,
  communityId: "community-original",
  idempotencyKey: "original-answer",
  qualificationId: "new-qualification-candidate",
  requestHash: "b".repeat(64),
  sessionId: "session-original",
  sessionItemId: "item-0",
};
function fixture(
  options: { classified?: boolean; participation?: boolean; unknown?: boolean } = {},
) {
  const trace: string[] = [];
  const unused = () =>
    Effect.fail(new GuestParticipationStoreRejected({ reason: "resource-policy-unavailable" }));
  const guest: OwnerAwareStudyV2Store = {
    getAvailability: () => Effect.succeed({ state: "unavailable", reason: "policy_blocked" }),
    startSession: unused,
    getSession: () => Effect.succeed(null),
    submitAnswer: unused,
    loadSpokenAnswerContext: unused,
    reserveSpokenAnswer: unused,
    failSpokenAnswer: unused,
    persistSuccessfulSpokenResult: unused,
    completeSpokenAnswer: unused,
    findStartOperation: () => Effect.succeed({ state: "pending_confirmation", session: null }),
  };
  const legacyUnused = () => Effect.fail(new StudyV2StoreFailed({ reason: "unavailable" }));
  const ordinary: StudyV2Store = {
    getAvailability: () => Effect.succeed({ state: "unavailable", reason: "policy_blocked" }),
    startSession: legacyUnused,
    getSession: (received) =>
      Effect.sync(() => {
        trace.push("legacy-read");
        expect(received.accountId).toBe(account.accountId);
        return ordinarySession;
      }),
    submitAnswer: (received) =>
      Effect.gen(function* () {
        trace.push("legacy-json");
        expect(received).not.toHaveProperty("access");
        expect(received.accountId).toBe(account.accountId);
        if (options.unknown) return yield* new StudyV2StoreFailed({ reason: "outcome-unknown" });
        return ordinaryAnswer;
      }),
    loadSpokenAnswerContext: legacyUnused,
    reserveSpokenAnswer: legacyUnused,
    failSpokenAnswer: legacyUnused,
    completeSpokenAnswer: legacyUnused,
  };
  const store = composeOwnerAwareStudyV2Store({
    starter: guest,
    mutations: guest,
    prepared: { get: unused },
    ordinary,
    originalAccountSources: {
      resolve: () =>
        Effect.sync(() => {
          trace.push("original-map");
          return source;
        }),
      receipt: () =>
        Effect.sync(() => {
          trace.push("original-receipt");
          return { source, attemptId: "actual-original-attempt" };
        }),
    },
    verifiedOrdinaryAccount: options.classified === false ? null : account,
    ...(options.participation
      ? {
          ordinaryParticipation: () =>
            Effect.sync(() => {
              trace.push("actual-participation-reader");
              return { state: "not_yet_qualified" as const };
            }),
        }
      : {}),
  });
  return { store, trace };
}
test("ordinary read retains exact existing account projection and original owner/persona", async () => {
  const f = fixture();
  const owned = await Effect.runPromise(
    f.store.getSession({
      access,
      communityId: "community-original",
      sessionId: "session-original",
    }),
  );
  expect(owned).toEqual({ source, session: ordinarySession });
  expect(f.trace).toEqual(["legacy-read", "original-map"]);
});
test("unclassified account context refuses before original map or legacy store", async () => {
  const f = fixture({ classified: false });
  const failure = await Effect.runPromise(
    f.store
      .getSession({ access, communityId: "community-original", sessionId: "session-original" })
      .pipe(Effect.flip),
  );
  expect(failure).toMatchObject({
    _tag: "GuestParticipationStoreRejected",
    reason: "owner-mismatch",
  });
  expect(f.trace).toEqual([]);
});
test("protected session-binding mismatch cannot delegate an ordinary account read", async () => {
  const f = fixture();
  const failure = await Effect.runPromise(
    f.store
      .getSession({
        access: { ...access, sessionBinding: "c".repeat(64) },
        communityId: "community-original",
        sessionId: "session-original",
      })
      .pipe(Effect.flip),
  );
  expect(failure).toMatchObject({ reason: "owner-mismatch" });
  expect(f.trace).toEqual([]);
});
test("mandatory unknown Account participation refuses BEFORE retained Account mutation", async () => {
  const f = fixture();
  const failure = await Effect.runPromise(f.store.submitAnswer(answerInput).pipe(Effect.flip));
  expect(failure).toMatchObject({ reason: "resource-policy-unavailable" });
  expect(f.trace).toEqual([]);
});
test("caller source/persona mismatch cannot reuse original account session authority", async () => {
  const f = fixture({ participation: true });
  const failure = await Effect.runPromise(
    f.store
      .submitAnswer({ ...answerInput, source: { ...source, personaId: "body-persona-other" } })
      .pipe(Effect.flip),
  );
  expect(failure).toMatchObject({ reason: "owner-mismatch" });
  expect(f.trace).toEqual(["original-map"]);
});
test("actual supplied Account participation plus original receipt preserve exact answer and ignore fresh candidate ID", async () => {
  const f = fixture({ participation: true });
  const result = await Effect.runPromise(f.store.submitAnswer(answerInput));
  expect(result).toEqual({
    state: "completed",
    operation: answerInput.operation,
    outcomeId: "actual-original-attempt",
    result: { source, answer: ordinaryAnswer, participation: { state: "not_yet_qualified" } },
  });
  expect(f.trace).toEqual([
    "original-map",
    "legacy-json",
    "original-receipt",
    "actual-participation-reader",
  ]);
});
test("legacy unknown Account COMMIT stays pending without invented phase/receipt/economics", async () => {
  const f = fixture({ participation: true, unknown: true });
  const result = await Effect.runPromise(f.store.submitAnswer(answerInput));
  expect(result).toEqual({
    state: "pending_confirmation",
    operation: answerInput.operation,
    outcomeId: null,
  });
  expect(f.trace).toEqual(["original-map", "legacy-json"]);
});
