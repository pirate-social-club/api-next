import { describe, expect, spyOn, test } from "bun:test";
import { Client } from "pg";
import { inspectStagingRemovalPlan } from "./staging-persona-removal-plan";
import { removeStagingObjectsInTransaction } from "./staging-persona-remove-objects";
import { loadStagingResetArtifacts } from "./staging-persona-reset-plan";

const artifacts = loadStagingResetArtifacts();

describe("removal plan artifact gate", () => {
  test("the destructive primitive also rejects tampered SQL before touching a connection", async () => {
    const client = new Client();
    const query = spyOn(client, "query").mockImplementation(() => {
      throw new Error("database must not be reached");
    });
    try {
      await expect(
        removeStagingObjectsInTransaction(client, {
          ...artifacts,
          migrations: artifacts.migrations.map((migration, index) =>
            index === 0 ? { ...migration, sql: `${migration.sql}\nSELECT 1;` } : migration,
          ),
        }),
      ).rejects.toThrow("migration checksum");
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  test("rejects tampered SQL before any database query or removal", async () => {
    const client = new Client();
    const query = spyOn(client, "query").mockImplementation(() => {
      throw new Error("database must not be reached");
    });
    try {
      await expect(
        inspectStagingRemovalPlan(client, {
          ...artifacts,
          migrations: artifacts.migrations.map((migration, index) =>
            index === 0 ? { ...migration, sql: `${migration.sql}\nSELECT 1;` } : migration,
          ),
        }),
      ).rejects.toThrow("migration checksum");
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  test("rejects a tampered manifest before any database query or removal", async () => {
    const client = new Client();
    const query = spyOn(client, "query").mockImplementation(() => {
      throw new Error("database must not be reached");
    });
    try {
      await expect(
        inspectStagingRemovalPlan(client, { ...artifacts, manifest: `${artifacts.manifest}\n` }),
      ).rejects.toThrow("manifest digest");
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });
});
