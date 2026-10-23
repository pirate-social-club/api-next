import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { diffBreaking, type OpenApiDocument } from "@pirate/contracts";
import {
  assertNoObsoleteBreakingChangeWaivers,
  type BreakingChangePolicy,
  filterAllowedBreakingChanges,
  parseBaselineDocument,
} from "./check-openapi-breaking.ts";

const baseline = "50f50bfacac8e49e7d75e0cec3c1ff97a4ac9a63";
const expected = [
  [
    "get_feedHomePublic",
    "response GET /feed/home/public: property added to closed response: items.items.post.video.dance_credit",
  ],
  [
    "get_feedHome",
    "response GET /feed/home: property added to closed response: items.items.post.video.dance_credit",
  ],
  [
    "get_postsPostId",
    "response GET /posts/{postId}: property added to closed response: video.dance_credit",
  ],
  [
    "get_publicCommunitiesCommunityRefFeed",
    "response GET /public-communities/{communityRef}/feed: property added to closed response: items.items.video.dance_credit",
  ],
  [
    "get_publicPersonasPersonaIdActivity",
    "response GET /public/personas/{personaId}/activity: property added to closed response: items.items.content.video.dance_credit",
  ],
  [
    "get_publicPostsByIdPostIdCanonicalRoute",
    "response GET /public/posts/by-id/{postId}/canonical-route: property added to closed response: content.video.dance_credit",
  ],
  [
    "get_publicPostsBySlug",
    "response GET /public/posts/by-slug: property added to closed response: content.video.dance_credit",
  ],
] as const;
const policy = (await Bun.file(
  new URL("./fixtures/openapi-dance-waivers-20261023.json", import.meta.url),
).json()) as BreakingChangePolicy;
const rawBase = execFileSync(
  "git",
  ["show", `${baseline}:apps/http-worker/src/generated/openapi.json`],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const before = parseBaselineDocument(baseline, rawBase);
const current = (await Bun.file(
  new URL("../apps/http-worker/src/generated/openapi.json", import.meta.url),
).json()) as OpenApiDocument;

test("public Dance credit declares exactly seven response additions against the preserved Funding baseline", () => {
  const entries = policy.breakingChangeWaivers.filter(
    (row) => row.operationId !== "get_meNotifications",
  );
  expect(entries.map((row) => [row.operationId, row.expectedViolations])).toEqual(
    expected.map(([id, diagnostic]) => [id, [diagnostic]]),
  );
  for (const row of entries) {
    expect(row.baselineSha).toBe(baseline);
    expect(row.kind).toBe("deprecation");
    expect(row.reason).toContain("#2026-10-23-dance-reference-credit-deprecation");
  }
  expect(
    diffBreaking(before, current)
      .filter((message) => message.includes("dance_credit"))
      .sort(),
  ).toEqual(expected.map(([, message]) => message).sort());
  expect(filterAllowedBreakingChanges(before, current, policy, baseline)).toEqual([]);
});
test("removing a declaration still reports its actual breaking field", () => {
  const first = expected[0];
  expect(
    filterAllowedBreakingChanges(
      before,
      current,
      {
        breakingChangeWaivers: policy.breakingChangeWaivers.filter(
          (row) => row.operationId !== first[0],
        ),
      },
      baseline,
    ),
  ).toEqual([first[1]]);
});
test("the declaration cannot admit a removed public Post operation", () => {
  const changed = { ...current, paths: { ...current.paths, "/posts/{postId}": {} } };
  expect(() => filterAllowedBreakingChanges(before, changed, policy, baseline)).toThrow();
});
test("the same candidate diff remains breaking on a future baseline and stale declarations must retire", () => {
  const future = "f".repeat(40);
  expect([...filterAllowedBreakingChanges(before, current, policy, future)].sort()).toEqual(
    [...diffBreaking(before, current)].sort(),
  );
  expect(() => assertNoObsoleteBreakingChangeWaivers(policy, future, () => true)).toThrow(
    "obsolete baseline",
  );
});

test("the stacked bonus changes no parent contract and retains no consumed waiver", async () => {
  const parent = "36c28b4928a953d6fcbf57e85178e85367fd1b49";
  const raw = execFileSync(
    "git",
    ["show", `${parent}:apps/http-worker/src/generated/openapi.json`],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const actualPolicy = (await Bun.file(
    new URL("../packages/contracts/breaking-change-waivers.json", import.meta.url),
  ).json()) as BreakingChangePolicy;
  expect(actualPolicy.breakingChangeWaivers).toEqual([]);
  expect(current).toEqual(parseBaselineDocument(parent, raw));
  expect(filterAllowedBreakingChanges(current, current, actualPolicy, parent)).toEqual([]);
  expect(() =>
    assertNoObsoleteBreakingChangeWaivers(actualPolicy, parent, () => true),
  ).not.toThrow();
});
