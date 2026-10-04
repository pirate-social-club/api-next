import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validateIsolatedDatabaseIdentity } from "./bootstrap-database.ts";

const url = "postgres://isolated_runtime:fixture@isolated.example/postgres";
const identity = {
  branchId: "isolatedbranch123",
  branchName: "rewards-runner-20261004",
  hostname: "isolated.example",
  usernameSha256: createHash("sha256").update("isolated_runtime").digest("hex"),
};

test("fresh database setup refuses a shared branch identity before connecting", () => {
  for (const branchName of ["main", "megapot-win-e2e-20260926-r1", "rewards-runner-2026;DROP"]) {
    expect(() => validateIsolatedDatabaseIdentity(url, { ...identity, branchName })).toThrow(
      "identity mismatch",
    );
  }
});

test("fresh database setup binds both the verified host and role", () => {
  expect(() =>
    validateIsolatedDatabaseIdentity(url.replace("isolated.example", "shared.example"), identity),
  ).toThrow("identity mismatch");
  expect(() =>
    validateIsolatedDatabaseIdentity(url.replace("isolated_runtime", "shared_runtime"), identity),
  ).toThrow("identity mismatch");
  expect(validateIsolatedDatabaseIdentity(url, identity).hostname).toBe(identity.hostname);
});
