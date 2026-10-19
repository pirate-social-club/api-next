import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlPlaneDb, ControlPlaneStatement } from "@pirate/application";
import { Effect } from "effect";
import {
  bindManagedVideoConnection,
  executeManagedVideoAdmission,
  parseManagedVideoAdmissionRequest,
  preflightManagedVideoAdmission,
  recordManagedVideoAdmission,
} from "./notifications-video-managed-runner.ts";

const directories: string[] = [];
test("canonical private receipt directory is required before dispatch", async () => {
  const directory = await receiptDirectory();
  const r = request();
  let calls = 0;
  const work = async () => {
    calls++;
  };
  await expect(
    recordManagedVideoAdmission(r, "f".repeat(64), join(directory, "not-created", "deep"), work),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const inside = await mkdtemp(join(root, "..receipts-"));
  directories.push(inside);
  await expect(recordManagedVideoAdmission(r, "f".repeat(64), inside, work)).rejects.toThrow(
    "outside_source",
  );
  const link = join(directory, "source-link");
  await symlink(root, link);
  await expect(recordManagedVideoAdmission(r, "f".repeat(64), link, work)).rejects.toThrow(
    "outside_source",
  );
  await chmod(directory, 0o755);
  await expect(recordManagedVideoAdmission(r, "f".repeat(64), directory, work)).rejects.toThrow(
    "private_receipt_directory_required",
  );
  expect(calls).toBe(0);
});

test("real platform finalization retains acknowledged SQL separately from rejected close", async () => {
  for (const closeFails of [false, true]) {
    const directory = await receiptDirectory();
    const r = request();
    const statements: string[] = [];
    let closed = 0;
    const outcome = await recordManagedVideoAdmission(r, "f".repeat(64), directory, (started) =>
      executeManagedVideoAdmission(
        r,
        connection,
        "-- unused for batch",
        migrations,
        started,
        async () => ({
          connect: async () => undefined,
          query: async ({ text }) => {
            statements.push(text);
            const rows = text.includes("current_database()")
              ? [
                  {
                    principal: "operator",
                    current_principal: "operator",
                    database: "postgres",
                    schema: "api_next",
                    schema_owner: true,
                  },
                ]
              : text.includes("schema_migrations")
                ? migrations
                : text.includes("process_video_alias_audit_batch_v1")
                  ? [{ examined: 50 }]
                  : [];
            return { rows, rowCount: rows.length };
          },
          end: async () => {
            closed++;
            if (closeFails) throw new Error(connection);
          },
        }),
      ),
    );
    expect(closed).toBe(1);
    expect(statements).toContain("COMMIT");
    if (closeFails) {
      expect(outcome).toMatchObject({
        acknowledged: false,
        sql_acknowledged: true,
        connection_closed: false,
        unknown_effect: false,
        code: "video_admission_connection_close_failed",
      });
      expect(await readdir(directory)).not.toContain(`${r.operation_id}.result.json`);
    } else expect(outcome).toMatchObject({ acknowledged: true, unknown_effect: false });
    for (const name of await readdir(directory))
      expect(await readFile(join(directory, name), "utf8")).not.toContain("fixture-secret");
  }
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
const packet = () => ({
  version: 1,
  operation_id: "00000000-0000-4000-8000-000000000001",
  action: "batch",
  not_before: new Date(Date.now() - 60_000).toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  source_commit: "a".repeat(40),
  target: {
    hostname: "example.pg.psdb.cloud",
    login: "operator.branch",
    principal: "operator",
    database: "postgres",
  },
  plan: {
    contract_sha256: "36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19",
    plan_sha256: "b".repeat(64),
    alias_run_id: "00000000-0000-4000-8000-000000000002",
    paired_solid_sha256: "c".repeat(64),
    cutover_source_sha256: "d".repeat(64),
  },
});
const request = () => parseManagedVideoAdmissionRequest(packet());
const connection =
  "postgresql://operator.branch:fixture-secret@example.pg.psdb.cloud:5432/postgres?sslmode=verify-full&sslrootcert=system";
const migrations = [{ version: "0001", checksum: "e".repeat(64) }];

function fixture(overrides: Record<string, unknown> = {}, ledger = migrations) {
  const statements: ControlPlaneStatement[] = [];
  const db: ControlPlaneDb["Service"] = {
    execute: <Row>(statement: ControlPlaneStatement) => {
      statements.push(statement);
      const rows = statement.label.endsWith("identity")
        ? [
            {
              principal: "operator",
              current_principal: "operator",
              database: "postgres",
              schema: "api_next",
              schema_owner: true,
              ...overrides,
            },
          ]
        : ledger;
      return Effect.succeed({ rows: rows as Row[], rowCount: rows.length });
    },
    withTransaction: (use) => use({ execute: db.execute }),
  };
  return { db, statements };
}

async function receiptDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "video-admission-runner-"));
  directories.push(directory);
  return directory;
}

test("request refuses unknown properties, unsupported actions and inactive or malformed execution windows", () => {
  for (const change of [
    { arbitrary: true },
    { action: "replay" },
    { expires_at: new Date(Date.now() - 1).toISOString() },
    { not_before: new Date(Date.now() + 120_000).toISOString() },
    { expires_at: "not-a-date" },
    { operation_id: "../escape" },
    { plan: { ...packet().plan, contract_sha256: "0".repeat(64) } },
  ])
    expect(() => parseManagedVideoAdmissionRequest({ ...packet(), ...change })).toThrow();
});

