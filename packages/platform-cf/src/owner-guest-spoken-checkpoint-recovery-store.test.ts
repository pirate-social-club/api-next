// Finite typed driver boundary; no native SQL/proof authority claim.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { success } from "../../application/src/guest-spoken-recovery.test-fixture.ts";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "./owner-guest-spoken-checkpoint-recovery-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const input = {
  access: {
    kind: "guest" as const,
    ownerId: success.source.ownerId,
    credentialId: "proved-credential",
    origin: "https://example.org",
  },
  communityId: success.result.communityId,
  sessionId: success.result.sessionId,
  sessionItemId: success.result.sessionItemId,
  idempotencyKey: success.operation.idempotencyKey,
  attemptNumber: success.result.attemptNumber,
  audioDigest: success.result.audioDigest,
  audioContentType: success.result.audioContentType,
  audioByteSize: success.result.audioByteSize,
  audioDurationMs: success.result.audioDurationMs,
};
const saved = {
  checkpointId: "checkpoint-original",
  captureId: "capture-original",
  uploadAttemptId: "upload-original",
  ...success,
};
function fixture(reply: unknown, options: { badBounds?: boolean; commitUnknown?: boolean } = {}) {
  const queries: PostgresQueryConfig[] = [],
    logs: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && options.commitUnknown) throw new Error("opaque uncertainty");
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
      if (
        /SELECT (find_owner_guest_spoken_success_for_audio|list_guest_spoken_closed_recovery|read_guest_spoken_closed_recovery)_v1/u.test(
          query.text,
        )
      )
        return { rows: [{ result: reply }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/guest-recovery", {
    clientFactory: () => client,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
  });
  return { queries, logs, ...makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(runtime) };
}
test("browser reader returns stored original hash/lease rather than consulting current context or configuration", async () => {
  const f = fixture(saved);
  expect(await Effect.runPromise(f.browser.findForAudio(input))).toEqual({
    checkpointId: saved.checkpointId,
    success,
  });
  const leaf = f.queries.find((query) => query.text.startsWith("SELECT find_owner_guest"));
  expect(leaf?.values).toEqual([
    JSON.stringify(input.access),
    input.communityId,
    input.sessionId,
    input.sessionItemId,
    input.idempotencyKey,
    input.attemptNumber,
    input.audioDigest,
    input.audioContentType,
    input.audioByteSize,
    input.audioDurationMs,
  ]);
  expect(
    f.queries.some((query) =>
      /require_guest_study_learning|prepare_guest_spoken|reserve_guest/u.test(query.text),
    ),
  ).toBe(false);
  expect(JSON.stringify(f.logs)).not.toContain(success.result.leaseToken);
});
test("coherent foreign route or audio tuple refuses even a structurally valid saved success", async () => {
  for (const wrong of [
    { ...saved, result: { ...saved.result, sessionId: "other-session" } },
    { ...saved, result: { ...saved.result, audioDigest: "c".repeat(64) } },
    { ...saved, operation: { ...saved.operation, idempotencyKey: "other-key" } },
  ]) {
    const result = await Effect.runPromise(
      Effect.result(fixture(wrong).browser.findForAudio(input)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("GuestParticipationStoreRejected");
  }
});
test("missing accepted checkpoint is null; malformed bounds prevent every recovery leaf", async () => {
  expect(await Effect.runPromise(fixture(null).browser.findForAudio(input))).toBeNull();
  const f = fixture(saved, { badBounds: true });
  const result = await Effect.runPromise(Effect.result(f.browser.findForAudio(input)));
  expect(result._tag).toBe("Failure");
  expect(f.queries.some((query) => query.text.includes("find_owner_guest"))).toBe(false);
});
test("COMMIT uncertainty cannot convert unresolved lookup into absence or leak original lease", async () => {
  const f = fixture(null, { commitUnknown: true });
  const result = await Effect.runPromise(Effect.result(f.browser.findForAudio(input)));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure._tag).toBe("ControlPlaneTransactionOutcomeUnknown");
  expect(JSON.stringify(f.logs)).not.toContain(success.result.leaseToken);
});
test("bounded cron reader rejects duplicate/outsize candidates and foreign checkpoint result", async () => {
  for (const rows of [
    [{ checkpointId: "checkpoint-original" }, { checkpointId: "checkpoint-original" }],
    Array.from({ length: 3 }, (_, i) => ({ checkpointId: `checkpoint-${i}` })),
  ]) {
    const result = await Effect.runPromise(Effect.result(fixture(rows).closed.list(2)));
    expect(result._tag).toBe("Failure");
  }
  const result = await Effect.runPromise(
    Effect.result(
      fixture({ saved, archive: { state: "failed", objectRef: null } }).closed.read(
        "checkpoint-other",
      ),
    ),
  );
  expect(result._tag).toBe("Failure");
});
