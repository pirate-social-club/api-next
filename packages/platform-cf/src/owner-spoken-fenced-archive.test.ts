import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeOwnerSpokenFencedArchiveStage } from "./owner-spoken-fenced-archive.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const audio = new Uint8Array([1, 2, 3]);
const digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const capture = {
  uploadAttemptId: "upload-original",
  sourceOwnerId: "owner-original",
  artifactId: "artifact-original",
  sourceKind: "study" as const,
  attemptRef: "attempt-original",
  commandRef: "command-original",
  reservationRef: "reservation-original",
  capturedRevision: 0,
  objectRef: `learner-audio/study/attempt-original/${digest}`,
  contentDigest: digest,
  contentType: "audio/webm",
  byteSize: 3,
  durationMs: 1000,
};
const input = {
  source: { kind: "guest" as const, ownerId: capture.sourceOwnerId },
  operation: {
    sourceOwnerId: capture.sourceOwnerId,
    kind: "study_answer" as const,
    idempotencyKey: "answer-original",
    requestHash: "a".repeat(64),
  },
  artifactId: capture.artifactId,
  resourceReservationId: capture.reservationRef,
  deletionFenceRevision: 0,
  contentDigest: digest,
  contentType: capture.contentType,
  audio,
};
const status = {
  capture,
  claimed: true,
  ioState: "writing",
  storageDisposition: null,
  cleanupRequired: false,
  mayContinue: true,
  mayPublish: false,
};
function fixture(
  options: {
    resolved?: unknown;
    claimed?: unknown;
    badBounds?: boolean;
    unknownCommitNumber?: number;
  } = {},
) {
  const queries: PostgresQueryConfig[] = [];
  const events: string[] = [];
  const logs: unknown[] = [];
  const retained: Promise<unknown>[] = [];
  let commits = 0;
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      events.push(query.text);
      if (query.text === "COMMIT" && ++commits === options.unknownCommitNumber)
        throw new Error("opaque private driver detail");
      if (query.text.startsWith("SELECT current_setting"))
        return {
          rows: [
            {
              transaction: "3s",
              lock: "250ms",
              statement: "2s",
              idle: options.badBounds ? "0" : "2s",
            },
          ],
          rowCount: 1,
        };
      if (query.text.startsWith("SELECT resolve_guest_audio_io_capture_private_v1"))
        return { rows: [{ result: options.resolved ?? capture }], rowCount: 1 };
      if (query.text.startsWith("SELECT claim_guest_audio_io_private_v1"))
        return { rows: [{ result: options.claimed ?? status }], rowCount: 1 };
      if (query.text.startsWith("SELECT settle_guest_audio_io_private_v1"))
        return { rows: [{ result: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/archive", {
    clientFactory: () => client,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
  });
  const stage = makeOwnerSpokenFencedArchiveStage(
    runtime,
    {
      put: async () => {
        events.push("PUT");
        return { size: audio.byteLength };
      },
    },
    (task) => retained.push(task),
  );
  return { stage, events, queries, logs, retained };
}
async function refuse(
  f: ReturnType<typeof fixture>,
  tag:
    | "GuestParticipationStoreRejected"
    | "ControlPlaneStatementFailed"
    | "ControlPlaneTransactionOutcomeUnknown",
) {
  const result = await Effect.runPromise(Effect.scoped(Effect.result(f.stage.store(input))));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure._tag).toBe(tag);
    expect(JSON.stringify(result.failure)).not.toContain("opaque private driver detail");
  }
  expect(f.events.includes("PUT")).toBe(false);
  expect(f.retained).toHaveLength(0);
}
test("foreign or excessive resolved captures cannot authorize PUT", async () => {
  for (const resolved of [
    { ...capture, sourceOwnerId: "foreign-owner" },
    { ...capture, artifactId: "foreign-artifact" },
    { ...capture, reservationRef: "foreign-reservation" },
    { ...capture, capturedRevision: 1 },
    { ...capture, byteSize: 524289 },
    { ...capture, durationMs: 60001 },
    { ...capture, objectRef: "x".repeat(214) },
    { ...capture, unexpected: true },
  ])
    await refuse(fixture({ resolved }), "GuestParticipationStoreRejected");
});
test("foreign or contradictory claim receipts refuse before PUT", async () => {
  for (const claimed of [
    { ...status, capture: { ...capture, commandRef: "foreign-command" } },
    { ...status, ioState: "closed" },
    { ...status, mayContinue: false },
    { ...status, mayPublish: true },
    {
      ...status,
      claimed: false,
      ioState: "closed",
      storageDisposition: "stored",
      mayPublish: true,
      cleanupRequired: true,
    },
  ])
    await refuse(fixture({ claimed }), "GuestParticipationStoreRejected");
});
test("failed bound readback and ambiguous claim commit convey no write authority", async () => {
  const bounded = fixture({ badBounds: true });
  await refuse(bounded, "ControlPlaneStatementFailed");
  expect(bounded.queries.some((q) => q.text.startsWith("SELECT resolve_guest"))).toBe(false);
  await refuse(fixture({ unknownCommitNumber: 2 }), "ControlPlaneTransactionOutcomeUnknown");
});
test("PUT starts after resolve and claim commit, and original settlement is retained", async () => {
  const f = fixture();
  expect(await Effect.runPromise(Effect.scoped(f.stage.store(input)))).toEqual({
    state: "stored",
    objectRef: capture.objectRef,
  });
  const position = f.events.indexOf("PUT");
  expect(f.events.slice(0, position).filter((e) => e === "COMMIT")).toHaveLength(2);
  expect(f.events.slice(position + 1).filter((e) => e === "COMMIT")).toHaveLength(1);
  expect(f.retained).toHaveLength(1);
  await Promise.all(f.retained);
});
