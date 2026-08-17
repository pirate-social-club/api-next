import { describe, expect, test } from "bun:test";
import {
  type LegacyGlobalHandleRow,
  makePublicProfileBackfillManifest,
  makePublicProfileTargetSnapshot,
  type PublicProfileBackfillDatabase,
  type PublicProfileBackfillTransaction,
  runPublicProfileBackfill,
} from "./public-profile-backfill.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_BACKFILL_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error(
    "CONTROL_PLANE_POSTGRES_TEST_URL is required for the public-profile backfill suite",
  );
}
type PgClient = Readonly<{
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Row[] }>;
  readonly connect: () => Promise<void>;
  readonly end: () => Promise<void>;
}>;

const pgModule =
  connectionString === undefined ? undefined : await import("pg").catch(() => undefined);
const migrationModule =
  connectionString === undefined
    ? undefined
    : await import("./postgres-migrations.ts").catch(() => undefined);
const PgClientConstructor = pgModule?.Client as unknown as
  | (new (input: {
      readonly connectionString: string;
    }) => PgClient)
  | undefined;
const runPostgresMigrations = migrationModule?.runPostgresMigrations;
const suite =
  connectionString === undefined ||
  PgClientConstructor === undefined ||
  runPostgresMigrations === undefined
    ? describe.skip
    : describe;

