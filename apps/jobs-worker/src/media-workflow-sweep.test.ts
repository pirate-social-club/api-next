import { describe, expect, test } from "bun:test";
import type {
  MediaProcessingAuthority,
  MediaProcessingCommit,
  MediaProcessingOutboxRecord,
  MediaProcessingStore,
  MediaProcessingWorkflowPayload,
} from "../../../packages/application/src/media/processing-contracts.ts";
import { consumeMediaProcessingQueueMessage } from "../../../packages/application/src/media/processing-queue.ts";
import { dispatchEligibleMediaOutbox } from "./media-outbox-dispatch.ts";
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
  title: "Song title",
  authorDeclaredRating: "general",
  creationRevision: 3,
  audioRevision: 1,
  analysisRevision: 1,
  decisionRevision: 0,
  workflowRevision: 1,
  retryCount: 0,
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
  replacementSequence: 0,
  publishedLyricsRevision: null,
  ...overrides,
});

describe("media Workflow missing-instance sweep", () => {
  test.each(["action_required", "manual_review"] as const)(
    "restores the event target for a finished %s wait",
    async (status) => {
      const current = candidate({ status, phase: null });
      let replacements = 0;
      const result = await sweepMissingMediaWorkflows({
        store: {
          listWorkflowCandidates: async () => [current],
          loadAuthority: async () => current,
          reconcileTerminalWorkflow: async () => {
            throw new Error("must preserve durable wait");
          },
          replaceMissingWorkflow: async (expected) => {
            expect(expected).toEqual(current);
            replacements += 1;
            return "committed";
          },
        },
        workflow: { get: async () => "finished" },
      });
      expect(result).toMatchObject({ finished: 1, replaced: 1, recoveryFailed: 0 });
      expect(replacements).toBe(1);
    },
  );

  test.each(["action_required", "manual_review"] as const)(
    "preserves a finished %s wait at the replacement ceiling",
    async (status) => {
      const current = candidate({ status, phase: null, replacementSequence: 3 });
      const result = await sweepMissingMediaWorkflows({
        store: {
          listWorkflowCandidates: async () => [current],
          loadAuthority: async () => current,
          reconcileTerminalWorkflow: async () => {
            throw new Error("must preserve durable wait");
          },
          replaceMissingWorkflow: async () => {
            throw new Error("must preserve replacement ceiling");
          },
        },
        workflow: { get: async () => "finished" },
      });
      expect(result).toMatchObject({
        finished: 1,
        replaced: 0,
        limitReached: 1,
        recoveryFailed: 0,
      });
    },
  );

  test("observes failed wait recovery without leaking the cause and continues the sweep", async () => {
    const first = candidate({ status: "action_required", phase: null });
    const second = candidate({
      operationId: "operation-2",
      submissionId: "submission-2",
      status: "manual_review",
      phase: null,
    });
    const observations: unknown[] = [];
    const result = await sweepMissingMediaWorkflows({
      store: {
        listWorkflowCandidates: async () => [first, second],
        loadAuthority: async (id) => (id === first.submissionId ? first : second),
        reconcileTerminalWorkflow: async () => {
          throw new Error("must preserve wait");
        },
        replaceMissingWorkflow: async (authority) => {
          if (authority === first) throw new Error("private-provider-response");
          return "committed";
        },
      },
      workflow: { get: async () => "finished" },
      observe: (observation) => observations.push(observation),
    });
    expect(result).toMatchObject({ recoveryFailed: 1, replaced: 1 });
    expect(observations[0]).toEqual({
      event: "workflow_terminal_recovery_failed",
      operationId: first.operationId,
      submissionId: first.submissionId,
      workflowRevision: 1,
    });
    expect(JSON.stringify(observations)).not.toContain("private-provider-response");
  });

  test("dispatches a committed replacement through the consumer into its new Workflow", async () => {
    let current = candidate();
    let replacement: MediaProcessingOutboxRecord | null = null;
    const launches: Readonly<{
      instanceId: string;
      payload: MediaProcessingWorkflowPayload;
    }>[] = [];
    const store = {
      reconcileTerminalWorkflow: async () => "escalated" as const,
      listWorkflowCandidates: async () => [current],
      loadAuthority: async () => current,
      replaceMissingWorkflow: async (expected: MediaProcessingAuthority) => {
        if (expected.workflowRevision !== current.workflowRevision) return "stale" as const;
        current = {
          ...current,
          workflowRevision: current.workflowRevision + 1,
          replacementSequence: current.replacementSequence + 1,
        };
        replacement = {
          outboxId: "replacement-outbox-1",
          eventType: "workflow_replacement",
          submissionId: current.submissionId,
          operationId: current.operationId,
          workflowRevision: current.workflowRevision,
          workflowInstanceId: `media-${current.operationId}-r${current.workflowRevision}`,
          deliveryAttempts: 0,
          state: "pending",
          claimFence: 0,
          claimOwner: null,
        };
        return "committed" as const;
      },
      getOutbox: async () => replacement,
      claimOutbox: async (_outboxId: string, workerId: string) => {
        if (replacement === null) return null;
        replacement = {
          ...replacement,
          state: "running",
          deliveryAttempts: 1,
          claimFence: 1,
          claimOwner: workerId,
        };
        return replacement;
      },
      completeOutbox: async () => {
        if (replacement === null) return false;
        replacement = { ...replacement, state: "delivered", claimOwner: null };
        return true;
      },
      failOutbox: async () => false,
    };

    expect(
      await sweepMissingMediaWorkflows({
        store,
        workflow: { get: async () => "missing" },
      }),
    ).toMatchObject({ replaced: 1 });

    const dispatch = await dispatchEligibleMediaOutbox(
      {
        listEligible: async () =>
          replacement === null ? [] : [{ outboxEventId: replacement.outboxId }],
      },
      {
        send: async (message) => {
          if ("kind" in message) throw new Error("song replacement used the video queue shape");
          const disposition = await consumeMediaProcessingQueueMessage(message, {
            store: store as unknown as MediaProcessingStore,
            workerId: "replacement-consumer-1",
            workflow: {
              get: async () => "missing",
              create: async (instanceId, payload) => {
                launches.push({ instanceId, payload });
                return "created";
              },
              notify: async () => {
                throw new Error("a newly created replacement must not receive a wakeup event");
              },
            },
          });
          if (disposition.disposition !== "ack") {
            throw new Error(`replacement consumer returned ${disposition.disposition}`);
          }
        },
      },
    );

    expect(dispatch).toEqual({ selected: 1, sent: 1, failed: 0 });
    expect(launches).toEqual([
      {
        instanceId: "media-operation-1-r2",
        payload: {
          outboxId: "replacement-outbox-1",
          submissionId: "submission-1",
          operationId: "operation-1",
          workflowRevision: 2,
        },
      },
    ]);
    expect(replacement).toMatchObject({ state: "delivered", deliveryAttempts: 1 });
  });

  test("advances authority once and leaves Queue delivery to launch replacement", async () => {
    let current = candidate();
    let replacementWrites = 0;
    const observed: number[] = [];
    const dependencies = {
      store: {
        reconcileTerminalWorkflow: async () => "escalated" as const,
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
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 1,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(1);
    expect(observed).toEqual([2]);
  });

  test("does not write for present, terminal, or stale candidates", async () => {
    const active = candidate();
    const terminal = candidate({ operationId: "operation-2", status: "blocked", phase: null });
    let replacementWrites = 0;
    const result = await sweepMissingMediaWorkflows({
      store: {
        reconcileTerminalWorkflow: async () => "escalated" as const,
        listWorkflowCandidates: async () => [active, terminal],
        loadAuthority: async () => ({ ...active, workflowRevision: 2 }),
        replaceMissingWorkflow: async () => {
          replacementWrites += 1;
          return "committed";
        },
      },
      workflow: { get: async () => "missing" },
    });
    expect(result).toEqual({
      inspected: 1,
      present: 0,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 0,
      stale: 1,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(0);

    const present = await sweepMissingMediaWorkflows({
      store: {
        reconcileTerminalWorkflow: async () => "escalated" as const,
        listWorkflowCandidates: async () => [active],
        loadAuthority: async () => active,
        replaceMissingWorkflow: async () => {
          replacementWrites += 1;
          return "committed";
        },
      },
      workflow: { get: async () => "present" },
    });
    expect(present).toEqual({
      inspected: 1,
      present: 1,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 0,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(0);
  });

  test("treats a concurrent replacement CAS replay as stale", async () => {
    const active = candidate();
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "escalated" as const,
          listWorkflowCandidates: async () => [active],
          loadAuthority: async () => active,
          replaceMissingWorkflow: async () => "replay",
        },
        workflow: { get: async () => "missing" },
      }),
    ).toEqual({
      inspected: 1,
      present: 0,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 0,
      stale: 1,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
  });

  test("stops when the replacement budget is exhausted", async () => {
    let replacementWrites = 0;
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "escalated" as const,
          listWorkflowCandidates: async () => [
            candidate({ workflowRevision: 4, replacementSequence: 3 }),
          ],
          loadAuthority: async () => candidate({ workflowRevision: 4, replacementSequence: 3 }),
          replaceMissingWorkflow: async () => {
            replacementWrites += 1;
            return "committed";
          },
        },
        workflow: { get: async () => "missing" },
      }),
    ).toEqual({
      inspected: 1,
      present: 0,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 0,
      stale: 0,
      limitReached: 1,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(0);
  });

  test("does not consume replacement budget from publication or alignment revisions", async () => {
    let current = candidate({
      status: "published",
      phase: null,
      postId: "media-post-operation-1",
      publishedLyricsRevision: 1,
      workflowRevision: 9,
      replacementSequence: 1,
    });
    let replacementWrites = 0;
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "escalated" as const,
          listWorkflowCandidates: async () => [current],
          loadAuthority: async () => current,
          replaceMissingWorkflow: async (expected: MediaProcessingAuthority) => {
            if (expected.workflowRevision !== current.workflowRevision) return "stale";
            replacementWrites += 1;
            current = {
              ...current,
              workflowRevision: current.workflowRevision + 1,
              replacementSequence: current.replacementSequence + 1,
            };
            return "committed";
          },
        },
        workflow: { get: async () => "missing" },
      }),
    ).toEqual({
      inspected: 1,
      present: 0,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 1,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(1);
  });

  test("inspects and replaces a published candidate from the pending-alignment policy", async () => {
    let current = candidate({
      status: "published",
      phase: null,
      postId: "media-post-operation-1",
      replacementSequence: 0,
      publishedLyricsRevision: 1,
    });
    let replacementWrites = 0;
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "escalated" as const,
          listWorkflowCandidates: async () => [current],
          loadAuthority: async () => current,
          replaceMissingWorkflow: async (expected: MediaProcessingAuthority) => {
            if (expected.workflowRevision !== current.workflowRevision) return "stale";
            replacementWrites += 1;
            current = { ...current, workflowRevision: current.workflowRevision + 1 };
            return "committed";
          },
        },
        workflow: { get: async () => "missing" },
      }),
    ).toEqual({
      inspected: 1,
      present: 0,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 1,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(1);
  });

  test("isolates a status-lookup failure and continues with unrelated candidates", async () => {
    const failing = candidate({ operationId: "operation-failing" });
    const healthy = candidate({ operationId: "operation-healthy" });
    let replacementWrites = 0;
    const observed: string[] = [];
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "escalated" as const,
          listWorkflowCandidates: async () => [failing, healthy],
          loadAuthority: async () => healthy,
          replaceMissingWorkflow: async () => {
            replacementWrites += 1;
            return "committed";
          },
        },
        workflow: {
          get: async (instanceId: string) => {
            if (instanceId.includes("operation-failing")) throw new Error("workflow api down");
            return "missing" as const;
          },
        },
        observe: (event: { event: string }) => {
          observed.push(event.event);
        },
      }),
    ).toEqual({
      inspected: 2,
      present: 0,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 1,
      stale: 0,
      limitReached: 0,
      lookupFailed: 1,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(1);
    expect(observed).toContain("workflow_lookup_failed");
  });

  test("isolates a failed terminal reconciliation and replaces the next row", async () => {
    const failing = candidate({ operationId: "operation-failing" });
    const healthy = candidate({ operationId: "operation-healthy" });
    let replacementWrites = 0;
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          listWorkflowCandidates: async () => [failing, healthy],
          loadAuthority: async (_submissionId: string, operationId: string) =>
            operationId === failing.operationId ? failing : healthy,
          reconcileTerminalWorkflow: async () => {
            throw new Error("database unavailable");
          },
          replaceMissingWorkflow: async () => {
            replacementWrites += 1;
            return "committed";
          },
        },
        workflow: {
          get: async (instanceId: string) =>
            instanceId.includes("operation-failing") ? "finished" : "missing",
        },
      }),
    ).toEqual({
      inspected: 2,
      present: 0,
      finished: 1,
      reconciled: 0,
      escalated: 0,
      indeterminate: 0,
      replaced: 1,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 1,
    });
    expect(replacementWrites).toBe(1);
  });

  test("escalates a finished instance even when its replacement budget is spent", async () => {
    const active = candidate({ replacementSequence: 3 });
    let replacementWrites = 0;
    const observed: string[] = [];
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "escalated" as const,
          listWorkflowCandidates: async () => [active],
          loadAuthority: async () => active,
          replaceMissingWorkflow: async () => {
            replacementWrites += 1;
            return "committed";
          },
        },
        workflow: { get: async () => "finished" },
        observe: (event: { event: string }) => observed.push(event.event),
      }),
    ).toEqual({
      inspected: 1,
      present: 0,
      finished: 1,
      reconciled: 0,
      escalated: 1,
      indeterminate: 0,
      replaced: 0,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(0);
    expect(observed).toContain("workflow_terminal");
  });

  test("reconciles a publish-phase terminal instance through the durable fence", async () => {
    const active = candidate({ phase: "publish", decisionRevision: 2 });
    let replacementWrites = 0;
    const observed: string[] = [];
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "reconciled" as const,
          listWorkflowCandidates: async () => [active],
          loadAuthority: async () => active,
          replaceMissingWorkflow: async () => {
            replacementWrites += 1;
            return "committed";
          },
        },
        workflow: { get: async () => "finished" },
        observe: (event: { event: string }) => observed.push(event.event),
      }),
    ).toEqual({
      inspected: 1,
      present: 0,
      finished: 1,
      reconciled: 1,
      escalated: 0,
      indeterminate: 0,
      replaced: 0,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(0);
    expect(observed).toContain("workflow_terminal");
  });

  test("concurrent sweepers produce exactly one replacement through the fence", async () => {
    let current = candidate();
    let replacementWrites = 0;
    const dependencies = {
      store: {
        reconcileTerminalWorkflow: async () => "escalated" as const,
        listWorkflowCandidates: async () => [current],
        loadAuthority: async () => current,
        replaceMissingWorkflow: async (expected: MediaProcessingAuthority) => {
          if (expected.workflowRevision !== current.workflowRevision) return "stale" as const;
          replacementWrites += 1;
          current = { ...current, workflowRevision: current.workflowRevision + 1 };
          return "committed" as const;
        },
      },
      workflow: { get: async () => "missing" as const },
    };
    const [first, second] = await Promise.all([
      sweepMissingMediaWorkflows(dependencies),
      sweepMissingMediaWorkflows(dependencies),
    ]);
    expect([first.replaced, second.replaced].sort()).toEqual([0, 1]);
    expect(first.lookupFailed + second.lookupFailed).toBe(0);
    expect(replacementWrites).toBe(1);
  });

  test("never replaces an existing instance whose status is indeterminate", async () => {
    const active = candidate();
    let replacementWrites = 0;
    expect(
      await sweepMissingMediaWorkflows({
        store: {
          reconcileTerminalWorkflow: async () => "escalated" as const,
          listWorkflowCandidates: async () => [active],
          loadAuthority: async () => active,
          replaceMissingWorkflow: async () => {
            replacementWrites += 1;
            return "committed";
          },
        },
        workflow: { get: async () => "indeterminate" },
      }),
    ).toEqual({
      inspected: 1,
      present: 0,
      finished: 0,
      reconciled: 0,
      escalated: 0,
      indeterminate: 1,
      replaced: 0,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
      recoveryFailed: 0,
    });
    expect(replacementWrites).toBe(0);
  });
});
