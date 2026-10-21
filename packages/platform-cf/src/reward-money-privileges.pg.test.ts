import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  moneyTableInventoryViolations,
  REWARDS_MONEY_TABLE_PATTERN,
  REWARDS_MONEY_TABLES,
  REWARDS_MONEY_TABLES_AFTER_0232,
} from "../../../scripts/rewards-money-write-contract.ts";

import { assertRuntimeMoneyInventory } from "../../../scripts/runtime-role-release-preflight.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw Error("Test URL required");
const suite = url ? describe : describe.skip;
const migration = () =>
  Bun.file(
    new URL(
      "../../../db/postgres/migrations/0232_reward_money_destructive_privileges.sql",
      import.meta.url,
    ),
  ).text();

// Tables created after 0232 are outside what that migration revoked. Their own
// migrations restrict them, which is tested where they are introduced.
const laterTables = Object.values(REWARDS_MONEY_TABLES_AFTER_0232).flat();
const coveredBy0232: readonly string[] = REWARDS_MONEY_TABLES.filter(
  (table) => !laterTables.includes(table),
);

suite("reviewed rewards money destructive privileges", () => {
  test("SOURCE ONLY CP5 removes inherited/default new-object authority and binds exact purposes", async () => {
    if (!url) throw new Error("Test URL required");
    const suffix = `${process.pid}_${Date.now()}`,
      schema = `funding_acl_${suffix}`,
      parent = `funding_parent_${suffix}`,
      runtime = `funding_http_${suffix}`,
      observer = `funding_observer_${suffix}`;
    const admin = new Client({ connectionString: url });
    const writer = new Client({ connectionString: url });
    await admin.connect();
    await writer.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}";SET search_path TO "${schema}"`);
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      const migrations = await loadPostgresMigrations();
      const boundary =
        migrations.findIndex((m) => m.version === "0276_reward_wallet_nonce_authority_v2.sql") + 1;
      if (boundary !== 276) throw new Error("Expected exact maintained276 prefix");
      const prefix = await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: migrations.slice(0, boundary),
        expectedLedger: [],
      });
      if (prefix.dryRun) throw new Error("Expected actual isolated migration prefix");
      expect(prefix.result.currentVersion).toBe("0276_reward_wallet_nonce_authority_v2.sql");
      await admin.query(
        `CREATE ROLE "${parent}";CREATE ROLE "${runtime}";CREATE ROLE "${observer}";GRANT "${parent}" TO "${runtime}";GRANT USAGE ON SCHEMA "${schema}" TO "${parent}","${observer}";ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${parent}";ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${parent}"`,
      );
      for (const file of [
        "0277_song_megapot_contributions_v2.sql",
        "0278_reward_principal_seals_v2.sql",
        "0279_reward_contribution_privileges_v2.sql",
      ])
        await admin.query(
          await Bun.file(
            new URL(`../../../db/postgres/migrations/${file}`, import.meta.url),
          ).text(),
        );
      await writer.query(`SET search_path TO "${schema}";SET ROLE "${runtime}"`);
      const acl = await writer.query(
        "SELECT has_table_privilege(current_user,'song_megapot_contributions_v2','SELECT') AS read,has_table_privilege(current_user,'song_megapot_contributions_v2','INSERT') AS write,has_table_privilege(current_user,'reward_late_principal_liabilities_v2','UPDATE') AS complete,has_table_privilege(current_user,'reward_incoming_receipts_v2','DELETE') AS remove,has_table_privilege(current_user,'reward_incoming_receipts_v2','TRUNCATE') AS truncate,has_function_privilege(current_user,'create_song_contribution_v2(jsonb,jsonb,text)','EXECUTE') AS issue",
      );
      expect(acl.rows).toEqual([
        {
          read: false,
          write: false,
          complete: false,
          remove: false,
          truncate: false,
          issue: false,
        },
      ]);
      await expect(
        writer.query("SELECT bind_reward_contribution_purpose_v2($1,'http_commands')", [runtime]),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query("SELECT bind_reward_contribution_purpose_v2($1,'http_commands')", [
        runtime,
      ]);
      await admin.query("SELECT bind_reward_contribution_purpose_v2($1,'incoming_observer')", [
        observer,
      ]);
      expect(
        (
          await writer.query(
            "SELECT has_function_privilege(current_user,'create_song_contribution_v2(jsonb,jsonb,text)','EXECUTE') AS issue,has_function_privilege(current_user,'accept_reward_funding_principal_v2(jsonb)','EXECUTE') AS confirm,has_function_privilege(current_user,'insert_song_contribution_command_v2(jsonb,jsonb)','EXECUTE') AS raw_command",
          )
        ).rows,
      ).toEqual([{ issue: true, confirm: false, raw_command: false }]);
      expect(
        (
          await writer.query(
            "SELECT has_function_privilege(current_user,'record_song_recovery_evidence_v2(text,text,jsonb)','EXECUTE') AS attest,has_function_privilege(current_user,'claim_song_funding_work_v2(text,text)','EXECUTE') AS job",
          )
        ).rows,
      ).toEqual([{ attest: false, job: false }]);
      await expect(writer.query("DELETE FROM reward_incoming_receipts_v2")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(writer.query("TRUNCATE song_megapot_contributions_v2")).rejects.toMatchObject({
        code: "42501",
      });
      await writer.query(`SET ROLE "${observer}"`);
      expect(
        (
          await writer.query(
            "SELECT has_function_privilege(current_user,'accept_reward_funding_principal_v2(jsonb)','EXECUTE') AS confirm,has_function_privilege(current_user,'update_song_contribution_command_v2(jsonb,jsonb,jsonb,jsonb)','EXECUTE') AS claim,has_table_privilege(current_user,'reward_late_principal_liabilities_v2','UPDATE') AS complete",
          )
        ).rows,
      ).toEqual([{ confirm: true, claim: false, complete: false }]);
      expect(
        (
          await writer.query(
            "SELECT has_function_privilege(current_user,'record_song_recovery_evidence_v2(text,text,jsonb)','EXECUTE') AS attest",
          )
        ).rows,
      ).toEqual([{ attest: false }]);
      await admin.query("SELECT bind_reward_contribution_purpose_v2($1,'funding_recovery_jobs')", [
        observer,
      ]);
      expect(
        (
          await writer.query(
            "SELECT has_function_privilege(current_user,'record_song_recovery_evidence_v2(text,text,jsonb)','EXECUTE') AS attest,has_function_privilege(current_user,'claim_song_funding_work_v2(text,text)','EXECUTE') AS work,has_function_privilege(current_user,'song_funding_work_packet_v2(reward_funding_work_envelopes_v2)','EXECUTE') AS internal,has_function_privilege(current_user,'update_song_contribution_command_v2(jsonb,jsonb,jsonb,jsonb)','EXECUTE') AS grant,has_table_privilege(current_user,'reward_funding_schedule_witnesses_v2','INSERT') AS raw_write",
          )
        ).rows,
      ).toEqual([{ attest: true, work: true, internal: false, grant: false, raw_write: false }]);
      expect(
        (
          await admin.query(
            "SELECT proconfig FROM pg_proc WHERE oid='accept_reward_funding_principal_v2(jsonb)'::regprocedure",
          )
        ).rows[0].proconfig,
      ).toContain(`search_path=pg_catalog, ${schema}, pg_temp`);
      // No new sequence is used to smuggle inherited money authority.
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S' AND c.relname ~ '(contribution|principal|funding_.*_v2)'",
            [schema],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await writer.end();
      await admin.query("RESET search_path");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      for (const role of [runtime, observer, parent])
        if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount)
          await admin.query(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);
      await admin.end();
    }
  }, 120_000);
  test("revokes direct, inherited and PUBLIC destruction while retaining runtime writes and unrelated defaults", async () => {
    if (!url) throw Error("Test URL required");
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `money_acl_${suffix}`;
    const parent = `money_parent_${suffix}`;
    const runtime = `money_runtime_${suffix}`;
    const direct = `money_direct_${suffix}`;
    const admin = new Client({ connectionString: url });
    const writer = new Client({ connectionString: url });
    await Promise.all([admin.connect(), writer.connect()]);
    try {
      await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(
        `CREATE ROLE "${parent}"; CREATE ROLE "${runtime}"; CREATE ROLE "${direct}"; GRANT "${parent}" TO "${runtime}"; GRANT USAGE ON SCHEMA "${schema}" TO "${parent}","${direct}"; GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA "${schema}" TO "${parent}","${direct}" WITH GRANT OPTION; SET ROLE "${parent}"; GRANT DELETE ON reward_ledger_credits TO "${runtime}"; RESET ROLE; GRANT DELETE,TRUNCATE ON reward_ledger_credits TO PUBLIC; ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "${parent}"; CREATE TABLE unrelated_retention(id text)`,
      );
      // The blanket grant above also reached the later tables. Their creating
      // migration leaves runtime roles read access only, so that is restored
      // here; 0232 is not expected to touch them.
      await admin.query(
        `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ${laterTables.join(",")} FROM "${parent}","${direct}" CASCADE`,
      );
      await writer.query(`SET search_path TO "${schema}"; SET ROLE "${runtime}"`);
      const grants = () =>
        writer.query<{
          object: string;
          read: boolean;
          insert: boolean;
          update: boolean;
          remove: boolean;
          truncate: boolean;
        }>(
          "SELECT c.relname AS object,has_table_privilege(current_user,c.oid,'SELECT') AS read,has_table_privilege(current_user,c.oid,'INSERT') AS insert,has_table_privilege(current_user,c.oid,'UPDATE') AS update,has_table_privilege(current_user,c.oid,'DELETE') AS remove,has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND c.relname ~ $2 ORDER BY c.relname",
          [schema, REWARDS_MONEY_TABLE_PATTERN],
        );
      const before = (await grants()).rows;
      expect(moneyTableInventoryViolations(before.map((row) => row.object))).toEqual([]);
      const inScope = <Row extends { object: string }>(rows: readonly Row[]) =>
        rows.filter((row) => coveredBy0232.includes(row.object));
      const outOfScope = <Row extends { object: string }>(rows: readonly Row[]) =>
        rows.filter((row) => laterTables.includes(row.object));
      expect(inScope(before)).toHaveLength(coveredBy0232.length);
      expect(inScope(before).every((row) => row.remove && row.truncate)).toBe(true);
      await admin.query(await migration());
      const after = (await grants()).rows;
      expect(after).toHaveLength(REWARDS_MONEY_TABLES.length);
      expect(
        inScope(after).every(
          (row) => row.read && row.insert && row.update && !row.remove && !row.truncate,
        ),
      ).toBe(true);
      // 0232 neither widened nor narrowed the later tables: still read only.
      expect(outOfScope(after)).toHaveLength(laterTables.length);
      expect(
        outOfScope(after).every(
          (row) => row.read && !row.insert && !row.update && !row.remove && !row.truncate,
        ),
      ).toBe(true);
      await expect(writer.query("DELETE FROM reward_ledger_credits")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(writer.query("TRUNCATE reward_ledger_credits")).rejects.toMatchObject({
        code: "42501",
      });
      await writer.query(`SET ROLE "${direct}"`);
      expect((await grants()).rows.every((row) => !row.remove && !row.truncate)).toBe(true);
      const retained = await admin.query<{ owner: string; remove: boolean; truncate: boolean }>(
        "SELECT current_user AS owner,has_table_privilege(current_user,'reward_ledger_credits','DELETE') AS remove,has_table_privilege(current_user,'reward_ledger_credits','TRUNCATE') AS truncate",
      );
      expect(retained.rows[0]).toMatchObject({ remove: true, truncate: true });
      await writer.query(`SET ROLE "${runtime}"`);
      await writer.query(
        "INSERT INTO unrelated_retention VALUES('retained'); DELETE FROM unrelated_retention WHERE id='retained'",
      );
      await expect(assertRuntimeMoneyInventory(writer, schema)).resolves.toBeUndefined();
      await admin.query("CREATE TABLE reward_unreviewed_fixture(id text)");
      expect(
        (
          await writer.query(
            "SELECT has_table_privilege(current_user,'reward_unreviewed_fixture','DELETE') AS remove",
          )
        ).rows,
      ).toEqual([{ remove: true }]);
      expect(moneyTableInventoryViolations((await grants()).rows.map((row) => row.object))).toEqual(
        ["reward_unreviewed_fixture: money table unreviewed"],
      );
      await expect(assertRuntimeMoneyInventory(writer, schema)).rejects.toThrow(
        "money table unreviewed",
      );
      await admin.query(
        `DROP TABLE reward_unreviewed_fixture; GRANT CREATE ON SCHEMA "${schema}" TO "${runtime}"; ALTER TABLE reward_ledger_credits OWNER TO "${runtime}"; REVOKE DELETE,TRUNCATE ON reward_ledger_credits FROM "${runtime}"`,
      );
      await expect(assertRuntimeMoneyInventory(writer, schema)).rejects.toThrow(
        "table-owner authority",
      );
    } finally {
      await writer.end();
      await admin.query("RESET search_path");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      for (const role of [runtime, parent, direct]) {
        if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount)
          await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
      }
      await admin.end();
    }
  }, 30000);
});
