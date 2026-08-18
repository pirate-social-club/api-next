import { describe, expect, test } from "bun:test";
import { COMMUNITY_PURCHASE_FUNDING_ALLOWED_TRANSITIONS } from "@pirate/domain";

// Reducer/trigger parity: the Postgres journal update guard must accept
// exactly the transition edges the domain reducer can produce — never more,
// never fewer. Parsed from the cumulative schema and from migration 0018,
// which replaced the guard with exactly one new planned → reconciliation_required
// edge.

function matrixFromSql(sql: string): Readonly<Record<string, readonly string[]>> {
  const matrix: Record<string, string[]> = {};
  const inList = /OLD\.state = '([a-z_]+)' AND NEW\.state IN \(([^)]+)\)/g;
  for (const match of sql.matchAll(inList)) {
    const from = match[1];
    const targets = match[2];
    if (from === undefined || targets === undefined) throw new Error("unparseable guard edge");
    matrix[from] = targets
      .split(",")
      .map((target) => target.trim().replaceAll("'", ""))
      .sort();
  }
  const single = /OLD\.state = '([a-z_]+)' AND NEW\.state = '([a-z_]+)'/g;
  for (const match of sql.matchAll(single)) {
    const from = match[1];
    const target = match[2];
    if (from === undefined || target === undefined) throw new Error("unparseable guard edge");
    matrix[from] = [target];
  }
  return matrix;
}

function matrixFromDomain(): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(COMMUNITY_PURCHASE_FUNDING_ALLOWED_TRANSITIONS).map(([from, targets]) => [
      from,
      [...targets].sort(),
    ]),
  );
}

describe("community-purchase funding trigger/reducer parity", () => {
  test("the cumulative schema guard accepts exactly the reducer's transition matrix", async () => {
    const schema = await Bun.file(
      new URL("../../../db/postgres/schema.sql", import.meta.url),
    ).text();
    const guardStart = schema.indexOf("guard_community_purchase_funding_journal_update");
    const guardEnd = schema.indexOf("$$;", guardStart);
    if (guardStart < 0 || guardEnd < 0) {
      throw new Error("journal update guard missing from cumulative schema");
    }
    expect(matrixFromSql(schema.slice(guardStart, guardEnd))).toEqual(matrixFromDomain());
  });

  test("migration 0018 replaces the guard with exactly the same matrix", async () => {
    const migration = await Bun.file(
      new URL(
        "../../../db/postgres/migrations/0018_m3_planned_observation_expiry.sql",
        import.meta.url,
      ),
    ).text();
    const guardStart = migration.indexOf("guard_community_purchase_funding_journal_update");
    const guardEnd = migration.indexOf("$$;", guardStart);
    if (guardStart < 0 || guardEnd < 0) {
      throw new Error("journal update guard missing from migration 0018");
    }
    const matrix = matrixFromSql(migration.slice(guardStart, guardEnd));
    expect(matrix).toEqual(matrixFromDomain());
    expect(matrix.planned).toContain("reconciliation_required");
  });
});
