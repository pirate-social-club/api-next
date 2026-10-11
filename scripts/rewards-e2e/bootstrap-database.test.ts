import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyIsolatedBootstrapBatches,
  validateIsolatedDatabaseIdentity,
} from "./bootstrap-database.ts";

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

const migrations = Array.from({ length: 45 }, (_, index) => ({
  version: `${String(index + 1).padStart(4, "0")}_fixture.sql`,
  checksum: String(index).padStart(64, "0"),
  sql: "SELECT 1",
}));

test("bounded bootstrap verifies the exact ledger at every transaction boundary", async () => {
  const sizes: number[] = [];
  let committed = 0;
  const result = await applyIsolatedBootstrapBatches(url, migrations, async (input) => {
    if (!input) throw new Error("Missing migration batch input");
    expect(input.expectedLedger).toEqual(
      migrations.slice(0, committed).map(({ version, checksum }) => ({ version, checksum })),
    );
    const pending = (input.migrations ?? []).slice(committed);
    sizes.push(pending.length);
    committed += pending.length;
    return {
      dryRun: false,
      result: {
        applied: pending.map(({ version }) => version),
        currentVersion: input.migrations?.at(-1)?.version ?? null,
      },
    };
  });
  expect(sizes).toEqual([20, 20, 5]);
  expect(result.applied).toEqual(migrations.map(({ version }) => version));
});

test("an uncertain or incomplete migration batch stops without admitting later batches", async () => {
  let calls = 0;
  await expect(
    applyIsolatedBootstrapBatches(url, migrations, async () => {
      calls++;
      return { dryRun: false, result: { applied: [], currentVersion: null } };
    }),
  ).rejects.toThrow("exact pinned range");
  expect(calls).toBe(1);
});
