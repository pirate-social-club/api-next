// Actual restricted-LOGIN original producers only; no fabricated capture/CP row.
import { expect, test } from "bun:test";
import { makeOwnerGuestSpokenClosedRecovery } from "@pirate/application/owner-guest-spoken-closed-recovery";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import {
  type SpokenRecoveryFixture as Fixture,
  spokenRecoveryFixture as fixture,
} from "./guest-spoken-recovery.pg-fixture.ts";
import { makeControlPlaneOwnerSpokenPreArchiveCheckpointStore } from "./owner-spoken-checkpoint-store.ts";
import { dispatch } from "./owner-spoken-checkpoint-test-session.ts";
import { makeOwnerSpokenFencedArchiveStage } from "./owner-spoken-fenced-archive.ts";
import { makeControlPlaneOwnerSpokenCapturedContinuationStore } from "./owner-study-mutations.ts";
import {
  editFixture,
  financialFingerprint,
  hash,
  lostCommitClient,
  origin,
  pgUrl,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientFactory } from "./postgres.ts";

const pgTest = pgUrl ? test : test.skip;
type Dispatch = Awaited<ReturnType<typeof dispatch>>;
const browserInput = (d: Dispatch) => ({
  access: {
    kind: "guest" as const,
    ownerId: d.guest.ownerId,
    credentialId: d.guest.credentialId,
    origin: d.guest.access.origin,
  },
  communityId: d.success.result.communityId,
  sessionId: d.success.result.sessionId,
  sessionItemId: d.success.result.sessionItemId,
  idempotencyKey: d.success.operation.idempotencyKey,
  attemptNumber: d.success.result.attemptNumber,
  audioDigest: d.success.result.audioDigest,
  audioContentType: d.success.result.audioContentType,
  audioByteSize: d.success.result.audioByteSize,
  audioDurationMs: d.success.result.audioDurationMs,
});
async function checkpoint(d: Dispatch) {
  const receipt = await run(d.checkpoint.persistBeforeArchive(d.success));
  if (receipt.state !== "completed") throw new Error("Actual committed checkpoint required");
  return receipt.result.checkpointId;
}
async function rotate(f: Fixture, d: Dispatch, serial: number) {
  const successor = String.fromCharCode(65 + (serial % 20)).repeat(21) + "A";
  const key = `recovery-rotation-${serial}`;
  await f.admin.query("SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9)", [
    origin,
    [d.guest.credentialId],
    d.guest.credentialId,
    d.guest.ownerId,
    key,
    hash(key),
    `${key}-operation`,
    successor,
    hash(`${key}-synthetic-secret`),
  ]);
  await f.admin.query("SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5)", [
    origin,
    [successor],
    d.guest.credentialId,
    successor,
    d.guest.ownerId,
  ]);
  return successor;
}
async function counts(f: Fixture) {
  const result = (
    await f.admin.query(`SELECT
 (SELECT count(*)::int FROM guest_study_spoken_captures) AS captures,
 (SELECT count(*)::int FROM guest_study_spoken_checkpoints) AS checkpoints,
 (SELECT count(*)::int FROM guest_resource_provider_calls) AS calls,
 (SELECT count(*)::int FROM guest_resource_provider_calls WHERE disposition='completed') AS completed_calls,
 (SELECT count(*)::int FROM study_attempts_v2 a JOIN study_session_items_v2 i USING(session_item_id) WHERE i.participation_owner_kind='guest') AS attempts,
 (SELECT COALESCE(sum(charged_cost_micros),0)::text FROM guest_study_spoken_checkpoints) AS charged`)
  ).rows;
  expect(result).toHaveLength(1);
  return Schema.decodeUnknownSync(
    Schema.Struct({
      captures: Schema.Int,
      checkpoints: Schema.Int,
      calls: Schema.Int,
      completed_calls: Schema.Int,
      attempts: Schema.Int,
      charged: Schema.String,
    }),
    { onExcessProperty: "error" },
  )(result[0]);
}
async function archive(f: Fixture, d: Dispatch, reject = false) {
  let puts = 0;
  const tasks: Promise<unknown>[] = [];
  const stage = makeOwnerSpokenFencedArchiveStage(
    makeDirectPostgresControlPlaneLayer(f.guestUrl, { closeTimeoutMs: 2000 }),
    {
      put: async () => {
        puts++;
        if (reject) throw new Error("owned deterministic unknown PUT");
        return { size: d.audio.byteLength };
      },
    },
    (task) => tasks.push(task),
  );
  const input = {
    source: d.success.source,
    operation: d.success.operation,
    artifactId: d.success.result.artifactId,
    resourceReservationId: d.success.resourceReservationId,
    deletionFenceRevision: d.success.deletionFenceRevision,
    audio: d.audio,
    contentType: d.success.result.audioContentType,
    contentDigest: d.success.result.audioDigest,
  };
  const result = await run(Effect.result(stage.store(input)));
  await Promise.all(tasks);
  return { result, puts: () => puts, replay: () => run(Effect.result(stage.store(input))) };
}
function lostFinalizerCommit() {
  let observed = false;
  const clientFactory: PostgresClientFactory = (_url, config) => {
    const client = new Client(config);
    let finalizerInTransaction = false;
    return {
      connection: client.connection,
      connect: () => client.connect(),
      end: () => client.end(),
      query: async ({ text, values }) => {
        const result = await client.query({
          text,
          values: values === undefined ? [] : [...values],
        });
        if (text.includes("SELECT finish_guest_spoken_answer_v1")) finalizerInTransaction = true;
        if (text === "COMMIT" && finalizerInTransaction && !observed) {
          observed = true;
          throw new Error("owned dropped actual finalizer COMMIT acknowledgment");
        }
        return result;
      },
    };
  };
  return { clientFactory, observed: () => observed };
}
pgTest(
  "actual missingCP stays null; route/audio conflict and revoked proof close browser recovery while original successor recovers after simulated learning expiry",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 901),
        input = browserInput(d),
        finance = await financialFingerprint(f);
      expect(await run(f.browser.findForAudio(input))).toBeNull();
      const foreign = await seedGuest(f, 902);
      for (const changed of [
        { ...input, sessionId: "other-session" },
        { ...input, audioDigest: "c".repeat(64) },
        { ...input, attemptNumber: 2 },
        { ...input, access: { ...input.access, origin: "https://foreign.example" } },
        { ...input, access: { ...input.access, credentialId: foreign.credentialId } },
      ])
        expect((await run(Effect.result(f.browser.findForAudio(changed))))._tag).toBe("Failure");
      const id = await checkpoint(d);
      // Explicit disposable clock substitution only; normal triggers restored in finally.
      await editFixture(
        f.admin,
        "UPDATE guest_credentials SET session_until=clock_timestamp()-INTERVAL '1 second' WHERE credential_id=$1",
        [d.guest.credentialId],
      );
      expect(await run(f.browser.findForAudio(input))).toEqual({
        checkpointId: id,
        success: d.success,
      });
      const successor = await rotate(f, d, 901);
      const revoked = await run(Effect.result(f.browser.findForAudio(input)));
      expect(revoked._tag).toBe("Failure");
      if (revoked._tag === "Failure")
        expect(revoked.failure).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: "proof-revoked",
        });
      expect(
        await run(
          f.browser.findForAudio({
            ...input,
            access: { ...input.access, credentialId: successor },
          }),
        ),
      ).toEqual({ checkpointId: id, success: d.success });
      expect(d.providerInvocations()).toBe(1);
      expect(await counts(f)).toMatchObject({
        checkpoints: 1,
        completed_calls: 1,
        attempts: 0,
        charged: "1000",
      });
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);
pgTest(
  "actual CP COMMIT acknowledgement loss is recovered from original captured source/key/audio without another provider call or charge",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 903),
        finance = await financialFingerprint(f),
        lost = lostCommitClient();
      const uncertain = makeControlPlaneOwnerSpokenPreArchiveCheckpointStore(
        makeDirectPostgresControlPlaneLayer(f.guestUrl, {
          closeTimeoutMs: 2000,
          clientFactory: lost.clientFactory,
        }),
      );
      const reply = await run(Effect.result(uncertain.persistBeforeArchive(d.success)));
      expect(lost.observed()).toBe(true);
      expect(reply._tag).toBe("Failure");
      if (reply._tag === "Failure")
        expect(reply.failure._tag).toBe("ControlPlaneTransactionOutcomeUnknown");
      const found = await run(f.browser.findForAudio(browserInput(d)));
      expect(found?.success).toEqual(d.success);
      expect(await run(f.closed.list(20))).toEqual([]); // no archive bytes/closed outcome yet
      expect(d.providerInvocations()).toBe(1);
      expect(await counts(f)).toMatchObject({
        checkpoints: 1,
        calls: 1,
        completed_calls: 1,
        attempts: 0,
        charged: "1000",
      });
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);
pgTest(
  "actual unknown PUT excludes cron continuation and replay never re-PUTs or rebills accepted original CP",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 904),
        id = await checkpoint(d),
        finance = await financialFingerprint(f),
        io = await archive(f, d, true);
      expect(io.result._tag).toBe("Failure");
      if (io.result._tag === "Failure")
        expect(io.result.failure._tag).toBe("LearnerAudioStorageOutcomeUnknown");
      expect(await run(f.closed.list(20))).toEqual([]);
      expect(await run(f.closed.read(id))).toBeNull();
      expect((await io.replay())._tag).toBe("Failure");
      expect(io.puts()).toBe(1);
      expect(d.providerInvocations()).toBe(1);
      expect(await run(f.browser.findForAudio(browserInput(d)))).toEqual({
        checkpointId: id,
        success: d.success,
      });
      expect(await counts(f)).toMatchObject({
        checkpoints: 1,
        calls: 1,
        completed_calls: 1,
        attempts: 0,
        charged: "1000",
      });
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);
pgTest(
  "actual closed stored archive finalizes after process/proof loss through config-free retained continuation and cannot duplicate attempts/cost",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 905),
        id = await checkpoint(d),
        finance = await financialFingerprint(f),
        io = await archive(f, d);
      expect(io.result._tag).toBe("Success");
      await rotate(f, d, 905);
      expect((await run(Effect.result(f.browser.findForAudio(browserInput(d)))))._tag).toBe(
        "Failure",
      );
      expect(await run(f.closed.list(20))).toEqual([{ checkpointId: id }]);
      const saved = await run(f.closed.read(id));
      expect(saved?.success).toEqual(d.success);
      expect(saved?.archive.state).toBe("stored");
      const worker = makeOwnerGuestSpokenClosedRecovery(f.closed, f.continuation);
      expect(await run(worker.run(20))).toEqual({
        examined: 1,
        completed: 1,
        pending: 0,
        skipped: 0,
      });
      expect(await run(worker.run(20))).toEqual({
        examined: 0,
        completed: 0,
        pending: 0,
        skipped: 0,
      });
      const answer = await run(
        f.continuation.completeCapturedSpokenAnswer({
          source: d.success.source,
          operation: d.success.operation,
          checkpointId: id,
        }),
      );
      expect(answer.state).toBe("completed");
      if (answer.state === "completed")
        expect(answer.result.participation).toEqual({ state: "practice_only" });
      expect(io.puts()).toBe(1);
      expect(d.providerInvocations()).toBe(1);
      expect(await counts(f)).toEqual({
        captures: 1,
        checkpoints: 1,
        calls: 1,
        completed_calls: 1,
        attempts: 1,
        charged: "1000",
      });
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);
pgTest(
  "actual successful finalizer COMMIT acknowledgement loss leaves one immutable answer; retained continuation replays without browser lease or duplicate attempts",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 906),
        id = await checkpoint(d),
        finance = await financialFingerprint(f),
        io = await archive(f, d),
        lost = lostFinalizerCommit();
      expect(io.result._tag).toBe("Success");
      const continuation = makeControlPlaneOwnerSpokenCapturedContinuationStore(
        makeDirectPostgresControlPlaneLayer(f.guestUrl, {
          closeTimeoutMs: 2000,
          clientFactory: lost.clientFactory,
        }),
      );
      const reply = await run(
        Effect.result(makeOwnerGuestSpokenClosedRecovery(f.closed, continuation).run(20)),
      );
      expect(lost.observed()).toBe(true);
      expect(reply._tag).toBe("Failure");
      if (reply._tag === "Failure")
        expect(reply.failure).toMatchObject({
          _tag: "ControlPlaneTransactionOutcomeUnknown",
          phase: "commit",
        });
      expect(await counts(f)).toMatchObject({
        checkpoints: 1,
        calls: 1,
        completed_calls: 1,
        attempts: 1,
        charged: "1000",
      });
      expect(await run(f.closed.list(20))).toEqual([]);
      const first = await run(
        f.continuation.completeCapturedSpokenAnswer({
          source: d.success.source,
          operation: d.success.operation,
          checkpointId: id,
        }),
      );
      expect(first.state).toBe("completed");
      expect(
        await run(
          f.continuation.completeCapturedSpokenAnswer({
            source: d.success.source,
            operation: d.success.operation,
            checkpointId: id,
          }),
        ),
      ).toEqual(first);
      expect(io.puts()).toBe(1);
      expect(d.providerInvocations()).toBe(1);
      expect(await counts(f)).toMatchObject({ checkpoints: 1, attempts: 1, charged: "1000" });
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);
