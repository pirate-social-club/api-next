import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { STUDY_EXERCISE_REVIEW_KEY_MAX_LENGTH } from "@pirate/contracts";

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
    const manifest = JSON.parse(
      await Bun.file(new URL("../db/postgres/migrations/checksums.json", import.meta.url)).text(),
    ) as { readonly migrations: Readonly<Record<string, string>> };
    const expectedVersions = Object.keys(manifest.migrations).sort();
    expect(migrations.map(({ version }) => version)).toEqual(expectedVersions);
    expect(formatMigrationPlan(migrations)).toContain(expectedVersions.at(-1) ?? "");
  });

  test("dry-run does not require an administrative URL or open a connection", async () => {
    const output = await runPostgresMigrations({ dryRun: true });
    expect(output).toMatchObject({ dryRun: true });
    if (!output.dryRun) throw new Error("expected a dry-run result");
    const manifest = JSON.parse(
      await Bun.file(new URL("../db/postgres/migrations/checksums.json", import.meta.url)).text(),
    ) as { readonly migrations: Readonly<Record<string, string>> };
    expect(output.plan).toHaveLength(Object.keys(manifest.migrations).length);
  });

  test("keeps the Study review-key wire and storage bounds equal", async () => {
    const migrations = await loadPostgresMigrations();
    const foundation = migrations.find(({ version }) => version === "0074_study_v2_foundation.sql");
    expect(foundation?.sql).toContain(
      `exercise_review_key TEXT NOT NULL CHECK (char_length(exercise_review_key) BETWEEN 1 AND ${STUDY_EXERCISE_REVIEW_KEY_MAX_LENGTH})`,
    );
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
    const migrations = await loadPostgresMigrations();
    for (const migration of migrations) {
      await Bun.write(
        join(directory, migration.version),
        migration.version === migrations[0]?.version
          ? `${migration.sql}\n-- tampered`
          : migration.sql,
      );
    }

    await expect(loadPostgresMigrations(new URL(`file://${directory}/`))).rejects.toThrow(
      "checksum mismatch: 0001_v1_product_slice.sql",
    );
  });
});
