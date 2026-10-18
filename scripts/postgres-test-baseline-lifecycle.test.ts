import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReusablePostgresTestSchemaOwnerWithDriver,
  disposeReusablePostgresTestSchemaOwners,
} from "./postgres-test-baseline.ts";
import {
  declareLifecycleProofSuite,
  makeLifecycleProofDriver,
} from "./postgres-test-baseline-lifecycle-fixture.ts";

const baseConnectionString = "postgres://socket-free.invalid/fixture";
const schemaName = "lifecycle-unit";
function fixture() {
  const io = makeLifecycleProofDriver();
  const owner = createReusablePostgresTestSchemaOwnerWithDriver(io.driver);
  return { io, owner };
}
function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function failureOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the fixture operation to reject");
}

describe("declaration-owned reusable PostgreSQL fixture lifecycle without sockets", () => {
  test("is lazy, including disposal of an unused owner, and cannot be reopened", async () => {
    const { io, owner } = fixture();
    expect(io.events).toEqual([]);
    await owner.dispose();
    await owner.dispose();
    expect(io.events).toEqual([]);
    await expect(
      owner.run({ baseConnectionString, schemaName, use: async () => 1 }),
    ).rejects.toThrow("disposed");
    expect(io.clients).toEqual([]);
  });

  test("initializes once, resets data between uses, fingerprints and verifies final disappearance", async () => {
    const { io, owner } = fixture();
    const first = await owner.run({
      baseConnectionString,
      schemaName,
      use: async ({ admin, schema, connectionString }) => {
        expect(new URL(connectionString).searchParams.get("options")).toBe(
          `-c search_path=${schema}`,
        );
        expect(schema.length).toBeLessThanOrEqual(63);
        expect(io.selected(admin).data.get("seed")).toBe("baseline");
        io.selected(admin).data.set("dirty", "previous-test");
        return schema;
      },
    });
    await owner.run({
      baseConnectionString,
      schemaName,
      use: async ({ admin, schema }) => {
        expect(schema).toBe(first);
        expect(io.selected(admin).data.has("dirty")).toBe(false);
        expect(io.selected(admin).data.get("seed")).toBe("baseline");
      },
    });
    expect(io.events.filter((event) => event === "initialize")).toHaveLength(1);
    expect(io.events).not.toContain("drop");
    await owner.dispose();
    const disposedEvents = [...io.events];
    await owner.dispose();
    expect(io.events).toEqual(disposedEvents);
    expect(io.events.filter((event) => event === "reset")).toHaveLength(2);
    expect(io.events.filter((event) => event === "fingerprint")).toHaveLength(3);
    expect(io.events.filter((event) => event === "drop")).toHaveLength(1);
    expect(io.events.indexOf("exists")).toBeGreaterThan(io.events.indexOf("drop"));
    expect(io.schemas.has(first)).toBe(false);
    expect(io.clients.every((client) => client.closed)).toBe(true);
  });

  test("serializes queued uses and refuses active cleanup without destroying the owner", async () => {
    const { io, owner } = fixture();
    const entered = latch();
    const finish = latch();
    const order: string[] = [];
    const first = owner.run({
      baseConnectionString,
      schemaName,
      use: async ({ admin }) => {
        order.push("first-enter");
        io.selected(admin).data.set("dirty", "first");
        entered.release();
        await finish.promise;
        order.push("first-exit");
      },
    });
    await entered.promise;
    const second = owner.run({
      baseConnectionString,
      schemaName,
      use: async ({ admin }) => {
        order.push("second-enter");
        expect(io.selected(admin).data.has("dirty")).toBe(false);
      },
    });
    try {
      await expect(owner.dispose()).rejects.toThrow("still active");
      expect(order).toEqual(["first-enter"]);
      expect(io.clients).toHaveLength(1);
      expect(io.events).not.toContain("drop");
    } finally {
      finish.release();
      await Promise.all([first, second]);
    }
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    await owner.dispose();
    expect(io.schemas.size).toBe(0);
  });

  test("preserves a primary use failure and every client cleanup failure in order", async () => {
    const { io, owner } = fixture();
    const primary = new Error("primary assertion");
    const rollback = new Error("rollback failed");
    const clear = new Error("search path cleanup failed");
    const close = new Error("close failed");
    io.failures.set("rollback", rollback);
    io.failures.set("clearSearchPath", clear);
    io.failures.set("close", close);
    const failure = await failureOf(() =>
      owner.run({
        baseConnectionString,
        schemaName,
        use: async () => {
          throw primary;
        },
      }),
    );
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.cause).toBe(primary);
    expect(failure.errors).toEqual([primary, rollback, clear, close]);
    expect(io.events.slice(-3)).toEqual(["rollback", "clearSearchPath", "close"]);
    expect(io.clients.every((client) => client.closed)).toBe(true);
    io.failures.clear();
    await owner.dispose();
  });

  test("closes a client whose connection failed without attempting queries on it", async () => {
    const { io, owner } = fixture();
    const connect = new Error("connect failed");
    io.failures.set("connect", connect);
    await expect(owner.run({ baseConnectionString, schemaName, use: async () => 1 })).rejects.toBe(
      connect,
    );
    expect(io.events).toEqual(["client", "connect", "close"]);
    await owner.dispose();
    expect(io.clients.every((client) => client.closed)).toBe(true);
    expect(io.schemas.size).toBe(0);
  });

  test("retains a failed initialization, avoids recreating it and disposes the partial schema", async () => {
    const { io, owner } = fixture();
    const initialize = new Error("baseline failed");
    io.failures.set("initialize", initialize);
    await expect(owner.run({ baseConnectionString, schemaName, use: async () => 1 })).rejects.toBe(
      initialize,
    );
    expect(io.schemas.size).toBe(1);
    io.failures.clear();
    await expect(owner.run({ baseConnectionString, schemaName, use: async () => 1 })).rejects.toBe(
      initialize,
    );
    expect(io.events.filter((event) => event === "initialize")).toHaveLength(1);
    await owner.dispose();
    expect(io.schemas.size).toBe(0);
    expect(io.events.filter((event) => event === "exists")).toHaveLength(1);
    expect(io.clients.every((client) => client.closed)).toBe(true);
  });

  test("does not DROP an unconfirmed schema when CREATE loses its acknowledgement", async () => {
    const io = makeLifecycleProofDriver();
    const lost = new Error("CREATE acknowledgement lost");
    const owner = createReusablePostgresTestSchemaOwnerWithDriver({
      ...io.driver,
      async create(client, schema) {
        await io.driver.create(client, schema);
        throw lost;
      },
    });
    await expect(owner.run({ baseConnectionString, schemaName, use: async () => 1 })).rejects.toBe(
      lost,
    );
    await expect(owner.dispose()).rejects.toThrow("ownership is unconfirmed and DROP was refused");
    expect(io.events).not.toContain("drop");
    expect(io.events).toContain("exists");
    expect(io.clients.every((client) => client.closed)).toBe(true);
  });

  test("detects catalog drift before reuse and still drops on a failing final fingerprint", async () => {
    const { io, owner } = fixture();
    await owner.run({
      baseConnectionString,
      schemaName,
      use: async ({ admin }) => {
        io.selected(admin).catalog = "unexpected-ddl";
      },
    });
    let used = false;
    await expect(
      owner.run({
        baseConnectionString,
        schemaName,
        use: async () => {
          used = true;
        },
      }),
    ).rejects.toThrow("between fixture runs");
    expect(used).toBe(false);
    await expect(owner.dispose()).rejects.toThrow("after its final fixture run");
    expect(io.schemas.size).toBe(0);
    expect(io.clients.every((client) => client.closed)).toBe(true);
  });

  test("detects catalog drift in the last use before emitting a completion marker", async () => {
    const { io, owner } = fixture();
    await owner.run({
      baseConnectionString,
      schemaName,
      use: async ({ admin }) => {
        io.selected(admin).catalog = "final-ddl";
      },
    });
    let marker = false;
    await expect(
      (async () => {
        await owner.dispose();
        marker = true;
      })(),
    ).rejects.toThrow("after its final fixture run");
    expect(marker).toBe(false);
    expect(io.schemas.size).toBe(0);
  });

  test("exposes final reset failure while still attempting DROP, verification and close", async () => {
    const { io, owner } = fixture();
    await owner.run({ baseConnectionString, schemaName, use: async () => 1 });
    const reset = new Error("final reset failed");
    io.failures.set("reset", reset);
    await expect(owner.dispose()).rejects.toBe(reset);
    expect(io.events).toContain("drop");
    expect(io.events).toContain("exists");
    expect(io.schemas.size).toBe(0);
    expect(io.clients.every((client) => client.closed)).toBe(true);
  });

  test("exposes DROP failure and retained schema, blocks the marker, and never silently retries disposal", async () => {
    const { io, owner } = fixture();
    await owner.run({ baseConnectionString, schemaName, use: async () => 1 });
    const drop = new Error("DROP failed");
    io.failures.set("drop", drop);
    let marker = false;
    const failure = await failureOf(async () => {
      await owner.dispose();
      marker = true;
    });
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.cause).toBe(drop);
    expect(failure.errors[0]).toBe(drop);
    expect(failure.errors[1]).toBeInstanceOf(Error);
    expect(String(failure.errors[1])).toContain("still exists after disposal");
    expect(marker).toBe(false);
    expect(io.schemas.size).toBe(1);
    expect(io.clients.every((client) => client.closed)).toBe(true);
    const events = [...io.events];
    await expect(owner.dispose()).rejects.toBe(failure);
    expect(io.events).toEqual(events);
    await expect(
      owner.run({ baseConnectionString, schemaName, use: async () => 1 }),
    ).rejects.toThrow("disposed");
  });

  test("refuses success when DROP returns but the exact named schema still exists", async () => {
    const { io, owner } = fixture();
    await owner.run({ baseConnectionString, schemaName, use: async () => 1 });
    io.controls.retainAfterDrop = true;
    await expect(owner.dispose()).rejects.toThrow("still exists after disposal");
    expect(io.clients.every((client) => client.closed)).toBe(true);
  });

  test("binds a lifetime to one connection and schema key", async () => {
    const { io, owner } = fixture();
    await owner.run({ baseConnectionString, schemaName, use: async () => 1 });
    const events = [...io.events];
    await expect(
      owner.run({ baseConnectionString, schemaName: "other", use: async () => 1 }),
    ).rejects.toThrow("cannot change");
    await expect(
      owner.run({
        baseConnectionString: "postgres://another.invalid/fixture",
        schemaName,
        use: async () => 1,
      }),
    ).rejects.toThrow("cannot change");
    expect(io.events).toEqual(events);
    await owner.dispose();
  });

  test("awaits every owner even when the first final disposal fails", async () => {
    const first = fixture();
    const second = fixture();
    await first.owner.run({ baseConnectionString, schemaName, use: async () => 1 });
    await second.owner.run({ baseConnectionString, schemaName, use: async () => 1 });
    const failure = new Error("first owner's reset failed");
    first.io.failures.set("reset", failure);
    await expect(disposeReusablePostgresTestSchemaOwners(first.owner, second.owner)).rejects.toBe(
      failure,
    );
    expect(first.io.schemas.size).toBe(0);
    expect(second.io.schemas.size).toBe(0);
    expect([...first.io.clients, ...second.io.clients].every((client) => client.closed)).toBe(true);
  });
});

