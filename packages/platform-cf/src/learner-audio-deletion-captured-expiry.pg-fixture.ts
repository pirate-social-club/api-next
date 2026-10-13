// Test-owned native ordinary producer regression. Reuses the accepted Account
// fixture/LOGIN and actual Study service; no raw producer or namespace inserts.
import { expect } from "bun:test";
import { StudyV2CommandRejected } from "@pirate/application";
import type { LearnerAudioUploadCapture } from "@pirate/application/learner-audio-capture";
import { Effect } from "effect";
import { Client } from "pg";
import {
  bounded,
  type Fixture,
  fixture,
  harness,
  run,
} from "./account-study-producer.pg-fixture.ts";
import { makeControlPlaneLearnerAudioDeletionStore } from "./learner-audio-deletion-repository.ts";

async function expireOriginalLease(f: Fixture, commandId: string) {
  expect((await f.admin.query("SHOW session_replication_role")).rows).toEqual([
    { session_replication_role: "origin" },
  ]);
  // Genuine clock fixture only; keeps the positive native CHECK and every guard.
  const changed = await f.admin.query(
    "UPDATE study_spoken_answer_commands SET lease_expires_at=reserved_at+interval '1 microsecond' WHERE command_id=$1 AND state='reserved' RETURNING lease_expires_at<=clock_timestamp() AS expired",
    [commandId],
  );
  expect(changed.rows).toEqual([{ expired: true }]);
}
const capturedRows = (f: Fixture, sessionId: string) =>
  f.admin.query<{
    upload_attempt_id: string;
    command_ref: string;
    artifact_id: string;
    io_state: string;
    storage_disposition: string | null;
    cleanup_required: boolean;
    command_state: string;
    payload_sha256: string | null;
    recording_state: string;
  }>(
    `SELECT c.upload_attempt_id,c.command_ref,c.artifact_id,u.io_state,u.storage_disposition,
    u.cleanup_required,command.state AS command_state,cp.payload_sha256,a.recording_state
   FROM learner_audio_account_producer_captures c
   JOIN learner_audio_upload_attempts u USING(upload_attempt_id)
   JOIN study_spoken_answer_commands command ON command.command_id=c.command_ref
   JOIN learner_audio_artifacts a ON a.learner_audio_artifact_id=c.artifact_id
   LEFT JOIN learner_audio_account_spoken_checkpoints cp USING(upload_attempt_id)
   WHERE c.session_id=$1`,
    [sessionId],
  );

