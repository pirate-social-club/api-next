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

test("the actual checksum loader supplies the complete contiguous repository 0001..0318 set", () => {
  expect(migrations).toHaveLength(318);
  expect(migrations.map((m) => Number(m.version.slice(0, 4)))).toEqual(
    Array.from({ length: 318 }, (_, i) => i + 1),
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
  expect(migrations[294]?.version).toBe("0295_shared_song_megapot_participation.sql");
  expect(migrations[295]).toMatchObject({
    version: "0296_moderated_dance_frozen_context.sql",
    checksum: "f59d6da6e52ce87e4378f9cc32bb9db00fb5027e7cdebf10c1241a78003cad71",
  });
  expect(migrations[296]).toMatchObject({
    version: "0297_moderated_dance_provider_disposition.sql",
    checksum: "6a2b6c84110224f61a1e0c97846f9ada96cc9a93a63d26b519fb74d47b88dd0d",
  });
  expect(migrations[297]).toMatchObject({
    version: "0298_moderated_dance_cloudconvert_probe.sql",
    checksum: "6e7e87389a509be9895d2a6bda0031c677cd21e1b8f2d90ecb682e7d1a25a3eb",
  });
  expect(migrations[298]).toMatchObject({
    version: "0299_moderated_dance_replay_retention.sql",
    checksum: "20055cc14cf6644481b526b25b771bba2016cd93f676518093238bbd05ff9c18",
  });
  expect(migrations[299]).toMatchObject({
    version: "0300_moderated_dance_public_replay_epochs.sql",
    checksum: "864c0f8588bfea996fbd3d3d62c6b03841aa1932c9a0f66a5c3872232f782ea1",
  });
  expect(migrations[300]).toMatchObject({
    version: "0301_moderated_dance_safety_retention.sql",
    checksum: "f81cd893e131ee2a61f61cc61d990ded633774eb706849d38c420d2c2dd5d7ff",
  });
  expect(migrations[301]).toMatchObject({
    version: "0302_moderated_dance_publication_input.sql",
    checksum: "b1d532c4a55b9f879d215cdba3a5f4092766831efa9812337f1936ead7d81f3c",
  });
  expect(migrations[302]).toMatchObject({
    version: "0303_moderated_dance_publication_grant_path.sql",
    checksum: "c8f25fb6f082c90675e1213d21d150c834020ccb0f94b8cb05c7ca5b997abe6b",
  });
  expect(migrations[303]).toMatchObject({
    version: "0304_moderated_dance_publication_cleanup.sql",
    checksum: "ffb4f17a382971d4c3e2b0eb17de77121626eaec503e3ee2c4db98616173f231",
  });
  expect(migrations[304]).toMatchObject({
    version: "0305_moderated_dance_publication_provider.sql",
    checksum: "96b1354fd8e76d402d1b2723d12fcef28b3a2759f925f193006fb1472dbdbcad",
  });
  expect(migrations[305]).toMatchObject({
    version: "0306_moderated_dance_publication_views.sql",
    checksum: "11e0fa953283e832a0f072f1321f8580ca1b29528f6a3a6bbde38275d51285cb",
  });
  expect(migrations[306]).toMatchObject({
    version: "0307_moderated_dance_reference_communities.sql",
    checksum: "de246a85b233c6620a872891de836ac96f15f6176b6d59feae32f58c362c5e24",
  });
  expect(migrations[307]).toMatchObject({
    version: "0308_moderated_dance_reference_queue.sql",
    checksum: "7fa7d6ec8261fc00c5afb0126f31a97bf72269ecf1f5eb1e86bd0fc998921eaa",
  });
  expect(migrations[308]).toMatchObject({
    version: "0309_moderated_dance_reference_recovery.sql",
    checksum: "c4a49efbcbd86df51919a5612fa24c919b5501a24dde9891d322d0776abc20bb",
  });
  expect(migrations[309]).toMatchObject({
    version: "0310_moderated_dance_reference_physical_key.sql",
    checksum: "c1e166c3804026db46c565ba915cbb2f739475206f49a9ece32418ec17de16fd",
  });
  expect(migrations[310]).toMatchObject({
    version: "0311_reward_safe_owner_execution.sql",
    checksum: "53a24c879f52e2d724ff01f5889bd86cab0cf6cbf8ea22cbe3e6e47496a504df",
  });
  expect(migrations[311]).toMatchObject({
    version: "0312_reward_safe_execution_scans.sql",
    checksum: "26885d9f07113b682978ef1ea5db397d13a07590e255e8b09f499ae00c76cc93",
  });
  expect(migrations[312]).toMatchObject({
    version: "0313_reward_ticket_first_pool.sql",
    checksum: "07b49f41ca0c5465ce8202f2e1d55284fe686d2624c88068e28473d8f96b6f6c",
  });
  expect(migrations[313]).toMatchObject({
    version: "0314_reward_leg_purchase_order_from_custody.sql",
    checksum: "6fe67b05c1821c91ba7938650462d3daaf0c0c172ac7583fd7804bb0494daf6c",
  });
  expect(migrations[314]).toMatchObject({
    version: "0315_reward_safe_preparation_lease.sql",
    checksum: "993d034ab6454b94c70b532b7c034b3603dbc63629ae478f9811727ef8557998",
  });
  expect(migrations[315]).toMatchObject({
    version: "0316_reward_safe_late_purchase_recovery.sql",
    checksum: "40c61d15a0e4e896621308bb52596757367d20cd580f2cb3a604d3c4f798dd1d",
  });
  expect(migrations[316]).toMatchObject({
    version: "0317_moderated_dance_normalization_frame_alias.sql",
    checksum: "2192dc0000d95b57eb601a84ce22eab65c6bb26bb25d013155920a2ac8592a32",
  });
  expect(migrations.at(-1)).toMatchObject({
    version: "0318_moderated_dance_settled_processing_capacity.sql",
    checksum: "b11bab8c84d8e59988a900d90e973fc008baa66cc77122d997fbfcca68d31d22",
  });
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
