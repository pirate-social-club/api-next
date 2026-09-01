import { describe, expect, test } from "bun:test";
import {
  applyPostgresTestBaseline,
  postgresTestSchemaCatalogFingerprint,
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
