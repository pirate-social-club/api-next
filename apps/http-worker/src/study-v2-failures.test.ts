import { expect, spyOn, test } from "bun:test";
import {
  StudyV2CommandRejected,
  type StudyV2Store,
  StudyV2StoreFailed,
} from "@pirate/application/use-cases/rewards/study-v2";
import { withHnsAuthoritySpan } from "@pirate/platform-cf/hns-authority-diagnostics";
import { httpRequestDiagnostics } from "@pirate/platform-cf/worker-request-diagnostics";
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

test("real Study handlers correlate overlapping SQL and operation failures without logging private request facts", async () => {
  const records: Record<string, unknown>[] = [];
  const logger = spyOn(console, "info").mockImplementation((_event, record) =>
    records.push(record),
  );
  const handlers = makeStudyV2Handlers({
    store,
    clock: { now: Effect.succeed(0) },
    ids: { next: Effect.succeed("unused") },
    controlledSpoken: {
      submitSpokenAnswer: () =>
        Effect.gen(function* () {
          yield* withHnsAuthoritySpan("query", Effect.void);
          return yield* new StudyV2StoreFailed({ reason: "constraint" });
        }),
    },
  });
  try {
    await Promise.all(
      [1, 2].map(() =>
        httpRequestDiagnostics.run("version", () =>
          expect(handlers.SubmitStudyAnswerV2(request)).rejects.toMatchObject({ status: 500 }),
        ),
      ),
    );
    const entries = records.filter((r) => r.phase === "request_entry");
    expect(entries).toHaveLength(2);
    const ids = new Set<string>();
    for (const entry of entries) {
      const phases = records.filter(
        (r) => r.request_sequence === entry.request_sequence && r.phase !== "request_entry",
      );
      expect(phases.map((r) => [r.phase, r.outcome])).toEqual([
        ["study_request", "started"],
        ["query", "started"],
        ["query", "success"],
        ["study_request", "failed"],
      ]);
      const id = phases[0]?.correlation_id;
      if (typeof id !== "string") throw new Error("Missing operation correlation");
      expect(id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(phases.every((r) => r.correlation_id === id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(2);
    for (const privateValue of [
      "recording",
      "account",
      "community",
      "session",
      "constraint",
      "audio/webm",
    ]) {
      expect(JSON.stringify(records)).not.toContain(privateValue);
    }
    expect(httpRequestDiagnostics.current()).toBeUndefined();
  } finally {
    logger.mockRestore();
  }
});
