// Actual257 source/controlled callbacks + genuine original CP producer only.
// No external R2/provider/DB/SQL gate has run while authoring this proposal.
import { expect, test } from "bun:test";
import type { StudyAudioArchiveResult } from "@pirate/application/study-v2-service";
import { Effect, Schema } from "effect";
import {
  type ArchiveFixture as Fixture,
  archiveFixture as fixture,
} from "./owner-spoken-archive.pg-fixture.ts";
import { dispatch } from "./owner-spoken-checkpoint-test-session.ts";
import { makeOwnerSpokenFencedArchiveStage } from "./owner-spoken-fenced-archive.ts";
import {
  financialFingerprint,
  hash,
  pgUrl,
  q,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const pgTest = pgUrl ? test : test.skip;
const archive = (
  f: Fixture,
  bucket: Parameters<typeof makeOwnerSpokenFencedArchiveStage>[1],
  tasks: Promise<unknown>[],
) =>
  makeOwnerSpokenFencedArchiveStage(
    makeDirectPostgresControlPlaneLayer(f.guestUrl, { closeTimeoutMs: 2000 }),
    bucket,
    (task) => tasks.push(task),
  );
type Dispatch = Awaited<ReturnType<typeof dispatch>>;
const input = (d: Dispatch) => ({
  source: d.success.source,
  operation: d.success.operation,
  artifactId: d.success.result.artifactId,
  resourceReservationId: d.success.resourceReservationId,
  deletionFenceRevision: d.success.deletionFenceRevision,
  audio: d.audio,
  contentType: d.success.result.audioContentType,
  contentDigest: d.success.result.audioDigest,
});
async function accepted(d: Dispatch) {
  const outcome = await run(d.checkpoint.persistBeforeArchive(d.success));
  if (outcome.state !== "completed")
    throw new Error("Actual committed prearchive checkpoint required");
  return outcome.result.checkpointId;
}
async function ledger(f: Fixture, d: Dispatch) {
  const rows = (
    await f.admin.query(
      `SELECT u.io_state,u.storage_disposition,u.cleanup_required,
    (SELECT count(*)::int FROM guest_study_spoken_checkpoints cp WHERE cp.capture_id=c.capture_id) AS checkpoints,
    (SELECT count(*)::int FROM guest_resource_provider_calls p WHERE p.call_id=c.provider_call_id AND p.disposition='completed') AS completed_calls,
    (SELECT cp.charged_cost_micros::text FROM guest_study_spoken_checkpoints cp WHERE cp.capture_id=c.capture_id) AS charged
    FROM guest_study_spoken_captures c JOIN learner_audio_upload_attempts u ON u.upload_attempt_id=c.upload_attempt_id
    WHERE c.command_id=$1 AND c.original_lease_token=$2`,
      [d.success.commandId, d.success.result.leaseToken],
    )
  ).rows;
  expect(rows.length).toBe(1);
  return Schema.decodeUnknownSync(
    Schema.Struct({
      io_state: Schema.Literals(["registered", "writing", "unknown", "closed"]),
      storage_disposition: Schema.NullOr(Schema.Literals(["stored", "absent", "failed"])),
      cleanup_required: Schema.Boolean,
      checkpoints: Schema.Int,
      completed_calls: Schema.Int,
      charged: Schema.NullOr(Schema.String),
    }),
    { onExcessProperty: "error" },
  )(rows[0]);
}
async function finalize(d: Dispatch, checkpointId: string, archiveResult: StudyAudioArchiveResult) {
  const ack = await run(
    d.owner.persistSuccessfulSpokenResult({
      access: d.guest.access,
      checkpoint: { ...d.success, result: { ...d.success.result, archive: archiveResult } },
    }),
  );
  expect(ack).toMatchObject({ state: "completed", outcomeId: checkpointId });
  const answer = await run(
    d.owner.completeSpokenAnswer({
      access: d.guest.access,
      checkpointId,
      source: d.success.source,
      operation: d.success.operation,
    }),
  );
  if (answer.state !== "completed")
    throw new Error("Actual original checkpoint finalization required");
  expect(answer.result.source).toEqual(d.success.source);
  expect(answer.result.participation).toEqual({ state: "practice_only" });
  expect(answer.result.answer.outcome).toBe("correct");
  return answer;
}

pgTest(
  "actual stored257 archive and finalizer reuse original CP; replay performs no second PUT/provider call",
  () =>
    fixture(async (f) => {
      const financial = await financialFingerprint(f),
        d = await dispatch(f, 701),
        cp = await accepted(d);
      const tasks: Promise<unknown>[] = [];
      let puts = 0;
      const stage = archive(
        f,
        {
          put: async () => {
            puts++;
            return { size: d.audio.byteLength };
          },
        },
        tasks,
      );
      const stored = await run(stage.store(input(d)));
      expect(stored.state).toBe("stored");
      const before = await ledger(f, d);
      expect(before).toMatchObject({
        io_state: "closed",
        storage_disposition: "stored",
        cleanup_required: false,
        checkpoints: 1,
        completed_calls: 1,
        charged: "1000",
      });
      expect(await run(stage.store(input(d)))).toEqual(stored);
      await Promise.all(tasks);
      expect(puts).toBe(1);
      expect(d.providerInvocations()).toBe(1);
      expect(await ledger(f, d)).toEqual(before);
      const answer = await finalize(d, cp, stored);
      expect(
        await run(
          d.owner.completeSpokenAnswer({
            access: d.guest.access,
            checkpointId: cp,
            source: d.success.source,
            operation: d.success.operation,
          }),
        ),
      ).toEqual(answer);
      expect((await ledger(f, d)).charged).toBe("1000");
      expect(await financialFingerprint(f)).toEqual(financial);
    }),
  30000,
);

pgTest(
  "actual original CP is mandatory before any controlled archive claim or PUT",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 702),
        tasks: Promise<unknown>[] = [];
      let puts = 0;
      const stage = archive(
        f,
        {
          put: async () => {
            puts++;
            return { size: 3 };
          },
        },
        tasks,
      );
      const rejected = await run(Effect.result(stage.store(input(d))));
      expect(rejected._tag).toBe("Failure");
      expect(puts).toBe(0);
      expect(await ledger(f, d)).toMatchObject({
        io_state: "registered",
        checkpoints: 0,
        completed_calls: 0,
        charged: null,
      });
    }),
  30000,
);

