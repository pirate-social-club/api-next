/** Offline initialization protocol; no native connection or migration SQL runs. */
import { expect, test } from "bun:test";
import type { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  initializeNotificationsInboxSchema,
  inspectScopedConnection,
} from "./notifications-schema-init.pg-fixture.ts";

import { validateVideoUpgradeTarget } from "./notifications-video-ordering-upgrade.pg18.fixture.ts";

type Operations = NonNullable<Parameters<typeof initializeNotificationsInboxSchema>[1]>;
type Inspection = Awaited<ReturnType<Operations["inspectScoped"]>>;
const migrations = await loadPostgresMigrations(); // Files/checksums only; no DB.
const secondMigration = migrations[1];
if (!secondMigration) throw new Error("Complete repository migration plan required");
const schema = `api_next_notifications_${"c".repeat(32)}`;
const url = new URL("postgresql://fixture_creator@fixture.invalid/postgres");
url.searchParams.set("options", `-c search_path=${schema}`);
const connectionString = url.toString();
const creator = "fixture_creator";
const inspection: Inspection = {
  creating_role: creator,
  selected_schema: schema,
  search_schemas: [schema],
  schema_owner: creator,
  relations: [],
  functions: [],
  types: [],
  ledger: null,
};

function protocol(
  options: {
    before?: Partial<Inspection>;
    afterDefaults?: Partial<Inspection>;
    scoped?: Partial<Inspection>;
    plan?: typeof migrations;
    ledger?: "checksum" | "missing" | "extra";
    wrongOwner?: boolean;
    migrateError?: Error;
    dryRun?: boolean;
    partialApply?: boolean;
    mode?: "full_migrations" | "pre_video_ordering_migrations";
  } = {},
) {
  const events: string[] = [];
  let defaultsInstalled = false;
  const plan = options.plan ?? migrations;
  const selectedPlan = options.mode === "pre_video_ordering_migrations" ? plan.slice(0, 274) : plan;
  const ledger = (
    options.mode === "pre_video_ordering_migrations" ? migrations.slice(0, 274) : migrations
  ).map(({ version, checksum }) => ({ version, checksum }));
  if (options.ledger === "checksum") {
    const first = ledger[0];
    if (!first) throw new Error("Nonempty repository ledger required");
    ledger[0] = { ...first, checksum: "0".repeat(64) };
  }
  if (options.ledger === "missing") ledger.pop();
  if (options.ledger === "extra")
    ledger.push({ version: "0277_unexpected.sql", checksum: "0".repeat(64) });
  const query = async (sql: string) => {
    const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length });
    if (sql.startsWith("SET search_path")) {
      events.push("pin-admin-schema");
      return result();
    }
    if (sql.includes("AS search_schemas")) {
      events.push(defaultsInstalled ? "empty-after-defaults" : "empty-before-defaults");
      return result([
        {
          ...inspection,
          ...options.before,
          ...(defaultsInstalled ? options.afterDefaults : {}),
        },
      ]);
    }
    if (sql.startsWith("SELECT version,checksum")) {
      events.push("exact-resulting-ledger");
      return result(ledger);
    }
    if (sql.startsWith("SELECT c.relname AS relation")) {
      events.push("creating-role-owners");
      return result(
        [
          "schema_migrations",
          "video_alias_audit_items_v1",
          "video_alias_audit_runs_v1",
          "video_notification_cutovers_v1",
        ].map((relation) => ({ relation, owner: options.wrongOwner ? "other_creator" : creator })),
      );
    }
    throw new Error(`Unexpected fixture statement: ${sql}`);
  };
  const input = {
    mode: options.mode ?? "full_migrations",
    admin: { query } as unknown as Pick<Client, "query">,
    schema,
    connectionString,
    beforeApplicationDdl: async () => {
      events.push("roles-membership-forward-defaults");
      defaultsInstalled = true;
    },
  };
  const operations: Operations = {
    baseline: async (config) => {
      events.push("baseline");
      expect(config.connectionString).toBe(connectionString);
    },
    load: async () => {
      events.push("checksum-loader");
      return plan;
    },
    inspectScoped: async (scopedUrl, scopedSchema) => {
      events.push("scoped-empty-and-creator");
      expect(scopedUrl).toBe(connectionString);
      expect(scopedSchema).toBe(schema);
      return { ...inspection, ...options.scoped };
    },
    migrate: async (config = {}) => {
      events.push("maintained-full-runner");
      expect(defaultsInstalled).toBe(true);
      expect(config.connectionString).toBe(connectionString);
      expect(config.expectedLedger).toEqual([]);
      if (options.mode === "pre_video_ordering_migrations") {
        expect(config.migrations).toEqual(selectedPlan);
        expect(config.migrations).toHaveLength(274);
        expect(config.migrations?.at(-1)?.version).toBe(
          "0274_author_declared_text_moderation_actions.sql",
        );
        expect(config.migrations?.some((m) => Number(m.version.slice(0, 4)) >= 275)).toBe(false);
      } else expect(config.migrations).toBe(plan);
      if (options.migrateError) throw options.migrateError;
      if (options.dryRun) return { dryRun: true, plan: [] };
      return {
        dryRun: false,
        result: {
          applied: selectedPlan.slice(options.partialApply ? 1 : 0).map(({ version }) => version),
          currentVersion: selectedPlan.at(-1)?.version ?? null,
        },
      };
    },
  };
  return { input, operations, events };
}

