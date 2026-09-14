import { describe, expect, test } from "bun:test";
import {
  HNS_ROOT_IMPORT_POLICY_V1,
  type HnsRootImportLifecycleEventV1,
  type HnsRootImportLifecycleStateV1,
  initialHnsRootImportLifecycleStateV1,
} from "@pirate/domain";
import { planHnsRootImportLifecycleCommitV1 } from "./hns-root-import-lifecycle-codec.ts";

const CLOCK_A = Date.parse("2026-09-12T10:00:00.000Z");
const CLOCK_B = Date.parse("2026-09-12T12:00:00.000Z");

function readyState(clock: number): HnsRootImportLifecycleStateV1 {
  const initial = initialHnsRootImportLifecycleStateV1(1);
  return {
    ...initial,
    phase: "ready",
    revision: 5,
    readiness_observed_at_epoch_ms: clock - 1_000,
  };
}

const activationEvent = (occurredAt: number): HnsRootImportLifecycleEventV1 =>
  ({
    event: "activation_requested",
    event_id: "event-activation",
    occurred_at_epoch_ms: occurredAt,
  }) as const;

function retentionReviewDueAt(plan: ReturnType<typeof planHnsRootImportLifecycleCommitV1>): string {
  const work = JSON.parse(plan.requested_work_json) as readonly {
    readonly kind: string;
    readonly due_at: string;
  }[];
  const review = work.find((entry) => entry.kind === "retention_review");
  if (review === undefined) throw new Error("retention review work missing");
  return review.due_at;
}

describe("HNS lifecycle commit planner", () => {
  test("the decision clock is the supplied argument, not the event occurrence time", () => {
    const event = activationEvent(Date.parse("2026-01-01T00:00:00.000Z"));
    const plan = planHnsRootImportLifecycleCommitV1(readyState(CLOCK_A), event, CLOCK_A);
    expect(plan.outcome_kind).toBe("transition");
    expect(retentionReviewDueAt(plan)).toBe(
      new Date(
        CLOCK_A + HNS_ROOT_IMPORT_POLICY_V1.retention_review.first_seconds * 1_000,
      ).toISOString(),
    );
  });

  test("a different supplied clock changes the scheduled work", () => {
    const event = activationEvent(Date.parse("2026-01-01T00:00:00.000Z"));
    const first = planHnsRootImportLifecycleCommitV1(readyState(CLOCK_A), event, CLOCK_A);
    const second = planHnsRootImportLifecycleCommitV1(readyState(CLOCK_B), event, CLOCK_B);
    expect(retentionReviewDueAt(second)).not.toBe(retentionReviewDueAt(first));
  });
});
