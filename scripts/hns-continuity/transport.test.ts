import { expect, test } from "bun:test";
import { execute } from "./acquire.mjs";
import { continuityFailureMessage } from "./refusal.mjs";

test("observation child processes do not inherit the database credential", async () => {
  const prior = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = "fixture-secret-must-not-cross-process-boundary";
  try {
    const output = await execute([
      process.execPath,
      "-e",
      "process.stdout.write(String(process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL === undefined))",
    ]);
    expect(output.toString()).toBe("true");
  } finally {
    if (prior === undefined) delete process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
    else process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL = prior;
  }
});

test("transport and database diagnostics do not expose credential-bearing errors", async () => {
  await expect(
    execute([process.execPath, "-e", "console.error('fixture-secret');process.exit(1)"]),
  ).rejects.toThrow("Operator transport failed; no credential output retained");
  expect(
    continuityFailureMessage(new Error("postgres://fixture:fixture-secret@host/db")),
  ).not.toContain("fixture-secret");
});
