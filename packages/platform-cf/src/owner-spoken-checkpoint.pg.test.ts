// Outside-source successor actual-PG proposal. No gate has run. Reuses actual
// maintained0001..0256 mutation fixture and exact sealed source suffix; no outside SQL.
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  type CheckpointFixture as Fixture,
  checkpointFixture as fixture,
} from "./owner-spoken-checkpoint.pg-fixture.ts";
import { makeControlPlaneOwnerSpokenPreArchiveCheckpointStore } from "./owner-spoken-checkpoint-store.ts";
import { dispatch } from "./owner-spoken-checkpoint-test-session.ts";
import {
  financialFingerprint,
  hash,
  lostCommitClient,
  origin,
  pgUrl,
  q,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const pgTest = pgUrl ? test : test.skip;
const one = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, rows: unknown[]) => {
  if (rows.length !== 1) throw new Error("Expected one genuine PG row");
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(rows[0]);
};
const countSchema = Schema.Struct({
  captures: Schema.Int,
  checkpoints: Schema.Int,
  calls: Schema.Int,
  completed_calls: Schema.Int,
  uploads: Schema.Int,
  attempts: Schema.Int,
  charged: Schema.String,
});
async function counts(f: Fixture) {
  return one(
    countSchema,
    (
      await f.admin.query(`SELECT
    (SELECT count(*)::int FROM guest_study_spoken_captures) AS captures,
    (SELECT count(*)::int FROM guest_study_spoken_checkpoints) AS checkpoints,
    (SELECT count(*)::int FROM guest_resource_provider_calls) AS calls,
    (SELECT count(*)::int FROM guest_resource_provider_calls WHERE disposition='completed') AS completed_calls,
    (SELECT count(*)::int FROM learner_audio_upload_attempts WHERE source_kind='study') AS uploads,
    (SELECT count(*)::int FROM study_attempts_v2 a JOIN study_session_items_v2 i USING(session_item_id)
      WHERE i.participation_owner_kind='guest') AS attempts,
    (SELECT COALESCE(sum(charged_cost_micros),0)::text FROM guest_study_spoken_checkpoints) AS charged`)
    ).rows,
  );
}

pgTest(
  "actual restricted LOGIN reserve creates immutable capture; prearchive success settles one original paid call once",
  () =>
    fixture(async (f) => {
      const financial = await financialFingerprint(f);
      const d = await dispatch(f, 501);
      expect(await counts(f)).toEqual({
        captures: 1,
        checkpoints: 0,
        calls: 1,
        completed_calls: 0,
        uploads: 1,
        attempts: 0,
        charged: "0",
      });
      const first = await run(d.checkpoint.persistBeforeArchive(d.success));
      expect(first.state).toBe("completed");
      const beforeReplay = await counts(f);
      expect(beforeReplay).toEqual({
        captures: 1,
        checkpoints: 1,
        calls: 1,
        completed_calls: 1,
        uploads: 1,
        attempts: 0,
        charged: "1000",
      });
      expect(await run(d.checkpoint.persistBeforeArchive(d.success))).toEqual(first);
      expect(await counts(f)).toEqual(beforeReplay);
      expect(d.providerInvocations()).toBe(1);
      const oldDispatch = await run(d.owner.reserveSpokenAnswer(d.input));
      expect(oldDispatch.state).toBe("pending_confirmation");
      expect(await counts(f)).toEqual(beforeReplay);
      expect(await financialFingerprint(f)).toEqual(financial);
    }),
  30000,
);

pgTest(
  "actual confirmed successor revokes initiating proof without preventing original captured-success persistence/readback",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 502);
      const successor = "Q".repeat(22);
      await f.admin.query("SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9)", [
        origin,
        [d.guest.credentialId],
        d.guest.credentialId,
        d.guest.ownerId,
        "checkpoint-rotation",
        hash("checkpoint-rotation"),
        "checkpoint-rotation-op",
        successor,
        hash("new-private-proof"),
      ]);
      await f.admin.query("SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5)", [
        origin,
        [successor],
        d.guest.credentialId,
        successor,
        d.guest.ownerId,
      ]);
      const rejected = await run(
        Effect.result(
          d.owner.loadSpokenAnswerContext({
            access: d.guest.access,
            communityId: "study-community",
            sessionId: d.success.result.sessionId,
            sessionItemId: d.success.result.sessionItemId,
            idempotencyKey: d.success.operation.idempotencyKey,
          }),
        ),
      );
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure")
        expect(rejected.failure._tag).toBe("GuestParticipationStoreRejected");
      const accepted = await run(d.checkpoint.persistBeforeArchive(d.success));
      expect(accepted.state).toBe("completed");
      const original = await run(
        d.checkpoint.findBeforeArchive({
          source: d.success.source,
          operation: d.success.operation,
          commandId: d.success.commandId,
          originalLeaseToken: d.success.result.leaseToken,
        }),
      );
      expect(original?.success).toEqual(d.success);
      expect(d.providerInvocations()).toBe(1);
      expect((await counts(f)).charged).toBe("1000");
    }),
  30000,
);

