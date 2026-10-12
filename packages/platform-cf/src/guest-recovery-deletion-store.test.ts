import { expect, test } from "bun:test";
import type { ControlPlaneStatement } from "@pirate/application";
import { Effect } from "effect";
import { makeGuestRecoveryAudioDeletionStores } from "./guest-recovery-deletion-store.ts";
import { makeOwnerLearnerAudioDeletionIo } from "./owner-audio-deletion-io.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const owner = "owner_00000000-0000-0000-0000-000000000001";
const operation = {
  sourceOwnerId: owner,
  kind: "learner_audio_deletion" as const,
  idempotencyKey: "original-key",
  requestHash: "a".repeat(64),
};
const access = {
  kind: "guest" as const,
  ownerId: owner,
  credentialId: "aaaaaaaaaaaaaaaaaaaaaA",
  origin: "https://example.org",
};
const batch = {
  operation,
  batchId: "batch-original",
  fenceRevision: 1,
  sourceOwnerIds: [owner],
  artifacts: [
    {
      artifactId: "artifact-original",
      source: { kind: "guest" as const, ownerId: owner },
      objectRef: "learner-audio/study/attempt-original/digest",
    },
  ],
  providerDisposition: "unknown" as const,
};
const prepare = { state: "completed" as const, operation, outcomeId: batch.batchId, result: batch };
const projection = {
  operation: {
    operation_kind: "learner_audio_deletion" as const,
    idempotency_key: operation.idempotencyKey,
    operation_id: "command-original",
  },
  state: "pending" as const,
  deleted_count: 0,
  remaining_count: 1,
  provider_disposition: "unknown" as const,
};
const done = {
  state: "completed" as const,
  operation,
  outcomeId: "command-original",
  result: projection,
};
function fixture(reply: (statement: ControlPlaneStatement) => unknown, commitUnknown = false) {
  const calls: ControlPlaneStatement[] = [];
  let inTransaction = false;
  const label = (text: string) =>
    text.startsWith("SELECT current_setting")
      ? "learner-audio.limits.verify"
      : text.startsWith("SELECT set_config('transaction_timeout'")
        ? "learner-audio.limits.set"
        : text.includes("prepare_guest_owner_audio_delete_v1")
          ? "guest-audio-delete.prepare"
          : text.includes("confirm_guest_owner_audio_delete_v1")
            ? "guest-audio-delete.confirm"
            : text.includes("fail_guest_owner_audio_delete_v1")
              ? "guest-audio-delete.fail"
              : text.includes("set_guest_learning_retention_v1")
                ? "guest-learning-retention.set"
                : null;
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {
      inTransaction = false;
    },
    query: async (query: PostgresQueryConfig) => {
      if (query.text.startsWith("BEGIN")) inTransaction = true;
      if (query.text === "COMMIT") {
        inTransaction = false;
        if (commitUnknown) throw new Error("controlled COMMIT acknowledgment loss");
      }
      if (query.text === "ROLLBACK") inTransaction = false;
      const named = label(query.text);
      if (named === null) return { rows: [], rowCount: 0 };
      const statement: ControlPlaneStatement = {
        label: named,
        text: query.text,
        values: query.values ?? [],
        readonly: named.startsWith("learner-audio.limits"),
      };
      calls.push(statement);
      if (named === "learner-audio.limits.set") return { rows: [], rowCount: 1 };
      return {
        rows: [
          named === "learner-audio.limits.verify"
            ? { transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }
            : { result: reply(statement) },
        ],
        rowCount: 1,
      };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/audio-delete", {
    clientFactory: () => client,
    logger: { info: () => {}, error: () => {} },
  });
  return { calls, active: () => inTransaction, ...makeGuestRecoveryAudioDeletionStores(runtime) };
}
const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null })),
  );
