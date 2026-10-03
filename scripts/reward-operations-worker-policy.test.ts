import { expect, test } from "bun:test";
import { rewardPlanFixture } from "./reward-operations-test-fixture.ts";
import {
  buildRewardFlagSettingsPatch,
  compareRewardWorkerDescriptor,
  decodeRewardWorkerDescriptor,
} from "./reward-operations-worker-policy.ts";

test("exact descriptor comparison refuses source, runtime, secret-descriptor and flag drift", () => {
  const baseline = rewardPlanFixture().workers.http.baseline;
  for (const actual of [
    { ...baseline, etag: "other" },
    { ...baseline, message: `git:${"b".repeat(40)}` },
    { ...baseline, runtime: { ...baseline.runtime, compatibility_date: "2026-10-03" } },
    {
      ...baseline,
      bindings: baseline.bindings.map((b) =>
        b.name === "SECRET" ? { ...b, type: "plain_text", text: "private" } : b,
      ),
    },
    {
      ...baseline,
      bindings: baseline.bindings.map((b) =>
        b.name === "MEGAPOT_REWARDS_ENABLED" ? { ...b, text: "false" } : b,
      ),
    },
  ])
    expect(() => compareRewardWorkerDescriptor(baseline, actual)).toThrow();
  expect(() =>
    decodeRewardWorkerDescriptor({
      ...baseline,
      bindings: [...baseline.bindings, baseline.bindings[0]],
    }),
  ).toThrow();
  const after = {
    ...baseline,
    id: "22222222-2222-2222-2222-222222222222",
    message: `${baseline.message} reviewed`,
    bindings: baseline.bindings.map((b) =>
      b.name === "MEGAPOT_REWARDS_ENABLED" ? { ...b, text: "false" } : b,
    ),
  };
  expect(() => compareRewardWorkerDescriptor(baseline, after, "false", false)).not.toThrow();
});

test("settings patch changes exactly the plain reward flag and inherits all other bindings from latest", () => {
  const baseline = rewardPlanFixture().workers.http.baseline;
  expect(buildRewardFlagSettingsPatch(baseline, "false", "operation")).toEqual({
    annotations: { "workers/message": "operation" },
    bindings: [
      { name: "MEGAPOT_REWARDS_ENABLED", type: "plain_text", text: "false" },
      { name: "SECRET", type: "inherit", version_id: "latest" },
      { name: "CONTROL_PLANE", type: "inherit", version_id: "latest" },
    ],
  });
});
