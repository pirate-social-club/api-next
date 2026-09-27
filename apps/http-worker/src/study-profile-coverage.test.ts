import { describe, expect, test } from "bun:test";
import {
  makeStudyProfileCoverageRunner,
  studyProfileCoverageDue,
} from "./study-profile-coverage.ts";

const missing = {
  communityId: "community-test",
  postId: "post-test",
  lyricsRevision: 2,
  sourceHash: "a".repeat(64),
};

describe("committed spoken profile coverage", () => {
  test("runs on the scheduled quarter-hour boundary, including a delayed tick", () => {
    expect(studyProfileCoverageDue(Date.parse("2026-09-27T12:14:00Z"))).toBe(false);
    expect(studyProfileCoverageDue(Date.parse("2026-09-27T12:15:00Z"))).toBe(true);
    expect(studyProfileCoverageDue(Date.parse("2026-09-27T12:15:59Z"))).toBe(true);
    expect(studyProfileCoverageDue(Date.parse("2026-09-27T12:16:00Z"))).toBe(false);
    expect(studyProfileCoverageDue(Date.parse("2026-09-27T12:30:00Z"))).toBe(true);
  });

  test("requests the existing producer and checks the accepted source", async () => {
    const requested: string[] = [];
    const run = makeStudyProfileCoverageRunner({
      nextMissing: async () => missing,
      generateProfile: async (input) => {
        requested.push(input.postId);
        return { lyricsRevision: missing.lyricsRevision, sourceHash: missing.sourceHash };
      },
      reportFailure: () => expect.unreachable(),
    });
    expect(await run()).toBe(true);
    expect(requested).toEqual([missing.postId]);
  });

  test("reports stale authority without blocking other work", async () => {
    const failures: string[] = [];
    const run = makeStudyProfileCoverageRunner({
      nextMissing: async () => missing,
      generateProfile: async () => ({ lyricsRevision: 3, sourceHash: missing.sourceHash }),
      reportFailure: ({ reason }) => failures.push(reason),
    });
    expect(await run()).toBe(false);
    expect(failures).toEqual(["Error"]);
  });
});
