import { expect, test } from "bun:test";
import type { Client } from "pg";
import { observeInplaceInventory } from "./staging-persona-inplace-inventory";

test("rejects a different SQL database before reading schema objects and rolls back", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return {
        rows: sql.startsWith("SELECT current_database") ? [{ target: false, direct: true }] : [],
      };
    },
  } as unknown as Client;
  await expect(observeInplaceInventory(client)).rejects.toThrow(
    "inplace_catalog_inventory_unproven",
  );
  expect(calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(calls.at(-1)).toBe("ROLLBACK");
  expect(calls.some((sql) => sql.includes("schema_migrations"))).toBe(false);
});

test("rejects a different migration ledger before the ownership inventory", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return {
        rows: sql.startsWith("SELECT current_database") ? [{ target: true, direct: true }] : [],
      };
    },
  } as unknown as Client;
  await expect(observeInplaceInventory(client)).rejects.toThrow(
    "inplace_catalog_inventory_unproven",
  );
  expect(calls.at(-1)).toBe("ROLLBACK");
  expect(calls.some((sql) => sql.includes("pg_identify_object"))).toBe(false);
});

test("redacts catalog failures and does not attach their cause", async () => {
  const client = {
    query: async () => {
      throw new Error("private connection fixture");
    },
  } as unknown as Client;
  try {
    await observeInplaceInventory(client);
    throw new Error("unexpected success");
  } catch (error) {
    expect((error as Error).message).toBe("inplace_catalog_inventory_unproven");
    expect((error as Error).cause).toBeUndefined();
  }
});
