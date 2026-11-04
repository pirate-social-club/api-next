// Outside authored/unexecuted proposal. Root actual native263 required.
import { expect, test } from "bun:test";
import type { DurableParticipationOutcome } from "@pirate/application/guest-participation-authority";
import type { Effect } from "effect";
import {
  bounded,
  type EphemeralFixture,
  ephemeralFixture,
} from "./guest-ephemeral-cleanup.pg-fixture.ts";
import {
  makeControlPlaneGuestEphemeralCleanup,
  makeGuestEphemeralCleanupStage,
} from "./guest-ephemeral-cleanup.ts";
import { commitAckDropProxy } from "./guest-ephemeral-commit-ack.pg-fixture.ts";
import type { RecoveryDeletionFixture } from "./guest-recovery-deletion.pg-fixture.ts";
import { makeOwnerLearnerAudioDeletionIo } from "./owner-audio-deletion-io.ts";
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
type Dispatch = Awaited<ReturnType<typeof dispatch>>;
function completed<A>(value: DurableParticipationOutcome<A>) {
  if (value.state !== "completed") throw new Error("Acknowledged original native result required");
  return value;
}
const recovery = (guest: Dispatch["guest"]) => ({
  kind: "guest" as const,
  ownerId: guest.ownerId,
  credentialId: guest.credentialId,
  origin: guest.access.origin,
});
const runtime = (f: EphemeralFixture) =>
  makeDirectPostgresControlPlaneLayer(f.cleanupUrl, { closeTimeoutMs: 2000 });
