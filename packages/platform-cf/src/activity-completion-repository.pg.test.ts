import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type ControlPlaneDb, prepareActivityPersona } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { proveActivityCompletionForwardAcl } from "./activity-completion-acl.pg-fixture.ts";
import { makeControlPlaneActivityCompletionRepository } from "./activity-completion-repository.ts";
import {
  AUTHOR_ID,
  COMMUNITY_ID,
  makeComposedActivityTimes,
  POST_ID,
} from "./activity-participation-composed.pg-fixture.ts";
import {
  makeKaraokeDriver,
  makeStudyDriver,
} from "./activity-participation-composed-drivers.pg-fixture.ts";
import { seedActivitySong } from "./activity-participation-composed-song.pg-fixture.ts";
import { makeControlPlaneActivityQualificationRepository } from "./activity-qualification-repository.ts";
import { prepareSinger } from "./karaoke-instrumental-policy.pg-fixture.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "./ordinary-study-account-birth.pg-fixture.ts";
import { makeControlPlanePersonaStore } from "./persona-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_ACTIVITY_COMPLETION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-activity-completion-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-activity-completion-suite-complete\n";
let completedTestCount = 0;

suite("persisted private activity completion projections", () => {
  test("projects actual Study and Karaoke decisions, deduped day ownership, private progress and access loss", async () => {
    if (connectionString === undefined) throw new Error("test URL missing");
    const schema = `activity_completion_${crypto.randomUUID().replaceAll("-", "")}`;
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      // Parent owns baseline generation. This test also runs against the unchanged
      // predecessor baseline by applying only the new forward migration locally.
      if (
        (await admin.query("SELECT to_regclass('activity_completion_decisions') AS relation"))
          .rows[0]?.relation === null
      ) {
        await admin.query(
          await readFile(
            new URL(
              "../../../db/postgres/migrations/0269_activity_completion_decisions.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      }
      const runtime = makeDirectPostgresControlPlaneLayer(scoped.toString());
      const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
        Effect.runPromise(effect.pipe(Effect.provide(runtime)));
      await makeOwnedOrdinaryAccountBirthFixture(runtime)(AUTHOR_ID);
      await admin.query("SET session_replication_role=replica");
      try {
        await seedActivitySong(admin, { accountAlreadyBorn: true });
      } finally {
        await admin.query("SET session_replication_role=origin");
      }
      const accountId = "completion-reader";
      const personaId = await prepareSinger(admin, runtime, accountId);
      const baseTimes = makeComposedActivityTimes(Date.now() - 30_000);
      // Keep the two different producer commits on exactly the same accepted day.
      const times = {
        ...baseTimes,
        study: { ...baseTimes.study, acceptedAt: baseTimes.karaoke.completedAt },
      };
      const readAt = times.karaoke.completedAt;
      const identity = { accountId, communityId: COMMUNITY_ID, readAt };
      const reads = makeControlPlaneActivityCompletionRepository();
      const study = makeStudyDriver(runtime, makeControlPlaneStudyV2Repository(), times.study);
      const karaoke = makeKaraokeDriver(
        runtime,
        makeControlPlaneKaraokeRepository(),
        times.karaoke,
      );
      const progressInput = { ...identity, postId: POST_ID };
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM community_memberships WHERE community_id=$1 AND user_id=$2",
            [COMMUNITY_ID, accountId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      const empty = await run(reads.getProgress(progressInput));
      expect(empty).toMatchObject({
        streak: { current: 0, best: 0, total_days: 0 },
        standing: null,
        activity_counts: [
          { activity: "study", qualification_count: 0 },
          { activity: "karaoke", qualification_count: 0 },
        ],
      });
      expect(empty.week.days).toHaveLength(7);
      expect(empty.week.days.every((mark) => !mark.earned)).toBe(true);
      // Minting a pending persona and confirming its wallet do not invent a
      // presentation. Explicit preparation of the now-active persona owns it.
      expect(await run(reads.getPresentation(identity))).toMatchObject({
        selection: { status: "unset" },
      });
      await Effect.runPromise(
        prepareActivityPersona(
          {
            accountId,
            communityId: COMMUNITY_ID,
            body: {
              idempotency_key: "prepare-active-completion-persona",
              choice: { kind: "existing", persona_id: personaId },
            },
          },
          {
            store: makeControlPlanePersonaStore(runtime),
            nextPersonaId: () => Effect.succeed("unused-persona"),
            nowIso: () => Effect.succeed(new Date().toISOString()),
          },
        ),
      );
      expect(await run(reads.getPresentation(identity))).toMatchObject({
        selection: {
          status: "selected",
          presentation: { persona_id: personaId },
        },
      });
      // The accepted prospective-change guard refuses future timestamps.
      // Establish this fixture's first pin nine days ago before any completion,
      // then change it at the actual current time after the seven-day window.
      await run(
        makeControlPlaneActivityQualificationRepository().setStreakTimezone({
          accountId,
          timezone: "UTC",
          idempotencyKey: "projection-initial-pin",
          requestHash: "b".repeat(64),
          updatedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        }),
      );
      const pending = await study.startSession(accountId, personaId, "projection-pending");
      expect(
        (
          await run(
            reads.getCompletion({
              ...identity,
              activity: "study",
              sessionId: pending.session_id,
              attemptId: null,
            }),
          )
        ).decision,
      ).toEqual({ status: "pending" });
      const { session, final } = await study.completeSession(
        accountId,
        personaId,
        "projection-study",
      );
      const studyInput = {
        ...identity,
        activity: "study" as const,
        sessionId: session.session_id,
        attemptId: null,
      };
      const completed = await run(reads.getCompletion(studyInput));
      expect(completed.decision).toMatchObject({
        status: "qualified",
        earned_day: {
          status: "recorded",
          song_day_newly_earned: true,
          community_day_newly_earned: true,
        },
      });
      const originalReplay = await study.replaySpokenCommand(final.command);
      expect(originalReplay).toEqual(final.result);
      const authority = await karaoke.reserve(accountId, personaId, "projection-karaoke");
      const attempt = await karaoke.finish(authority, "projection-karaoke-qualification");
      const karaokeInput = {
        ...identity,
        activity: "karaoke" as const,
        sessionId: authority.sessionId,
        attemptId: authority.attemptId,
      };
      const karaokeRead = await run(reads.getCompletion(karaokeInput));
      expect(karaokeRead.decision).toMatchObject({
        status: "qualified",
        earned_day: {
          status: "recorded",
          signal_id: "projection-karaoke-qualification",
          song_day_newly_earned: false,
          community_day_newly_earned: false,
        },
      });
      expect(await karaoke.finish(authority, "ignored-replay-qualification")).toEqual(attempt);
      expect(await run(reads.getCompletion(karaokeInput))).toEqual(karaokeRead);
      expect(await run(reads.getCompletion(studyInput))).toEqual(completed);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM activity_completion_decisions"))
          .rows,
      ).toEqual([{ count: 2 }]);
      const progress = await run(reads.getProgress(progressInput));
      expect(progress.activity_counts).toEqual([
        { activity: "study", qualification_count: 1 },
        { activity: "karaoke", qualification_count: 1 },
      ]);
      expect(progress.streak.total_days).toBe(1);
      expect(progress.week.days.filter((mark) => mark.earned)).toEqual([
        { day: times.study.acceptedAt.slice(0, 10), earned: true },
      ]);
      expect((await run(reads.getProgress({ ...identity, postId: null }))).streak.total_days).toBe(
        1,
      );
      const expired = await run(
        reads.getProgress({
          ...progressInput,
          readAt: new Date(Date.parse(readAt) + 10 * 86_400_000).toISOString(),
        }),
      );
      expect(expired).toMatchObject({
        streak: { current: 0, best: 1, total_days: 1 },
        standing: null,
      });

      // A future session whose first-pass answers all miss has an explicit
      // persisted refusal to qualify, even if every card is eventually resolved.
      const missed = await study.startSession(accountId, personaId, "projection-miss");
      for (const attemptNumber of [1, 2])
        for (const item of missed.items) {
          await study.answerSpoken({
            accountId,
            sessionId: missed.session_id,
            sessionItemId: item.session_item_id,
            attemptNumber,
            correct: attemptNumber === 2,
            commandId: `projection-miss-${item.ordinal}-${attemptNumber}`,
          });
        }
      expect(
        (await run(reads.getCompletion({ ...studyInput, sessionId: missed.session_id }))).decision,
      ).toMatchObject({ status: "not_qualified", reason: "producer_not_qualified" });
      expect((await run(reads.getProgress(progressInput))).activity_counts).toEqual(
        progress.activity_counts,
      );
      // Reproduce a pre-observer completion using the genuine producer, without
      // changing any accepted decision, grade, qualification or day ledger.
      await admin.query(
        "ALTER TABLE study_sessions_v2 DISABLE TRIGGER study_v2_completion_decision",
      );
      const historical = await study.startSession(accountId, personaId, "projection-historical");
      try {
        for (const attemptNumber of [1, 2])
          for (const item of historical.items) {
            await study.answerSpoken({
              accountId,
              sessionId: historical.session_id,
              sessionItemId: item.session_item_id,
              attemptNumber,
              correct: attemptNumber === 2,
              commandId: `projection-historical-${item.ordinal}-${attemptNumber}`,
            });
          }
      } finally {
        await admin.query(
          "ALTER TABLE study_sessions_v2 ENABLE TRIGGER study_v2_completion_decision",
        );
      }
      const historicalInput = { ...studyInput, sessionId: historical.session_id };
      expect((await run(reads.getCompletion(historicalInput))).decision).toEqual({
        status: "unknown",
        reason: "historical_decision_unavailable",
      });
      for (const wrong of [
        { ...studyInput, accountId: AUTHOR_ID },
        { ...studyInput, communityId: "wrong-community" },
        { ...karaokeInput, attemptId: "wrong-attempt" },
      ])
        await expect(run(reads.getCompletion(wrong))).rejects.toMatchObject({
          reason: "not-found",
        });

      const beforeReads = (
        await admin.query(
          "SELECT jsonb_agg(to_jsonb(d) ORDER BY session_id) AS rows FROM activity_completion_decisions d",
        )
      ).rows;
      await run(reads.getCompletion(studyInput));
      await run(reads.getCompletion(historicalInput));
      await run(reads.getProgress(progressInput));
      expect(
        (
          await admin.query(
            "SELECT jsonb_agg(to_jsonb(d) ORDER BY session_id) AS rows FROM activity_completion_decisions d",
          )
        ).rows,
      ).toEqual(beforeReads);
      await expect(
        admin.query("UPDATE activity_completion_decisions SET decided_at=decided_at"),
      ).rejects.toMatchObject({ code: "P0001" });
      await expect(admin.query("DELETE FROM activity_completion_decisions")).rejects.toMatchObject({
        code: "P0001",
      });

      const changedAt = new Date().toISOString();
      await run(
        makeControlPlaneActivityQualificationRepository().setStreakTimezone({
          accountId,
          timezone: "America/New_York",
          idempotencyKey: "prospective-projection-zone",
          requestHash: "a".repeat(64),
          updatedAt: changedAt,
        }),
      );
      const nextYear = new Date(readAt).getUTCFullYear() + 1;
      const afterDst = await run(
        reads.getProgress({ ...progressInput, readAt: `${nextYear}-11-08T04:30:00.000Z` }),
      );
      expect(afterDst.today).toBe(`${nextYear}-11-07`);
      expect(afterDst.timezone).toBe("America/New_York");
      expect((await run(reads.getCompletion(studyInput))).decision).toEqual(completed.decision);
      expect((await run(reads.getCompletion(studyInput))).timezone).toBe("UTC");
      expect(await study.replaySpokenCommand(final.command)).toEqual(final.result);

      await admin.query("UPDATE personas SET status='suspended' WHERE persona_id=$1", [personaId]);
      await expect(run(reads.getCompletion(studyInput))).rejects.toMatchObject({
        reason: "not-found",
      });
      expect(await run(reads.getPresentation(identity))).toMatchObject({
        selection: { status: "unavailable" },
      });
      await admin.query("UPDATE posts SET status='deleted' WHERE community_id=$1 AND post_id=$2", [
        COMMUNITY_ID,
        POST_ID,
      ]);
      await expect(run(reads.getProgress(progressInput))).rejects.toMatchObject({
        reason: "not-found",
      });
      // Own aggregate history survives loss of access to an individual song;
      // the response names no inaccessible post, performing persona or evidence.
      expect((await run(reads.getProgress({ ...identity, postId: null }))).streak.total_days).toBe(
        1,
      );
      await admin.query("UPDATE communities SET status='hidden' WHERE community_id=$1", [
        COMMUNITY_ID,
      ]);
      await expect(run(reads.getProgress({ ...identity, postId: null }))).rejects.toMatchObject({
        reason: "not-found",
      });
      await expect(run(reads.getPresentation(identity))).rejects.toMatchObject({
        reason: "not-found",
      });
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    completedTestCount += 1;
  }, 180_000);
  test("preserves forward-migration ACLs for a real restricted login and controlled ordinary completion", async () => {
    if (connectionString === undefined) throw new Error("test URL missing");
    await proveActivityCompletionForwardAcl(connectionString);
    completedTestCount += 1;
  }, 180_000);
  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 2) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
