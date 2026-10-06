import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import {
  moneyTableInventoryViolations,
  REWARDS_MONEY_TABLE_PATTERN,
  REWARDS_MONEY_TABLES,
} from "./rewards-money-write-contract.ts";

import {
  assertMainLedger,
  privilegeViolations,
  RUNTIME_RELEASE_PRIVILEGES,
} from "./runtime-role-release-preflight.ts";

const facts = RUNTIME_RELEASE_PRIVILEGES.map((requirement) => ({
  object: requirement.object,
  privilege: requirement.privilege,
  expected: requirement.allowed,
  exists: true,
  allowed: requirement.allowed,
}));

describe("runtime role release preflight", () => {
  test("covers direct table operations in reward, Megapot, custody and Wallet repositories", async () => {
    const covered = new Set(
      RUNTIME_RELEASE_PRIVILEGES.filter((requirement) => requirement.allowed).map(
        (requirement) => `${requirement.object}:${requirement.privilege}`,
      ),
    );
    const schema = await Bun.file(new URL("../db/postgres/schema.sql", import.meta.url)).text();
    const tables = new Set(
      [
        ...schema.matchAll(
          /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:api_next\.)?"?([a-z][a-z0-9_]*)"?/giu,
        ),
      ].map((match) => match[1]),
    );
    expect(tables.has("wallet_sponsored_sends")).toBe(true);
    const directory = new URL("../packages/platform-cf/src/", import.meta.url);
    const repositories = (await readdir(directory, { recursive: true }))
      .filter((source) =>
        /(?:^|\/)(?:reward|megapot|wallet|song-reward|custody)-.*-repository\.ts$/u.test(source),
      )
      .sort();
    for (const required of [
      "custody-solvency-repository.ts",
      "megapot-purchase-repository.ts",
      "megapot-sweep-repository.ts",
      "reward-gas-topup-repository.ts",
      "reward-payout-repository.ts",
      "reward-refund-repository.ts",
      "song-reward-offer-repository.ts",
      "wallet-sponsored-send-repository.ts",
    ]) {
      expect(repositories).toContain(required);
    }
    const sources = [...repositories, "reward-claim-verification-intent.ts"];
    const missing = new Set<string>();
    for (const source of sources) {
      const body = await Bun.file(new URL(source, directory)).text();
      for (const match of body.matchAll(
        /\b(FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([a-z][a-z0-9_]*)\b/gu,
      )) {
        const table = match[2];
        if (!table || !tables.has(table)) continue;
        const operation =
          match[1] === "FROM" || match[1] === "JOIN"
            ? "SELECT"
            : match[1] === "INTO"
              ? "INSERT"
              : match[1]?.startsWith("DELETE")
                ? "DELETE"
                : "UPDATE";
        if (!covered.has(`${table}:${operation}`)) missing.add(`${source}: ${table}:${operation}`);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });

  test("accepts the reviewed claim and Wallet privilege contract", () => {
    expect(privilegeViolations(facts)).toEqual([]);
  });

  test("refuses a missing sponsored-send table grant before activation", () => {
    const withoutInsert = facts.map((fact) =>
      fact.object === "wallet_sponsored_sends" && fact.privilege === "INSERT"
        ? { ...fact, allowed: false }
        : fact,
    );
    expect(privilegeViolations(withoutInsert)).toEqual(["wallet_sponsored_sends: INSERT mismatch"]);
  });

  test("refuses a missing claim routine and unsafe direct claim-table write", () => {
    const broken = facts.map((fact) =>
      fact.object === "accept_megapot_participant_claim_v1(text,text)"
        ? { ...fact, exists: false, allowed: false }
        : fact.object === "megapot_participant_claims" && fact.privilege === "UPDATE"
          ? { ...fact, allowed: true }
          : fact,
    );
    expect(privilegeViolations(broken)).toEqual([
      "megapot_participant_claims: UPDATE mismatch",
      "accept_megapot_participant_claim_v1(text,text): EXECUTE object missing",
    ]);
  });

  test("requires the exact migration filenames and checksums of the release source", () => {
    const plan = [
      { version: "0226_reward_sponsored_send_reservations.sql", checksum: "a" },
      { version: "0227_wallet_sponsored_send_scope.sql", checksum: "b" },
    ];
    expect(() => assertMainLedger(plan, plan)).not.toThrow();
    expect(() =>
      assertMainLedger(
        [
          { version: "0225_reward_sponsored_send_reservations.sql", checksum: "a" },
          { version: "0226_wallet_sponsored_send_scope.sql", checksum: "b" },
        ],
        plan,
      ),
    ).toThrow("mismatch at position 1");
    expect(() => assertMainLedger(plan.slice(0, 1), plan)).toThrow("length mismatch");
    expect(() =>
      assertMainLedger(
        [plan[0] as (typeof plan)[number], { ...plan[1], checksum: "changed" }],
        plan,
      ),
    ).toThrow("mismatch at position 2");
  });
});

describe("destructive money-table inventory", () => {
  test("requires reviewed coverage of every matching schema table and the actual migration", async () => {
    const schema = await Bun.file(new URL("../db/postgres/schema.sql", import.meta.url)).text();
    const actual = [...schema.matchAll(/\bCREATE TABLE ([a-z][a-z0-9_]*) /gu)]
      .map((match) => match[1])
      .filter((table) => new RegExp(REWARDS_MONEY_TABLE_PATTERN).test(table));
    expect(moneyTableInventoryViolations(actual)).toEqual([]);
    const sql = await Bun.file(
      new URL(
        "../db/postgres/migrations/0232_reward_money_destructive_privileges.sql",
        import.meta.url,
      ),
    ).text();
    const array = sql.split("FOREACH table_name IN ARRAY ARRAY[")[1]?.split("] LOOP")[0] ?? "";
    // Tables created after 0232 have their inherited privileges removed by the
    // migration that creates them, which is checked here in the same way.
    const laterTables: Record<string, readonly string[]> = {
      "0242_reward_operations_run_lease.sql": [
        "reward_operations_run_lease",
        "reward_operations_run_lease_events",
      ],
    };
    const later = Object.values(laterTables).flat();
    expect([...array.matchAll(/'([a-z][a-z0-9_]*)'/gu)].map((match) => match[1])).toEqual(
      REWARDS_MONEY_TABLES.filter((table) => !later.includes(table)),
    );
    for (const [migration, tables] of Object.entries(laterTables)) {
      const laterSql = await Bun.file(
        new URL(`../db/postgres/migrations/${migration}`, import.meta.url),
      ).text();
      const revoked =
        laterSql.split("FOREACH table_name IN ARRAY ARRAY[")[1]?.split("] LOOP")[0] ?? "";
      expect([...revoked.matchAll(/'([a-z][a-z0-9_]*)'/gu)].map((match) => match[1])).toEqual([
        ...tables,
      ]);
      expect(laterSql).toContain(
        "EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name)",
      );
      expect(laterSql).toContain(
        "EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name)",
      );
    }
    const seen = new Set<string>();
    for (const requirement of RUNTIME_RELEASE_PRIVILEGES) {
      const key = `${requirement.object}:${requirement.privilege}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (const table of REWARDS_MONEY_TABLES)
      for (const privilege of ["DELETE", "TRUNCATE"] as const)
        expect(
          RUNTIME_RELEASE_PRIVILEGES.find(
            (row) => row.object === table && row.privilege === privilege,
          )?.allowed,
        ).toBe(false);
  });
  test("refuses unknown or missing money tables instead of treating them as reviewed", () => {
    expect(
      moneyTableInventoryViolations([...REWARDS_MONEY_TABLES, "reward_future_ledger"]),
    ).toEqual(["reward_future_ledger: money table unreviewed"]);
    expect(
      moneyTableInventoryViolations(
        REWARDS_MONEY_TABLES.filter((table) => table !== "reward_ledger_credits"),
      ),
    ).toEqual(["reward_ledger_credits: money table missing"]);
  });
});
