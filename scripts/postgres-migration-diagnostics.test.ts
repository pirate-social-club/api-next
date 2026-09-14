import { expect, test } from "bun:test";
import { ControlPlaneStatementFailed } from "@pirate/application";
import { makeMigrationDiagnosticClient } from "./postgres-migration-diagnostics.ts";

test("an empty tagged error still names its failing migration and safe SQL classification", () => {
  const diagnostics = makeMigrationDiagnosticClient([]);
  const failure = new ControlPlaneStatementFailed({
    label: "postgres.migrations.0182_example.sql.apply",
    sqlState: "0A000",
    constraint: null,
    outcomeCertainty: "aborted",
  });
  expect(failure.message).toBe("");
  expect(diagnostics.describe(failure)).toBe(
    "Postgres migration statement postgres.migrations.0182_example.sql.apply failed (SQLSTATE 0A000)",
  );
});

test("non-migration statements retain an actionable nonempty diagnostic", () => {
  const diagnostics = makeMigrationDiagnosticClient([]);
  expect(
    diagnostics.describe(
      new ControlPlaneStatementFailed({
        label: "postgres.migrations.ensure-ledger",
        sqlState: null,
        constraint: null,
        outcomeCertainty: "not-started",
      }),
    ),
  ).toBe(
    "Postgres migration statement postgres.migrations.ensure-ledger failed (SQLSTATE unknown)",
  );
});
