import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  SongOwnerPolicyStoreError,
  type SongOwnerPolicyStoreService,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { makeControlPlaneSongOwnerPolicyRepository } from "./song-owner-video-policy-repository.ts";

type Row = Readonly<Record<string, unknown>>;

const managementRow = (overrides: Row = {}): Row => ({
  community_id: "community-1",
  post_id: "song-1",
  audio_revision: "1",
  owner_account_id: "account-owner",
  policy_revision: "2",
  third_party_reward_legs: "allowed",
  pool_leg: "declined",
  derivative_video: "owner_only",
  policy_hash: "11".repeat(32),
  effective_at: new Date("2026-09-02T12:00:00.000Z"),
  ...overrides,
});

const publicRow = (overrides: Row = {}): Row => ({
  community_id: "community-1",
  post_id: "song-1",
  policy_revision: "2",
  derivative_video: "owner_only",
  can_post_with_song: false,
  ...overrides,
});

const fakeDb = (
  responses: readonly (readonly Row[])[],
  calls: ControlPlaneStatement[],
): ControlPlaneDb["Service"] => {
  let responseIndex = 0;
  const execute = <R = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<R>, never> => {
    calls.push(statement);
    const rows = responses[responseIndex++] ?? [];
    return Effect.succeed({ rows: rows as readonly R[], rowCount: rows.length });
  };
  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  };
};

const runWith = <A, E>(
  effect: Effect.Effect<A, E, ControlPlaneDb>,
  db: ControlPlaneDb["Service"],
) => Effect.runPromiseExit(Effect.provideService(effect, ControlPlaneDb, db));

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

const managementInput: Parameters<SongOwnerPolicyStoreService["getManagement"]>[0] = {
  communityId: "community-1",
  postId: "song-1",
  accountId: "account-owner",
  personaId: "persona-owner",
};

describe("song owner policy Postgres repository", () => {
  test("projects private management rows and keeps owner identity out of public rows", async () => {
    const calls: ControlPlaneStatement[] = [];
    const repository = makeControlPlaneSongOwnerPolicyRepository();
    const privateExit = await runWith(
      repository.getManagement(managementInput),
      fakeDb([[managementRow()]], calls),
    );
    expect(Exit.isSuccess(privateExit)).toBe(true);
    if (Exit.isSuccess(privateExit)) {
      expect(privateExit.value).toMatchObject({
        owner_account_id: "account-owner",
        policy_revision: 2,
      });
    }

    const publicExit = await runWith(
      repository.getPublic({
        communityId: "community-1",
        postId: "song-1",
        accountId: null,
        personaId: null,
      }),
      fakeDb([[publicRow()]], calls),
    );
    expect(Exit.isSuccess(publicExit)).toBe(true);
    if (Exit.isSuccess(publicExit)) {
      expect(publicExit.value).toEqual({
        object: "song_owner_policy",
        community_id: "community-1",
        post_id: "song-1",
        policy_revision: 2,
        derivative_video: "owner_only",
        can_post_with_song: false,
        video_ready: true,
      });
      expect(publicExit.value).not.toHaveProperty("owner_account_id");
      expect(publicExit.value).not.toHaveProperty("third_party_reward_legs");
      expect(publicExit.value).not.toHaveProperty("pool_leg");
      expect(publicExit.value).not.toHaveProperty("audio_revision");
    }
    expect(calls.map((call) => call.label)).toEqual([
      "song-owner-policy.management.read",
      "song-owner-policy.public.read",
    ]);
    expect(calls[1]?.text).toContain("post.visibility = 'public'");
  });

  test("public video readiness follows the current revision's verified PCM object", async () => {
    const checked: unknown[] = [];
    const repository = makeControlPlaneSongOwnerPolicyRepository({
      getReady: async (song, duration) => {
        checked.push({ song, duration });
        return null;
      },
    });
    const input = {
      communityId: "community-1",
      postId: "song-1",
      accountId: "account-owner",
      personaId: "persona-owner",
    };
    const readyTiming = publicRow({
      audio_revision: "3",
      timing_audio_sha256: "a".repeat(64),
      timing_duration_samples: "720000",
    });
    const pending = await runWith(repository.getPublic(input), fakeDb([[publicRow()]], []));
    expect(Exit.isSuccess(pending) && pending.value.video_ready).toBe(false);
    expect(checked).toEqual([]);
    const absent = await runWith(repository.getPublic(input), fakeDb([[readyTiming]], []));
    expect(Exit.isSuccess(absent) && absent.value.video_ready).toBe(false);
    expect(checked).toEqual([
      {
        song: {
          songPostId: "song-1",
          audioRevision: 3,
          canonicalAudioSha256: "a".repeat(64),
        },
        duration: 720000,
      },
    ]);
    const verified = makeControlPlaneSongOwnerPolicyRepository({
      getReady: async () => ({
        songPostId: "song-1",
        audioRevision: 3,
        canonicalAudioSha256: "a".repeat(64),
        durationSamples: 720000,
        objectKey: "song-video-pcm/song-1-r3.pcm",
        objectVersion: "v3",
        objectEtag: "etag-3",
        pcmSha256: "b".repeat(64),
        byteLength: 2880000,
        decoderRecipe: "pinned-ffmpeg-6.1.1",
      }),
    });
    const available = await runWith(verified.getPublic(input), fakeDb([[readyTiming]], []));
    expect(Exit.isSuccess(available) && available.value.video_ready).toBe(true);
  });

  test("maps the database CAS exception to a typed policy conflict", async () => {
    const calls: ControlPlaneStatement[] = [];
    let callIndex = 0;
    const execute = <R = unknown>(
      statement: ControlPlaneStatement,
    ): Effect.Effect<ControlPlaneResult<R>, ControlPlaneStatementFailed> => {
      calls.push(statement);
      callIndex += 1;
      if (callIndex < 3) {
        return Effect.succeed({ rows: [{} as R], rowCount: 1 });
      }
      return Effect.fail(
        new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: "P0001",
          constraint: null,
          outcomeCertainty: "completed",
        }),
      );
    };
    const db = {
      execute,
      withTransaction: <A, E, R>(
        use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
      ) => use({ execute }),
    } satisfies ControlPlaneDb["Service"];
    const exit = await runWith(
      makeControlPlaneSongOwnerPolicyRepository().update({
        communityId: "community-1",
        postId: "song-1",
        accountId: "account-owner",
        update: {
          persona_id: "persona-owner",
          expected_policy_revision: 2,
          third_party_reward_legs: "allowed",
          pool_leg: "declined",
          derivative_video: "blocked",
        },
      }),
      db,
    );
    const failure = failureOf(exit);
    expect(failure).toBeInstanceOf(SongOwnerPolicyStoreError);
    expect(failure).toMatchObject({ operation: "update", reason: "conflict" });
    expect(calls.map((call) => call.label)).toEqual([
      "song-owner-policy.persona.authority",
      "song-owner-policy.owner.authority",
      "song-owner-policy.revision.append",
    ]);
  });
});
