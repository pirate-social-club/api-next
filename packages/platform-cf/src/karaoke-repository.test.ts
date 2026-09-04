import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";

type Result = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  rowCount: number;
}>;

const sourceResult: Result = {
  rows: [
    {
      audio_revision: 1,
      lyrics_revision: 1,
      canonical_audio_sha256: "a".repeat(64),
      artifact_sha256: "b".repeat(64),
      artifact: {
        version: "media-timed-lyrics-artifact-v1",
        mode: "word",
        segments: [
          { text: "Hold", start_ms: 0, end_ms: 300 },
          { text: "on", start_ms: 350, end_ms: 600 },
        ],
      },
      current_policy_version_id: "karaoke_qualification_v2@1",
    },
  ],
  rowCount: 1,
};

const catalogResult: Result = {
  rows: [{ ordinal: 1, lyric_line_id: "line-1", canonical_text: "Hold on" }],
  rowCount: 1,
};

const input = {
  accountId: "account-1",
  attemptId: "attempt-1",
  artifactId: "artifact-1",
  clientContext: undefined,
  communityId: "community-1",
  createdAt: "2026-09-01T12:00:00.000Z",
  expiresAt: "2026-09-01T12:30:00.000Z",
  idempotencyKey: "idempotency-1",
  personaId: "persona-1",
  postId: "post-1",
  requestHash: "c".repeat(64),
  sessionId: "session-1",
  timezone: null,
} as const;

const fakeLayer = (
  respond: (label: string, values: readonly unknown[]) => Result,
  statements: Array<Readonly<{ label: string; values: readonly unknown[] }>>,
) => {
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) =>
    Effect.sync(() => {
      statements.push({ label: statement.label, values: statement.values });
      return respond(statement.label, statement.values) as never;
    });
  return Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
};

const sourceResponse = (label: string): Result => {
  if (label === "karaoke.session.source") return sourceResult;
  if (label === "karaoke.session.catalog") return catalogResult;
  if (label === "learner-audio.account-lock") return { rows: [], rowCount: 1 };
  if (label === "karaoke.session.identity") {
    return {
      rows: [
        {
          persona_id: "persona-1",
          binding_eligible: true,
          community_eligible: true,
        },
      ],
      rowCount: 1,
    };
  }
  if (label === "karaoke.session.replay") return { rows: [], rowCount: 0 };
  throw new Error(`unexpected SQL label ${label}`);
};

const authorityRow = (timezone: string): Readonly<Record<string, unknown>> => ({
  account_id: input.accountId,
  artifact_id: input.artifactId,
  attempt_id: input.attemptId,
  audio_revision: 1,
  community_id: input.communityId,
  created_at: input.createdAt,
  expires_at: input.expiresAt,
  karaoke_revision_id: "karaoke-revision-test",
  line_snapshot: [],
  lyrics_revision: 1,
  persona_id: input.personaId,
  post_id: input.postId,
  qualification_policy_version_id: "karaoke_qualification_v2@1",
  request_hash: input.requestHash,
  session_id: input.sessionId,
  timezone,
});

describe("Karaoke session timezone authority", () => {
  test("rejects a requested timezone that conflicts with the pinned account clock", async () => {
    const statements: Array<Readonly<{ label: string; values: readonly unknown[] }>> = [];
    const repository = makeControlPlaneKaraokeRepository();
    const failure = await Effect.runPromise(
      Effect.flip(
        repository.reserveSession({ ...input, timezone: "UTC" }).pipe(
          Effect.provide(
            fakeLayer((label) => {
              if (label === "karaoke.session.clock") {
                return { rows: [{ timezone: "Asia/Tbilisi" }], rowCount: 1 };
              }
              return sourceResponse(label);
            }, statements),
          ),
        ),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "KaraokeCommandRejected",
      reason: "invalid-input",
    });
    expect(statements.map(({ label }) => label)).not.toContain("karaoke.session.insert");
  });

  test("pins UTC when the account has no clock and the request omits a timezone", async () => {
    const statements: Array<Readonly<{ label: string; values: readonly unknown[] }>> = [];
    const repository = makeControlPlaneKaraokeRepository();
    const authority = await Effect.runPromise(
      repository.reserveSession(input).pipe(
        Effect.provide(
          fakeLayer((label) => {
            if (label === "karaoke.session.clock") return { rows: [], rowCount: 0 };
            if (
              label === "karaoke.session.clock-pin" ||
              label === "karaoke.session.insert" ||
              label === "karaoke.recording.reserve"
            ) {
              return { rows: [], rowCount: 1 };
            }
            if (label === "karaoke.session.inserted") {
              return { rows: [authorityRow("UTC")], rowCount: 1 };
            }
            return sourceResponse(label);
          }, statements),
        ),
      ),
    );

    expect(authority.timezone).toBe("UTC");
    expect(statements.find(({ label }) => label === "karaoke.session.clock-pin")?.values).toEqual([
      input.accountId,
      "UTC",
      input.createdAt,
    ]);
    expect(statements.find(({ label }) => label === "karaoke.session.insert")?.values[12]).toBe(
      "UTC",
    );
  });

  test("replays an immutable session before consulting a prospectively changed clock", async () => {
    const statements: Array<Readonly<{ label: string; values: readonly unknown[] }>> = [];
    const repository = makeControlPlaneKaraokeRepository();
    const authority = await Effect.runPromise(
      repository.reserveSession({ ...input, timezone: "America/New_York" }).pipe(
        Effect.provide(
          fakeLayer((label) => {
            if (label === "karaoke.session.replay") {
              return { rows: [authorityRow("America/New_York")], rowCount: 1 };
            }
            return sourceResponse(label);
          }, statements),
        ),
      ),
    );

    expect(authority.timezone).toBe("America/New_York");
    expect(statements.map(({ label }) => label)).not.toContain("karaoke.session.clock");
  });
});
