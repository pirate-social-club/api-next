import { describe, expect, test } from "bun:test";
import type {
  MediaProcessingAuthority,
  MediaProcessingCommit,
} from "../../../packages/application/src/media/processing-contracts.ts";
import { sweepMissingMediaWorkflows } from "./media-workflow-sweep.ts";

const candidate = (
  overrides: Partial<MediaProcessingAuthority> = {},
): MediaProcessingAuthority => ({
  communityId: "community-1",
  actorAccountId: "account-1",
  authorPersonaId: "persona-1",
  submissionId: "submission-1",
  operationId: "operation-1",
  songType: "original",
  creationRevision: 3,
  audioRevision: 1,
  analysisRevision: 1,
  decisionRevision: 0,
  workflowRevision: 1,
  status: "processing",
  phase: "analysis",
  audio: {
    immutableRef: "audio/ref",
    canonicalSha256: "a".repeat(64),
    contentType: "audio/mpeg",
    sizeBytes: 42,
  },
  termsRevision: 3,
  lyrics: null,
  analysis: null,
  decision: null,
  boundReferenceAssetId: null,
  postId: null,
  publishedLyricsRevision: null,
  ...overrides,
});

describe("media Workflow missing-instance sweep", () => {
  test("advances authority once and leaves Queue delivery to launch replacement", async () => {
    let current = candidate();
    let replacementWrites = 0;
    const observed: number[] = [];
    const dependencies = {
      store: {
        listWorkflowCandidates: async () => [current],
        loadAuthority: async () => current,
        replaceMissingWorkflow: async (
          expected: MediaProcessingAuthority,
        ): Promise<MediaProcessingCommit> => {
          if (expected.workflowRevision !== current.workflowRevision) return "stale";
          replacementWrites += 1;
          current = { ...current, workflowRevision: current.workflowRevision + 1 };
          return "committed";
        },
      },
      workflow: { get: async () => "missing" as const },
      observe: (event: { workflowRevision?: number }) => {
        if (event.workflowRevision !== undefined) observed.push(event.workflowRevision);
      },
    };

    expect(await sweepMissingMediaWorkflows(dependencies)).toEqual({
      inspected: 1,
      present: 0,
      replaced: 1,
      stale: 0,
    });
    expect(replacementWrites).toBe(1);
    expect(observed).toEqual([2]);
  });

  test("does not write for present, terminal, or stale candidates", async () => {
    const active = candidate();
    const terminal = candidate({ operationId: "operation-2", status: "published", phase: null });
    let replacementWrites = 0;
    const result = await sweepMissingMediaWorkflows({
      store: {
        listWorkflowCandidates: async () => [active, terminal],
        loadAuthority: async () => ({ ...active, workflowRevision: 2 }),
        replaceMissingWorkflow: async () => {
          replacementWrites += 1;
          return "committed";
        },
      },
      workflow: { get: async () => "missing" },
    });
    expect(result).toEqual({ inspected: 1, present: 0, replaced: 0, stale: 1 });
    expect(replacementWrites).toBe(0);

    const present = await sweepMissingMediaWorkflows({
      store: {
        listWorkflowCandidates: async () => [active],
        loadAuthority: async () => active,
        replaceMissingWorkflow: async () => {
          replacementWrites += 1;
          return "committed";
        },
      },
      workflow: { get: async () => "present" },
    });
    expect(present).toEqual({ inspected: 1, present: 1, replaced: 0, stale: 0 });
    expect(replacementWrites).toBe(0);
  });

  test("treats a concurrent replacement CAS replay as stale", async () => {
    const active = candidate();
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          listWorkflowCandidates: async () => [active],
          loadAuthority: async () => active,
          replaceMissingWorkflow: async () => "replay",
        },
        workflow: { get: async () => "missing" },
      }),
    ).toEqual({ inspected: 1, present: 0, replaced: 0, stale: 1 });
  });
});