export async function runCapturedStudyDeletionExpiryRegression(): Promise<void> {
  // An unknown writer and the later positive no-I/O example are distinct owned
  // schemas/generations. The former never becomes terminal merely due to expiry.
  await fixture(async (f) => {
    let puts = 0;
    const h = harness(f, {
      put: async () => {
        puts++;
        throw new Error("finite PUT acknowledgement unavailable");
      },
    });
    const session = await h.start("delete-unknown-expiry");
    const input = await h.input(session, "delete-unknown-expiry-answer");
    expect(await run(Effect.flip(h.submit(input)))).toMatchObject({
      _tag: "StudyV2StoreFailed",
      reason: "outcome-unknown",
    });
    const initial = await capturedRows(f, session.session_id);
    expect(initial.rows).toHaveLength(1);
    const original = initial.rows[0];
    if (original === undefined) throw new Error("Actual captured generation missing");
    expect(original).toMatchObject({
      io_state: "unknown",
      command_state: "reserved",
      storage_disposition: null,
      recording_state: "pending",
    });
    expect(typeof original.payload_sha256).toBe("string");
    expect(puts).toBe(1);
    expect(h.calls()).toBe(1);
    let deletes = 0;
    const store = makeControlPlaneLearnerAudioDeletionStore(h.runtime, {
      delete: async () => {
        deletes++;
      },
    });
    const deletion = () =>
      run(
        store.deleteBatch({
          accountId: "study-account",
          deletedAt: new Date().toISOString(),
        }),
      );
    await expect(deletion()).rejects.toMatchObject({ reason: "in-flight" });
    await expireOriginalLease(f, original.command_ref);
    await expect(deletion()).rejects.toMatchObject({ reason: "in-flight" });
    expect(
      (
        await f.admin.query("SELECT close_unclaimed_learner_audio_private_v1($1) AS closed", [
          original.upload_attempt_id,
        ])
      ).rows,
    ).toEqual([{ closed: false }]);
    const retained = (await capturedRows(f, session.session_id)).rows[0];
    expect(retained).toMatchObject({
      upload_attempt_id: original.upload_attempt_id,
      command_ref: original.command_ref,
      artifact_id: original.artifact_id,
      payload_sha256: original.payload_sha256,
      io_state: "unknown",
      command_state: "reserved",
      storage_disposition: null,
      recording_state: "pending",
      cleanup_required: true,
    });
    expect(puts).toBe(1);
    expect(h.calls()).toBe(1);
    expect(deletes).toBeGreaterThan(0);
    expect(
      (await f.admin.query("SELECT count(*)::integer AS n FROM study_attempts_v2")).rows,
    ).toEqual([{ n: 0 }]);
    const heldSchema = f.schema;

    // Keep the unknown Account's schema open throughout the independent
    // positive cohort, then re-read its unchanged original held source below.
    await fixture(async (f) => {
      expect(f.schema).not.toBe(heldSchema);
      let puts = 0;
      const h = harness(f, {
        put: async () => {
          puts++;
          throw new Error("unclaimed capture must not perform PUT");
        },
      });
      const session = await h.start("delete-unclaimed-expiry");
      const input = await h.input(session, "delete-unclaimed-expiry-answer");
      let saved: LearnerAudioUploadCapture | null = null;
      // Observe the actual service's reservation before dispatch. Original
      // request hash/IDs/context/native capture come from production source.
      const noDispatch = {
        ...h.protocol,
        beginProvider: (capture: LearnerAudioUploadCapture) => {
          saved = capture;
          return Effect.fail(new StudyV2CommandRejected({ reason: "provider-unavailable" }));
        },
      };
      expect(await run(Effect.flip(h.submit(input, noDispatch)))).toMatchObject({
        _tag: "StudyV2CommandRejected",
        reason: "provider-unavailable",
      });
      const captured = () => {
        if (saved === null) throw new Error("Actual reservation capture missing");
        return saved;
      };
      const original = captured();
      expect((await capturedRows(f, session.session_id)).rows).toMatchObject([
        {
          upload_attempt_id: original.uploadAttemptId,
          command_ref: original.commandRef,
          artifact_id: original.artifactId,
          io_state: "registered",
          command_state: "reserved",
          storage_disposition: null,
          payload_sha256: null,
          recording_state: "pending",
        },
      ]);
      await expireOriginalLease(f, original.commandRef);
      expect(puts).toBe(0);
      expect(h.calls()).toBe(0);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::integer AS n FROM learner_audio_account_provider_calls",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      // No new runtime grant: only the schema-owning fixture can invoke this
      // existing native closure. The actual helper serializes with mandatory claim
      // and succeeds solely for registered original intent, never writing/unknown.
      expect(
        (
          await f.serving.query(
            "SELECT has_function_privilege(current_user,'close_unclaimed_learner_audio_private_v1(text)','EXECUTE') AS allowed",
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      expect(
        (
          await f.admin.query("SELECT close_unclaimed_learner_audio_private_v1($1) AS closed", [
            original.uploadAttemptId,
          ])
        ).rows,
      ).toEqual([{ closed: true }]);
      expect((await capturedRows(f, session.session_id)).rows).toMatchObject([
        {
          upload_attempt_id: original.uploadAttemptId,
          io_state: "closed",
          storage_disposition: "absent",
          command_state: "reserved",
          payload_sha256: null,
        },
      ]);
      const deletedKeys: string[][] = [];
      const store = makeControlPlaneLearnerAudioDeletionStore(h.runtime, {
        delete: async (keys) => {
          deletedKeys.push(typeof keys === "string" ? [keys] : [...keys]);
          expect(
            (
              await f.admin.query(
                "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND xact_start IS NOT NULL",
                [f.role],
              )
            ).rows,
          ).toEqual([{ n: 0 }]);
        },
      });
      const deletion = () =>
        run(
          store.deleteBatch({
            accountId: "study-account",
            deletedAt: new Date().toISOString(),
          }),
        );
      expect(await deletion()).toMatchObject({ deleted_count: 1, remaining_count: 0 });
      expect(deletedKeys).toEqual([[original.objectRef]]);
      expect((await capturedRows(f, session.session_id)).rows).toMatchObject([
        {
          upload_attempt_id: original.uploadAttemptId,
          artifact_id: original.artifactId,
          io_state: "closed",
          storage_disposition: "absent",
          cleanup_required: false,
          recording_state: "deleted",
          command_state: "reserved",
          payload_sha256: null,
        },
      ]);
      // The old zero-delete/zero-remaining assertion belongs to replay AFTER a
      // positive no-I/O disposition and successful exact-key deletion.
      expect(await deletion()).toMatchObject({ deleted_count: 0, remaining_count: 0 });
      expect(deletedKeys).toHaveLength(1);
      expect(puts).toBe(0);
      expect(h.calls()).toBe(0);
      expect(
        (await f.admin.query("SELECT count(*)::integer AS n FROM study_attempts_v2")).rows,
      ).toEqual([{ n: 0 }]);

      const locker = new Client({
        connectionString: f.runtimeUrl,
        connectionTimeoutMillis: 2000,
        statement_timeout: 5000,
      });
      let blocked: Promise<
        Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: unknown }>
      > | null = null;
      let primary: unknown;
      let failed = false;
      const cleanupErrors: unknown[] = [];
      try {
        await bounded(locker.connect(), "audio expiry locker connect", 2000);
        await locker.query("BEGIN");
        await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))", [
          "study-account",
          83_000_001,
        ]);
        const pid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        if (pid === undefined) throw new Error("Owned locker backend missing");
        let settled = false;
        blocked = deletion().then(
          (value) => {
            settled = true;
            return { ok: true as const, value };
          },
          (error) => {
            settled = true;
            return { ok: false as const, error };
          },
        );
        const deadline = Date.now() + 1500;
        let observed = false;
        while (!settled && Date.now() < deadline) {
          const wait = await f.admin.query(
            "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND $2::integer=ANY(pg_blocking_pids(pid))",
            [f.role, pid],
          );
          if (wait.rows[0]?.n > 0) {
            observed = true;
            break;
          }
          await Bun.sleep(5);
        }
        expect(observed).toBe(true);
        expect(settled).toBe(false);
        await locker.query("COMMIT");
        const outcome = await bounded(blocked, "audio expiry blocked deletion drain", 5000);
        if (!outcome.ok) throw outcome.error;
        expect(outcome.value).toMatchObject({ deleted_count: 0 });
      } catch (error) {
        failed = true;
        primary = error;
      } finally {
        try {
          await bounded(locker.query("ROLLBACK"), "audio expiry locker release", 2000);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await bounded(locker.end(), "audio expiry locker close", 2000);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (blocked !== null) {
          try {
            const drained = await bounded(blocked, "audio expiry final deletion drain", 5000);
            if (!drained.ok) cleanupErrors.push(drained.error);
          } catch (error) {
            f.deferDestructiveCleanup();
            cleanupErrors.push(error);
          }
        }
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          failed ? [primary, ...cleanupErrors] : cleanupErrors,
          "Owned audio expiry cleanup failed",
        );
      if (failed) throw primary;
    });
    expect((await capturedRows(f, session.session_id)).rows[0]).toMatchObject({
      upload_attempt_id: original.upload_attempt_id,
      command_ref: original.command_ref,
      artifact_id: original.artifact_id,
      payload_sha256: original.payload_sha256,
      io_state: "unknown",
      command_state: "reserved",
      storage_disposition: null,
      recording_state: "pending",
      cleanup_required: true,
    });
    expect(puts).toBe(1);
    expect(h.calls()).toBe(1);
  });
}