pgTest(
  "actual rejected PUT leaves unknown upload and original CP/cost retained; replay never redispatches",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 703);
      await accepted(d);
      const tasks: Promise<unknown>[] = [];
      let puts = 0;
      const stage = archive(
        f,
        {
          put: async () => {
            puts++;
            throw new Error("owned deterministic transport uncertainty");
          },
        },
        tasks,
      );
      for (let n = 0; n < 2; n++) {
        const reply = await run(Effect.result(stage.store(input(d))));
        expect(reply._tag).toBe("Failure");
        if (reply._tag === "Failure")
          expect(reply.failure._tag).toBe("LearnerAudioStorageOutcomeUnknown");
      }
      await Promise.all(tasks);
      expect(puts).toBe(1);
      expect(d.providerInvocations()).toBe(1);
      expect(await ledger(f, d)).toMatchObject({
        io_state: "unknown",
        storage_disposition: null,
        checkpoints: 1,
        completed_calls: 1,
        charged: "1000",
      });
    }),
  30000,
);

pgTest(
  "actual late fulfilled PUT after coordinated native253 beginDelete cannot publish or erase the accepted checkpoint",
  () =>
    fixture(async (f) => {
      const financial = await financialFingerprint(f),
        d = await dispatch(f, 704),
        cp = await accepted(d);
      let issued: () => void = () => {},
        release: (value: { size: number }) => void = () => {};
      const started = new Promise<void>((resolve) => {
        issued = resolve;
      });
      const put = new Promise<{ size: number }>((resolve) => {
        release = resolve;
      });
      const tasks: Promise<unknown>[] = [];
      const stage = archive(
        f,
        {
          put: () => {
            issued();
            return put;
          },
        },
        tasks,
      );
      const pending = run(stage.store(input(d)));
      await started;
      expect((await ledger(f, d)).io_state).toBe("writing");
      // Explicit narrow fixture ADMIN event: existing actual253 private producer,
      // no raw runtime grant/new wrapper/fake row. This is not recovery authority.
      await f.admin.query(
        "SELECT prepare_learner_audio_delete_private_v1($1,$2,$3,$4,$5::text[],$6,$7,$8)",
        [
          d.guest.ownerId,
          "owned-late-fence",
          hash("owned-late-fence"),
          "owned-late-fence-command",
          [d.guest.ownerId],
          "owned-late-fence-batch",
          10,
          "not_stored",
        ],
      );
      release({ size: d.audio.byteLength });
      const result = await pending;
      await Promise.all(tasks);
      expect(result).toEqual({ state: "failed", objectRef: null });
      expect(await ledger(f, d)).toMatchObject({
        io_state: "closed",
        storage_disposition: "stored",
        cleanup_required: true,
        checkpoints: 1,
        completed_calls: 1,
        charged: "1000",
      });
      const original = await run(
        d.checkpoint.findBeforeArchive({
          source: d.success.source,
          operation: d.success.operation,
          commandId: d.success.commandId,
          originalLeaseToken: d.success.result.leaseToken,
        }),
      );
      expect(original?.checkpointId).toBe(cp);
      expect(original?.success).toEqual(d.success);
      await finalize(d, cp, result);
      expect(d.providerInvocations()).toBe(1);
      expect(await financialFingerprint(f)).toEqual(financial);
    }),
  30000,
);