pgTest(
  "missing or altered original lease/source/result cannot become a successful checkpoint",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 503);
      const foreign = await seedGuest(f, 504);
      for (const changed of [
        {
          ...d.success,
          result: { ...d.success.result, leaseToken: "wrong-original-private-lease" },
        },
        {
          ...d.success,
          source: { kind: "guest" as const, ownerId: foreign.ownerId },
          operation: { ...d.success.operation, sourceOwnerId: foreign.ownerId },
        },
        {
          ...d.success,
          result: { ...d.success.result, grade: { ...d.success.result.grade, correct: false } },
        },
      ]) {
        const refusal = await run(Effect.result(d.checkpoint.persistBeforeArchive(changed)));
        expect(refusal._tag).toBe("Failure");
        expect((await counts(f)).checkpoints).toBe(0);
        expect((await counts(f)).completed_calls).toBe(0);
      }
      expect((await counts(f)).calls).toBe(1);
    }),
  30000,
);

pgTest(
  "two exact actual transactions serialize to one immutable checkpoint and one charge",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 505);
      const results = await Promise.all([
        run(d.checkpoint.persistBeforeArchive(d.success)),
        run(d.checkpoint.persistBeforeArchive(d.success)),
      ]);
      expect(results[1]).toEqual(results[0]);
      expect(await counts(f)).toEqual({
        captures: 1,
        checkpoints: 1,
        calls: 1,
        completed_calls: 1,
        uploads: 1,
        attempts: 0,
        charged: "1000",
      });
    }),
  30000,
);

pgTest(
  "actual successful COMMIT with withheld acknowledgment resolves from the original leaf without regrade/redispatch",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 506);
      const lost = lostCommitClient();
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
      expect((await counts(f)).checkpoints).toBe(1);
      expect(await run(d.checkpoint.persistBeforeArchive(d.success))).toMatchObject({
        state: "completed",
      });
      expect((await counts(f)).charged).toBe("1000");
      expect(d.providerInvocations()).toBe(1);
    }),
  30000,
);

pgTest(
  "actual restricted LOGIN cannot read/mutate/truncate private checkpoint identities or invoke internal primitives",
  () =>
    fixture(async (f) => {
      for (const table of ["guest_study_spoken_captures", "guest_study_spoken_checkpoints"])
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"])
          expect(
            one(
              Schema.Struct({ allowed: Schema.Literal(false) }),
              (
                await f.guest.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [
                  table,
                  privilege,
                ])
              ).rows,
            ).allowed,
          ).toBe(false);
      for (const signature of [
        "capture_guest_spoken_dispatch_private_v1(text,jsonb,text,text,text,text,text,bigint,boolean)",
        "persist_guest_spoken_success_private_v1(text,jsonb,text,text,jsonb,jsonb)",
        "load_guest_spoken_success_private_v1(text,jsonb,text,text)",
        "read_guest_spoken_capture_private_v1(text,jsonb,text,text)",
        "require_guest_resource_success_checkpoint_v1(text,text,text,text,numeric)",
      ])
        expect(
          one(
            Schema.Struct({ allowed: Schema.Literal(false) }),
            (
              await f.guest.query(
                "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
                [signature],
              )
            ).rows,
          ).allowed,
        ).toBe(false);
      await expect(
        f.guest.query(`TRUNCATE ${q("guest_study_spoken_captures")}`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query(`SELECT * FROM ${q("guest_study_spoken_checkpoints")}`),
      ).rejects.toMatchObject({ code: "42501" });
    }),
  30000,
);

pgTest(
  "positive schema phase closes oddly named FK references to both new checkpoint identities",
  () =>
    fixture(async (f) => {
      for (const [offset, relation, key] of [
        [1, "guest_study_spoken_captures", "capture_id"],
        [2, "guest_study_spoken_checkpoints", "checkpoint_id"],
      ] as const) {
        const name = `odd_checkpoint_reference_${offset}`;
        await f.admin.query(
          `CREATE TABLE ${q(name)}(ordinary_key TEXT REFERENCES ${q(relation)}(${q(key)}))`,
        );
        await expect(
          f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()"),
        ).rejects.toMatchObject({ code: "GP003" });
        await f.admin.query(`DROP TABLE ${q(name)}`);
        await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
      }
    }),
  30000,
);
