import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Step = {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
};
const source = readFileSync(
  new URL("../.github/workflows/secret-drift.yml", import.meta.url),
  "utf8",
);
const workflow = Bun.YAML.parse(source) as {
  jobs: { audit: { steps: Step[]; "continue-on-error"?: boolean } };
};
const job = workflow.jobs.audit;
const steps = job.steps;

describe("secret drift workflow failure isolation", () => {
  test("installs once before either audit and exposes the actual install outcome", () => {
    const installs = steps.filter((step) => step.run === "bun install --frozen-lockfile");
    expect(installs).toHaveLength(1);
    expect(installs[0]?.id).toBe("install");
    expect(steps.findIndex((step) => step.id === "install")).toBeLessThan(
      steps.findIndex((step) => step.run === "bun run audit:secrets"),
    );
  });

  test("allows the second audit after failure but excludes cancellation and unsuccessful setup", () => {
    const audits = steps.filter((step) => step.run?.startsWith("bun run audit:"));
    expect(audits.map((step) => step.run)).toEqual([
      "bun run audit:secrets",
      "bun run audit:infisical",
    ]);
    expect(audits[0]?.if).toBeUndefined();
    // A status function overrides GitHub's implicit success() guard. Pin the
    // setup and cancellation guards too; hosted runs prove scheduler behavior.
    expect(audits[1]?.if).toBe(`\${{ !cancelled() && steps.install.outcome == 'success' }}`);
  });

  test("neither audit nor setup failure is converted into job success", () => {
    expect(job["continue-on-error"]).toBeUndefined();
    for (const step of steps) expect(step["continue-on-error"]).toBeUndefined();
    expect(source).not.toContain("|| true");
  });
});
