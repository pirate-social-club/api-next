import { expect, test } from "bun:test";
import {
  assertRewardResourceExclusion,
  decodeRewardOperationsPlan,
} from "./reward-operations-plan.ts";

import { rewardPlanFixture } from "./reward-operations-test-fixture.ts";

test("strict plan needs independent enable/existing-version authority and preserves source-only bounds", () => {
  const plan = rewardPlanFixture();
  expect(() => decodeRewardOperationsPlan({ ...plan, surprise: "ignored" })).toThrow();
  expect(() => decodeRewardOperationsPlan({ ...plan, target: "true" })).toThrow();
  expect(() => decodeRewardOperationsPlan({ ...plan, expectedRevision: "01" })).toThrow();
  expect(() => decodeRewardOperationsPlan({ ...plan, environment: "prod" })).toThrow();
  const worker = plan.workers.http;
  expect(() =>
    decodeRewardOperationsPlan({
      ...plan,
      workers: {
        ...plan.workers,
        http: { ...worker, route: "existing-version", candidate: worker.baseline },
      },
    }),
  ).toThrow();
});

test("exclusion binds both Workers and lasts through the full reviewed expiry", () => {
  const plan = rewardPlanFixture();
  const lease = {
    schemaVersion: 1,
    reference: plan.exclusionReference,
    operationId: plan.operationId,
    accountId: plan.accountId,
    http: plan.workers.http.name,
    jobs: plan.workers.jobs.name,
    active: true,
    startsAt: "2026-10-03T12:00:00Z",
    expiresAt: plan.expiresAt,
  };
  const now = Date.parse("2026-10-03T12:01:00Z");
  expect(() => assertRewardResourceExclusion(lease, plan, now)).not.toThrow();
  for (const change of [
    { active: false },
    { accountId: "b".repeat(32) },
    { jobs: "other-worker" },
    { expiresAt: "2026-10-03T12:02:00Z" },
  ])
    expect(() => assertRewardResourceExclusion({ ...lease, ...change }, plan, now)).toThrow();
});
