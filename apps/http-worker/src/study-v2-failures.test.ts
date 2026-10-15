import { expect, test } from "bun:test";
import {
  StudyV2CommandRejected,
  type StudyV2Store,
  StudyV2StoreFailed,
} from "@pirate/application/use-cases/rewards/study-v2";
import { Effect } from "effect";
import { makeStudyV2Handlers } from "./study-v2-handlers.ts";

const unused = () => Effect.die("unexpected store operation");
const store: StudyV2Store = {
  getAvailability: unused,
  startSession: unused,
  getSession: unused,
  submitAnswer: unused,
  loadSpokenAnswerContext: unused,
  reserveSpokenAnswer: unused,
  failSpokenAnswer: unused,
  completeSpokenAnswer: unused,
};
const request = {
  body: new Uint8Array([1]),
  headers: {
    "content-type": "audio/webm",
    "idempotency-key": "recording",
    "x-audio-duration-ms": "1000",
    "x-study-attempt-number": "1",
  },
  params: { communityId: "community", sessionId: "session", sessionItemId: "item" },
  query: {},
  principal: { kind: "user", subject: "account" },
} as const;

test("Study provider and duration refusals have nonretryable structured next actions", async () => {
  for (const [reason, status, reasonCode, nextAction] of [
    ["provider-outcome-unknown", 409, "study_provider_outcome_unknown", "operator_review"],
    ["provider-refused", 409, "study_provider_refused", "record_again"],
    ["recording-too-short", 400, "study_recording_too_short", "record_again"],
  ] as const) {
    const handlers = makeStudyV2Handlers({
      store,
      clock: { now: Effect.succeed(0) },
      ids: { next: Effect.succeed("unused") },
      controlledSpoken: {
        submitSpokenAnswer: () => Effect.fail(new StudyV2CommandRejected({ reason })),
      },
    });
    await expect(handlers.SubmitStudyAnswerV2(request)).rejects.toMatchObject({
      status,
      retryable: false,
      details: { reason_code: reasonCode, next_action: nextAction },
    });
  }
});

test("unrelated storage constraint stays an internal error", async () => {
  const handlers = makeStudyV2Handlers({
    store,
    clock: { now: Effect.succeed(0) },
    ids: { next: Effect.succeed("unused") },
    controlledSpoken: {
      submitSpokenAnswer: () => Effect.fail(new StudyV2StoreFailed({ reason: "constraint" })),
    },
  });
  await expect(handlers.SubmitStudyAnswerV2(request)).rejects.toMatchObject({
    status: 500,
    message: "Study operation failed",
  });
});
