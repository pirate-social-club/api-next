import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test } from "vitest";
import { workerBackground } from "../../packages/platform-cf/src/worker-background.ts";

test("deferred work runs on the native execution context and outlives the response", async () => {
  const ctx = createExecutionContext();
  const order: string[] = [];
  const response = await workerBackground.run(
    // Call through the context: a detached waitUntil is an illegal invocation in workerd.
    (work) => ctx.waitUntil(work),
    async () => {
      const deferred = workerBackground.defer(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Work started in the background can still defer further work for the same request.
        expect(workerBackground.defer(async () => void order.push("nested"))).toBe(true);
        order.push("background");
      });
      order.push("responded");
      return deferred;
    },
  );
  expect(response).toBe(true);
  expect(order).toEqual(["responded"]);
  await waitOnExecutionContext(ctx);
  expect(order).toEqual(["responded", "nested", "background"]);
});

test("nothing is deferred outside a request", () => {
  let started = false;
  expect(
    workerBackground.defer(async () => {
      started = true;
    }),
  ).toBe(false);
  expect(started).toBe(false);
});
