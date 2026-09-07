import { expect, test } from "bun:test";
import { executeKaraokeFenceRelease } from "./staging-karaoke-release-operation.ts";

// Deliberately synthetic directives, not a reviewed live restoration plan.
const plan = {
  version: "staging-karaoke-release-plan-v1",
  ingressApplicationId: "a".repeat(32),
  resumeQueues: [{ name: "fixture-queue", id: "b".repeat(32) }],
  servingWorkers: [{ worker: "fixture-worker", versionId: "c".repeat(32) }],
  reviewedGrantDigest: "d".repeat(64),
  surfaceOrder: ["database", "producers", "ingress"],
};
const now = () => "2026-09-07T10:00:00.000Z";

test("invalid or duplicate restoration directives refuse before any attempt", async () => {
  for (const invalid of [
    null,
    { ...plan, unexpected: true },
    { ...plan, ingressApplicationId: "invalid" },
    { ...plan, surfaceOrder: ["database", "database", "ingress"] },
    { ...plan, resumeQueues: [...plan.resumeQueues, ...plan.resumeQueues] },
  ]) {
    let attempts = 0;
    const refused = async (): Promise<never> => {
      attempts++;
      throw new Error("must not execute");
    };
    await expect(
      executeKaraokeFenceRelease({
        plan: invalid,
        now,
        surfaces: { ingress: refused, producers: refused, database: refused },
        onAttempt: () => {
          attempts++;
        },
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(0);
  }
});

test("unproven confirmation time stops the release after one surface", async () => {
  for (const releasedAt of ["invalid", "2026-09-06T10:00:00.000Z", "2026-09-08T10:00:00.000Z"]) {
    let attempts = 0;
    const run = async () => {
      attempts++;
      return { surface: "database" as const, releasedAt, receipt: "provider-receipt" };
    };
    const result = await executeKaraokeFenceRelease({
      plan,
      now,
      surfaces: { ingress: run, producers: run, database: run },
    });
    expect(result.disposition).toBe("unresolved");
    expect(attempts).toBe(1);
    expect(result.receipts).toHaveLength(0);
  }
});
