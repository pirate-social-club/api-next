import { expect } from "bun:test";
import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import { GuestStudyAnswerResultV1 } from "@pirate/contracts";
import { type Layer, Schema } from "effect";
import type { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneOwnerStudyMutations } from "./owner-study-mutations.ts";
import {
  completed,
  disclosure,
  editFixture,
  hash,
  policy,
  q,
  run,
  seedGuest,
  translation,
} from "./owner-study-starter.pg-fixture.ts";
import { makeControlPlaneOwnerStudyStarter } from "./owner-study-starter.ts";
import { insertTelegramPracticeReadinessFixture } from "./study-v2-ready-song.pg-fixture.ts";

type SqlFailure = { code: unknown; table: unknown; column: unknown };
export async function proveGuestStudyCompletionOwnerRepair(input: {
  admin: Client;
  serving: Client;
  role: string;
  schema: string;
  lines: readonly string[];
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>;
  connectionString: string;
  sqlFailures: readonly SqlFailure[];
}): Promise<void> {
  const { admin, serving, role, runtime } = input;
  const f = { admin };
  const prefix = (await loadPostgresMigrations()).filter(
    (migration) => Number(migration.version.slice(0, 4)) <= 269,
  );
  const repair = (await loadPostgresMigrations()).find(
    (migration) => migration.version === "0270_activity_completion_guest_study_owner.sql",
  );
  if (repair === undefined) throw new Error("forward guest completion repair missing");
  expect(prefix).toHaveLength(269);
  // Existing fixture song content only; no guest session/attempt/receipt rows
  // are manufactured. Bootstrap, reservation, capture and mutation stay real.
  const lyrics = input.lines.join("\n");
  await editFixture(
    admin,
    `INSERT INTO media_song_lyrics_revisions(submission_id,community_id,actor_user_id,author_persona_id,
      operation_id,lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,lyrics_text,lyrics_sha256,provenance)
      VALUES('study-submission','study-community','study-account','study-persona','study-operation',1,2,1,$1,$2,$3,'pasted')`,
    ["2".repeat(64), lyrics, hash(lyrics)],
  );
  await insertTelegramPracticeReadinessFixture(admin);
  await editFixture(admin, "UPDATE study_language_profiles SET source_hash=$1", [hash(lyrics)]);
  for (let index = 1; index <= 4; index += 1) await translation(f, index, "ar", "B1");
  await editFixture(
    admin,
    "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE exercise_type='say_it_back'",
  );
  await admin.query("SELECT require_guest_learning_runtime_role_v1($1::regrole)", [role]);
  for (const signature of [
    "reserve_guest_prepared_study_start_v1(jsonb,jsonb,text,text,text,text,text,text,jsonb,text)",
    "prepare_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb)",
    "commit_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,text,text,text,text,boolean)",
    "read_owner_study_session_snapshot_v1(jsonb,text,text)",
    "find_guest_study_start_operation_v1(jsonb,text,text,text,text)",
    "prepare_guest_json_answer_v1(jsonb,jsonb,text,text,text,integer,jsonb)",
    "apply_guest_json_item_mutation_v1(jsonb,jsonb,jsonb,jsonb,text,text)",
    "transition_guest_json_answer_v1(jsonb,text,jsonb,jsonb,jsonb)",
    "finish_guest_json_answer_v1(jsonb,text,jsonb,jsonb)",
  ])
    await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(role)}`);
  const accountTables = [
    "activity_completion_decisions",
    "activity_qualifications",
    "account_streak_clocks",
    "song_streaks",
    "community_streaks",
    "song_streak_days",
    "song_streak_day_activities",
    "community_streak_days",
    "persona_activity_presentations",
  ];
  const accountFacts = async () => {
    const facts: Record<string, unknown> = {};
    for (const table of accountTables)
      facts[table] = (
        await admin.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${q(table)} t`,
        )
      ).rows;
    return facts;
  };
  const before = await accountFacts();
  const proof = await seedGuest(f, 270);
  const starter = makeControlPlaneOwnerStudyStarter(runtime, disclosure, policy);
  const key = "guest-completion-forward-owner";
  const started = await run(
    starter.startPreparedSession({
      access: proof.access,
      source: { kind: "guest", ownerId: proof.ownerId },
      operation: {
        sourceOwnerId: proof.ownerId,
        kind: "study_start",
        idempotencyKey: key,
        requestHash: hash(key),
      },
      communityId: "study-community",
      postId: "study-post",
      sessionId: "guest-completion-session",
      createdAt: new Date().toISOString(),
      targetLanguage: "ar",
      learnerBand: "B1",
      timezone: "UTC",
      idempotencyKey: key,
      requestHash: hash(key),
      rewardMode: "practice_only",
      rewardTerms: null,
      disclosure: { version: disclosure.version, accepted: true },
      trustedEdge: { kind: "trusted_edge", fingerprint: "guest-completion-local-fixture" },
      policy,
      freshRefusalOperationId: "unused-guest-completion-refusal",
    }),
  );
  if (started.kind !== "start") throw new Error("genuine guest start required");
  let session = completed(started.outcome).result.session;
  expect(session.items).toHaveLength(4);
  expect(session.items.every((item) => item.exercise_type === "translation_choice")).toBe(true);
  const mutations = makeControlPlaneOwnerStudyMutations(runtime, {
    rawPolicy: policy,
    disclosureVersion: disclosure.version,
    rerecordEnabled: false,
    providerRetention: "not_stored",
  });
  const answerInput = (ordinal: number) => {
    const current = session.lesson.current;
    if (current === null) throw new Error("genuine current guest card missing");
    const answerKey = `guest-completion-answer-${ordinal}`;
    return {
      access: proof.access,
      source: { kind: "guest" as const, ownerId: proof.ownerId },
      operation: {
        sourceOwnerId: proof.ownerId,
        kind: "study_answer" as const,
        idempotencyKey: answerKey,
        requestHash: hash(answerKey),
      },
      communityId: "study-community",
      sessionId: session.session_id,
      sessionItemId: current.session_item_id,
      attemptNumber: current.presentation_number,
      idempotencyKey: answerKey,
      requestHash: hash(answerKey),
      acceptedAt: new Date().toISOString(),
      attemptId: `attempt-${answerKey}`,
      qualificationId: `unused-qualification-${answerKey}`,
      answer: { kind: "single_select" as const, choice_key: "a" },
    };
  };
  const answer = async (request: ReturnType<typeof answerInput>) => {
    const result = await run(mutations.submitAnswer(request));
    if (result.state !== "completed") throw new Error("committed genuine guest answer required");
    return {
      result,
      answer: Schema.decodeUnknownSync(GuestStudyAnswerResultV1)(result.result.answer),
    };
  };
  for (let index = 0; index < 3; index += 1)
    session = (await answer(answerInput(index))).answer.session;
  const finalInput = answerInput(3);
  // Negative control uses accepted0269 itself. Its deferred23502 occurs at
  // COMMIT; the accepted adapter correctly returns a typed unknown outcome.
  await expect(run(mutations.submitAnswer(finalInput))).rejects.toMatchObject({
    _tag: "ControlPlaneTransactionOutcomeUnknown",
    phase: "commit",
  });
  expect(input.sqlFailures).toContainEqual({
    code: "23502",
    table: "activity_completion_decisions",
    column: "account_id",
  });
  expect(
    (
      await admin.query("SELECT status,completed_at FROM study_sessions_v2 WHERE session_id=$1", [
        session.session_id,
      ])
    ).rows,
  ).toEqual([{ status: "active", completed_at: null }]);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM study_attempts_v2 WHERE session_item_id IN(SELECT session_item_id FROM study_session_items_v2 WHERE session_id=$1)",
        [session.session_id],
      )
    ).rows,
  ).toEqual([{ n: 3 }]);
  expect(await accountFacts()).toEqual(before);
  const boundary = async () =>
    (
      await admin.query(`SELECT oid,proowner,proacl::text,prosecdef,proconfig FROM pg_proc
    WHERE oid='capture_activity_completion_decision_private_v1()'::regprocedure`)
    ).rows;
  const oldBoundary = await boundary();
  expect(oldBoundary).toMatchObject([
    { prosecdef: true, proconfig: [`search_path=pg_catalog, ${input.schema}, pg_temp`] },
  ]);
  const upgraded = await runPostgresMigrations({
    connectionString: input.connectionString,
    migrations: [...prefix, repair],
    expectedLedger: prefix,
  });
  expect(upgraded).toMatchObject({ dryRun: false, result: { applied: [repair.version] } });
  expect(await boundary()).toEqual(oldBoundary);
  const final = await answer(finalInput);
  session = final.answer.session;
  expect(session.status).toBe("completed");
  expect(session.progress).toMatchObject({ first_pass_correct: 4, score_bps: 10000 });
  expect(final.answer.participation).toEqual({ state: "practice_only" });
  expect(
    (
      await admin.query(
        `SELECT status,participation_owner_kind,participation_owner_id,account_id,persona_id,
    completed_at IS NOT NULL AS completed FROM study_sessions_v2 WHERE session_id=$1`,
        [session.session_id],
      )
    ).rows,
  ).toEqual([
    {
      status: "completed",
      participation_owner_kind: "guest",
      participation_owner_id: proof.ownerId,
      account_id: null,
      persona_id: null,
      completed: true,
    },
  ]);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM study_attempts_v2 WHERE session_item_id IN(SELECT session_item_id FROM study_session_items_v2 WHERE session_id=$1)",
        [session.session_id],
      )
    ).rows,
  ).toEqual([{ n: 4 }]);
  expect(
    (
      await admin.query(
        `SELECT
          (SELECT count(*)::int FROM activity_completion_decisions WHERE activity_key='study' AND session_id=$1) AS decisions,
          (SELECT count(*)::int FROM activity_qualifications WHERE study_session_id=$1) AS qualifications,
          (SELECT count(*)::int FROM song_streak_days) AS song_days,
          (SELECT count(*)::int FROM community_streak_days) AS community_days`,
        [session.session_id],
      )
    ).rows,
  ).toEqual([{ decisions: 0, qualifications: 0, song_days: 0, community_days: 0 }]);
  expect(
    (
      await serving.query("SELECT session_id FROM study_sessions_v2 WHERE session_id=$1", [
        session.session_id,
      ])
    ).rows,
  ).toEqual([]);
  expect(await accountFacts()).toEqual(before);
  expect((await answer(finalInput)).result).toEqual(final.result);
  expect(await accountFacts()).toEqual(before);
  // Restore only seeded catalogue availability for the following ordinary
  // account producer proof. Guest sessions, attempts and receipts stay untouched.
  await editFixture(
    admin,
    "UPDATE study_exercise_versions SET retired_at=NULL WHERE exercise_type='say_it_back'",
  );
}