test("the actual checksum loader supplies the complete contiguous repository 0001..0295 set", () => {
  expect(migrations).toHaveLength(295);
  expect(migrations.map((m) => Number(m.version.slice(0, 4)))).toEqual(
    Array.from({ length: 295 }, (_, i) => i + 1),
  );
  expect(migrations[274]).toMatchObject({
    version: "0275_video_root_comment_ordering.sql",
    checksum: "ce3a162f0ff721e78bec5fdb065b9da8dc0cdbfb1371aaba4c3952eaa503c8d4",
  });
  expect(migrations[275]).toMatchObject({
    version: "0276_wallet_send_palm_assertion_lock.sql",
    checksum: "51d53c71b178f84ac730e6a7659319f61b3871d31c6976ee913616a6b87af8e3",
  });
  expect(migrations[292]?.version).toBe("0293_moderated_dance_notification_recovery_bounds.sql");
  expect(migrations[293]?.version).toBe("0294_song_contribution_refusals.sql");
  expect(migrations.at(-1)?.version).toBe("0295_shared_song_megapot_participation.sql");
});

test("behavior initialization retains its baseline and pre-DDL callback without running migrations", async () => {
  const p = protocol();
  await initializeNotificationsInboxSchema({ ...p.input, mode: "baseline" }, p.operations);
  expect(p.events).toEqual(["roles-membership-forward-defaults", "baseline"]);
});

test("ACL initialization proves empty schema on both connections and installs defaults before the exact full runner", async () => {
  const p = protocol();
  await initializeNotificationsInboxSchema(p.input, p.operations);
  expect(p.events).toEqual([
    "checksum-loader",
    "pin-admin-schema",
    "empty-before-defaults",
    "roles-membership-forward-defaults",
    "empty-after-defaults",
    "scoped-empty-and-creator",
    "maintained-full-runner",
    "exact-resulting-ledger",
    "creating-role-owners",
  ]);
});

test("the distinct upgrade mode validates the complete source plan then installs exactly274", async () => {
  const p = protocol({ mode: "pre_video_ordering_migrations" });
  await initializeNotificationsInboxSchema(p.input, p.operations);
  expect(p.events).toContain("maintained-full-runner");
  expect(p.events).toContain("exact-resulting-ledger");
  expect(p.events).not.toContain("baseline");
});

