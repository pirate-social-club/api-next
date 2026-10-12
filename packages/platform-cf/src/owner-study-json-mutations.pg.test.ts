// Runnable proposal after root adoption + exact sealed private successor SQL.
// No SQL/browser/application gate was executed by this reviewer.
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { GuestStudyAnswerResultV1 } from "@pirate/contracts";
import type { OwnerAwareStudyV2Store } from "@pirate/application";
import { mutationFixture, type MutationFixture } from "./owner-study-mutations.pg-fixture.ts";
import {
  completed,
  counts,
  editFixture,
  financialFingerprint,
  hash,
  lostCommitClient,
  pgUrl,
  q,
  rejected,
  reserve,
  run,
  seedGuest,
  translation,
} from "./owner-study-starter.pg-fixture.ts";

type Submit = Parameters<OwnerAwareStudyV2Store["submitAnswer"]>[0];
const answer = (result: Awaited<ReturnType<typeof submit>>) => {
  expect(result.state).toBe("completed");
  if (result.state !== "completed") throw new Error("Expected actual completed guest answer");
  expect(result.result.source.kind).toBe("guest");
  return {
    ...result,
    answer: Schema.decodeUnknownSync(GuestStudyAnswerResultV1, {
      onExcessProperty: "error",
    })(result.result.answer),
  };
};
const submit = (f: MutationFixture, input: Submit) => run(f.mutationStore.submitAnswer(input));
async function lesson(f: MutationFixture, key: string) {
  // Four genuine prepared helper versions, no alternate actor/lesson selector.
  for (let i = 1; i <= 4; i++) await translation(f, i, "ar", "B1");
  await editFixture(
    f.admin,
    "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE exercise_type='say_it_back'",
  );
  const proof = await seedGuest(f, 1),
    rsv = await reserve(f, proof.access, key, 0);
  const started = completed(
    await run(
      f.store.startSession({
        ...rsv.input,
        targetLanguage: "ar",
        learnerBand: "B1",
      }),
    ),
  );
  expect(started.result.session.items).toHaveLength(4);
  expect(
    started.result.session.items.every((item) => item.exercise_type === "translation_choice"),
  ).toBe(true);
  const input = (
    key: string,
    choice: string,
    attempt: number,
    item = started.result.session.lesson.current?.session_item_id,
  ): Submit => {
    if (!item) throw new Error("Actual current server-selected item required");
    const requestHash = hash(
      JSON.stringify({
        session: started.result.session.session_id,
        item,
        attempt,
        choice,
      }),
    );
    return {
      access: proof.access,
      source: started.result.source,
      operation: {
        sourceOwnerId: proof.ownerId,
        kind: "study_answer",
        idempotencyKey: key,
        requestHash,
      },
      acceptedAt: new Date().toISOString(),
      answer: { kind: "single_select", choice_key: choice },
      attemptId: `attempt-${key}`,
      attemptNumber: attempt,
      communityId: "study-community",
      idempotencyKey: key,
      qualificationId: `unused-qualification-${key}`,
      requestHash,
      sessionId: started.result.session.session_id,
      sessionItemId: item,
    };
  };
  return { proof, started, rsv, input };
}
const suite = pgUrl ? describe : describe.skip;
suite("owner-aware guest JSON mutation genuine PostgreSQL", () => {
  test("retry hides the choice, retains original current clock, and correct second answer advances without account or paid effects", async () => {
    await mutationFixture(async (f) => {
      const l = await lesson(f, "json-progress"),
        money = await financialFingerprint(f),
        before = await counts(f);
      const initial = l.started.result.session.lesson.current;
      if (initial === null) throw new Error("Original current presentation missing");
      const first = answer(await submit(f, l.input("json-wrong-1", "b", 1)));
      expect(first.answer).toMatchObject({
        outcome: "incorrect",
        first_pass: true,
        attempt_state: "retryable",
        feedback: { kind: "none" },
        participation: { state: "practice_only" },
      });
      expect(first.answer.session.lesson.current).toEqual({
        ...initial,
        presentation_number: 2,
        is_reappearance: true,
      });
      expect(first.answer.session.lesson.presentation_count).toBe(1);
      expect(first.answer.session.progress.answered_exercise_count).toBe(0);
      const second = answer(await submit(f, l.input("json-correct-2", "a", 2)));
      expect(second.answer).toMatchObject({
        outcome: "correct",
        first_pass: false,
        attempt_state: "spent",
        feedback: {
          kind: "choice_reveal",
          correct_choice_key: "a",
          correct_text: "Fixture a",
          explanation: "Fixture only",
        },
      });
      expect(second.answer.session.lesson.current?.session_item_id).not.toBe(
        initial?.session_item_id,
      );
      expect(second.answer.session.lesson.presentation_count).toBe(2);
      expect(second.answer.session.lesson.resolved_card_count).toBe(1);
      const after = await counts(f);
      expect(after.calls).toBe(0);
      expect(after.accounts).toBe(before.accounts);
      expect(after.personas).toBe(before.personas);
      expect(after.memberships).toBe(before.memberships);
      expect(await financialFingerprint(f)).toEqual(money);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM study_attempts_v2 WHERE session_item_id=$1",
            [l.input("unused", "a", 1).sessionItemId],
          )
        ).rows[0].n,
      ).toBe(2);
      for (const relation of [
        "study_attempts_v2",
        "study_review_items",
        "study_lesson_item_state_v2",
        "guest_study_spoken_captures",
        "guest_study_spoken_checkpoints",
      ])
        await expect(f.guest.query(`SELECT * FROM ${q(relation)} LIMIT 1`)).rejects.toMatchObject({
          code: "42501",
        });
      await expect(
        f.guest.query("SELECT project_owner_study_session_private_v1('x','x','x')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query(
          "SELECT capture_guest_spoken_dispatch_private_v1('x','{}','x','x','x','x','x',0,true)",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  }, 30000);
  test("two same-key concurrent JSON mutations return one immutable original outcome and one actual attempt", async () => {
    await mutationFixture(async (f) => {
      const l = await lesson(f, "json-concurrent"),
        input = l.input("same-json-key", "a", 1);
      const [a, b] = await Promise.all([
        submit(f, input),
        submit(f, {
          ...input,
          attemptId: "different-draw",
          qualificationId: "different-unused-draw",
        }),
      ]);
      expect(a).toEqual(b);
      const done = answer(a);
      expect(done.answer.session.lesson.presentation_count).toBe(1);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS attempts FROM study_attempts_v2 WHERE session_item_id=$1 AND attempt_number=1",
            [input.sessionItemId],
          )
        ).rows[0].attempts,
      ).toBe(1);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS operations FROM guest_participation_operations WHERE source_owner_id=$1 AND operation_kind='study_answer'",
            [l.proof.ownerId],
          )
        ).rows[0].operations,
      ).toBe(1);
      const replay = await submit(f, {
        ...input,
        acceptedAt: "2000-01-01T00:00:00.000Z",
        attemptId: "fresh-ignored-id",
      });
      expect(replay).toEqual(a);
      expect((await counts(f)).calls).toBe(0);
    });
  }, 30000);
  test("changed original key hash and other proved owner refuse without partial attempt or operation", async () => {
    await mutationFixture(async (f) => {
      const l = await lesson(f, "json-authority"),
        input = l.input("json-original", "b", 1);
      await submit(f, input);
      const before = (await f.admin.query("SELECT count(*)::int AS n FROM study_attempts_v2")).rows;
      const changed = {
        ...input,
        requestHash: hash("different"),
        operation: { ...input.operation, requestHash: hash("different") },
      };
      expect(await rejected(f.mutationStore.submitAnswer(changed))).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "idempotency-conflict",
      });
      const other = await seedGuest(f, 2);
      expect(
        await rejected(
          f.mutationStore.submitAnswer({
            ...input,
            access: other.access,
            source: { kind: "guest", ownerId: other.ownerId },
            operation: { ...input.operation, sourceOwnerId: other.ownerId },
          }),
        ),
      ).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "owner-mismatch",
      });
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM study_attempts_v2")).rows,
      ).toEqual(before);
    });
  }, 30000);
  test("actual committed JSON answer with lost COMMIT acknowledgement remains typed unknown and exact replay recovers one outcome", async () => {
    await mutationFixture(async (f) => {
      const l = await lesson(f, "json-unknown"),
        input = l.input("unknown-json-key", "a", 1),
        fault = lostCommitClient();
      const error = await rejected(
        f.mutationStoreFor({ clientFactory: fault.clientFactory }).submitAnswer(input),
      );
      expect(fault.observed()).toBe(true);
      expect(error).toMatchObject({
        _tag: "ControlPlaneTransactionOutcomeUnknown",
        phase: "commit",
      });
      const recovered = answer(
        await submit(f, { ...input, attemptId: "fresh-unused-after-unknown" }),
      );
      expect(recovered.answer.session.lesson.presentation_count).toBe(1);
      expect(
        (
          await f.admin.query(
            "SELECT state,count(*)::int AS n FROM guest_participation_operations WHERE source_owner_id=$1 AND operation_kind='study_answer' GROUP BY state",
            [l.proof.ownerId],
          )
        ).rows,
      ).toEqual([{ state: "completed", n: 1 }]);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM study_attempts_v2 WHERE session_item_id=$1",
            [input.sessionItemId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
  }, 30000);
  test("three wrong answers per real card complete a four-card practice lesson at12 presentations with no qualification or funds", async () => {
    await mutationFixture(async (f) => {
      const l = await lesson(f, "json-budget"),
        money = await financialFingerprint(f);
      let session = l.started.result.session;
      for (let card = 0; card < 4; card++) {
        const iid = session.lesson.current?.session_item_id;
        if (!iid) throw new Error("Actual current card missing");
        for (let n = 1; n <= 3; n++) {
          const result = answer(await submit(f, l.input(`json-exhaust-${card}-${n}`, "b", n, iid)));
          session = result.answer.session;
          expect(result.answer.attempt_state).toBe(n === 3 ? "spent" : "retryable");
          expect(result.answer.feedback.kind).toBe(n === 3 ? "choice_reveal" : "none");
        }
      }
      expect(session.status).toBe("completed");
      expect(session.lesson).toMatchObject({
        current: null,
        presentation_count: 12,
        presentation_cap: 12,
        resolved_card_count: 4,
        total_card_count: 4,
        completion_reason: "all_resolved",
      });
      expect(session.progress).toEqual({
        qualifying_exercise_count: 4,
        answered_exercise_count: 4,
        first_pass_correct: 0,
        required_correct: 3,
        score_bps: 0,
      });
      expect(session.participation).toEqual({ state: "practice_only" });
      expect(await financialFingerprint(f)).toEqual(money);
      expect((await counts(f)).calls).toBe(0);
      const [row] = (
        await f.admin.query(
          "SELECT state,remaining_units FROM guest_resource_session_reservations WHERE reservation_id=$1",
          [l.rsv.reservationId],
        )
      ).rows;
      expect(row).toEqual({ state: "completed", remaining_units: 0 });
    });
  }, 30000);
});
