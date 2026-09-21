import { expect, test } from "bun:test";
import {
  parseMediaAlignmentRecoveryRequest,
  runMediaAlignmentOperatorRecovery,
} from "./media-alignment-operator-recovery.ts";

const request = {
  communityId: "community",
  submissionId: "submission",
  actorUserId: "song-owner",
  personaId: "song-persona",
  idempotencyKey: "alignment-recovery-1",
  evidenceRef: "review/alignment-recovery-1",
  expectedWorkflowRevision: 2,
  expected: {
    postId: "post",
    audioRevision: 1,
    analysisRevision: 1,
    lyricsRevision: 1,
    canonicalAudioSha256: "a".repeat(64),
    lyricsSha256: "b".repeat(64),
  },
};

test("alignment request is closed and excludes operator identity", () => {
  expect(parseMediaAlignmentRecoveryRequest(request)).toEqual(request);
  expect(() =>
    parseMediaAlignmentRecoveryRequest({ ...request, operatorPrincipalId: "admin" }),
  ).toThrow();
  expect(() =>
    parseMediaAlignmentRecoveryRequest({
      ...request,
      expected: { ...request.expected, operationId: "injected" },
    }),
  ).toThrow();
});

test("alignment request validates exact lineage", () => {
  for (const expectedWorkflowRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      parseMediaAlignmentRecoveryRequest({ ...request, expectedWorkflowRevision }),
    ).toThrow();
  }
  expect(() =>
    parseMediaAlignmentRecoveryRequest({
      ...request,
      expected: { ...request.expected, lyricsRevision: 1.5 },
    }),
  ).toThrow();
  expect(() =>
    parseMediaAlignmentRecoveryRequest({
      ...request,
      expected: { ...request.expected, canonicalAudioSha256: "A".repeat(64) },
    }),
  ).toThrow();
  for (const evidenceRef of [" review ", "review\0note", "\0", "\0review", "review\0", ""]) {
    expect(() => parseMediaAlignmentRecoveryRequest({ ...request, evidenceRef })).toThrow();
  }
});

test("alignment command rejects invalid flags before database access", async () => {
  for (const args of [
    ["--execute"],
    ["--request", "unused", "--execute", "--execute"],
    ["--request", "unused", "--force"],
  ]) {
    await expect(runMediaAlignmentOperatorRecovery(args)).rejects.toThrow("usage");
  }
});
