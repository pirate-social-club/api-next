import { expect, test } from "bun:test";
import type { Client } from "pg";
import { fingerprintRehearsalData } from "./staging-persona-rehearsal-inventory";

test.each(["f", "m"])(
  "rehearsal fingerprint refuses unsupported stored relation %s and rolls back",
  async (relkind) => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: sql.includes("SELECT relname") ? [{ relname: "remote", relkind }] : [] };
      },
    } as unknown as Client;
    await expect(fingerprintRehearsalData(client)).rejects.toThrow("data_classes_unproven");
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.some((sql) => sql.includes("FROM ONLY"))).toBe(false);
  },
);

test("rehearsal fingerprint preserves rollback on a relation read failure", async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM ONLY")) throw new Error("fixture_read_failed");
      return { rows: sql.includes("SELECT relname") ? [{ relname: "local", relkind: "r" }] : [] };
    },
  } as unknown as Client;
  await expect(fingerprintRehearsalData(client)).rejects.toThrow("fixture_read_failed");
  expect(statements.at(-1)).toBe("ROLLBACK");
});
