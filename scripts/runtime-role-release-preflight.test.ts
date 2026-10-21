import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import {
  moneyTableInventoryViolations,
  REWARDS_MONEY_TABLE_PATTERN,
  REWARDS_MONEY_TABLES,
  REWARDS_MONEY_TABLES_AFTER_0232,
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

// Recognize only these reviewed migration ACL shapes, not arbitrary SQL or
// effective database privileges. The isolated PG/role gate still proves those.
function reviewedMoneyTableRevocations(
  migration: string,
  sql: string,
  expected: readonly string[],
): string[] {
  const tags: Readonly<Record<string, string>> = {
    "0242_reward_operations_run_lease.sql": "lease_permissions",
    "0276_reward_wallet_nonce_authority_v2.sql": "permissions",
    "0277_song_megapot_contributions_v2.sql": "acl",
    "0278_reward_principal_seals_v2.sql": "principal_acl",
  };
  const tag = tags[migration];
  if (!tag) throw new Error("unreviewed money ACL form");
  const uncommented = sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/--[^\n]*/gu, "");
  const body = new RegExp(`DO\\s+\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$\\s*;`, "u").exec(
    uncommented,
  )?.[1];
  if (!body) throw new Error("money ACL block missing");
  const compact = (text: string) => text.replace(/\s+/gu, "").toLowerCase();
  const requirePart = (part: string, message: string, source = body) => {
    if (!compact(source).includes(compact(part))) throw new Error(message);
  };
  const names = (list: string | undefined) => {
    if (!list) throw new Error("money table coverage missing");
    return list.split(",").map((item) => {
      const match = /^\s*'([a-z][a-z0-9_]*)'\s*$/u.exec(item);
      if (!match?.[1]) throw new Error("money table coverage malformed");
      return match[1];
    });
  };
  const requireRevoke = (source: string, command: string, binding: string, message: string) => {
    // Check the SQL string itself as well as its identifier/role binding; a
    // function revoke, a commented revoke or a different table cannot count.
    if (!source.includes(`'${command}'`)) throw new Error(message);
    requirePart(`EXECUTE format('${command}',${binding});`, message, source);
  };
  let tables: string[];
  if (tag === "lease_permissions") {
    tables = names(
      /FOREACH\s+table_name\s+IN\s+ARRAY\s+ARRAY\s*\[([^\]]*)\]\s+LOOP/u.exec(body)?.[1],
    );
    requireRevoke(
      body,
      "REVOKE ALL ON TABLE %I FROM PUBLIC",
      "table_name",
      "PUBLIC revocation missing",
    );
    requirePart(
      `FOR role_name IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass(table_name) AND a.grantee<>0 AND a.grantee<>c.relowner LOOP`,
      "inherited table ACL scope missing",
    );
    requireRevoke(
      body,
      "REVOKE ALL ON TABLE %I FROM %I",
      "table_name,role_name",
      "inherited revocation missing",
    );
  } else if (tag === "permissions") {
    // 0276 has one literal table; stop before the independent function ACL loop.
    const tableAcl = body.split(/FOR\s+f\s+IN\s+SELECT/u)[0] ?? "";
    const table = /WHERE\s+c\.oid='([a-z][a-z0-9_]*)'::regclass/u.exec(tableAcl)?.[1];
    tables = table ? [table] : [];
    if (!table) throw new Error("money table coverage missing");
    requirePart("trusted TEXT := current_schema();", "table namespace/owner scope missing");
    requirePart(
      `REVOKE ALL ON ${table} FROM PUBLIC CASCADE;`,
      "PUBLIC revocation missing",
      tableAcl,
    );
    requirePart(
      `FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid='${table}'::regclass AND a.grantee<>0 AND a.grantee<>c.relowner
      LOOP`,
      "inherited table ACL scope missing",
      tableAcl,
    );
    requireRevoke(
      tableAcl,
      `REVOKE ALL ON %I.${table} FROM %I CASCADE`,
      "trusted,r",
      "inherited revocation missing",
    );
  } else {
    // 0277/0278 enumerate owned tables from pg_class, not pg_proc. Restrict
    // observation to that table loop so function revokes cannot fill a hole.
    const functionLoop = body.search(/FOR\s+x\s+IN\s+SELECT[^;]*\bFROM\s+pg_proc\b/u);
    if (functionLoop < 0) throw new Error("money table ACL boundary missing");
    const tableAcl = body.slice(0, functionLoop);
    tables = names(/(?:c\.)?relname\s+IN\s*\(([^)]*)\)\s+LOOP/u.exec(tableAcl)?.[1]);
    const alias = tag === "acl" ? "c." : "";
    requirePart("trusted TEXT:=current_schema();", "table namespace/owner scope missing");
    requirePart(
      `FOR x IN SELECT ${alias}oid,${alias}relname,${alias}relowner
      FROM pg_class ${alias ? "c" : ""} WHERE ${alias}relnamespace=to_regnamespace(trusted)
      AND ${alias}relname IN (`,
      "table namespace/owner scope missing",
      tableAcl,
    );
    requireRevoke(
      tableAcl,
      "REVOKE ALL ON %I.%I FROM PUBLIC CASCADE",
      "trusted,x.relname",
      "PUBLIC revocation missing",
    );
    requirePart(
      `FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=x.oid AND a.grantee<>0 AND a.grantee<>x.relowner LOOP`,
      "inherited table ACL scope missing",
      tableAcl,
    );
    requireRevoke(
      tableAcl,
      "REVOKE ALL ON %I.%I FROM %I CASCADE",
      "trusted,x.relname,r.name",
      "inherited revocation missing",
    );
  }
  if (JSON.stringify(tables) !== JSON.stringify(expected))
    throw new Error("money table coverage mismatch");
  return tables;
}

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
      .map((match) => {
        if (!match[1]) throw new Error("money schema table name missing");
        return match[1];
      })
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
    const laterTables = REWARDS_MONEY_TABLES_AFTER_0232;
    const later = Object.values(laterTables).flat();
    expect([...array.matchAll(/'([a-z][a-z0-9_]*)'/gu)].map((match) => match[1])).toEqual(
      REWARDS_MONEY_TABLES.filter((table) => !later.includes(table)),
    );
    for (const [migration, tables] of Object.entries(laterTables)) {
      const laterSql = await Bun.file(
        new URL(`../db/postgres/migrations/${migration}`, import.meta.url),
      ).text();
      expect(reviewedMoneyTableRevocations(migration, laterSql, tables)).toEqual([...tables]);
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

  test("each reviewed ACL form refuses missing coverage, PUBLIC/inherited revokes and foreign ACL scope", async () => {
    for (const [migration, tables] of Object.entries(REWARDS_MONEY_TABLES_AFTER_0232)) {
      const sql = await Bun.file(
        new URL(`../db/postgres/migrations/${migration}`, import.meta.url),
      ).text();
      const first = tables[0];
      if (!first) throw new Error("reviewed table inventory empty");
      expect(() =>
        reviewedMoneyTableRevocations(migration, sql, [...tables, "reward_unreviewed"]),
      ).toThrow("money table coverage mismatch");
      expect(() => reviewedMoneyTableRevocations(migration, sql, tables.slice(1))).toThrow(
        "money table coverage mismatch",
      );
      expect(() =>
        reviewedMoneyTableRevocations(
          migration,
          sql.replaceAll(first, "reward_unreviewed"),
          tables,
        ),
      ).toThrow("money table coverage mismatch");
      const missingTable = migration.startsWith("0276_")
        ? sql.replace(`c.oid='${first}'::regclass`, "c.oid=NULL")
        : sql.replaceAll(`'${first}',`, "");
      expect(missingTable).not.toBe(sql);
      expect(() => reviewedMoneyTableRevocations(migration, missingTable, tables)).toThrow(
        migration.startsWith("0276_")
          ? "money table coverage missing"
          : "money table coverage mismatch",
      );
      const publicCommand = migration.startsWith("0242_")
        ? "REVOKE ALL ON TABLE %I FROM PUBLIC"
        : migration.startsWith("0276_")
          ? `REVOKE ALL ON ${first} FROM PUBLIC CASCADE`
          : "REVOKE ALL ON %I.%I FROM PUBLIC CASCADE";
      const inheritedCommand = migration.startsWith("0242_")
        ? "REVOKE ALL ON TABLE %I FROM %I"
        : migration.startsWith("0276_")
          ? `REVOKE ALL ON %I.${first} FROM %I CASCADE`
          : "REVOKE ALL ON %I.%I FROM %I CASCADE";
      const publicLine = sql.split("\n").find((line) => line.includes(publicCommand));
      if (!publicLine) throw new Error("reviewed PUBLIC revoke missing");
      expect(() =>
        reviewedMoneyTableRevocations(
          migration,
          sql.replace(publicLine, `-- ${publicLine}`),
          tables,
        ),
      ).toThrow("PUBLIC revocation missing");
      for (const [command, message] of [
        [publicCommand, "PUBLIC revocation missing"],
        [inheritedCommand, "inherited revocation missing"],
      ] as const) {
        expect(sql).toContain(command);
        expect(() =>
          reviewedMoneyTableRevocations(
            migration,
            sql.replace(command, command.replace("REVOKE ALL ON", "REVOKE SELECT ON")),
            tables,
          ),
        ).toThrow(message);
        expect(() =>
          reviewedMoneyTableRevocations(
            migration,
            sql.replace(command, command.replace("REVOKE ALL ON", "REVOKE ALL ON FUNCTION")),
            tables,
          ),
        ).toThrow(message);
      }
      expect(() =>
        reviewedMoneyTableRevocations(migration, sql.replace("c.relacl", "c.reloptions"), tables),
      ).toThrow("inherited table ACL scope missing");
      expect(() =>
        reviewedMoneyTableRevocations(
          migration,
          sql.replace(/a\.grantee\s*<>\s*0/u, "TRUE"),
          tables,
        ),
      ).toThrow("inherited table ACL scope missing");
    }
  });
});
