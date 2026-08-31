import { describe, expect, test } from "bun:test";
import { applyPostgresTestBaseline } from "./postgres.ts";

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
});
