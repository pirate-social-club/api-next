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
      "0003_m2_community_content.sql",
      "0004_post_comment_lock.sql",
      "0005_m2_behavior_invariants.sql",
      "0006_public_profile_handle_index.sql",
      "0007_public_profile_handle_invariants.sql",
      "0008_community_route_slug.sql",
      "0009_gates_v2_evidence_and_action_grants.sql",
    ]);
    expect(formatMigrationPlan(migrations)).toContain("0001_v1_product_slice.sql");
    expect(formatMigrationPlan(migrations)).toContain("0002_identity.sql");
    expect(formatMigrationPlan(migrations)).toContain("0003_m2_community_content.sql");
    expect(formatMigrationPlan(migrations)).toContain("0004_post_comment_lock.sql");
    expect(formatMigrationPlan(migrations)).toContain("0005_m2_behavior_invariants.sql");
    expect(formatMigrationPlan(migrations)).toContain("0006_public_profile_handle_index.sql");
    expect(formatMigrationPlan(migrations)).toContain("0007_public_profile_handle_invariants.sql");
    expect(formatMigrationPlan(migrations)).toContain("0008_community_route_slug.sql");
    expect(formatMigrationPlan(migrations)).toContain("0008_community_route_slug.sql");
    expect(formatMigrationPlan(migrations)).toContain(
      "0009_gates_v2_evidence_and_action_grants.sql",
    );
  });

  test("dry-run does not require an administrative URL or open a connection", async () => {
    const output = await runPostgresMigrations({ dryRun: true });
    expect(output).toMatchObject({ dryRun: true });
    if (!output.dryRun) throw new Error("expected a dry-run result");
    expect(output.plan).toHaveLength(9);
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
    const m2 = await Bun.file(new URL("0003_m2_community_content.sql", source)).text();
    await Bun.write(join(directory, "0003_m2_community_content.sql"), m2);
    const commentLock = await Bun.file(new URL("0004_post_comment_lock.sql", source)).text();
    await Bun.write(join(directory, "0004_post_comment_lock.sql"), commentLock);
    const m2Behavior = await Bun.file(new URL("0005_m2_behavior_invariants.sql", source)).text();
    await Bun.write(join(directory, "0005_m2_behavior_invariants.sql"), m2Behavior);
    const publicProfile = await Bun.file(
      new URL("0006_public_profile_handle_index.sql", source),
    ).text();
    await Bun.write(join(directory, "0006_public_profile_handle_index.sql"), publicProfile);
    const publicProfileInvariants = await Bun.file(
      new URL("0007_public_profile_handle_invariants.sql", source),
    ).text();
    await Bun.write(
      join(directory, "0007_public_profile_handle_invariants.sql"),
      publicProfileInvariants,
    );
    const communityRouteSlug = await Bun.file(
      new URL("0008_community_route_slug.sql", source),
    ).text();
    await Bun.write(join(directory, "0008_community_route_slug.sql"), communityRouteSlug);
    const gatesV2 = await Bun.file(
      new URL("0009_gates_v2_evidence_and_action_grants.sql", source),
    ).text();
    await Bun.write(join(directory, "0009_gates_v2_evidence_and_action_grants.sql"), gatesV2);

    await expect(loadPostgresMigrations(new URL(`file://${directory}/`))).rejects.toThrow(
      "checksum mismatch: 0001_v1_product_slice.sql",
    );
  });
});