const schemaIdentifier = (): string =>
  `api_next_backfill_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

const dates = {
  issued_at: "2026-08-16T00:00:00.000Z",
  replaced_at: null,
  created_at: "2026-08-16T00:00:00.000Z",
  updated_at: "2026-08-16T00:00:00.000Z",
} as const;

function row(
  input: Partial<LegacyGlobalHandleRow> &
    Pick<LegacyGlobalHandleRow, "global_handle_id" | "user_id" | "label_normalized">,
): LegacyGlobalHandleRow {
  const { global_handle_id, user_id, label_normalized, ...overrides } = input;
  return {
    global_handle_id,
    user_id,
    label_normalized,
    label_display: `${label_normalized}.pirate`,
    status: "active",
    tier: "standard",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    ...dates,
    ...overrides,
  };
}

function manifest(rows: readonly LegacyGlobalHandleRow[]) {
  const users = [...new Set(rows.map((value) => value.user_id))].sort();
  return makePublicProfileBackfillManifest({
    snapshot_at: "2026-08-16T01:00:00.000Z",
    rows,
    owner_mappings: users.map((legacy_user_id) => ({
      legacy_user_id,
      api_next_user_id: `api_${legacy_user_id}`,
      legacy_owner_state: "active",
      reviewed: false,
    })),
    handle_mappings: rows.map((value) => ({
      legacy_handle_id: value.global_handle_id,
      api_next_handle_id: `api_${value.global_handle_id}`,
    })),
  });
}

function makeClient(connection: string): PgClient {
  if (PgClientConstructor === undefined) throw new Error("pg is not installed");
  return new PgClientConstructor({ connectionString: connection });
}

async function migrate(connection: string): Promise<void> {
  if (runPostgresMigrations === undefined)
    throw new Error("postgres migration runner is unavailable");
  await runPostgresMigrations({ connectionString: connection });
}

function database(client: PgClient): PublicProfileBackfillDatabase {
  return {
    withTransaction: async <A>(
      run: (transaction: PublicProfileBackfillTransaction) => Promise<A>,
    ): Promise<A> => {
      await client.query("BEGIN");
      try {
        const result = await run({
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            values: readonly unknown[] | undefined,
          ): Promise<{ readonly rows: readonly Row[] }> => {
            const response = await client.query<Record<string, unknown>>(
              text,
              values === undefined ? undefined : [...values],
            );
            return { rows: response.rows as readonly Row[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
  };
}

async function withSchema<A>(use: (connection: string, admin: PgClient) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = makeClient(connectionString);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

suite("public-profile historical backfill against Postgres 17 migrations", () => {
  test("runs the actual transaction adapter against valid migration tables", async () => {
    await withSchema(async (connection, admin) => {
      await migrate(connection);
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('api_legacy_owner', 'active', '{}'::jsonb)`,
      );
      const current = row({
        global_handle_id: "legacy_current",
        user_id: "legacy_owner",
        label_normalized: "pg-captain",
      });
      const historical = row({
        global_handle_id: "legacy_old",
        user_id: "legacy_owner",
        label_normalized: "pg-old-captain",
        status: "redirect",
        redirect_target_global_handle_id: "legacy_current",
      });
      const sourceManifest = manifest([historical, current]);
      const targetSnapshot = makePublicProfileTargetSnapshot({
        captured_at: "2026-08-16T02:00:00.000Z",
        users: [{ user_id: "api_legacy_owner", status: "active" }],
        handles: [],
      });
      const dryRun = await runPublicProfileBackfill({
        mode: "dry-run",
        manifest: sourceManifest,
        target: targetSnapshot,
      });
      expect(dryRun.applied).toBe(0);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM public_handle_index")).rows[0]
          ?.count,
      ).toBe(0);

      const client = makeClient(connection);
      await client.connect();
      try {
        const first = await runPublicProfileBackfill({
          mode: "apply",
          manifest: sourceManifest,
          database: database(client),
        });
        expect(first.applied).toBe(2);
        const rows = await admin.query<{
          handle_id: string;
          owner_user_id: string;
          status: string;
          redirect_target_handle_id: string | null;
        }>(
          `SELECT handle_id, owner_user_id, status, redirect_target_handle_id
             FROM public_handle_index ORDER BY handle_id`,
        );
        expect(rows.rows).toEqual([
          {
            handle_id: "api_legacy_current",
            owner_user_id: "api_legacy_owner",
            status: "active",
            redirect_target_handle_id: null,
          },
          {
            handle_id: "api_legacy_old",
            owner_user_id: "api_legacy_owner",
            status: "redirect",
            redirect_target_handle_id: "api_legacy_current",
          },
        ]);
        const rerun = await runPublicProfileBackfill({
          mode: "apply",
          manifest: sourceManifest,
          database: database(client),
        });
        expect(rerun.applied).toBe(0);
        expect(rerun.report.counts.skips).toBe(2);
      } finally {
        await client.end();
      }
    });
  });

  test("does not commit when a locked target owner changes status", async () => {
    await withSchema(async (connection, admin) => {
      await migrate(connection);
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('api_race_owner', 'active', '{}'::jsonb)`,
      );
      const current = row({
        global_handle_id: "legacy_race_current",
        user_id: "legacy_race_owner",
        label_normalized: "race-captain",
      });
      const sourceManifest = manifest([current]);
      const blocking = makeClient(connection);
      const applying = makeClient(connection);
      await blocking.connect();
      await applying.connect();
      try {
        await blocking.query("BEGIN");
        await blocking.query(
          "UPDATE users SET status = 'deleted' WHERE user_id = 'api_race_owner'",
        );
        const applyPromise = runPublicProfileBackfill({
          mode: "apply",
          manifest: sourceManifest,
          database: database(applying),
        });
        setTimeout(() => {
          void blocking.query("COMMIT");
        }, 100);
        await expect(applyPromise).rejects.toThrow("public-profile-backfill-plan-has-errors");
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM public_handle_index")).rows[0]
            ?.count,
        ).toBe(0);
      } finally {
        await blocking.query("ROLLBACK").catch(() => undefined);
        await blocking.end();
        await applying.end();
      }
    });
  });

  test("rejects a collision before writes and rolls back a database failure", async () => {
    await withSchema(async (connection, admin) => {
      await migrate(connection);
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('api_collision_owner', 'active', '{}'::jsonb),
                ('api_failure_owner', 'active', '{}'::jsonb),
                ('api_legacy_collision_owner', 'active', '{}'::jsonb),
                ('api_legacy_failure_owner', 'active', '{}'::jsonb)`,
      );
      await admin.query(
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id)
         VALUES ('api_existing', 'collision-captain', 'collision-captain.pirate', 'active', 'api_collision_owner')`,
      );
      const collision = row({
        global_handle_id: "legacy_collision",
        user_id: "legacy_collision_owner",
        label_normalized: "collision-captain",
      });
      const client = makeClient(connection);
      await client.connect();
      try {
        await expect(
          runPublicProfileBackfill({
            mode: "apply",
            manifest: manifest([collision]),
            database: database(client),
          }),
        ).rejects.toThrow("public-profile-backfill-plan-has-errors");
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM public_handle_index")).rows[0]
            ?.count,
        ).toBe(1);

        await admin.query(`
          CREATE FUNCTION fail_public_profile_backfill() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'backfill rollback';
          END;
          $$`);
        await admin.query(`
          CREATE TRIGGER fail_public_profile_backfill_trigger
          BEFORE INSERT ON public_handle_index
          FOR EACH ROW EXECUTE FUNCTION fail_public_profile_backfill()`);
        const failing = row({
          global_handle_id: "legacy_failure",
          user_id: "legacy_failure_owner",
          label_normalized: "rollback-captain",
        });
        await expect(
          runPublicProfileBackfill({
            mode: "apply",
            manifest: manifest([failing]),
            database: database(client),
          }),
        ).rejects.toThrow("backfill rollback");
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM public_handle_index")).rows[0]
            ?.count,
        ).toBe(1);
      } finally {
        await client.end();
      }
    });
  });
});
