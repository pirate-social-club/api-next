import { expect, test } from "bun:test";
import { inspectStreamReconciliation } from "./video-stream-reconciliation-inspect.ts";

const operation = "media-operation-739e13de-b703-4626-a1d7-fced7e2fb81f";
const creator = "b440637519c7975be67bb7c59de8ed8053a8ec83b0edec2d263b4952790d44a4";
const authority = {
  operationId: operation,
  submissionId: "submission-fixture",
  postId: "post-fixture",
  effectIdentity: `video-enrichment:${operation}:stream`,
  creator,
  sourceSha256: "a".repeat(64),
  ingestRevision: 2,
  claimFence: 4,
  state: "reconciliation_required",
  reason: "acceptance_unknown",
  enrichmentState: "failed",
  authoritySha256: "b".repeat(64),
};
const listing = (videos: unknown[], total = videos.length, range = videos.length) => ({
  success: true,
  result: { videos, total, range },
});
const candidate = {
  uid: "c".repeat(32),
  creator,
  meta: { operation_id: operation, source_sha256: authority.sourceSha256, name: "private-label" },
  playback: { hls: "https://private.invalid/capability" },
};
async function inspect(creatorList: unknown, all: unknown, change: object = {}) {
  let reads = 0;
  const paths: string[] = [];
  const result = await inspectStreamReconciliation({
    readAuthority: async () => (reads++ === 0 ? authority : { ...authority, ...change }),
    get: async (path) => {
      paths.push(path);
      return path.includes("creator=") ? creatorList : all;
    },
  });
  return { result, paths, reads };
}
test("two complete searches establish current absence and preserve unknown historical acceptance", async () => {
  const other = { uid: "d".repeat(32), creator: "other-creator", meta: {} };
  const { result, paths, reads } = await inspect(listing([]), listing([other]));
  expect(result).toMatchObject({
    outcome: "no_matching_current_asset",
    complete_current_coverage: true,
    mutation: false,
    copy_allowed: false,
    historical_noncreation_proved: false,
    terminal_failure_authorized: false,
  });
  expect(paths).toHaveLength(2);
  expect(reads).toBe(2);
  expect(JSON.stringify(result)).not.toContain("other-creator");
});
test("a candidate is retained for review with only safe exact identity comparisons", async () => {
  const { result } = await inspect(listing([candidate]), listing([candidate]));
  expect(result.outcome).toBe("matching_current_assets_require_review");
  expect(result.relevant_matches).toEqual([
    { uid: candidate.uid, creator_matches: true, operation_matches: true, source_matches: true },
  ]);
  expect(JSON.stringify(result)).not.toContain("private-label");
  expect(JSON.stringify(result)).not.toContain("private.invalid");
});
test("matching operation with a different creator is unresolved identity evidence", async () => {
  const { result } = await inspect(listing([]), listing([{ ...candidate, creator: "different" }]));
  expect(result.relevant_matches[0]?.creator_matches).toBe(false);
  expect(result.terminal_failure_authorized).toBe(false);
});
test("multiple matches are retained rather than selecting one", async () => {
  const second = { ...candidate, uid: "e".repeat(32) };
  const { result } = await inspect(listing([candidate, second]), listing([candidate, second]));
  expect(result.relevant_matches).toHaveLength(2);
  expect(result.copy_allowed).toBe(false);
});
test("incomplete empty account listing refuses absence", async () => {
  await expect(inspect(listing([]), listing([], 1, 1))).rejects.toThrow("coverage refused");
});
test("a full 1000-row page refuses rather than treating truncation as completion", async () => {
  const rows = Array.from({ length: 1000 }, () => ({ uid: "d".repeat(32), meta: {} }));
  await expect(inspect(listing([]), listing(rows))).rejects.toThrow("coverage refused");
});
test("creator and account observations must agree", async () => {
  await expect(inspect(listing([]), listing([candidate]))).rejects.toThrow("searches disagree");
});
test("duplicate provider identities cannot stand in for complete coverage", async () => {
  const other = { uid: "d".repeat(32), meta: {} };
  await expect(inspect(listing([]), listing([other, other]))).rejects.toThrow("coverage refused");
});
test("failed provider authorization is unavailable, never an empty match", async () => {
  await expect(inspect({ success: false, result: [] }, listing([]))).rejects.toThrow();
});
test("claim or source-authority changes during provider I/O refuse a verdict", async () => {
  await expect(inspect(listing([]), listing([]), { claimFence: 5 })).rejects.toThrow(
    "stale authority",
  );
  await expect(
    inspect(listing([]), listing([]), { authoritySha256: "c".repeat(64) }),
  ).rejects.toThrow("stale authority");
});
test("a creator marker not derived from the exact operation is refused before provider I/O", async () => {
  let calls = 0;
  await expect(
    inspectStreamReconciliation({
      readAuthority: async () => ({ ...authority, creator: "f".repeat(64) }),
      get: async () => {
        calls++;
        return listing([]);
      },
    }),
  ).rejects.toThrow("identity refused");
  expect(calls).toBe(0);
});
