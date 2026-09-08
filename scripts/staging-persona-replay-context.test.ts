import { expect, test } from "bun:test";
import type { Client } from "pg";
import { prepareStagingReplayContext } from "./staging-persona-replay-context";

const expected = { transactionId: "123", schemaOid: 456, statementTimeoutMs: 120_000 };
function fixture(
  options: { wrongSchema?: boolean; changedTransaction?: boolean; temp?: boolean } = {},
) {
  const calls: { sql: string; values: unknown }[] = [];
  let identities = 0;
  const query = async (sql: string, values?: unknown) => {
    calls.push({ sql, values });
    if (sql.includes("AS transaction_id")) {
      identities++;
      return {
        rows: [
          {
            transaction_id: options.changedTransaction && identities > 1 ? "124" : "123",
            schema_oid: options.wrongSchema ? 999 : 456,
            isolation: "read committed",
          },
        ],
      };
    }
    if (sql.includes("AS target"))
      return {
        rows: [
          {
            target: "api_next",
            schemas: options.temp
              ? ["pg_temp_1", "api_next", "pg_catalog"]
              : ["api_next", "pg_catalog"],
          },
        ],
      };
    return { rows: [] };
  };
  return { calls, admin: { query } as unknown as Pick<Client, "query"> };
}

test("restores the exact replay path and requires an explicit bounded timeout", async () => {
  const f = fixture();
  await prepareStagingReplayContext(f.admin, expected);
  expect(f.calls[1]?.sql).toBe("SET LOCAL search_path = api_next, pg_catalog");
  expect(f.calls[2]?.values).toEqual(["120000ms"]);
  expect(f.calls).toHaveLength(5);
});

test("rejects a replaced schema before changing replay settings", async () => {
  const f = fixture({ wrongSchema: true });
  await expect(prepareStagingReplayContext(f.admin, expected)).rejects.toThrow(
    "reset_replay_identity_changed",
  );
  expect(f.calls).toHaveLength(1);
});

test("rejects a transaction change and an implicit temporary namespace", async () => {
  for (const options of [{ changedTransaction: true }, { temp: true }]) {
    await expect(prepareStagingReplayContext(fixture(options).admin, expected)).rejects.toThrow();
  }
});

test("refuses an unbounded or malformed timeout before querying", async () => {
  for (const timeout of [0, -1, 600_001, 1.5, Number.NaN]) {
    const f = fixture();
    await expect(
      prepareStagingReplayContext(f.admin, { ...expected, statementTimeoutMs: timeout }),
    ).rejects.toThrow("reset_replay_context_invalid");
    expect(f.calls).toHaveLength(0);
  }
});
