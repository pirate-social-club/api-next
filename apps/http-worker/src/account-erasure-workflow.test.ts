import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_ERASURE_OWNERS,
  type AccountErasureOwner,
  type AccountErasureWorkflowStore,
} from "@pirate/application/use-cases/account-erasure-orchestration";
import {
  type AccountErasureWorkflowStep,
  makeAccountErasureWorkflowRunner,
} from "./account-erasure-workflow.ts";

const workflowEvent = {
  instanceId: "account-erasure-request-1",
  payload: { erasure_request_id: "erasure-request-1" },
} as const;

const directStep = (names: string[]): AccountErasureWorkflowStep => ({
  do: async (name, _options, callback) => {
    names.push(name);
    return callback();
  },
});

describe("account erasure Workflow", () => {
  test("drains every owner in policy order before completing", async () => {
    const calls: string[] = [];
    const attempts = new Map<AccountErasureOwner, number>();
    const store: AccountErasureWorkflowStore = {
      claim: async (requestId) => {
        calls.push(`claim:${requestId}`);
        return { outcome: "claimed" };
      },
      drainOwner: async ({ owner }) => {
        calls.push(`owner:${owner}`);
        const attempt = attempts.get(owner) ?? 0;
        attempts.set(owner, attempt + 1);
        if (owner === "learner_audio" && attempt === 0) {
          return { outcome: "draining", deletedCount: 1_000, remainingCount: 1 };
        }
        return {
          outcome: "terminal",
          disposition: owner === "retained_evidence" ? "retained_by_policy" : "deleted",
        };
      },
      complete: async (requestId) => {
        calls.push(`complete:${requestId}`);
        return { erasureRequestId: requestId, status: "completed" };
      },
    };
    const stepNames: string[] = [];

    const result = await makeAccountErasureWorkflowRunner(() => ({ store }))(
      {},
      workflowEvent,
      directStep(stepNames),
    );

    expect(result).toEqual({ erasureRequestId: "erasure-request-1", status: "completed" });
    expect(calls.filter((call) => call === "owner:learner_audio")).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("owner:"))).toEqual([
      ...ACCOUNT_ERASURE_OWNERS.slice(0, 5).map((owner) => `owner:${owner}`),
      "owner:learner_audio",
      ...ACCOUNT_ERASURE_OWNERS.slice(5).map((owner) => `owner:${owner}`),
    ]);
    expect(stepNames).toContain("account-erasure-learner_audio-1");
    expect(stepNames.at(-1)).toBe("account-erasure-complete");
  });

  test("returns a persisted paused disposition without running later owners", async () => {
    const visited: AccountErasureOwner[] = [];
    const store: AccountErasureWorkflowStore = {
      claim: async () => ({ outcome: "claimed" }),
      drainOwner: async ({ owner }) => {
        visited.push(owner);
        return owner === "external_providers"
          ? { outcome: "paused", status: "authority_required" }
          : { outcome: "terminal", disposition: "deleted" };
      },
      complete: async () => {
        throw new Error("must not complete");
      },
    };

    const result = await makeAccountErasureWorkflowRunner(() => ({ store }))(
      {},
      workflowEvent,
      directStep([]),
    );

    expect(result.status).toBe("authority_required");
    expect(visited.at(-1)).toBe("external_providers");
    expect(visited).not.toContain("platform_logs");
  });

  test("rejects zero-progress batches instead of looping forever", async () => {
    const store: AccountErasureWorkflowStore = {
      claim: async () => ({ outcome: "claimed" }),
      drainOwner: async () => ({ outcome: "draining", deletedCount: 0, remainingCount: 4 }),
      complete: async () => {
        throw new Error("must not complete");
      },
    };

    await expect(
      makeAccountErasureWorkflowRunner(() => ({ store }))({}, workflowEvent, directStep([])),
    ).rejects.toThrow("non-progress");
  });

  test("returns an already-terminal claim without touching an owner", async () => {
    let touched = false;
    const store: AccountErasureWorkflowStore = {
      claim: async () => ({ outcome: "terminal", status: "pending_expiry" }),
      drainOwner: async () => {
        touched = true;
        throw new Error("must not drain");
      },
      complete: async () => {
        throw new Error("must not complete");
      },
    };

    const result = await makeAccountErasureWorkflowRunner(() => ({ store }))(
      {},
      workflowEvent,
      directStep([]),
    );

    expect(result).toEqual({ erasureRequestId: "erasure-request-1", status: "pending_expiry" });
    expect(touched).toBe(false);
  });
});
