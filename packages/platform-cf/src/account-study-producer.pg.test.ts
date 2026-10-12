import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { StudyV2StoreFailed } from "@pirate/application";
import { makeControlledAccountSpokenRecovery } from "./controlled-account-spoken-recovery.ts";
import { makeAccountLearnerAudioDeleteProtocol } from "./account-audio-deletion-protocol.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";
import { makeTelegramStudyStore } from "./telegram-study-store.ts";
import { telegramStudyAdmission } from "./telegram-study-admission.ts";
import {
  bounded,
  deferred,
  dropCommitAcknowledgement,
  fixture,
  harness,
  pgUrl,
  rejected,
  run,
  stopBeforeFinalize,
  type Fixture,
} from "./account-study-producer.pg-fixture.ts";
import type {
  AccountSpokenInput,
  ControlledAccountSpokenProtocol,
} from "@pirate/application/controlled-account-spoken";

const suite = pgUrl === undefined ? describe.skip : describe;
const now = () => new Date().toISOString();
async function count(f: Fixture, sql: string, values: readonly unknown[] = []) {
  const row = (
    await f.admin.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${sql}`, [...values])
  ).rows[0];
  if (row === undefined) throw new Error("Count row missing");
  return row.n;
}
async function rowsFor(f: Fixture, input: AccountSpokenInput) {
  const rows = await f.admin.query(
    `SELECT c.upload_attempt_id,c.owner_id,c.account_id,c.artifact_id,c.command_ref,c.producer_generation,
    c.content_digest,c.captured_revision,c.expected_object_ref,u.io_state,u.storage_disposition,u.cleanup_required,
    command.state AS command_state,command.lease_token,command.audio_digest,cp.successful_result,cp.payload_sha256,
    provider.state AS provider_state,artifact.recording_state,artifact.object_ref
    FROM learner_audio_account_producer_captures c JOIN learner_audio_upload_attempts u USING(upload_attempt_id)
    JOIN study_spoken_answer_commands command ON command.command_id=c.command_ref
    JOIN learner_audio_artifacts artifact ON artifact.learner_audio_artifact_id=c.artifact_id
    LEFT JOIN learner_audio_account_spoken_checkpoints cp USING(upload_attempt_id)
    LEFT JOIN learner_audio_account_provider_calls provider USING(upload_attempt_id)
    WHERE c.account_id=$1 AND c.session_id=$2 AND c.session_item_id=$3 AND c.idempotency_key=$4`,
    [input.accountId, input.sessionId, input.sessionItemId, input.idempotencyKey],
  );
  expect(rows.rows).toHaveLength(1);
  const row = rows.rows[0];
  if (row === undefined) throw new Error("Genuine capture missing");
  return row;
}
async function expireLease(f: Fixture, input: AccountSpokenInput) {
  // Changes only the genuine lease clock; guards remain active. Time passage is
  // intentionally not evidence that provider/storage I/O settled.
  expect((await f.admin.query("SHOW session_replication_role")).rows).toEqual([
    { session_replication_role: "origin" },
  ]);
  await f.admin.query(
    "UPDATE study_spoken_answer_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1 AND session_item_id=$2 AND idempotency_key=$3 AND state='reserved'",
    [input.sessionId, input.sessionItemId, input.idempotencyKey],
  );
}

suite("genuine controlled ordinary Study producer", () => {
  test("five causal recovery/storage cases preserve original account grade and private authority", async () => {
    await fixture(async (f) => {
      const objects = new Map<string, Uint8Array>();
      let puts = 0;
      const visibleBeforePut = async (key: string, bytes: Uint8Array) => {
        const evidence = await f.admin.query(
          `SELECT c.account_id,c.source_kind,u.io_state,cp.upload_attempt_id AS checkpoint,
          p.state AS provider_state,cp.successful_result->>'artifactId' AS artifact,
          cp.successful_result->>'commandId' AS command,c.artifact_id,c.command_ref
          FROM learner_audio_account_producer_captures c JOIN learner_audio_upload_attempts u USING(upload_attempt_id)
          JOIN learner_audio_account_spoken_checkpoints cp USING(upload_attempt_id)
          JOIN learner_audio_account_provider_calls p USING(upload_attempt_id) WHERE c.expected_object_ref=$1`,
          [key],
        );
        expect(evidence.rows).toHaveLength(1);
        const row = evidence.rows[0];
        if (row === undefined) throw new Error("CP missing before external PUT");
        expect(row).toMatchObject({
          account_id: "study-account",
          source_kind: "study",
          io_state: "writing",
          provider_state: "succeeded",
        });
        expect(row.checkpoint).toBeString();
        expect(row.artifact).toBe(row.artifact_id);
        expect(row.command).toBe(row.command_ref);
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND xact_start IS NOT NULL",
              [f.role],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        // This independent PG client observes committed CP+claim, so neither
        // provider grading nor network PUT relies on an open producer SQL tx.
        puts++;
        objects.set(key, new Uint8Array(bytes));
        return { size: bytes.byteLength };
      };
      const normal = harness(f, { put: visibleBeforePut });

      // 1. Actual Account service, four original current cards, one attempt/CP
      // each and unchanged qualification arithmetic. Replay adds nothing.
      let session = await normal.start("ordinary-producer-complete");
      let lastInput: AccountSpokenInput | undefined;
      const answers = [];
      for (let step = 0; session.status === "active" && step < 4; step++) {
        const input = await normal.input(
          session,
          `ordinary-card:${session.lesson.presentation_count}`,
        );
        const answer = await run(normal.submit(input));
        expect(answer.outcome).toBe("correct");
        expect(
          await count(f, "study_attempts_v2 WHERE session_item_id=$1", [input.sessionItemId]),
        ).toBe(1);
        const row = await rowsFor(f, input);
        expect(row).toMatchObject({
          account_id: "study-account",
          io_state: "closed",
          storage_disposition: "stored",
          cleanup_required: false,
          command_state: "completed",
          provider_state: "succeeded",
          recording_state: "stored",
        });
        expect(row.owner_id).toBe(
          (
            await f.admin.query(
              "SELECT owner_id FROM participation_owners WHERE kind='account' AND account_id='study-account'",
            )
          ).rows[0].owner_id,
        );
        expect(row.producer_generation).toBe(row.lease_token);
        expect(row.content_digest).toBe(row.audio_digest);
        lastInput = input;
        answers.push(answer);
        session = answer.session;
      }
      expect(answers).toHaveLength(4);
      expect(session.status).toBe("completed");
      expect(session.progress.first_pass_correct).toBe(4);
      expect(session.progress.required_correct).toBe(3);
      expect(
        await count(f, "activity_qualifications WHERE study_session_id=$1", [session.session_id]),
      ).toBe(1);
      expect(
        await count(
          f,
          "learner_audio_account_spoken_checkpoints cp JOIN learner_audio_account_producer_captures c USING(upload_attempt_id) WHERE c.session_id=$1",
          [session.session_id],
        ),
      ).toBe(4);
      if (lastInput === undefined) throw new Error("Completed fixture answer absent");
      const finalAnswer = answers[3];
      if (finalAnswer === undefined) throw new Error("Final answer absent");
      const oldCalls = normal.calls(),
        oldPuts = puts,
        oldIds = normal.ids();
      expect(await run(normal.submit(lastInput))).toEqual(finalAnswer);
      expect(normal.calls()).toBe(oldCalls);
      expect(puts).toBe(oldPuts);
      expect(normal.ids()).toBe(oldIds);

      // Real linked Telegram consent+conversation lease and actual admission,
      // rather than a fake authorize callback. Historical practice stays excluded.
      await f.admin.query(
        "INSERT INTO community_telegram_integrations(community_id,record,revision,bot_epoch,webhook_id,bot_id) VALUES('study-community',$1::jsonb,1,'epoch','owned-hook','123')",
        [
          JSON.stringify({
            ...emptyTelegramIntegration("study-community"),
            botEpoch: "epoch",
            botId: "123",
            botUsername: "owned_fixture_bot",
            status: "ready",
          }),
        ],
      );
      await f.admin.query(
        "INSERT INTO community_telegram_private_chats(community_id,bot_epoch,telegram_user_id) VALUES('study-community','epoch','321')",
      );
      await f.admin.query(
        "INSERT INTO telegram_account_associations(telegram_user_id,account_id) VALUES('321','study-account')",
      );
      await f.admin.query(
        "INSERT INTO telegram_bot_grants(community_id,bot_id,telegram_user_id,account_id,persona_id,revision) VALUES('study-community','123','321','study-account','study-persona',1)",
      );
      const chat = makeTelegramStudyStore(makeTelegramDatabase(normal.runtime), "study-community", [
        "study-post",
      ]);
      const lease = await chat.claim(
        { communityId: "study-community", botId: "123", telegramUserId: "321", epoch: "epoch" },
        "owned-conversation-lease",
      );
      if (lease === null) throw new Error("Genuine Telegram conversation lease missing");
      const admission = telegramStudyAdmission(
        lease,
        { accountId: "study-account", personaId: "study-persona", revision: 1 },
        ["study-post"],
      );
      const practice = harness(f, { put: visibleBeforePut }, {}, admission);
      let practiceSession = await practice.start("ordinary-telegram-practice");
      expect(
        (
          await f.admin.query(
            "SELECT telegram_practice_only FROM study_sessions_v2 WHERE session_id=$1",
            [practiceSession.session_id],
          )
        ).rows,
      ).toEqual([{ telegram_practice_only: true }]);
      for (let step = 0; practiceSession.status === "active" && step < 4; step++) {
        const i = await practice.input(
          practiceSession,
          `practice:${practiceSession.lesson.presentation_count}`,
        );
        const a = await run(practice.submit(i));
        expect(a.outcome).toBe("correct");
        practiceSession = a.session;
      }
      expect(
        await count(f, "activity_qualifications WHERE study_session_id=$1", [
          practiceSession.session_id,
        ]),
      ).toBe(0);
      expect(practiceSession.status).toBe("completed");
      expect(practiceSession.progress.first_pass_correct).toBe(4);
      await chat.release(lease);

      // 2. Genuine successful CP COMMIT with only ACK withheld: one provider
      // success, original CP durable, no archive before persistence confirmed.
      const cpInput = await normal.input(await normal.start("ordinary-cp-ack-loss"), "cp-ack-loss");
      const cpLoss = dropCommitAcknowledgement("SELECT persist_account_spoken_success_private_v1(");
      const cpHarness = harness(
        f,
        { put: visibleBeforePut },
        { clientFactory: cpLoss.clientFactory },
      );
      const cpFailure = await rejected(cpHarness.submit(cpInput));
      expect(cpFailure).toMatchObject({ _tag: "StudyV2StoreFailed", reason: "outcome-unknown" });
      expect(cpLoss.observed()).toBe(true);
      const cpOriginal = await rowsFor(f, cpInput);
      expect(cpOriginal).toMatchObject({
        io_state: "registered",
        provider_state: "succeeded",
        command_state: "reserved",
      });
      expect(cpOriginal.successful_result).toBeObject();
      expect(
        await count(f, "study_attempts_v2 WHERE session_item_id=$1", [cpInput.sessionItemId]),
      ).toBe(0);
      const beforeWrongRoutePuts = puts,
        beforeWrongRouteCalls = normal.calls();
      expect(
        await rejected(
          normal.submit({ ...cpInput, communityId: "wrong-community" }, normal.protocol, null),
        ),
      ).toMatchObject({ _tag: "StudyV2StoreFailed", reason: "invalid-row" });
      expect(puts).toBe(beforeWrongRoutePuts);
      expect(normal.calls()).toBe(beforeWrongRouteCalls);
      expect((await rowsFor(f, cpInput)).payload_sha256).toBe(cpOriginal.payload_sha256);
      expect((await rowsFor(f, cpInput)).io_state).toBe("registered");
      const callsBefore = normal.calls(),
        idsBefore = normal.ids();
      const cpRecovered = await run(normal.submit(cpInput, normal.protocol, null));
      expect(cpRecovered.outcome).toBe("correct");
      expect(cpHarness.calls()).toBe(1);
      expect(normal.calls()).toBe(callsBefore);
      expect(normal.ids()).toBe(idsBefore);
      expect((await rowsFor(f, cpInput)).payload_sha256).toBe(cpOriginal.payload_sha256);
      expect(
        await count(f, "study_attempts_v2 WHERE session_item_id=$1", [cpInput.sessionItemId]),
      ).toBe(1);
      const unavailableInput = await normal.input(
        await normal.start("ordinary-provider-unconfigured"),
        "provider-unconfigured",
      );
      const unavailableIds = normal.ids();
      expect(await rejected(normal.submit(unavailableInput, normal.protocol, null))).toMatchObject({
        _tag: "StudyV2CommandRejected",
        reason: "provider-unavailable",
      });
      expect(
        await count(f, "study_spoken_answer_commands WHERE session_id=$1", [
          unavailableInput.sessionId,
        ]),
      ).toBe(0);
      expect(normal.ids()).toBe(unavailableIds);

      // 3. Genuine finalizer COMMIT ACK loss replays the committed grade. A
      // separate stopped process after real closed PUT is recovered without
      // provider/bucket/config/Clock/IdGen by the actual closed-checkpoint cron.
      const finalInput = await normal.input(
        await normal.start("ordinary-finalizer-ack-loss"),
        "finalizer-ack-loss",
      );
      const finalLoss = dropCommitAcknowledgement(
        "SELECT require_account_spoken_success_private_v1(",
      );
      const finalHarness = harness(
        f,
        { put: visibleBeforePut },
        { clientFactory: finalLoss.clientFactory },
      );
      expect(await rejected(finalHarness.submit(finalInput))).toMatchObject({
        _tag: "StudyV2StoreFailed",
        reason: "outcome-unknown",
      });
      expect(finalLoss.observed()).toBe(true);
      expect((await rowsFor(f, finalInput)).command_state).toBe("completed");
      expect(
        await count(f, "study_attempts_v2 WHERE session_item_id=$1", [finalInput.sessionItemId]),
      ).toBe(1);
      const putCount = puts,
        callsCount = normal.calls();
      expect((await run(normal.submit(finalInput))).outcome).toBe("correct");
      expect(puts).toBe(putCount);
      expect(normal.calls()).toBe(callsCount);
      const cronInput = await normal.input(
        await normal.start("ordinary-config-free-recovery"),
        "config-free-recovery",
      );
      expect(
        await rejected(normal.submit(cronInput, stopBeforeFinalize(normal.protocol))),
      ).toMatchObject({ _tag: "StudyV2StoreFailed", reason: "unavailable" });
      const beforeCron = await rowsFor(f, cronInput);
      expect(beforeCron).toMatchObject({
        io_state: "closed",
        storage_disposition: "stored",
        command_state: "reserved",
        provider_state: "succeeded",
      });
      await expireLease(f, cronInput);
      const recovery = makeControlledAccountSpokenRecovery(f.runtime(), normal.store.finalize);
      const recoveryPuts = puts,
        recoveryCalls = normal.calls(),
        recoveryIds = normal.ids();
      expect(await run(recovery.recover())).toMatchObject({
        claimed: 1,
        recovered: 1,
        storageFailures: 0,
        fenced: 0,
      });
      expect(puts).toBe(recoveryPuts);
      expect(normal.calls()).toBe(recoveryCalls);
      expect(normal.ids()).toBe(recoveryIds);
      expect(await run(recovery.recover())).toMatchObject({ claimed: 0, recovered: 0 });
      expect((await rowsFor(f, cronInput)).payload_sha256).toBe(beforeCron.payload_sha256);
      expect(
        await count(f, "study_attempts_v2 WHERE session_item_id=$1", [cronInput.sessionItemId]),
      ).toBe(1);

      // Actual captured finalizer commits; then a genuine Post visibility
      // change revokes today's ordinary egress. No fake auth/store response.
      const egressInput = await normal.input(
        await normal.start("ordinary-egress-denied"),
        "egress-denied",
      );
      let committedPayloadHash: string | undefined;
      const hideAfterCommit: ControlledAccountSpokenProtocol = {
        ...normal.protocol,
        finalize: Effect.fn("accountProducerFixture.hideAfterCommittedFinalize")(function* (
          capture: Parameters<ControlledAccountSpokenProtocol["finalize"]>[0],
          success: Parameters<ControlledAccountSpokenProtocol["finalize"]>[1],
          archive: Parameters<ControlledAccountSpokenProtocol["finalize"]>[2],
        ) {
          const result = yield* normal.protocol.finalize(capture, success, archive);
          yield* Effect.promise(async () => {
            const payload = (await rowsFor(f, egressInput)).payload_sha256;
            if (typeof payload !== "string") throw new Error("Committed checkpoint digest missing");
            committedPayloadHash = payload;
            await f.admin.query(
              "UPDATE posts SET visibility='members_only' WHERE post_id='study-post' AND community_id='study-community'",
            );
          });
          return result;
        }),
      };
      try {
        expect(await rejected(normal.submit(egressInput, hideAfterCommit))).toMatchObject({
          _tag: "StudyV2CommandRejected",
          reason: "not-found",
        });
        expect(
          await run(
            normal.store.ordinary.getSession({
              accountId: egressInput.accountId,
              communityId: egressInput.communityId,
              sessionId: egressInput.sessionId,
            }),
          ),
        ).toBeNull();
        const denied = await rowsFor(f, egressInput);
        expect(denied).toMatchObject({
          command_state: "completed",
          provider_state: "succeeded",
          io_state: "closed",
          storage_disposition: "stored",
        });
        if (committedPayloadHash === undefined)
          throw new Error("Actual finalizer did not commit before egress test");
        expect(denied.payload_sha256).toBe(committedPayloadHash);
        expect(
          await count(f, "study_attempts_v2 WHERE session_item_id=$1", [egressInput.sessionItemId]),
        ).toBe(1);
        expect(
          await count(f, "learner_audio_account_spoken_checkpoints WHERE upload_attempt_id=$1", [
            denied.upload_attempt_id,
          ]),
        ).toBe(1);
        const hiddenPuts = puts,
          hiddenCalls = normal.calls();
        expect(await rejected(normal.submit(egressInput, normal.protocol, null))).toMatchObject({
          _tag: "StudyV2CommandRejected",
          reason: "not-found",
        });
        expect(puts).toBe(hiddenPuts);
        expect(normal.calls()).toBe(hiddenCalls);
      } finally {
        await bounded(
          f.admin.query(
            "UPDATE posts SET visibility='public' WHERE post_id='study-post' AND community_id='study-community'",
          ),
          "restore owned Post visibility",
        );
      }

      // 4. A real captured PUT stays pending while genuine account deletion
      // fences it. A fulfilled late PUT is retained as a stored object fact,
      // never published after deletion, and invalidates the old DELETE batch.
      const putEntered = deferred<void>(),
        putFinish = deferred<{ size: number }>();
      const late = harness(f, {
        put: async (key, bytes) => {
          try {
            await visibleBeforePut(key, bytes);
          } catch (error) {
            putEntered.reject(new Error("Owned deferred PUT entry failed"));
            throw error;
          }
          objects.delete(key);
          putEntered.resolve();
          const result = await putFinish.promise;
          objects.set(key, new Uint8Array(bytes));
          return result;
        },
      });
      const lateInput = await late.input(await late.start("ordinary-late-put"), "late-put");
      const deletion = makeAccountLearnerAudioDeleteProtocol(f.runtime());
      // Attach both settlement handlers immediately, before waiting for entry.
      const lateRun = rejected(late.submit(lateInput, stopBeforeFinalize(late.protocol))).then(
        (failure) => ({ kind: "settled" as const, failure }),
        (error) => ({ kind: "rejected" as const, error }),
      );
      let lateFailure: unknown;
      try {
        const entry = await bounded(
          Promise.race([putEntered.promise.then(() => ({ kind: "entered" as const })), lateRun]),
          "deferred PUT entry race",
          5000,
        );
        expect(entry.kind).toBe("entered");
        const lateOriginal = await rowsFor(f, lateInput);
        expect(lateOriginal.io_state).toBe("writing");
        const firstBatch = await run(deletion.prepare("study-account", 1000));
        expect(firstBatch.objectRefs.length).toBeLessThanOrEqual(1000);
        expect(firstBatch.objectRefs).toContain(lateOriginal.expected_object_ref);
        for (const key of firstBatch.objectRefs) objects.delete(key);
        // Other previous stored objects can make positive progress; completion
        // still cannot pass the outstanding writer. Zero progress may be in-flight.
        await run(Effect.exit(deletion.confirm(firstBatch, now())));
        const firstCommand = (
          await f.admin.query(
            "SELECT c.command_id,c.state FROM learner_audio_delete_commands c JOIN learner_audio_delete_batches b USING(command_id) WHERE b.batch_id=$1",
            [firstBatch.batchId],
          )
        ).rows[0];
        if (firstCommand === undefined) throw new Error("Deletion command missing");
        expect(firstCommand.state).not.toBe("completed");
        await expireLease(f, lateInput);
        const lateBefore = await rowsFor(f, lateInput);
        expect(lateBefore.io_state).not.toBe("closed");
        // A new request while original captured I/O is unresolved cannot mint a
        // replacement generation; failed reserve changes roll back atomically.
        expect(
          await rejected(
            late.submit({ ...lateInput, idempotencyKey: "replacement-while-writing" }),
          ),
        ).toBeInstanceOf(StudyV2StoreFailed);
        expect(
          await count(f, "learner_audio_account_producer_captures WHERE command_ref=$1", [
            lateOriginal.command_ref,
          ]),
        ).toBe(1);
        putFinish.resolve({ size: lateInput.audio.byteLength });
        expect(await bounded(lateRun, "late producer settlement")).toMatchObject({
          kind: "settled",
          failure: { _tag: "StudyV2StoreFailed", reason: "unavailable" },
        });
        await bounded(late.drain(), "late producer background drain");
        const settled = await rowsFor(f, lateInput);
        expect(settled).toMatchObject({
          io_state: "closed",
          storage_disposition: "stored",
          cleanup_required: true,
          provider_state: "succeeded",
          command_state: "reserved",
        });
        expect(settled.payload_sha256).toBe(lateOriginal.payload_sha256);
        expect(objects.has(lateOriginal.expected_object_ref)).toBe(true);
        expect(
          await rejected(
            late.submit({ ...lateInput, idempotencyKey: "replacement-while-cleanup" }),
          ),
        ).toBeInstanceOf(StudyV2StoreFailed);
        expect(
          await count(f, "learner_audio_account_producer_captures WHERE command_ref=$1", [
            lateOriginal.command_ref,
          ]),
        ).toBe(1);
        expect(late.calls()).toBe(1);
        expect(
          await count(f, "study_attempts_v2 WHERE session_item_id=$1", [lateInput.sessionItemId]),
        ).toBe(0);
        const beforeOldReplay = await f.admin.query(
          "SELECT state FROM learner_audio_delete_commands WHERE command_id=$1",
          [firstCommand.command_id],
        );
        await run(Effect.exit(deletion.confirm(firstBatch, now())));
        expect(
          (
            await f.admin.query(
              "SELECT state FROM learner_audio_delete_commands WHERE command_id=$1",
              [firstCommand.command_id],
            )
          ).rows,
        ).toEqual(beforeOldReplay.rows);
        expect(objects.has(lateOriginal.expected_object_ref)).toBe(true);
        const newBatch = await run(deletion.prepare("study-account", 1000));
        expect(newBatch.batchId).not.toBe(firstBatch.batchId);
        expect(newBatch.objectRefs).toContain(lateOriginal.expected_object_ref);
        for (const key of newBatch.objectRefs) objects.delete(key);
        expect((await run(deletion.confirm(newBatch, now()))).remaining_count).toBe(0);
        expect((await rowsFor(f, lateInput)).recording_state).toBe("deleted");
        expect(objects.has(lateOriginal.expected_object_ref)).toBe(false);
        expect(await run(recovery.recover())).toMatchObject({
          claimed: 1,
          recovered: 1,
          storageFailures: 0,
          fenced: 0,
        });
        expect(
          await count(f, "study_attempts_v2 WHERE session_item_id=$1", [lateInput.sessionItemId]),
        ).toBe(1);
        expect((await rowsFor(f, lateInput)).payload_sha256).toBe(lateOriginal.payload_sha256);
      } catch (error) {
        lateFailure = error;
        throw error;
      } finally {
        // Resolving twice is harmless; every early assertion/SQL failure releases
        // the known original PUT and drains its already-handled original run.
        putFinish.resolve({ size: lateInput.audio.byteLength });
        const drains = await Promise.allSettled([
          bounded(lateRun, "late original final drain"),
          bounded(late.drain(), "late all background final drain"),
        ]);
        if (drains.some((result) => result.status === "rejected"))
          throw new AggregateError(
            lateFailure === undefined
              ? [new Error("Owned deferred PUT final drain did not complete")]
              : [lateFailure, new Error("Owned deferred PUT final drain did not complete")],
            "Owned deferred PUT cleanup failed",
          );
      }

      // 5. Rejected PUT is actual storage uncertainty, never a failed archive
      // or terminal no-I/O fact. Lease expiry/retry/delete cannot erase the CP
      // or free its writer; all subsequent work retains the original generation.
      let unknownPuts = 0;
      const uncertain = harness(f, {
        put: async () => {
          unknownPuts++;
          throw new Error("controlled storage transport lost response");
        },
      });
      const unknownInput = await uncertain.input(
        await uncertain.start("ordinary-unknown-put"),
        "unknown-put",
      );
      expect(await rejected(uncertain.submit(unknownInput))).toMatchObject({
        _tag: "StudyV2StoreFailed",
        reason: "outcome-unknown",
      });
      const unknown = await rowsFor(f, unknownInput);
      expect(unknown).toMatchObject({
        io_state: "unknown",
        provider_state: "succeeded",
        command_state: "reserved",
      });
      expect(unknown.successful_result).toBeObject();
      expect(
        await count(f, "study_attempts_v2 WHERE session_item_id=$1", [unknownInput.sessionItemId]),
      ).toBe(0);
      await expireLease(f, unknownInput);
      expect(await rejected(uncertain.submit(unknownInput))).toMatchObject({
        _tag: "StudyV2StoreFailed",
        reason: "outcome-unknown",
      });
      expect(unknownPuts).toBe(1);
      expect(uncertain.calls()).toBe(1);
      expect(
        await rejected(
          uncertain.submit({ ...unknownInput, idempotencyKey: "unknown-replacement" }),
        ),
      ).toBeInstanceOf(StudyV2StoreFailed);
      expect(
        await count(f, "learner_audio_account_producer_captures WHERE command_ref=$1", [
          unknown.command_ref,
        ]),
      ).toBe(1);
      const unknownBatch = await run(deletion.prepare("study-account", 1000));
      for (const key of unknownBatch.objectRefs) objects.delete(key);
      const batchBeforeUnknown = (
        await f.admin.query(
          "SELECT state,revision FROM learner_audio_delete_batches WHERE batch_id=$1",
          [unknownBatch.batchId],
        )
      ).rows;
      expect(
        await rejected(
          deletion.unknown({ ...unknownBatch, fenceRevision: unknownBatch.fenceRevision + 1 }),
        ),
      ).toMatchObject({ _tag: "ControlPlaneStatementFailed" });
      expect(
        (
          await f.admin.query(
            "SELECT state,revision FROM learner_audio_delete_batches WHERE batch_id=$1",
            [unknownBatch.batchId],
          )
        ).rows,
      ).toEqual(batchBeforeUnknown);
      await run(deletion.unknown(unknownBatch));
      expect(
        (
          await f.admin.query("SELECT state FROM learner_audio_delete_batches WHERE batch_id=$1", [
            unknownBatch.batchId,
          ])
        ).rows,
      ).toEqual([{ state: "unknown" }]);
      expect(await rejected(deletion.confirm(unknownBatch, now()))).toMatchObject({
        _tag: "LearnerAudioDeletionFailed",
        reason: "in-flight",
      });
      const retained = await rowsFor(f, unknownInput);
      expect(retained.io_state).toBe("unknown");
      expect(retained.payload_sha256).toBe(unknown.payload_sha256);
      expect(
        (
          await f.admin.query(
            "SELECT c.state FROM learner_audio_delete_commands c JOIN learner_audio_delete_batches b USING(command_id) WHERE b.batch_id=$1",
            [unknownBatch.batchId],
          )
        ).rows[0].state,
      ).not.toBe("completed");
      expect(await run(recovery.recover())).toMatchObject({ claimed: 0, recovered: 0 });
      expect(unknownPuts).toBe(1);
      expect(await count(f, "activity_qualifications WHERE activity_key='study'")).toBe(1);
      expect((await f.admin.query("SHOW session_replication_role")).rows).toEqual([
        { session_replication_role: "origin" },
      ]);
      await bounded(
        Promise.all([normal.drain(), practice.drain(), uncertain.drain()]),
        "successful producer background drains",
        8000,
      );
    });
  }, 180000);
});