test("connection is bound to direct verified TLS, exact host, branch login and database", () => {
  const bound = new URL(bindManagedVideoConnection(request(), connection));
  expect(bound.searchParams.get("sslmode")).toBe("verify-full");
  expect(bound.searchParams.has("sslrootcert")).toBe(false);
  expect(bound.searchParams.get("options")).toBe("-c search_path=api_next,pg_catalog");
  for (const invalid of [
    connection.replace(":5432", ":6432"),
    connection.replace("verify-full", "require"),
    connection.replace("example.pg.psdb.cloud", "other.pg.psdb.cloud"),
    connection.replace("operator.branch:", "operator.other:"),
    connection.replace("/postgres?", "/other?"),
    connection.replace(":fixture-secret", ""),
    connection.replace("postgresql:", "https:"),
    `${connection}&host=other.pg.psdb.cloud`,
    `${connection}&port=6432`,
    `${connection}&user=other`,
    `${connection}&database=other`,
    `${connection}&password=other`,
    `${connection}&sslmode=disable`,
    `${connection}&sslmode=verify-full`,
    `${connection}&ssl=true`,
    `${connection}&sslnegotiation=postgres`,
  ])
    expect(() => bindManagedVideoConnection(request(), invalid)).toThrow("connection_refused");
});

test("actual LOGIN and complete ledger are checked using only read statements", async () => {
  const f = fixture();
  expect(
    await Effect.runPromise(preflightManagedVideoAdmission(f.db, request(), migrations)),
  ).toEqual({ principal: "operator", migrations: 1 });
  expect(f.statements.map((s) => s.label)).toEqual([
    "notifications.video.managed.identity",
    "notifications.video.managed.ledger",
  ]);
  expect(f.statements.every((s) => s.readonly)).toBe(true);
});

test("changed principal, SET ROLE, database, schema or schema ownership refuses before ledger or action", async () => {
  for (const mismatch of [
    { principal: "other" },
    { current_principal: "other" },
    { database: "other" },
    { schema: "public" },
    { schema_owner: false },
  ]) {
    const f = fixture(mismatch);
    await expect(
      Effect.runPromise(preflightManagedVideoAdmission(f.db, request(), migrations)),
    ).rejects.toThrow("principal_refused");
    expect(f.statements).toHaveLength(1);
  }
});

test("missing, additional, reordered or changed migrations refuse", async () => {
  for (const ledger of [
    [],
    [...migrations, ...migrations],
    [{ version: "0002", checksum: migrations[0]?.checksum ?? "" }],
    [{ version: "0001", checksum: "f".repeat(64) }],
  ]) {
    const f = fixture({}, ledger);
    await expect(
      Effect.runPromise(preflightManagedVideoAdmission(f.db, request(), migrations)),
    ).rejects.toThrow("ledger_refused");
  }
});

test("intent is durable before dispatch and an acknowledged result records the exact packet", async () => {
  const directory = await receiptDirectory();
  const r = request();
  const outcome = await recordManagedVideoAdmission(
    r,
    "f".repeat(64),
    directory,
    async (started) => {
      const intent = JSON.parse(
        await readFile(join(directory, `${r.operation_id}.intent.json`), "utf8"),
      );
      expect(intent.packet_sha256).toBe("f".repeat(64));
      expect(intent.plan_sha256).toBe(r.plan.plan_sha256);
      started();
      return { examined: 50 };
    },
  );
  expect(outcome).toEqual({ acknowledged: true, unknown_effect: false, result: { examined: 50 } });
  expect(
    JSON.parse(await readFile(join(directory, `${r.operation_id}.result.json`), "utf8")),
  ).toEqual(outcome);
});

test("concurrent same-ID invocations dispatch once; an existing intent prevents another attempt", async () => {
  const directory = await receiptDirectory();
  const r = request();
  let calls = 0;
  const work = async (started: () => void) => {
    calls++;
    started();
    return null;
  };
  const results = await Promise.allSettled([
    recordManagedVideoAdmission(r, "f".repeat(64), directory, work),
    recordManagedVideoAdmission(r, "f".repeat(64), directory, work),
  ]);
  expect(calls).toBe(1);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  await expect(recordManagedVideoAdmission(r, "f".repeat(64), directory, work)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("post-dispatch failure retains uncertainty and credentials never enter receipts", async () => {
  const directory = await receiptDirectory();
  const r = request();
  const outcome = await recordManagedVideoAdmission(
    r,
    "f".repeat(64),
    directory,
    async (started) => {
      started();
      throw new Error(connection);
    },
  );
  expect(outcome).toEqual({
    acknowledged: false,
    unknown_effect: true,
    code: "video_admission_reconciliation_required",
  });
  for (const name of await readdir(directory))
    expect(await readFile(join(directory, name), "utf8")).not.toContain("fixture-secret");
});

test("preflight failure records no started effect; expired intent is refused before work", async () => {
  const directory = await receiptDirectory();
  const r = request();
  expect(
    await recordManagedVideoAdmission(r, "f".repeat(64), directory, async () => {
      throw new Error("refused");
    }),
  ).toEqual({ acknowledged: false, unknown_effect: false, code: "video_admission_not_started" });
  let called = false;
  await expect(
    recordManagedVideoAdmission(
      { ...r, expires_at: new Date(0).toISOString() },
      "f".repeat(64),
      await receiptDirectory(),
      async () => {
        called = true;
      },
    ),
  ).rejects.toThrow("window_refused");
  expect(called).toBe(false);
});