const system = (f: EphemeralFixture) => makeControlPlaneGuestEphemeralCleanup(runtime(f));
type CleanupOutcome = Effect.Success<ReturnType<ReturnType<typeof system>["prepareNext"]>>;
async function knownDelete(f: EphemeralFixture, key: string, expected: string) {
  const calls: string[] = [];
  const bucket: Readonly<{ delete: (objectRef: string) => Promise<void> }> = {
    delete: async (objectRef) => {
      await noSqlHeld(f);
      expect(objectRef).toBe(expected);
      calls.push(objectRef);
    },
  };
  await bucket.delete(key);
  expect(calls).toEqual([expected]);
}
async function selectMode(
  f: RecoveryDeletionFixture,
  guest: Dispatch["guest"],
  mode: "ephemeral" | "private_learning",
  key: string,
) {
  const result = await run(
    f.retention.set({
      access: recovery(guest),
      operation: {
        sourceOwnerId: guest.ownerId,
        kind: "learning_retention",
        idempotencyKey: key,
        requestHash: hash(key),
      },
      mode,
    }),
  );
  expect(result.state).toBe("completed");
}
async function fresh(
  f: RecoveryDeletionFixture,
  serial: number,
  mode: "ephemeral" | "private_learning" = "ephemeral",
) {
  const guest = await seedGuest(f, serial);
  await selectMode(f, guest, mode, `retention-${serial}-${mode}`);
  return dispatch(f, serial, guest);
}
async function accepted(f: RecoveryDeletionFixture, d: Dispatch) {
  const cp = completed(await run(d.checkpoint.persistBeforeArchive(d.success)));
  const background: Promise<unknown>[] = [];
  let puts = 0;
  const archive = makeOwnerSpokenFencedArchiveStage(
    makeDirectPostgresControlPlaneLayer(f.guestUrl),
    {
      put: async (_key, bytes) => {
        puts++;
        return { size: bytes.byteLength };
      },
    },
    (task) => background.push(task),
  );
  const stored = await run(
    archive.store({
      source: d.success.source,
      operation: d.success.operation,
      artifactId: d.success.result.artifactId,
      resourceReservationId: d.success.resourceReservationId,
      deletionFenceRevision: d.success.deletionFenceRevision,
      audio: d.audio,
      contentType: d.success.result.audioContentType,
      contentDigest: d.success.result.audioDigest,
    }),
  );
  expect(stored.state).toBe("stored");
  expect(
    (
      await run(
        d.owner.persistSuccessfulSpokenResult({
          access: d.guest.access,
          checkpoint: { ...d.success, result: { ...d.success.result, archive: stored } },
        }),
      )
    ).state,
  ).toBe("completed");
  const answer = completed(
    await run(
      d.owner.completeSpokenAnswer({
        access: d.guest.access,
        source: d.success.source,
        operation: d.success.operation,
        checkpointId: cp.result.checkpointId,
      }),
    ),
  );
  expect(answer.result.answer.outcome).toBe("correct");
  expect(answer.result.participation).toEqual({ state: "practice_only" });
  await Promise.all(background);
  expect(puts).toBe(1);
  expect(d.providerInvocations()).toBe(1);
  return { cp, answer };
}
async function upload(f: RecoveryDeletionFixture, d: Dispatch) {
  const rows = (
    await f.admin.query(
      "SELECT upload_attempt_id FROM guest_study_spoken_captures WHERE command_id=$1",
      [d.input.commandId],
    )
  ).rows;
  if (rows.length !== 1 || typeof rows[0].upload_attempt_id !== "string")
    throw new Error("Genuine original upload missing");
  return rows[0].upload_attempt_id;
}
async function evidence(f: RecoveryDeletionFixture, d: Dispatch) {
  return (
    await f.admin.query(
      `SELECT to_jsonb(cap) AS capture,to_jsonb(cp) AS checkpoint,to_jsonb(operation) AS main,
  to_jsonb(call_row) AS provider,(to_jsonb(u)-'cleanup_required') AS terminal,to_jsonb(fence) AS fence
  FROM guest_study_spoken_captures cap JOIN guest_study_spoken_checkpoints cp USING(capture_id)
  JOIN guest_participation_operations operation ON operation.operation_id=cap.operation_id
  JOIN guest_resource_provider_calls call_row ON call_row.call_id=cap.provider_call_id
  JOIN learner_audio_upload_attempts u ON u.upload_attempt_id=cap.upload_attempt_id
  JOIN learner_audio_owner_fences fence ON fence.owner_id=cap.source_owner_id WHERE cap.command_id=$1`,
      [d.input.commandId],
    )
  ).rows;
}
async function age(f: RecoveryDeletionFixture, d: Dispatch, interval = "23 hours 56 minutes") {
  // Explicit disposable clock model, NOT wall-clock acceptance. One identical
  // shift preserves reserve+24h/artifact/capture lineage; no IDs/results changed.
  await f.admin.query("BEGIN");
  try {
    await f.admin.query("SET LOCAL session_replication_role=replica");
    await f.admin.query(
      "UPDATE study_spoken_answer_commands SET reserved_at=reserved_at-$2::interval,lease_expires_at=lease_expires_at-$2::interval WHERE command_id=$1",
      [d.input.commandId, interval],
    );
    await f.admin.query(
      "UPDATE learner_audio_artifacts SET created_at=created_at-$2::interval,expires_at=expires_at-$2::interval WHERE learner_audio_artifact_id=$1",
      [d.input.artifactId, interval],
    );
    await f.admin.query(
      "UPDATE guest_study_spoken_captures SET created_at=created_at-$2::interval,captured_retention_expires_at=captured_retention_expires_at-$2::interval WHERE command_id=$1",
      [d.input.commandId, interval],
    );
    await f.admin.query("COMMIT");
  } catch (error) {
    await f.admin.query("ROLLBACK");
    throw error;
  }
  expect((await f.admin.query("SHOW session_replication_role")).rows).toEqual([
    { session_replication_role: "origin" },
  ]);
  expect(
    (
      await f.admin.query(
        `SELECT cap.captured_platform_retention='ephemeral' AS ephemeral,
  cap.captured_retention_expires_at=a.expires_at AS same_deadline,
  a.expires_at=c.reserved_at+interval '24 hours' AS reserve24h
  FROM guest_study_spoken_captures cap JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=cap.artifact_id
  JOIN study_spoken_answer_commands c ON c.command_id=cap.command_id WHERE cap.command_id=$1`,
        [d.input.commandId],
      )
    ).rows,
  ).toEqual([{ ephemeral: true, same_deadline: true, reserve24h: true }]);
}
async function storedArtifact(f: RecoveryDeletionFixture, d: Dispatch) {
  return (
    await f.admin.query(
      "SELECT to_jsonb(a) AS artifact FROM learner_audio_artifacts a WHERE learner_audio_artifact_id=$1",
      [d.input.artifactId],
    )
  ).rows;
}
async function noSqlHeld(f: EphemeralFixture) {
  expect(
    (
      await f.admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND state IN('active','idle in transaction','idle in transaction (aborted)')",
        [f.cleanupRole],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
}
type Settlement<A> = { ok: true; value: A } | { ok: false; error: unknown };
const handled = <A>(task: Promise<A>): Promise<Settlement<A>> =>
  task.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
async function withAckProxy<A>(
  url: string,
  label: string,
  use: (proxy: Awaited<ReturnType<typeof commitAckDropProxy>>) => Promise<A>,
) {
  const proxy = await commitAckDropProxy(url);
  const result = await handled(Promise.resolve().then(() => use(proxy)));
  const drains = await Promise.allSettled([bounded(proxy.close(), label)]);
  const errors = drains.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      result.ok ? errors : [result.error, ...errors],
      "Native ACK proxy drain failed",
    );
  if (!result.ok) throw result.error;
  return result.value;
}

async function reject(task: Promise<unknown>) {
  try {
    await task;
  } catch (error) {
    return error;
  }
  throw new Error("Expected actual rejection");
}
async function ownerDelete(f: EphemeralFixture, d: Dispatch, key: string) {
  const keys: string[] = [];
  const io = makeOwnerLearnerAudioDeletionIo(f.deletion, {
    delete: async (selected) => {
      keys.push(...selected);
    },
  });
  const result = await run(
    io.executeBatch({
      access: recovery(d.guest),
      operation: {
        sourceOwnerId: d.guest.ownerId,
        kind: "learner_audio_deletion",
        idempotencyKey: key,
        requestHash: hash(key),
      },
      maximumArtifacts: 1000,
    }),
  );
  expect(result.state).toBe("completed");
  expect(keys).toContain(`learner-audio/study/${d.input.attemptId}/${d.input.audioDigest}`);
  expect(
    (
      await f.admin.query("SELECT guest_ephemeral_owner_delete_witness_private_v1($1) AS proved", [
        await upload(f, d),
      ])
    ).rows,
  ).toEqual([{ proved: true }]);
  return storedArtifact(f, d);
}

pgTest(
  "future-only NEW capture deadline, native exact cleanup and permanent original namespace preserve siblings/history",
  () => {
    let historical: Dispatch | undefined;
    return ephemeralFixture(
      async (f) => {
        if (!historical) throw new Error("Genuine pre263 capture required");
        expect(
          (
            await f.admin.query(
              "SELECT captured_platform_retention,captured_retention_expires_at FROM guest_study_spoken_captures WHERE command_id=$1",
              [historical.input.commandId],
            )
          ).rows,
        ).toEqual([{ captured_platform_retention: null, captured_retention_expires_at: null }]);
        const d = await fresh(f, 801),
          finished = await accepted(f, d),
          privateSibling = await fresh(f, 802, "private_learning");
        await accepted(f, privateSibling);
        const sibling = await storedArtifact(f, privateSibling),
          old = await storedArtifact(f, historical);
        expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
        await expect(
          f.cleanup.query(
            "UPDATE guest_study_spoken_captures SET captured_platform_retention='private_learning' WHERE command_id=$1",
            [d.input.commandId],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          f.admin.query(
            "UPDATE guest_study_spoken_captures SET captured_platform_retention='private_learning' WHERE command_id=$1",
            [d.input.commandId],
          ),
        ).rejects.toMatchObject({ code: "P0001" });
        await age(f, d);
        await selectMode(f, d.guest, "private_learning", "change-after-capture");
        const before = await evidence(f, d),
          finance = await financialFingerprint(f);
        let original: CleanupOutcome;
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n FROM learner_audio_account_producer_captures WHERE upload_attempt_id=$1",
              [await upload(f, d)],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        original = await run(system(f).prepareNext());
        if (original.state !== "prepared") throw new Error("Due native cleanup required");
        await knownDelete(
          f,
          original.cleanup.objectRef,
          `learner-audio/study/${d.input.attemptId}/${d.input.audioDigest}`,
        );
        // Controlled fulfilled exact DELETE witness, then actual native confirmation.
        await run(system(f).confirm(original.cleanup, new Date().toISOString()));
        const tombstone = await storedArtifact(f, d);
        expect(tombstone[0].artifact.recording_state).toBe("deleted");
        expect(tombstone[0].artifact.object_ref).toBeNull();
        await run(system(f).confirm(original.cleanup, new Date().toISOString()));
        expect(await storedArtifact(f, d)).toEqual(tombstone);
        expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
        expect(await evidence(f, d)).toEqual(before);
        expect(await financialFingerprint(f)).toEqual(finance);
        expect(await storedArtifact(f, privateSibling)).toEqual(sibling);
        expect(await storedArtifact(f, historical)).toEqual(old);
        expect(
          await run(
            d.owner.completeSpokenAnswer({
              access: d.guest.access,
              source: d.success.source,
              operation: d.success.operation,
              checkpointId: finished.cp.result.checkpointId,
            }),
          ),
        ).toEqual(finished.answer);
        expect(d.providerInvocations()).toBe(1);
        const captured = (
          await f.admin.query("SELECT read_guest_audio_io_capture_private_v1($1) AS c", [
            await upload(f, d),
          ])
        ).rows[0].c;
        const claim = (
          await f.admin.query("SELECT claim_guest_audio_io_private_v1($1::jsonb) AS s", [
            JSON.stringify(captured),
          ])
        ).rows[0].s;
        expect(claim.mayPublish).toBe(false);
        expect(claim.claimed).toBe(false);
        expect(
          (
            await f.admin.query(
              "SELECT settle_guest_audio_io_private_v1($1::jsonb,'stored',true) AS published",
              [JSON.stringify(captured)],
            )
          ).rows,
        ).toEqual([{ published: false }]);
        for (const newId of [await upload(f, d), "forbidden-new-upload"]) {
          await expect(
            f.admin.query(
              "SELECT register_learner_audio_upload_private_v1($1,$2,'study',$3,$4,$5,$6,$7,$8)",
              [
                d.guest.ownerId,
                d.input.artifactId,
                d.input.attemptId,
                d.input.commandId,
                d.initial.reservationId,
                original.cleanup.objectRef,
                newId,
                d.input.deletionFenceRevision,
              ],
            ),
          ).rejects.toMatchObject({ code: "P0001" });
        }
      },
      async (f) => {
        historical = await fresh(f, 800);
        await accepted(f, historical);
      },
    );
  },
  180000,
);

for (const firstDeleteFails of [false, true])
  pgTest(
    `genuine owner deletion during pending exact cleanup ${firstDeleteFails ? "unknown first DELETE" : "known DELETE"} reconciles the SAME command`,
    () =>
      ephemeralFixture(async (f) => {
        const d = await fresh(f, firstDeleteFails ? 804 : 803);
        await accepted(f, d);
        await age(f, d);
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let calls = 0;
        const stage = makeGuestEphemeralCleanupStage({
          runtime: runtime(f),
          maximumDeletes: 1,
          bucket: {
            delete: async (key) => {
              await noSqlHeld(f);
              expect(key).toBe(`learner-audio/study/${d.input.attemptId}/${d.input.audioDigest}`);
              calls++;
              entered.resolve();
              await release.promise;
              if (firstDeleteFails) throw new Error("Controlled exact DELETE outcome unknown");
            },
          },
        });
        let work: Promise<Settlement<void>> | undefined;
        let original: CleanupOutcome | undefined;
        let primaryFailed = false,
          primaryError: unknown;
        const drains: unknown[] = [];
        try {
          work = handled(run(stage()));
          await bounded(
            Promise.race([
              entered.promise,
              work.then((o) => {
                if (!o.ok) throw o.error;
                throw new Error("Settled before actual DELETE entry");
              }),
            ]),
            "owner-delete-entry",
          );
          original = await run(system(f).prepareNext());
          if (original.state !== "prepared") throw new Error("Pending exact cleanup missing");
          const retained = await evidence(f, d),
            finance = await financialFingerprint(f);
          const ownerTombstone = await ownerDelete(
            f,
            d,
            `actual-owner-supersession-${firstDeleteFails}`,
          );
          release.resolve();
          const result = await bounded(work, "original-exact-delete-settlement");
          if (firstDeleteFails) {
            expect(result.ok).toBe(false);
            if (!result.ok)
              expect(result.error).toMatchObject({ _tag: "GuestEphemeralStorageOutcomeUnknown" });
            expect(await run(system(f).prepareNext())).toEqual(original);
            const retry = makeGuestEphemeralCleanupStage({
              runtime: runtime(f),
              maximumDeletes: 1,
              bucket: {
                delete: async (key) => {
                  await noSqlHeld(f);
                  calls++;
                  expect(key).toBe(
                    original?.state === "prepared" ? original.cleanup.objectRef : "",
                  );
                },
              },
            });
            await run(retry());
          } else {
            expect(result.ok).toBe(true);
          }
          expect(await storedArtifact(f, d)).toEqual(ownerTombstone);
          expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
          const after = await evidence(f, d);
          expect(after.map(({ fence, ...facts }) => facts)).toEqual(
            retained.map(({ fence, ...facts }) => facts),
          );
          expect(await financialFingerprint(f)).toEqual(finance);
          expect(calls).toBe(firstDeleteFails ? 2 : 1);
          expect(d.providerInvocations()).toBe(1);
          expect(
            (
              await f.admin.query(
                "SELECT state FROM learner_audio_upload_cleanup_commands WHERE cleanup_id=$1",
                [original.cleanup.cleanupId],
              )
            ).rows,
          ).toEqual([{ state: "completed" }]);
        } catch (error) {
          primaryFailed = true;
          primaryError = error;
        } finally {
          release.resolve();
          if (work)
            try {
              await bounded(work, "original-stage-drain");
            } catch (error) {
              drains.push(error);
            }
        }
        if (drains.length)
          throw new AggregateError(
            primaryFailed ? [primaryError, ...drains] : drains,
            "Native stage drain failed",
          );
        if (primaryFailed) throw primaryError;
      }),
    180000,
  );

pgTest(
  "unknown provider and unfinished/unknown writer stay held; SAME late original CP then finalizes and cleans",
  () =>
    ephemeralFixture(async (f) => {
      // Actual256 controlled original-capture failure callback, not a raw/core grant.
      const failureLeaf = "fail_guest_spoken_answer_v1(text,jsonb,text,text,text,text,text)";
      expect(
        (
          await f.admin.query(
            `SELECT p.proowner=c.relowner AS owner,
        p.pronamespace=c.relnamespace AS namespace,p.prosecdef AS definer,
        p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned,
        NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
        FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
            [failureLeaf],
          )
        ).rows,
      ).toEqual([{ owner: true, namespace: true, definer: true, pinned: true, private: true }]);
      await expect(
        f.guest.query(
          "SELECT fail_guest_spoken_answer_v1('unavailable','{}'::jsonb,'unavailable','unavailable','unavailable','unknown','timeout')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${failureLeaf} TO ${q(f.role)}`);
      expect(
        (
          await f.guest.query(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
            [failureLeaf],
          )
        ).rows,
      ).toEqual([{ allowed: true }]);
      expect(
        (
          await f.cleanup.query(
            "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
            [failureLeaf],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      const provider = await fresh(f, 805);
      await age(f, provider, "24 hours 1 minute");
      expect(
        (
          await f.admin.query(
            "SELECT captured_retention_expires_at<=clock_timestamp() AS expired FROM guest_study_spoken_captures WHERE command_id=$1",
            [provider.input.commandId],
          )
        ).rows,
      ).toEqual([{ expired: true }]);
      expect(
        (
          await run(
            provider.owner.failSpokenAnswer({
              access: provider.guest.access,
              source: provider.success.source,
              operation: provider.success.operation,
              commandId: provider.input.commandId,
              leaseToken: provider.input.leaseToken,
              failedAt: new Date().toISOString(),
              providerFailureKind: "timeout",
              providerDisposition: "unknown",
              resourceReservationId: provider.initial.reservationId,
            }),
          )
        ).state,
      ).toBe("pending_confirmation");
      expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
      expect(
        (
          await f.admin.query(
            "SELECT disposition FROM guest_resource_provider_calls WHERE source_owner_id=$1",
            [provider.guest.ownerId],
          )
        ).rows,
      ).toEqual([{ disposition: "unknown" }]);
      const unfinished = await fresh(f, 806);
      await run(unfinished.checkpoint.persistBeforeArchive(unfinished.success));
      await age(f, unfinished, "24 hours 1 minute");
      expect(
        (
          await f.admin.query(
            "SELECT captured_retention_expires_at<=clock_timestamp() AS expired FROM guest_study_spoken_captures WHERE command_id=$1",
            [unfinished.input.commandId],
          )
        ).rows,
      ).toEqual([{ expired: true }]);
      expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
      const background: Promise<unknown>[] = [];
      const archive = makeOwnerSpokenFencedArchiveStage(
        makeDirectPostgresControlPlaneLayer(f.guestUrl),
        {
          put: async () => {
            throw new Error("Controlled unknown original PUT");
          },
        },
        (task) => background.push(task),
      );
      expect(
        await reject(
          run(
            archive.store({
              source: unfinished.success.source,
              operation: unfinished.success.operation,
              artifactId: unfinished.input.artifactId,
              resourceReservationId: unfinished.initial.reservationId,
              deletionFenceRevision: unfinished.input.deletionFenceRevision,
              audio: unfinished.audio,
              contentType: unfinished.input.audioContentType,
              contentDigest: unfinished.input.audioDigest,
            }),
          ),
        ),
      ).toMatchObject({ _tag: "LearnerAudioStorageOutcomeUnknown" });
      await Promise.allSettled(background);
      expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
      expect(
        (
          await f.admin.query(
            "SELECT io_state FROM learner_audio_upload_attempts WHERE upload_attempt_id=$1",
            [await upload(f, unfinished)],
          )
        ).rows,
      ).toEqual([{ io_state: "unknown" }]);
      // Original provider result is genuinely retained; no fresh provider dispatch.
      await accepted(f, provider);
      const prepared = await run(system(f).prepareNext());
      if (prepared.state !== "prepared")
        throw new Error("Same late finalized original cleanup required");
      expect(prepared.cleanup.uploadAttemptId).toBe(await upload(f, provider));
      await knownDelete(
        f,
        prepared.cleanup.objectRef,
        `learner-audio/study/${provider.input.attemptId}/${provider.input.audioDigest}`,
      );
      await run(system(f).confirm(prepared.cleanup, new Date().toISOString()));
      expect(provider.providerInvocations()).toBe(1);
      expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
      expect(
        (
          await f.admin.query(
            "SELECT io_state FROM learner_audio_upload_attempts WHERE upload_attempt_id=$1",
            [await upload(f, unfinished)],
          )
        ).rows,
      ).toEqual([{ io_state: "unknown" }]);
    }),
  180000,
);

pgTest(
  "actual prepare and confirm COMMIT ACK loss retain SAME pending/completed original cleanup",
  () =>
    ephemeralFixture(async (f) => {
      const d = await fresh(f, 807);
      await accepted(f, d);
      await age(f, d);
      const before = await evidence(f, d),
        finance = await financialFingerprint(f);
      const deletedKeys: string[] = [];
      await withAckProxy(f.cleanupUrl, "actual-prepare-ack-proxy-close", async (prepareProxy) => {
        const stage = makeGuestEphemeralCleanupStage({
          runtime: makeDirectPostgresControlPlaneLayer(prepareProxy.connectionString, {
            closeTimeoutMs: 2000,
          }),
          maximumDeletes: 1,
          bucket: {
            delete: async (key) => {
              deletedKeys.push(key);
              throw new Error("DELETE must not follow unacknowledged preparation");
            },
          },
        });
        prepareProxy.arm();
        expect(await reject(run(stage()))).toMatchObject({
          _tag: "ControlPlaneTransactionOutcomeUnknown",
          phase: "commit",
        });
        expect(prepareProxy.observed()).toEqual({ sawCommit: true, sawIdle: true });
        expect(deletedKeys).toEqual([]);
      });
      const pending = (
        await f.admin.query(
          `SELECT c.state,jsonb_build_object('cleanupId',c.cleanup_id,
  'uploadAttemptId',c.upload_attempt_id,'objectRef',c.object_ref,'attemptId',cap.attempt_id,
  'contentDigest',cap.audio_digest) AS cleanup FROM learner_audio_upload_cleanup_commands c
  JOIN guest_study_spoken_captures cap USING(upload_attempt_id) WHERE cap.command_id=$1`,
          [d.input.commandId],
        )
      ).rows;
      expect(pending).toHaveLength(1);
      expect(pending[0].state).toBe("pending");
      const prepared = await run(system(f).prepareNext());
      if (prepared.state !== "prepared")
        throw new Error("Actual retained pending cleanup required");
      expect(prepared.cleanup).toEqual(pending[0].cleanup);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM learner_audio_upload_cleanup_commands WHERE upload_attempt_id=$1",
            [prepared.cleanup.uploadAttemptId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      expect(await evidence(f, d)).toEqual(before);
      expect(await financialFingerprint(f)).toEqual(finance);
      await withAckProxy(f.cleanupUrl, "actual-confirm-ack-proxy-close", async (confirmProxy) => {
        // The exact external DELETE is fulfilled; only native COMMIT response is lost.
        await knownDelete(
          f,
          prepared.cleanup.objectRef,
          `learner-audio/study/${d.input.attemptId}/${d.input.audioDigest}`,
        );
        const store = makeControlPlaneGuestEphemeralCleanup(
          makeDirectPostgresControlPlaneLayer(confirmProxy.connectionString, {
            closeTimeoutMs: 2000,
          }),
        );
        confirmProxy.arm();
        expect(
          await reject(run(store.confirm(prepared.cleanup, new Date().toISOString()))),
        ).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" });
        expect(confirmProxy.observed()).toEqual({ sawCommit: true, sawIdle: true });
        expect(
          (
            await f.admin.query(
              "SELECT state FROM learner_audio_upload_cleanup_commands WHERE cleanup_id=$1",
              [prepared.cleanup.cleanupId],
            )
          ).rows,
        ).toEqual([{ state: "completed" }]);
        const tombstone = await storedArtifact(f, d);
        await run(system(f).confirm(prepared.cleanup, new Date().toISOString()));
        expect(await storedArtifact(f, d)).toEqual(tombstone);
        expect(await run(system(f).prepareNext())).toEqual({ state: "idle" });
        expect(await evidence(f, d)).toEqual(before);
        expect(await financialFingerprint(f)).toEqual(finance);
      });
    }),
  180000,
);