function runFiles(labels: readonly string[], failPrimaryAndDrop = false) {
  const directory = mkdtempSync(join(tmpdir(), "api-next-lifecycle-"));
  const trace = join(directory, "trace.log");
  writeFileSync(trace, "");
  const fixturePath = new URL("./postgres-test-baseline-lifecycle-fixture.ts", import.meta.url)
    .pathname;
  const files = labels.map((label) => {
    const file = join(directory, `${label}.test.ts`);
    const declaration = declareLifecycleProofSuite.name;
    writeFileSync(
      file,
      `import { ${declaration} } from ${JSON.stringify(fixturePath)};\n${declaration}(${JSON.stringify({ kind: "socket_free", label, tracePath: trace, failPrimaryAndDrop })});\n`,
    );
    return file;
  });
  const result = Bun.spawnSync([process.execPath, "test", ...files], {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: directory,
      XDG_CACHE_HOME: directory,
      BUN_INSTALL_CACHE_DIR: directory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const events = readFileSync(trace, "utf8").trim().split("\n");
  const log = result.stdout.toString() + result.stderr.toString();
  writeFileSync(join(directory, "test.log"), log);
  console.info(
    JSON.stringify({
      lifecycleProofDirectory: directory,
      runtime: Bun.version,
      exit: result.exitCode,
      events,
      log,
    }),
  );
  return { result, events, log };
}

test("pinned Bun multi-file declaration hooks retain each owner across tests and finish disposal before markers", () => {
  expect(Bun.version).toBe("1.4.0");
  const { result, events, log } = runFiles(["a", "b"]);
  expect(result.exitCode).toBe(0);
  expect(log).toContain("6 pass");
  expect(log).toContain("0 fail");
  for (const label of ["a", "b"]) {
    const own = events.filter((event) => event.startsWith(`${label}:`));
    expect(own.filter((event) => event.startsWith(`${label}:initialize:`))).toHaveLength(2);
    expect(own.filter((event) => event.startsWith(`${label}:reset:`))).toHaveLength(3);
    expect(own.filter((event) => event.startsWith(`${label}:drop:`))).toHaveLength(2);
    const disposal = own.indexOf(`${label}:dispose-enter`);
    expect(disposal).toBeGreaterThan(own.indexOf(`${label}:use-2`));
    expect(disposal).toBeGreaterThan(own.indexOf(`${label}:use-secondary`));
    expect(own.at(-1)).toBe(`${label}:marker`);
    expect(own.slice(0, disposal).some((event) => event.startsWith(`${label}:drop:`))).toBe(false);
  }
  expect(events.indexOf("b:declared")).toBeGreaterThan(events.indexOf("a:marker"));
});

test("the actual Bun afterAll reports both primary and DROP failures and withholds completion", () => {
  const { result, events, log } = runFiles(["failure"], true);
  expect(result.exitCode).toBe(1);
  expect(log).toContain("synthetic primary failure");
  expect(log).toContain("synthetic DROP failure");
  expect(events).not.toContain("failure:marker");
  expect(events.filter((event) => event.startsWith("failure:drop:"))).toHaveLength(2);
  expect(events.filter((event) => event.startsWith("failure:exists:"))).toHaveLength(2);
  expect(events.filter((event) => event.startsWith("failure:close:"))).toHaveLength(5);
});
