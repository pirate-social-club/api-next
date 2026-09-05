import { expect, test } from "bun:test";
import { observeStagingProviderBackup } from "./staging-persona-provider-backup";

function fixture() {
  return [
    { id: "mvydkmmwh5x4", name: "pirate-staging", kind: "postgresql" },
    { id: "syu03e00w3ux", name: "main", kind: "postgresql", ready: true, state: "ready" },
    {
      id: "backup-fixture",
      state: "success",
      database_branch: { id: "syu03e00w3ux", name: "main" },
      protected: false,
      restored_branches: [],
      created_at: "2026-09-05T14:17:02Z",
      started_at: "2026-09-05T14:17:03Z",
      completed_at: "2026-09-05T14:21:09Z",
      expires_at: "2026-09-07T14:17:02Z",
      actor: { display_name: "private fixture identity" },
      secret: "never emit",
    },
  ];
}

test("reads exact staging resources and returns metadata without claiming recovery", async () => {
  const rows = fixture();
  const paths: string[] = [];
  const result = await observeStagingProviderBackup("backup-fixture", async (path) => {
    paths.push(path);
    return rows.shift();
  });
  expect(paths).toEqual([
    "organizations/{org}/databases/pirate-staging",
    "organizations/{org}/databases/pirate-staging/branches/main",
    "organizations/{org}/databases/pirate-staging/branches/main/backups/backup-fixture",
  ]);
  expect(result).toMatchObject({
    backup_id: "backup-fixture",
    deletion_protected: false,
    restored_branch_ids: [],
    sql_target_verified: false,
    recovery_verified: false,
    execution_authorized: false,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain("never emit");
});

test("refuses path injection before any provider read", async () => {
  let reads = 0;
  await expect(
    observeStagingProviderBackup("../other", async () => {
      reads++;
    }),
  ).rejects.toThrow("staging_provider_backup_unproven");
  expect(reads).toBe(0);
});

test("refuses mismatched identity, incomplete metadata and failed or malformed backups", async () => {
  const mutations: ((rows: Record<string, unknown>[]) => void)[] = [
    (rows) => {
      rows[0] = { ...rows[0], id: "other-database" };
    },
    (rows) => {
      rows[1] = { ...rows[1], ready: false };
    },
    (rows) => {
      rows[2] = { ...rows[2], id: "other-backup" };
    },
    (rows) => {
      rows[2] = { ...rows[2], database_branch: { id: "other-branch", name: "main" } };
    },
    (rows) => {
      rows[2] = { ...rows[2], state: "running" };
    },
    (rows) => {
      rows[2] = { ...rows[2], started_at: null };
    },
    (rows) => {
      rows[2] = { ...rows[2], expires_at: "2026-09-05T14:00:00Z" };
    },
    (rows) => {
      rows[2] = { ...rows[2], restored_branches: [{ id: "syu03e00w3ux" }] };
    },
  ];
  for (const mutate of mutations) {
    const rows: Record<string, unknown>[] = fixture();
    mutate(rows);
    await expect(
      observeStagingProviderBackup("backup-fixture", async () => rows.shift()),
    ).rejects.toThrow("staging_provider_backup_unproven");
  }
});

test("redacts reader failures without attaching their cause", async () => {
  try {
    await observeStagingProviderBackup("backup-fixture", async () => {
      throw new Error("credential fixture");
    });
    throw new Error("unexpected success");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("staging_provider_backup_unproven");
    expect((error as Error).cause).toBeUndefined();
  }
});