for (const boundary of ["checksum", "filename"] as const)
  test(`the upgrade prefix cannot proceed with a changed source boundary: ${boundary}`, async () => {
    const plan = migrations.map((migration, index) =>
      index !== 274
        ? migration
        : {
            ...migration,
            ...(boundary === "checksum"
              ? { checksum: "0".repeat(64) }
              : { version: "0275_unreviewed.sql" }),
          },
    );
    const p = protocol({ mode: "pre_video_ordering_migrations", plan });
    await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow(
      "source-bound274-to275 boundary",
    );
    expect(p.events).toEqual(["checksum-loader"]);
  });

test("the upgrade prefix still refuses existing application objects before defaults", async () => {
  const p = protocol({
    mode: "pre_video_ordering_migrations",
    before: { relations: ["already_populated"] },
  });
  await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow();
  expect(p.events).not.toContain("roles-membership-forward-defaults");
  expect(p.events).not.toContain("maintained-full-runner");
});

for (const dirty of [
  { relations: ["existing_table"] },
  { functions: ["existing_function()"] },
  { types: ["existing_enum"] },
  { relations: ["schema_migrations"], ledger: "schema_migrations" },
])
  test(`ACL refuses a preexisting object even without applied ledger entries: ${Object.keys(dirty)[0]}`, async () => {
    const p = protocol({ before: dirty });
    await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow();
    expect(p.events).not.toContain("roles-membership-forward-defaults");
    expect(p.events).not.toContain("maintained-full-runner");
  });

test("a pre-DDL callback that creates an application function cannot reach migration application", async () => {
  const p = protocol({ afterDefaults: { functions: ["unexpected_function()"] } });
  await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow();
  expect(p.events).toContain("empty-after-defaults");
  expect(p.events).not.toContain("maintained-full-runner");
});

for (const scoped of [
  { creating_role: "other_creator", schema_owner: "other_creator" },
  { selected_schema: "public", search_schemas: ["public"] },
  { relations: ["existing_relation_on_scoped_connection"] },
])
  test(`ACL refuses the wrong scoped identity/search path/state: ${Object.keys(scoped)[0]}`, async () => {
    const p = protocol({ scoped });
    await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow();
    expect(p.events).not.toContain("maintained-full-runner");
  });

test("unscoped URLs cannot initialize ACL migrations", async () => {
  const p = protocol();
  await expect(
    initializeNotificationsInboxSchema(
      { ...p.input, connectionString: "postgresql://fixture.invalid/postgres" },
      p.operations,
    ),
  ).rejects.toThrow("dedicated schema-scoped connection");
  expect(p.events).toEqual([]);
});

for (const plan of [migrations.slice(0, -1), [secondMigration, ...migrations.slice(1)]])
  test(`missing or noncontiguous plans are refused before defaults: ${plan.length}`, async () => {
    const p = protocol({ plan });
    await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow(
      "complete contiguous repository migration plan",
    );
    expect(p.events).toEqual(["checksum-loader"]);
  });

for (const boundary of ["checksum", "filename"] as const)
  test(`full ACL initialization rejects a changed current source boundary: ${boundary}`, async () => {
    const plan = migrations.map((migration, index) =>
      index !== migrations.length - 1
        ? migration
        : {
            ...migration,
            ...(boundary === "checksum"
              ? { checksum: "0".repeat(64) }
              : { version: `${String(migrations.length).padStart(4, "0")}_unreviewed.sql` }),
          },
    );
    const p = protocol({ plan });
    await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow(
      "exact repository migration plan",
    );
    expect(p.events).toEqual(["checksum-loader"]);
  });

for (const ledger of ["checksum", "missing", "extra"] as const)
  test(`the resulting ledger must match every ordered checksum: ${ledger}`, async () => {
    const p = protocol({ ledger });
    await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow();
    expect(p.events).toContain("exact-resulting-ledger");
  });

test("resulting ownership must still be the role that installed the hostile defaults", async () => {
  const p = protocol({ wrongOwner: true });
  await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow();
  expect(p.events.at(-1)).toBe("creating-role-owners");
});

