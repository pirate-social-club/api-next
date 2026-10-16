import { expect } from "bun:test";
import type { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import type { Client } from "pg";
import { makeControlPlaneActivityCompletionRepository } from "./activity-completion-repository.ts";
import {
  COMMUNITY_ID,
  makeComposedActivityTimes,
  POST_ID,
} from "./activity-participation-composed.pg-fixture.ts";
import {
  makeKaraokeDriver,
  type Runtime,
} from "./activity-participation-composed-drivers.pg-fixture.ts";
import { makeControlPlaneActivityQualificationRepository } from "./activity-qualification-repository.ts";
import { prepareSinger } from "./karaoke-instrumental-policy.pg-fixture.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";

/** Shared first-case schema; every streak day below comes from a real producer. */
export async function proveActivityStreakRankingPopulation(input: {
  admin: Client;
  runtime: Runtime;
  accountId: string;
  personaId: string;
  readAt: string;
}): Promise<void> {
  const { admin, runtime, readAt } = input;
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
  const publicReads = makeControlPlaneActivityQualificationRepository();
  const privateReads = makeControlPlaneActivityCompletionRepository();
  const actor = async (suffix: string, days: number) => {
    const accountId = `rank-population-${suffix}`;
    const personaId = await prepareSinger(admin, runtime, accountId);
    await run(
      publicReads.setPresentationPersona({
        accountId,
        personaId,
        communityId: COMMUNITY_ID,
        idempotencyKey: `rank-present-${suffix}`,
        requestHash: "b".repeat(64),
        updatedAt: new Date().toISOString(),
      }),
    );
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const times = makeComposedActivityTimes(Date.parse(readAt) - offset * 86_400_000 - 4000);
      const driver = makeKaraokeDriver(runtime, makeControlPlaneKaraokeRepository(), times.karaoke);
      const authority = await driver.reserve(accountId, personaId, `rank-${suffix}-${offset}`);
      await driver.finish(authority, `rank-qualification-${suffix}-${offset}`);
    }
    return { accountId, personaId };
  };
  const first = await actor("tie-first", 2);
  const second = await actor("tie-second", 2);
  const suspended = await actor("suspended-leader", 3);
  const inactive = await actor("inactive-account-leader", 3);
  await admin.query("UPDATE personas SET status='suspended' WHERE persona_id=$1", [
    suspended.personaId,
  ]);
  await admin.query("UPDATE users SET status='deleted' WHERE user_id=$1", [inactive.accountId]);
  const facts = async () => {
    const snapshot: Record<string, unknown> = {};
    for (const table of [
      "activity_qualifications",
      "activity_completion_decisions",
      "song_streaks",
      "community_streaks",
      "song_streak_days",
      "song_streak_day_activities",
      "community_streak_days",
      "persona_activity_presentations",
    ])
      snapshot[table] = (
        await admin.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`,
        )
      ).rows;
    return snapshot;
  };
  const before = await facts();
  for (const postId of [POST_ID, null]) {
    const leaderboard = (accountId: string | null, limit = 1, observedAt = readAt) => {
      const common = { accountId, communityId: COMMUNITY_ID, readAt: observedAt, limit };
      return run(
        postId === null
          ? publicReads.getCommunityLeaderboard(common)
          : publicReads.getSongLeaderboard({ ...common, postId }),
      );
    };
    const privateProgress = (accountId: string, observedAt = readAt) =>
      run(
        privateReads.getProgress({
          accountId,
          communityId: COMMUNITY_ID,
          postId,
          readAt: observedAt,
        }),
      );
    const board = await leaderboard(input.accountId);
    // Competition ties share rank1 and consume two places; viewer remains3
    // outside limit1. Removed leaders must consume no rank in either read.
    expect(board.entries.map(({ rank }) => rank)).toEqual([1, 1]);
    expect(board.entries.map(({ persona }) => persona.persona_id).sort()).toEqual(
      [first.personaId, second.personaId].sort(),
    );
    expect(board.viewer_standing).toMatchObject({
      rank: 3,
      current: 1,
      best: 1,
      is_viewer: true,
      persona: { persona_id: input.personaId },
    });
    for (const [participant, expectedRank] of [
      [first, 1],
      [second, 1],
      [input, 3],
    ] as const) {
      const privateRead = await privateProgress(participant.accountId);
      const publicRead = await leaderboard(participant.accountId);
      expect(privateRead.observed_at).toBe(readAt);
      expect(privateRead.standing).toEqual({
        rank: expectedRank,
        persona_id: participant.personaId,
      });
      expect(publicRead.viewer_standing?.rank).toBe(privateRead.standing?.rank);
    }
    const anonymous = await leaderboard(null);
    expect(anonymous.entries.map(({ persona }) => persona.persona_id)).toEqual(
      board.entries.map(({ persona }) => persona.persona_id),
    );
    expect(anonymous.viewer_standing).toBeNull();
    expect((await leaderboard(suspended.accountId, 10)).viewer_standing).toBeNull();
    expect((await privateProgress(suspended.accountId)).standing).toBeNull();
    expect((await leaderboard(inactive.accountId, 10)).viewer_standing).toBeNull();
    await expect(privateProgress(inactive.accountId)).rejects.toMatchObject({
      reason: "not-found",
    });
    for (const account of [input, first, second, suspended, inactive])
      expect(JSON.stringify(board)).not.toContain(account.accountId);
    const expiresAt = (
      await admin.query(
        "SELECT active_until_at FROM song_streaks WHERE account_id=$1 AND community_id=$2 AND post_id=$3",
        [first.accountId, COMMUNITY_ID, POST_ID],
      )
    ).rows[0]?.active_until_at;
    if (!(expiresAt instanceof Date)) throw new Error("real producer streak expiration missing");
    const expiration = expiresAt.toISOString();
    // The existing viewer changed its timezone prospectively; its own ledger
    // may expire later. Assert each actor's actual boundary without inventing
    // a shared expiration from another account's timezone.
    const expiredBoard = await leaderboard(input.accountId, 10, expiration);
    expect(
      expiredBoard.entries.some(
        ({ persona }) =>
          persona.persona_id === first.personaId || persona.persona_id === second.personaId,
      ),
    ).toBe(false);
    expect((await privateProgress(first.accountId, expiration)).standing).toBeNull();
    expect((await leaderboard(first.accountId, 10, expiration)).viewer_standing).toBeNull();
    expect(expiredBoard.viewer_standing?.rank ?? null).toBe(
      (await privateProgress(input.accountId, expiration)).standing?.rank ?? null,
    );
  }
  expect(await facts()).toEqual(before);
  // Accepted bindings cannot be removed. Exercise an actually unbound scope
  // through its admission API, rather than inventing an impossible streak row.
  const otherCommunity = "rank-unbound-community";
  await admin.query(
    "INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES($1,'Ranking binding control','active',$2,clock_timestamp(),clock_timestamp())",
    [otherCommunity, input.accountId],
  );
  await expect(
    run(
      publicReads.setPresentationPersona({
        accountId: input.accountId,
        personaId: input.personaId,
        communityId: otherCommunity,
        idempotencyKey: "rank-unbound-selection",
        requestHash: "c".repeat(64),
        updatedAt: new Date().toISOString(),
      }),
    ),
  ).rejects.toMatchObject({ reason: "persona-ineligible" });
  expect(
    (
      await run(
        privateReads.getProgress({
          accountId: input.accountId,
          communityId: otherCommunity,
          postId: null,
          readAt,
        }),
      )
    ).standing,
  ).toBeNull();
  expect(
    (
      await run(
        publicReads.getCommunityLeaderboard({
          accountId: input.accountId,
          communityId: otherCommunity,
          readAt,
          limit: 1,
        }),
      )
    ).entries,
  ).toEqual([]);
}
