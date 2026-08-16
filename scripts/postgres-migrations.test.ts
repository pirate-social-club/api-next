import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  formatMigrationPlan,
  loadPostgresMigrations,
  normalizePostgresConnectionString,
  runPostgresMigrations,
} from "./postgres-migrations";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Postgres migration runner", () => {
  test("loads the exact ordered, checksum-verified migration plan", async () => {
    const migrations = await loadPostgresMigrations();
    expect(migrations.map(({ version }) => version)).toEqual([
      "0001_v1_product_slice.sql",
      "0002_identity.sql",
    ]);
    expect(formatMigrationPlan(migrations)).toContain("0001_v1_product_slice.sql");
    expect(formatMigrationPlan(migrations)).toContain("0002_identity.sql");
  });

  test("dry-run does not require an administrative URL or open a connection", async () => {
    const output = await runPostgresMigrations({ dryRun: true });
    expect(output).toMatchObject({ dryRun: true });
    if (!output.dryRun) throw new Error("expected a dry-run result");
    expect(output.plan).toHaveLength(2);
  });

  test("normalizes psql's system sslrootcert value for node pg", () => {
    expect(
      normalizePostgresConnectionString(
        "postgresql://postgres:password@example.test/postgres?sslmode=verify-full&sslrootcert=system",
      ),
    ).toBe("postgresql://postgres:password@example.test/postgres?sslmode=verify-full");
  });

  test("fails closed when a migration checksum is tampered", async () => {
    const directory = await mkdtemp(join("/tmp", "api-next-migrations-"));
    temporaryDirectories.push(directory);
    const source = new URL("../db/postgres/migrations/", import.meta.url);
    const manifest = await Bun.file(new URL("checksums.json", source)).text();
    await Bun.write(join(directory, "checksums.json"), manifest);
    const sql = await Bun.file(new URL("0001_v1_product_slice.sql", source)).text();
    await Bun.write(join(directory, "0001_v1_product_slice.sql"), `${sql}\n-- tampered`);
    const identity = await Bun.file(new URL("0002_identity.sql", source)).text();
    await Bun.write(join(directory, "0002_identity.sql"), identity);

    await expect(loadPostgresMigrations(new URL(`file://${directory}/`))).rejects.toThrow(
      "checksum mismatch: 0001_v1_product_slice.sql",
    );
  });
});