test("migration failures propagate once without a baseline fallback, retry or ledger fabrication", async () => {
  const failure = new Error("maintained runner failed");
  const p = protocol({ migrateError: failure });
  await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toBe(failure);
  expect(p.events.filter((e) => e === "maintained-full-runner")).toHaveLength(1);
  expect(p.events).not.toContain("baseline");
  expect(p.events).not.toContain("exact-resulting-ledger");
});

for (const incomplete of [{ dryRun: true }, { partialApply: true }])
  test(`a dry run or incomplete application cannot count as initialization: ${Object.keys(incomplete)[0]}`, async () => {
    const p = protocol(incomplete);
    await expect(initializeNotificationsInboxSchema(p.input, p.operations)).rejects.toThrow();
    expect(p.events).not.toContain("exact-resulting-ledger");
  });

for (const stage of ["connect", "inspect"] as const)
  for (const primary of [new Error("scoped inspection failed"), undefined])
    for (const closeFails of [false, true])
      test(`scoped ${stage} refusal (${primary === undefined ? "undefined" : "Error"}) retains primary with close failure=${closeFails}`, async () => {
        const events: string[] = [];
        const closeError = new Error("scoped close failed");
        const client = {
          connect: async () => {
            events.push("connect");
            if (stage === "connect") throw primary;
          },
          query: async () => {
            events.push("inspect");
            throw primary;
          },
          end: async () => {
            events.push("end");
            if (closeFails) throw closeError;
          },
        };
        const [outcome] = await Promise.allSettled([
          inspectScopedConnection(connectionString, schema, client),
        ]);
        if (!outcome || outcome.status !== "rejected") throw new Error("Expected scoped refusal");
        expect(events).toEqual(
          stage === "connect" ? ["connect", "end"] : ["connect", "inspect", "end"],
        );
        if (closeFails) {
          expect(outcome.reason).toBeInstanceOf(AggregateError);
          if (!(outcome.reason instanceof AggregateError)) throw new Error("Expected aggregate");
          expect(outcome.reason.cause).toBe(primary);
          expect(outcome.reason.errors).toHaveLength(2);
          expect(outcome.reason.errors[0]).toBe(primary);
          expect(outcome.reason.errors[1]).toBe(closeError);
        } else expect(outcome.reason).toBe(primary);
      });

test("actual scoped inspection returns its row only after one successful close", async () => {
  const events: string[] = [];
  const result = await inspectScopedConnection(connectionString, schema, {
    connect: async () => {
      events.push("connect");
    },
    query: async (_sql, values) => {
      events.push("inspect");
      expect(values).toEqual([schema]);
      return { rows: [inspection] };
    },
    end: async () => {
      events.push("end");
    },
  });
  expect(result).toBe(inspection);
  expect(events).toEqual(["connect", "inspect", "end"]);
});

test("a close-only failure after actual scoped inspection stays a failure", async () => {
  const closeError = new Error("scoped close failed");
  await expect(
    inspectScopedConnection(connectionString, schema, {
      connect: async () => undefined,
      query: async () => ({ rows: [inspection] }),
      end: async () => {
        throw closeError;
      },
    }),
  ).rejects.toBe(closeError);
});

const pg18Target = "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable";
test("the video upgrade target is bound to the maintained inbox and literal CI origin", () => {
  expect(validateVideoUpgradeTarget(pg18Target, pg18Target)).toBe(new URL(pg18Target).toString());
  for (const bad of [
    pg18Target.replace("127.0.0.1", "localhost"),
    pg18Target.replace("127.0.0.1", "127.1"),
    pg18Target.replace(":5432/", ":5433/"),
    pg18Target.replace("/postgres?", "/another?"),
    `${pg18Target}&host=remote.invalid`,
    `${pg18Target}&options=-c%20search_path=public`,
    `${pg18Target}&sslmode=require`,
    `${pg18Target}#fragment`,
  ])
    expect(() => validateVideoUpgradeTarget(bad, bad)).toThrow();
  expect(() => validateVideoUpgradeTarget(pg18Target, undefined)).toThrow();
  expect(() =>
    validateVideoUpgradeTarget(pg18Target, `${pg18Target}&host=remote.invalid`),
  ).toThrow();
});