pgTest(
  "actual wrong source/reservation/fence/digest and changed bytes refuse before external PUT",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 705);
      await accepted(d);
      const tasks: Promise<unknown>[] = [];
      let puts = 0;
      const stage = archive(
          f,
          {
            put: async () => {
              puts++;
              return { size: 3 };
            },
          },
          tasks,
        ),
        original = input(d);
      const foreign = await seedGuest(f, 706);
      for (const changed of [
        { ...original, source: { kind: "guest" as const, ownerId: foreign.ownerId } },
        { ...original, resourceReservationId: "wrong-reservation" },
        { ...original, deletionFenceRevision: original.deletionFenceRevision + 1 },
        { ...original, contentDigest: "a".repeat(64) },
        { ...original, audio: new Uint8Array([3, 2, 1]) },
      ]) {
        expect((await run(Effect.result(stage.store(changed))))._tag).toBe("Failure");
      }
      expect(puts).toBe(0);
      expect((await ledger(f, d)).io_state).toBe("registered");
    }),
  30000,
);

pgTest(
  "actual runtime role cannot invoke new internal capture reads or raw253/audio/resource primitives",
  () =>
    fixture(async (f) => {
      for (const signature of [
        "read_guest_audio_io_capture_private_v1(text)",
        "require_guest_audio_io_capture_private_v1(jsonb)",
        "claim_learner_audio_upload_private_v1(text)",
        "settle_learner_audio_upload_private_v1(text,text,boolean,text)",
        "prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)",
        "lock_learner_audio_sources_private_v1(text[])",
        "require_guest_resource_success_checkpoint_v1(text,text,text,text,numeric)",
      ]) {
        const rows = (
          await f.guest.query(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
            [signature],
          )
        ).rows;
        expect(rows.length).toBe(1);
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ allowed: Schema.Literal(false) }), {
            onExcessProperty: "error",
          })(rows[0]).allowed,
        ).toBe(false);
      }
      await expect(
        f.guest.query("SELECT claim_learner_audio_upload_private_v1('owned-none')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query("SELECT read_guest_audio_io_capture_private_v1('owned-none')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query(`SELECT * FROM ${q("guest_study_spoken_captures")}`),
      ).rejects.toMatchObject({ code: "42501" });
    }),
  30000,
);
