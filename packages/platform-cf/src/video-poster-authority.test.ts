import { expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeVideoPosterAuthority } from "./video-poster-authority.ts";

const key = "video-analysis/op-1/v2/a3/poster.jpg";
const input = {
  postId: "post-1",
  communityId: "community-1",
  artifactRef: `media://derived/${key}`,
};
const row = {
  operation_id: "op-1",
  video_revision: "2",
  analysis_revision: "3",
  artifact_ref: input.artifactRef,
  canonical_sha256: "a".repeat(64),
  source_sha256: "b".repeat(64),
  poster_policy_revision: "1",
};
function fixture(rows: readonly Record<string, unknown>[]) {
  const calls: ControlPlaneStatement[] = [];
  const execute = <R = unknown>(statement: ControlPlaneStatement) => {
    calls.push(statement);
    return Effect.succeed({ rows: rows as readonly R[], rowCount: rows.length });
  };
  const resolve = makeVideoPosterAuthority(
    Layer.succeed(ControlPlaneDb, {
      execute,
      withTransaction: <A, E, R>(
        use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
      ) => use({ execute }),
    }),
  );
  return { calls, resolve };
}

test("poster key is derived from durable operation and revision facts, not the supplied locator", async () => {
  const f = fixture([row]);
  expect(await Effect.runPromise(f.resolve(input))).toEqual({
    artifactRef: input.artifactRef,
    key,
    sha256: row.canonical_sha256,
    sourceSha256: row.source_sha256,
    policyRevision: "1",
  });
  expect(f.calls[0]?.values).toEqual([input.postId, input.communityId, input.artifactRef]);
  expect(f.calls[0]?.readonly).toBe(true);
  await expect(
    Effect.runPromise(f.resolve({ ...input, artifactRef: "media://derived/private/secret" })),
  ).rejects.toThrow("Invalid poster authority");
});

test("absent sealed authority is explicit", async () => {
  expect(await Effect.runPromise(fixture([]).resolve(input))).toBeNull();
});

test.each([
  { operation_id: "../other" },
  { video_revision: "02" },
  { analysis_revision: "0" },
  { canonical_sha256: "invalid" },
  { source_sha256: "invalid" },
  { poster_policy_revision: "2" },
  { artifact_ref: "media://derived/wrong/poster.jpg" },
])("rejects invalid or mismatched durable identity %j", async (change) => {
  await expect(
    Effect.runPromise(fixture([{ ...row, ...change }]).resolve(input)),
  ).rejects.toThrow();
});

test("duplicate authority rows are not silently selected", async () => {
  await expect(Effect.runPromise(fixture([row, row]).resolve(input))).rejects.toThrow(
    "Ambiguous poster authority",
  );
});
