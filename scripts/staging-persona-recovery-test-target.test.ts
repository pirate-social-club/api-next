import { expect, test } from "bun:test";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";

test("admits only the literal loopback test database without host overrides", () => {
  expect(localRecoveryTestUrl("postgres://postgres@127.0.0.1:55439/postgres").hostname).toBe(
    "127.0.0.1",
  );
  expect(
    localRecoveryTestUrl("postgresql://postgres@127.0.0.1/postgres?sslmode=disable").pathname,
  ).toBe("/postgres");
  for (const value of [
    "postgres://operator:secret@staging.example/postgres",
    "postgres://operator:secret@127.0.0.1/postgres?host=staging.example",
    "postgres://postgres@127.0.0.1/postgres?options=-crole=operator",
    "postgres://postgres@localhost/postgres",
    "postgres://postgres@127.0.0.1/another_database",
    "https://postgres@127.0.0.1/postgres",
    "invalid secret",
  ])
    expect(() => localRecoveryTestUrl(value)).toThrow("local_recovery_test_target_required");
});
