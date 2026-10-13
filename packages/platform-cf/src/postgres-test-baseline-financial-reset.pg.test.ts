import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  applyPostgresTestBaseline,
  postgresTestSchemaCatalogFingerprint,
  resetPostgresTestBaseline,
} from "@pirate/testing/postgres";
import { Client } from "pg";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("PostgreSQL test URL is required");
}
const suite = url ? describe : describe.skip;
const privateRelations = [
  "guest_owner_associations",
  "participation_eligibility_decisions",
  "megapot_owner_shares",
  "megapot_owner_snapshot_leaves",
  "megapot_owner_allocations",
  "reward_credit_persona_bindings",
  "reward_credit_recipient_selections",
] as const;
const privateFunctions = [
  "reject_disabled_owner_financial_dml_v1()",
  "guard_disabled_beneficiary_dispatch_v1()",
  "guard_disabled_owner_credit_dispatch_v1()",
  "require_megapot_beneficiary_version_private_v1(text,numeric,smallint)",
  "guest_financial_component_has_history_private_v1(text[])",
  "require_disabled_owner_financial_inventory_private_v1()",
] as const;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function finite<A>(work: Promise<A>, milliseconds: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned PostgreSQL fixture operation timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withOwnedBaseline(
  work: (admin: Client, reader: Client, schema: string) => Promise<void>,
): Promise<void> {
  if (!url) throw new Error("PostgreSQL test URL is required");
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("This destructive fixture requires an owned loopback PostgreSQL server");
  }
  const nonce = randomUUID().replaceAll("-", "");
  const schema = `api_next_hns_observer_${nonce}`;
  const role = `financial_reset_reader_${nonce}`;
  // Disposable synthetic role password only; no provider/session credential.
  const password = randomUUID();
  const admin = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  let reader: Client | undefined;
  let primary: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await finite(admin.connect(), 5000);
    await admin.query(`CREATE SCHEMA ${quote(schema)}; SET search_path TO ${quote(schema)}`);
    await applyPostgresTestBaseline(admin);
    await admin.query(
      `CREATE ROLE ${quote(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'; GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`,
    );
    const readerUrl = new URL(url);
    readerUrl.username = role;
    readerUrl.password = password;
    readerUrl.searchParams.set("options", `-c search_path=${schema}`);
    reader = new Client({
      connectionString: readerUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 11000,
    });
    await finite(reader.connect(), 5000);
    expect((await reader.query("SELECT current_user,session_user")).rows).toEqual([
      { current_user: role, session_user: role },
    ]);
    const migrationOwner = (await admin.query<{ owner: string }>("SELECT current_user AS owner"))
      .rows[0]?.owner;
    if (migrationOwner === undefined) throw new Error("Migration owner is unavailable");
    await expect(reader.query(`SET ROLE ${quote(migrationOwner)}`)).rejects.toMatchObject({
      code: "42501",
    });
    await work(admin, reader, schema);
  } catch (error) {
    primary = error;
  } finally {
    const attempt = async (cleanup: () => Promise<unknown>) => {
      try {
        await finite(cleanup(), 5000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    const readerToClose = reader;
    if (readerToClose !== undefined) await attempt(() => readerToClose.end());
    // Independent attempts: a failed rollback/end/drop cannot skip the others.
    await attempt(() => admin.query("ROLLBACK; RESET ROLE; SET search_path TO public"));
    const cleanupQuery = async (text: string) => {
      const cleanup = new Client({
        connectionString: url,
        connectionTimeoutMillis: 1500,
        statement_timeout: 2000,
        query_timeout: 2500,
      });
      try {
        await finite(cleanup.connect(), 1500);
        await finite(cleanup.query(text), 2500);
      } finally {
        await finite(cleanup.end(), 1000);
      }
    };
    await attempt(() => cleanupQuery(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`));
    await attempt(() =>
      cleanupQuery(
        `DO $cleanup_role$ BEGIN IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${role}') THEN EXECUTE 'DROP OWNED BY ${quote(role)}'; EXECUTE 'DROP ROLE ${quote(role)}'; END IF; END $cleanup_role$;`,
      ),
    );
    await attempt(() => admin.end());
  }
  if (cleanupErrors.length !== 0) {
    throw new AggregateError(
      primary === undefined ? cleanupErrors : [primary, ...cleanupErrors],
      "Owned financial reset fixture failed or did not clean up",
    );
  }
  if (primary !== undefined) throw primary;
}

async function enabledGuardCount(admin: Client): Promise<number> {
  const row = (
    await admin.query<{ count: string }>(
      `SELECT count(*)::TEXT AS count FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      WHERE c.relnamespace=pg_catalog.current_schema()::regnamespace AND c.relname=ANY($1::TEXT[])
        AND t.tgname='disabled_owner_financial_dml' AND NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgtype=62 AND t.tgfoid='reject_disabled_owner_financial_dml_v1()'::regprocedure`,
      [privateRelations],
    )
  ).rows[0];
  if (row === undefined) throw new Error("Native guard inventory result is unavailable");
  return Number(row.count);
}

async function exactSourceResetGuardCount(admin: Client): Promise<number> {
  const row = (
    await admin.query<{ count: number }>(
      `SELECT count(*)::INTEGER AS count
     FROM owner_accounting_native_source_inventory_v1 source
     CROSS JOIN LATERAL jsonb_to_recordset(source.manifest->'triggers')
       AS expected(relation TEXT,name TEXT,type INTEGER,enabled TEXT)
     JOIN pg_catalog.pg_trigger actual ON actual.tgrelid=to_regclass(format('%I.%I',current_schema(),expected.relation))
       AND actual.tgname=expected.name AND actual.tgtype=expected.type AND actual.tgenabled=expected.enabled::"char"
     WHERE source.singleton AND (expected.type & 32)<>0
       AND expected.relation<>'owner_accounting_native_source_inventory_v1'`,
    )
  ).rows[0];
  if (row === undefined) throw new Error("Actual source reset guard inventory unavailable");
  return row.count;
}

async function observeLockWait(
  observer: Client,
  pid: number,
  relation: string,
  blockingPid?: number,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (
      await observer.query<{ waiting: boolean; blockers: number[] }>(
        "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=$1 AND relation=to_regclass($2) AND NOT granted) AS waiting,pg_catalog.pg_blocking_pids($1) AS blockers",
        [pid, relation],
      )
    ).rows[0];
    if (row?.waiting && (blockingPid === undefined || row.blockers.includes(blockingPid))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected causal PostgreSQL relation lock wait was not observed");
}

suite("owned empty financial baseline reset", () => {
  test("preserves all source-declared privileges and immutable metadata on baseline replay", async () => {
    await withOwnedBaseline(async (admin, reader, schema) => {
      const source = (
        await admin.query<{ source_version: string; manifest_sha256: string }>(
          "SELECT source_version,encode(sha256(convert_to(manifest::TEXT,'UTF8')),'hex') AS manifest_sha256 FROM owner_accounting_native_source_inventory_v1 WHERE singleton",
        )
      ).rows;
      expect(source).toEqual([
        {
          source_version: "owner_accounting_native_source_v1",
          manifest_sha256: "5d6899e0cdf9932b601984e7764e8c3216408170f8e6c6cb9ec361d73aafcaf8",
        },
      ]);
      const functions = (
        await admin.query<{ signature: string; acl_class: string }>(
          "SELECT f.signature,f.acl_class FROM owner_accounting_native_source_inventory_v1 m CROSS JOIN LATERAL jsonb_to_recordset(m.manifest->'functions') AS f(signature TEXT,acl_class TEXT) WHERE m.singleton ORDER BY f.signature COLLATE \"C\"",
        )
      ).rows;
      expect(functions).toHaveLength(371);
      expect(functions.filter((f) => f.acl_class === "private_source_only")).toHaveLength(193);
      expect(functions.filter((f) => f.acl_class === "controlled_financial")).toHaveLength(141);
      expect(functions.filter((f) => f.acl_class === "legacy_source_default")).toHaveLength(37);
      const privileges = (
        await reader.query<{ signature: string; allowed: boolean }>(
          "SELECT signature,has_function_privilege(current_user,to_regprocedure(format('%I.%s',$1::TEXT,signature)),'EXECUTE') AS allowed FROM unnest($2::TEXT[]) signature ORDER BY signature COLLATE \"C\"",
          [schema, functions.map((f) => f.signature)],
        )
      ).rows;
      expect(privileges).toEqual(
        functions.map((f) => ({
          signature: f.signature,
          allowed: f.acl_class === "legacy_source_default",
        })),
      );
      await expect(
        reader.query("SELECT * FROM owner_accounting_native_source_inventory_v1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        admin.query("TRUNCATE owner_accounting_native_source_inventory_v1"),
      ).rejects.toMatchObject({ code: "GP003" });
      expect(
        (
          await admin.query(
            "SELECT source_version,encode(sha256(convert_to(manifest::TEXT,'UTF8')),'hex') AS manifest_sha256 FROM owner_accounting_native_source_inventory_v1 WHERE singleton",
          )
        ).rows,
      ).toEqual(source);
      await admin.query("BEGIN READ ONLY");
      await admin.query("SELECT require_owner_accounting_ready_private_v1()");
      await admin.query("COMMIT");
    });
  }, 180000);

  test("preserves native catalog, all seed rows and every restricted private boundary", async () => {
    await withOwnedBaseline(async (admin, reader) => {
      const before = await postgresTestSchemaCatalogFingerprint(admin);
      const resetFile = await Bun.file(
        new URL("../../../db/postgres/test-reset.sql", import.meta.url),
      ).text();
      const seedTables = [
        ...new Set(
          [...resetFile.matchAll(/^INSERT INTO (?:"([^"]+)"|([a-z0-9_]+))/gmu)].map(
            (match) => match[1] ?? match[2],
          ),
        ),
      ];
      if (seedTables.length !== 23 || seedTables.some((table) => table === undefined))
        throw new Error("Exact maintained baseline seed inventory is required");
      const seedCounts = async () =>
        Promise.all(
          seedTables.map(async (table) => {
            if (table === undefined) throw new Error("Seed table is unavailable");
            const row = (
              await admin.query<{ count: string }>(
                `SELECT count(*)::TEXT AS count FROM ${quote(table)}`,
              )
            ).rows[0];
            if (row === undefined) throw new Error("Seed count is unavailable");
            return [table, row.count];
          }),
        );
      const originalSeeds = await seedCounts();
      const originalSourceMetadata = (
        await admin.query(
          "SELECT source_version,encode(sha256(convert_to(manifest::TEXT,'UTF8')),'hex') AS manifest_sha256 FROM owner_accounting_native_source_inventory_v1 WHERE singleton",
        )
      ).rows;
      expect(originalSourceMetadata).toEqual([
        {
          source_version: "owner_accounting_native_source_v1",
          manifest_sha256: "5d6899e0cdf9932b601984e7764e8c3216408170f8e6c6cb9ec361d73aafcaf8",
        },
      ]);
      expect(originalSeeds.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(45);
      for (const table of privateRelations) {
        await expect(reader.query(`SELECT * FROM ${quote(table)}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(reader.query(`TRUNCATE ${quote(table)}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(admin.query(`TRUNCATE ${quote(table)} CASCADE`)).rejects.toMatchObject({
          code: "GP003",
        });
      }
      for (const signature of privateFunctions) {
        expect(
          (
            await reader.query<{ allowed: boolean }>(
              "SELECT has_function_privilege(current_user,to_regprocedure($1),'EXECUTE') AS allowed",
              [signature],
            )
          ).rows,
        ).toEqual([{ allowed: false }]);
      }
      expect(await enabledGuardCount(admin)).toBe(7);
      expect(await exactSourceResetGuardCount(admin)).toBe(19);
      await resetPostgresTestBaseline(admin);
      expect(await postgresTestSchemaCatalogFingerprint(admin)).toBe(before);
      expect(await enabledGuardCount(admin)).toBe(7);
      expect(await exactSourceResetGuardCount(admin)).toBe(19);
      expect(await seedCounts()).toEqual(originalSeeds);
      expect(
        (
          await admin.query(
            "SELECT source_version,encode(sha256(convert_to(manifest::TEXT,'UTF8')),'hex') AS manifest_sha256 FROM owner_accounting_native_source_inventory_v1 WHERE singleton",
          )
        ).rows,
      ).toEqual(originalSourceMetadata);
      await admin.query(
        "SELECT require_guest_practice_only_schema_phase_v1(); SELECT require_disabled_owner_financial_inventory_private_v1()",
      );
      for (const table of privateRelations) {
        await expect(reader.query(`SELECT * FROM ${quote(table)}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(admin.query(`TRUNCATE ${quote(table)} CASCADE`)).rejects.toMatchObject({
          code: "GP003",
        });
      }
    });
  }, 180000);

  test("refuses altered guards, foreign namespace and external CASCADE without deleting sentinels", async () => {
    await withOwnedBaseline(async (admin, _reader, schema) => {
      await admin.query(
        "CREATE TABLE fixture_reset_sentinel(id TEXT PRIMARY KEY); INSERT INTO fixture_reset_sentinel VALUES ('original')",
      );
      const original = async () =>
        expect((await admin.query("SELECT * FROM fixture_reset_sentinel")).rows).toEqual([
          { id: "original" },
        ]);
      await admin.query(
        "ALTER TABLE guest_owner_associations DISABLE TRIGGER disabled_owner_financial_dml",
      );
      await expect(resetPostgresTestBaseline(admin)).rejects.toMatchObject({ code: "GP003" });
      await original();
      await admin.query(
        "ALTER TABLE guest_owner_associations ENABLE TRIGGER disabled_owner_financial_dml",
      );
      expect(await enabledGuardCount(admin)).toBe(7);
      await admin.query("SET search_path TO public");
      await expect(resetPostgresTestBaseline(admin)).rejects.toMatchObject({ code: "GP003" });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      await original();
      const other = `${schema}_other`;
      try {
        await admin.query(
          `CREATE SCHEMA ${quote(other)}; CREATE TABLE ${quote(other)}.external_reset_child (id TEXT PRIMARY KEY, original TEXT REFERENCES ${quote(schema)}.fixture_reset_sentinel(id)); INSERT INTO ${quote(other)}.external_reset_child VALUES ('foreign','original')`,
        );
        await expect(resetPostgresTestBaseline(admin)).rejects.toMatchObject({ code: "GP003" });
        await original();
        expect(
          (await admin.query(`SELECT * FROM ${quote(other)}.external_reset_child`)).rows,
        ).toEqual([{ id: "foreign", original: "original" }]);
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${quote(other)} CASCADE`);
      }
      expect(await enabledGuardCount(admin)).toBe(7);
    });
  }, 180000);

  test("holds the complete parent set while concurrent owner DDL attempts a late foreign FK", async () => {
    await withOwnedBaseline(async (admin, observer, schema) => {
      if (!url) throw new Error("PostgreSQL test URL is required");
      const blocker = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
        query_timeout: 11000,
      });
      const ddl = new Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
        query_timeout: 11000,
      });
      const other = `${schema}_other`;
      const drains: Promise<unknown>[] = [];
      const cleanupErrors: unknown[] = [];
      let primary: unknown;
      let resetOutcome:
        | Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>>
        | undefined;
      let ddlOutcome:
        | Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>>
        | undefined;
      const pid = async (client: Client) => {
        const row = (
          await client.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid")
        ).rows[0];
        if (row === undefined) throw new Error("Backend PID is unavailable");
        return row.pid;
      };
      try {
        await Promise.all([finite(blocker.connect(), 5000), finite(ddl.connect(), 5000)]);
        await admin.query(
          `CREATE SCHEMA ${quote(other)}; CREATE TABLE ${quote(other)}.late_external_reset_child(id TEXT PRIMARY KEY, phase BOOLEAN); INSERT INTO ${quote(other)}.late_external_reset_child VALUES ('foreign',TRUE)`,
        );
        const resetPid = await pid(admin);
        const ddlPid = await pid(ddl);
        await blocker.query(
          `BEGIN; LOCK TABLE ONLY ${quote(schema)}.guest_owner_associations IN ACCESS EXCLUSIVE MODE`,
        );
        // Both promises are handled immediately; every exit releases and drains.
        resetOutcome = resetPostgresTestBaseline(admin).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        drains.push(resetOutcome);
        await observeLockWait(observer, resetPid, `${schema}.guest_owner_associations`);
        ddlOutcome = ddl
          .query(
            `ALTER TABLE ${quote(other)}.late_external_reset_child ADD CONSTRAINT late_foreign_phase_fk FOREIGN KEY(phase) REFERENCES ${quote(schema)}.guest_learning_schema_phase(singleton)`,
          )
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        drains.push(ddlOutcome);
        // Old8-table locking allows ALTER to finish here; the corrected full
        // parent locks make real owner DDL wait until the reset transaction ends.
        await observeLockWait(observer, ddlPid, `${schema}.guest_learning_schema_phase`, resetPid);
        await blocker.query("COMMIT");
        const reset = await finite(resetOutcome, 10000);
        if (!reset.ok) throw reset.error;
        const altered = await finite(ddlOutcome, 10000);
        if (!altered.ok) throw altered.error;
        expect(
          (await admin.query(`SELECT * FROM ${quote(other)}.late_external_reset_child`)).rows,
        ).toEqual([{ id: "foreign", phase: true }]);
        expect(await enabledGuardCount(admin)).toBe(7);
        await admin.query(
          `ALTER TABLE ${quote(other)}.late_external_reset_child DROP CONSTRAINT late_foreign_phase_fk`,
        );
        await admin.query("SELECT require_disabled_owner_financial_inventory_private_v1()");
      } catch (error) {
        primary = error;
      } finally {
        const attempt = async (cleanup: () => Promise<unknown>) => {
          try {
            await finite(cleanup(), 5000);
          } catch (error) {
            cleanupErrors.push(error);
          }
        };
        await attempt(() => blocker.query("ROLLBACK"));
        await attempt(() => Promise.allSettled(drains));
        await attempt(() => ddl.end());
        await attempt(() => blocker.end());
        await attempt(() => admin.query(`DROP SCHEMA IF EXISTS ${quote(other)} CASCADE`));
      }
      if (cleanupErrors.length !== 0)
        throw new AggregateError(
          primary === undefined ? cleanupErrors : [primary, ...cleanupErrors],
          "Concurrent reset fixture cleanup failed",
        );
      if (primary !== undefined) throw primary;
    });
  }, 180000);

  test("rolls back all exact temporary source guards when genuine TRUNCATE refuses", async () => {
    await withOwnedBaseline(async (admin) => {
      const originalPhase = (await admin.query("SELECT * FROM guest_learning_schema_phase")).rows;
      const before = await postgresTestSchemaCatalogFingerprint(admin);
      let injected = false;
      const actualDriver = {
        query: async (text: string) => {
          if (text.includes("DO $owned_empty_financial_reset$")) {
            const boundary = text.indexOf("\nTRUNCATE TABLE");
            if (boundary < 0) throw new Error("Actual reset TRUNCATE boundary missing");
            injected = true;
            const fault = `
CREATE FUNCTION fixture_refuse_reset() RETURNS TRIGGER LANGUAGE plpgsql AS $fixture$
BEGIN RAISE EXCEPTION 'controlled owned TRUNCATE fault' USING ERRCODE='P0001'; END $fixture$;
CREATE TRIGGER fixture_refuse_reset BEFORE TRUNCATE ON guest_learning_schema_phase FOR EACH STATEMENT EXECUTE FUNCTION fixture_refuse_reset();
`;
            return await admin.query(text.slice(0, boundary) + fault + text.slice(boundary));
          }
          return await admin.query(text);
        },
      };
      await expect(resetPostgresTestBaseline(actualDriver)).rejects.toMatchObject({
        code: "P0001",
      });
      expect(injected).toBe(true);
      expect(await enabledGuardCount(admin)).toBe(7);
      expect(await exactSourceResetGuardCount(admin)).toBe(19);
      expect(await postgresTestSchemaCatalogFingerprint(admin)).toBe(before);
      expect((await admin.query("SELECT * FROM guest_learning_schema_phase")).rows).toEqual(
        originalPhase,
      );
      expect(
        (await admin.query("SELECT to_regprocedure('fixture_refuse_reset()') IS NULL AS removed"))
          .rows,
      ).toEqual([{ removed: true }]);
      await admin.query("SELECT require_owner_accounting_ready_private_v1()");
    });
  }, 180000);
});
