import { describe, expect, it } from "vitest";

import jobsWorker, * as jobsEntrypoint from "../../apps/jobs-worker/src/index";

describe("jobs worker entrypoint module boundary", () => {
  it("exposes only functions and the cron lock class as named exports", () => {
    for (const [name, value] of Object.entries(jobsEntrypoint)) {
      if (name === "default") continue;
      expect(typeof value, `${name} must be a function or handler class`).toBe("function");
    }
  });

  it("exposes the default handler with its runtime methods", () => {
    const handler = jobsWorker as unknown as Record<string, unknown>;
    for (const method of ["fetch", "queue", "scheduled"]) {
      expect(typeof handler[method], `${method} must be a handler method`).toBe("function");
    }
  });
});
