import { expect, test } from "bun:test";
import { RewardOperationsRefusal } from "./reward-operations-report.ts";
import { rewardPlanFixture } from "./reward-operations-test-fixture.ts";
import {
  boundedRewardOperation,
  createRewardWorkerClient,
  readWithBoundedRetry,
} from "./reward-operations-worker-client.ts";

test("read retries are bounded, authentication never retries, and an outer abort ends a hanging read", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const delays: number[] = [];
  await expect(
    readWithBoundedRetry(
      async () => {
        calls++;
        throw new RewardOperationsRefusal("provider", 503);
      },
      signal,
      async (ms) => {
        delays.push(ms);
      },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(3);
  expect(delays).toEqual([1000, 2000]);
  calls = 0;
  await expect(
    readWithBoundedRetry(async () => {
      calls++;
      throw new RewardOperationsRefusal("authentication", 403);
    }, signal),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  const controller = new AbortController();
  const pending = boundedRewardOperation(new Promise(() => {}), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test("CLI deployment accepts human success stdout and uses the same injected account/token", async () => {
  const plan = { ...rewardPlanFixture(), environment: "production" as const };
  const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
  const client = createRewardWorkerClient({
    root: "/fixture",
    plan,
    token: "private-token",
    command: async (args, env) => {
      calls.push({ args, env });
      return { stdout: "Successfully deployed version to 100%", exitCode: 0 };
    },
  });
  await expect(
    client.deploy(
      plan.workers.http,
      plan.workers.http.baseline.id,
      "reviewed",
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
  expect(calls[0]?.args).toContain("production");
  expect(calls[0]?.args).not.toContain("--json");
  expect(calls[0]?.env.CLOUDFLARE_API_TOKEN).toBe("private-token");
  expect(calls[0]?.env.CLOUDFLARE_ACCOUNT_ID).toBe(plan.accountId);
});

test("equal maximum version timestamps and split deployments refuse", async () => {
  const plan = rewardPlanFixture();
  const client = createRewardWorkerClient({
    root: "/fixture",
    plan,
    token: "token",
    command: async (args) => ({
      exitCode: 0,
      stdout: JSON.stringify(
        args[0] === "versions"
          ? [
              {
                id: plan.workers.http.baseline.id,
                metadata: { created_on: "2026-10-03T12:00:00Z" },
              },
              {
                id: "22222222-2222-2222-2222-222222222222",
                metadata: { created_on: "2026-10-03T12:00:00Z" },
              },
            ]
          : { versions: [{ version_id: plan.workers.http.baseline.id, percentage: 50 }] },
      ),
    }),
  });
  await expect(client.versions(plan.workers.http, new AbortController().signal)).rejects.toThrow(
    "latest-mismatch",
  );
  await expect(client.serving(plan.workers.http, new AbortController().signal)).rejects.toThrow(
    "split-deployment",
  );
});

test("token contract permits absent expiry, refuses short known expiry, and retries mid-body reads", async () => {
  const plan = rewardPlanFixture();
  let tokenReads = 0;
  const client = createRewardWorkerClient({
    root: "/fixture",
    plan,
    token: "token",
    now: () => Date.parse("2026-10-03T12:00:00Z"),
    sleep: async () => {},
    fetch: async (url) => {
      if (String(url).endsWith("tokens/verify")) {
        tokenReads++;
        if (tokenReads === 1)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(Error("private transport"));
              },
            }),
          );
      }
      return Response.json({ success: true, result: { status: "active" } });
    },
  });
  await client.authenticate(plan.workers.http, new AbortController().signal);
  expect(tokenReads).toBe(2);
  const expired = createRewardWorkerClient({
    root: "/fixture",
    plan,
    token: "token",
    now: () => Date.parse("2026-10-03T12:00:00Z"),
    fetch: async () =>
      Response.json({
        success: true,
        result: { status: "active", expires_on: "2026-10-03T12:10:00Z" },
      }),
  });
  await expect(
    expired.authenticate(plan.workers.http, new AbortController().signal),
  ).rejects.toThrow("expiry");
});
