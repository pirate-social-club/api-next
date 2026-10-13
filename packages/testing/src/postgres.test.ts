import { describe, expect, test } from "bun:test";
import {
  applyPostgresTestBaseline,
  postgresTestSchemaCatalogFingerprint,
  preparePostgresTestBaselineReset,
  resetPostgresTestBaseline,
} from "./postgres.ts";

describe("PostgreSQL test baseline", () => {
  test("applies the tracked baseline atomically after binding the current schema", async () => {
    const queries: string[] = [];
    await applyPostgresTestBaseline({
      query: async (text) => {
        queries.push(text);
      },
    });

    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("target_schema TEXT := current_schema()");
    expect(queries[1]).toContain("pg_catalog.format('%I, pg_temp', target_schema)");
    expect(queries[2]).toContain("-- GENERATED FILE. DO NOT EDIT.");
    expect(queries.at(-1)).toBe("COMMIT");
  });

  test("rolls back when baseline application fails", async () => {
    const queries: string[] = [];
    const failure = new Error("baseline rejected");

    await expect(
      applyPostgresTestBaseline({
        query: async (text) => {
          queries.push(text);
          if (text.includes("-- GENERATED FILE. DO NOT EDIT.")) throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  test("does not mask the baseline failure when rollback also fails", async () => {
    const failure = new Error("baseline rejected");

    await expect(
      applyPostgresTestBaseline({
        query: async (text) => {
          if (text.includes("-- GENERATED FILE. DO NOT EDIT.")) throw failure;
          if (text === "ROLLBACK") throw new Error("connection lost");
        },
      }),
    ).rejects.toBe(failure);
  });

  test("resets baseline data atomically", async () => {
    const queries: string[] = [];
    await resetPostgresTestBaseline({
      query: async (text) => {
        queries.push(text);
      },
    });

    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("TRUNCATE TABLE");
    expect(queries[1]).toContain("RESTART IDENTITY CASCADE");
    expect(queries.at(-1)).toBe("COMMIT");
  });

  test("restores native financial guards before unchanged seeds and verifies after them", () => {
    const original =
      "-- GENERATED FILE. DO NOT EDIT.\nTRUNCATE TABLE fixture RESTART IDENTITY CASCADE;\nINSERT INTO fixture VALUES ('seed');";
    const wrapped = preparePostgresTestBaselineReset(original);
    const truncate = wrapped.indexOf("TRUNCATE TABLE fixture");
    const restore = wrapped.indexOf("DO $restore_empty_financial_reset_guards$");
    const seeds = wrapped.indexOf("INSERT INTO fixture VALUES ('seed')");
    const verify = wrapped.indexOf("DO $verify_empty_financial_reset$");
    expect(truncate).toBeGreaterThan(
      wrapped.indexOf("DISABLE TRIGGER disabled_owner_financial_dml"),
    );
    expect(restore).toBeGreaterThan(truncate);
    expect(seeds).toBeGreaterThan(restore);
    expect(verify).toBeGreaterThan(seeds);
    expect(wrapped).toContain("pg_advisory_xact_lock(83000003,1)");
    expect(wrapped).toContain("positive outstanding credits");
    expect(wrapped).toContain("LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE");
    expect(wrapped.indexOf("LOCK TABLE ONLY")).toBeLessThan(
      wrapped.indexOf("test reset cannot cascade outside"),
    );
    expect(wrapped).toContain("complete tracked reset relation inventory required");
    expect(wrapped).toContain("reset table custody did not stabilize");
    expect(wrapped).not.toContain("session_replication_role");
    expect(wrapped).not.toContain("DISABLE TRIGGER ALL");
    const restoredOriginal = wrapped
      .slice(wrapped.indexOf("-- GENERATED FILE. DO NOT EDIT."), verify)
      .replace(
        /\nDO \$restore_empty_financial_reset_guards\$[\s\S]*?\$restore_empty_financial_reset_guards\$;\n/u,
        "",
      )
      .trimEnd();
    expect(restoredOriginal).toBe(original);
  });

  test("refuses a missing or repeated reset boundary", () => {
    expect(() => preparePostgresTestBaselineReset("SELECT 1;")).toThrow("exactly one");
    expect(() =>
      preparePostgresTestBaselineReset("RESTART IDENTITY CASCADE; RESTART IDENTITY CASCADE;"),
    ).toThrow("exactly one");
    expect(() =>
      preparePostgresTestBaselineReset("TRUNCATE TABLE fixture, fixture RESTART IDENTITY CASCADE;"),
    ).toThrow("repeats a relation");
    expect(() =>
      preparePostgresTestBaselineReset(
        "TRUNCATE TABLE foreign_schema.fixture RESTART IDENTITY CASCADE;",
      ),
    ).toThrow("closed table identifier");
  });

  test("owned video reset refuses live/system/database identifiers before rendering SQL", () => {
    const sql = "TRUNCATE TABLE fixture RESTART IDENTITY CASCADE;";
    for (const ownedVideoDatabase of [
      "postgres",
      "api_next",
      "api_next_staging",
      "video_workflow_123",
      "api_next_video_1234567890123_deadbeef'",
      "api_next_video_123_deadbeef",
    ]) {
      expect(() => preparePostgresTestBaselineReset(sql, { ownedVideoDatabase })).toThrow(
        "Exact owned video fixture database required",
      );
    }
  });

  test("rolls back a reset refusal without masking it when rollback also fails", async () => {
    const queries: string[] = [];
    const refusal = new Error("native financial inventory refused");
    await expect(
      resetPostgresTestBaseline({
        query: async (text) => {
          queries.push(text);
          if (text.includes("DO $owned_empty_financial_reset$")) throw refusal;
          if (text === "ROLLBACK") throw new Error("connection cleanup failed");
        },
      }),
    ).rejects.toBe(refusal);
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  test("requires a catalog fingerprint result", async () => {
    await expect(
      postgresTestSchemaCatalogFingerprint({ query: async () => ({ rows: [] }) }),
    ).rejects.toThrow("catalog fingerprint was unavailable");
    await expect(
      postgresTestSchemaCatalogFingerprint({
        query: async (text) => {
          expect(text).toContain("pg_get_constraintdef");
          return { rows: [{ fingerprint: "catalog-hash" }] };
        },
      }),
    ).resolves.toBe("catalog-hash");
  });
});
