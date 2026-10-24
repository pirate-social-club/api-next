import { expect, test } from "bun:test";
import { recoveryAdmission } from "./safe-pool-recover-late-purchase.ts";

test("the command admits by its own API_NEXT_ENV, with the production switch only in production", () => {
  expect(
    recoveryAdmission({ API_NEXT_ENV: "production", SAFE_POOL_PRODUCTION_ENABLED: "true" }),
  ).toEqual({ runtimeEnvironment: "production", productionEnabled: true });
  expect(recoveryAdmission({ API_NEXT_ENV: "production" })).toEqual({
    runtimeEnvironment: "production",
    productionEnabled: false,
  });
  expect(recoveryAdmission({ API_NEXT_ENV: "staging" })).toEqual({
    runtimeEnvironment: "staging",
    productionEnabled: false,
  });
  expect(
    recoveryAdmission({ API_NEXT_ENV: "development", SAFE_POOL_PRODUCTION_ENABLED: "false" }),
  ).toEqual({ runtimeEnvironment: "development", productionEnabled: false });
  for (const env of [
    {},
    { API_NEXT_ENV: "" },
    { API_NEXT_ENV: "test" },
    { API_NEXT_ENV: "Production" },
    { API_NEXT_ENV: "staging", SAFE_POOL_PRODUCTION_ENABLED: "true" },
    { API_NEXT_ENV: "development", SAFE_POOL_PRODUCTION_ENABLED: "true" },
  ]) {
    expect(() => recoveryAdmission(env)).toThrow();
  }
});

test("the dry run refuses a missing environment or a misplaced switch before any database or chain", async () => {
  const run = async (env: Record<string, string>) => {
    const child = Bun.spawn(
      [process.execPath, "scripts/safe-pool-recover-late-purchase.ts", "--attestation", "x"],
      {
        cwd: new URL("../", import.meta.url).pathname,
        // No RPC or database variables: the refusal must come first.
        env: { PATH: process.env.PATH ?? "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, error: JSON.parse(stderr) as { action: string; code: string } };
  };
  expect(await run({})).toEqual({
    exitCode: 1,
    stdout: "",
    error: { action: "failed", code: "API_NEXT_ENV must be production, staging or development" },
  });
  for (const environment of ["staging", "development"]) {
    expect(await run({ API_NEXT_ENV: environment, SAFE_POOL_PRODUCTION_ENABLED: "true" })).toEqual({
      exitCode: 1,
      stdout: "",
      error: {
        action: "failed",
        code: "SAFE_POOL_PRODUCTION_ENABLED is refused outside production",
      },
    });
  }
});