test("real immutable batch travels from short prepare through outside-SQL delete to pending confirmation", async () => {
  const f = fixture((statement) =>
    statement.label === "guest-audio-delete.prepare" ? prepare : done,
  );
  let deletes = 0;
  const io = makeOwnerLearnerAudioDeletionIo(f.deletion, {
    delete: async (keys) => {
      expect(f.active()).toBe(false);
      expect(keys).toEqual([batch.artifacts[0]?.objectRef]);
      deletes++;
    },
  });
  expect(
    await Effect.runPromise(io.executeBatch({ access, operation, maximumArtifacts: 1000 })),
  ).toEqual(done);
  expect(deletes).toBe(1);
  expect(f.calls.filter((c) => c.label.endsWith(".limits.verify"))).toHaveLength(2);
  const prepareCall = f.calls.find((c) => c.label === "guest-audio-delete.prepare");
  expect(prepareCall?.values).toEqual([JSON.stringify(access), JSON.stringify(operation), 1000]);
});
test("unresolved remote deletion records unknown against exact batch, never confirms or erases a fence", async () => {
  const f = fixture((statement) =>
    statement.label === "guest-audio-delete.prepare" ? prepare : done,
  );
  const io = makeOwnerLearnerAudioDeletionIo(f.deletion, {
    delete: async () => {
      expect(f.active()).toBe(false);
      throw new Error("controlled transport uncertainty");
    },
  });
  expect(
    await Effect.runPromise(io.executeBatch({ access, operation, maximumArtifacts: 1000 })),
  ).toEqual(done);
  expect(f.calls.some((c) => c.label === "guest-audio-delete.confirm")).toBe(false);
  expect(f.calls.find((c) => c.label === "guest-audio-delete.fail")?.values).toEqual([
    JSON.stringify(batch),
    "unknown",
  ]);
});
test("foreign prepared source refuses before external deletion", async () => {
  const f = fixture(() => ({
    ...prepare,
    result: {
      ...batch,
      artifacts: [{ ...batch.artifacts[0], source: { kind: "guest", ownerId: "owner-foreign" } }],
    },
  }));
  let deletes = 0;
  const io = makeOwnerLearnerAudioDeletionIo(f.deletion, {
    delete: async () => {
      deletes++;
    },
  });
  const failure = await failureOf(io.executeBatch({ access, operation, maximumArtifacts: 1000 }));
  expect(failure?._tag).toBe("GuestParticipationStoreRejected");
  expect(deletes).toBe(0);
});
test("coherent outer outcome cannot return a foreign inner public operation locator", async () => {
  for (const mode of ["confirm", "fail"] as const) {
    const f = fixture(() => ({
      ...done,
      result: {
        ...projection,
        operation: { ...projection.operation, idempotency_key: "foreign-key" },
      },
    }));
    const effect =
      mode === "confirm"
        ? f.deletion.confirmBatch({
            batch,
            storageDisposition: "deleted",
            deletedAt: "2026-10-12T00:00:00.000Z",
          })
        : f.deletion.failBatch({ batch, storageDisposition: "unknown" });
    const failure = await failureOf(effect);
    expect(failure?._tag).toBe("GuestParticipationStoreRejected");
  }
});
test("prepare COMMIT uncertainty is preserved and issues no outside I/O or fabricated completed outcome", async () => {
  const f = fixture(() => prepare, true);
  let deletes = 0;
  const io = makeOwnerLearnerAudioDeletionIo(f.deletion, {
    delete: async () => {
      deletes++;
    },
  });
  const failure = await failureOf(io.executeBatch({ access, operation, maximumArtifacts: 1000 }));
  expect(failure?._tag).toBe("ControlPlaneTransactionOutcomeUnknown");
  if (failure?._tag === "ControlPlaneTransactionOutcomeUnknown")
    expect(failure.phase).toBe("commit");
  expect(deletes).toBe(0);
});
test("retention replay validates original mode and never includes learning lease in recovery access", async () => {
  const retentionOperation = { ...operation, kind: "learning_retention" as const };
  const good = {
    state: "completed",
    operation: retentionOperation,
    outcomeId: "retention-original",
    result: { mode: "ephemeral", effective_at: "2026-10-12T00:00:00.000Z" },
  };
  const f = fixture(() => good);
  expect(
    await Effect.runPromise(
      f.retention.set({ access, operation: retentionOperation, mode: "ephemeral" }),
    ),
  ).toEqual(good);
  const wrong = fixture(() => ({ ...good, result: { ...good.result, mode: "private_learning" } }));
  expect(
    (
      await failureOf(
        wrong.retention.set({ access, operation: retentionOperation, mode: "ephemeral" }),
      )
    )?._tag,
  ).toBe("GuestParticipationStoreRejected");
  expect(f.calls.find((c) => c.label === "guest-learning-retention.set")?.values[0]).toBe(
    JSON.stringify(access),
  );
});
