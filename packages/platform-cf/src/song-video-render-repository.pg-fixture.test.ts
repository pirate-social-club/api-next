import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  type SongVideoFixtureDriver,
  songVideoFixtureOwner,
} from "./song-video-render-repository.pg-fixture.ts";

const schema = `song_video_${"a".repeat(32)}`;
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function proof() {
  const events: string[] = [];
  const clients: ProofClient[] = [];
  const catalog = new Map<string, { name: string; oid: string; owner: string; owned: boolean }>();
  const controls = {
    createFailure: false,
    inspectFailure: false,
    dropFailure: false,
    retain: false,
  };
  class ProofClient {
    closed = false;
    closeFailure = false;
    connectFailure = false;
    queryGate: Promise<void> | undefined;
    async connect() {
      events.push("connect");
      if (this.connectFailure) throw new Error("connect failed");
    }
    async query(_statement: string) {
      events.push("query");
      await this.queryGate;
      return { rows: [] };
    }
    async end() {
      events.push("close");
      if (this.closeFailure) throw new Error("close failed");
      this.closed = true;
    }
  }
  const driver: SongVideoFixtureDriver<ProofClient> = {
    client: () => {
      const client = new ProofClient();
      clients.push(client);
      return client;
    },
    create: async (_admin, name) => {
      events.push("create");
      if (controls.createFailure) throw new Error("create response lost");
      if (catalog.has(name)) throw new Error("schema already exists");
      catalog.set(name, { name, oid: "101", owner: "10", owned: true });
    },
    select: async () => {
      events.push("select");
    },
    inspect: async (_admin, name, oid) => {
      events.push("inspect");
      if (controls.inspectFailure) throw new Error("inspect failed");
      return [...catalog.values()]
        .filter((row) => row.name === name || row.oid === oid)
        .map((row) => ({ ...row }));
    },
    drop: async (_admin, identity) => {
      events.push("drop");
      if (clients.slice(1).some((client) => !client.closed))
        throw new Error("DROP attempted before owned clients closed");
      if (controls.dropFailure) throw new Error("drop failed");
      if (!controls.retain) catalog.delete(identity.name);
    },
  };
  const owner = songVideoFixtureOwner({
    schema,
    driver,
    connectionString: "socket-free-base",
    scopedConnectionString: "socket-free-scoped",
  });
  const initialize = () => owner.initialize(() => owner.client.connect());
  return { owner, clients, catalog, controls, events, initialize };
}

// Exercise declaration-time Bun hooks on the same owner used by the PG fixture.
const suite = proof();
const markers: string[] = [];
beforeAll(() => suite.initialize());
afterAll(async () => {
  await suite.owner.dispose();
  expect(suite.catalog.size).toBe(0);
  expect(suite.clients.every((client) => client.closed)).toBe(true);
  expect(suite.events.filter((event) => event === "create")).toHaveLength(1);
  expect(markers).toEqual(["first", "second"]);
});
test("suite first use retains its one owned schema until final disposal", () =>
  suite.owner.run(async () => {
    expect(suite.catalog.size).toBe(1);
    expect(suite.events).not.toContain("drop");
    await suite.owner.client.query("first case");
    markers.push("first");
  }));
test("suite second use preserves shared state and uses the same initialized schema", () =>
  suite.owner.run(async () => {
    expect(markers).toEqual(["first"]);
    expect(suite.catalog.get(schema)?.oid).toBe("101");
    expect(suite.events.filter((event) => event === "create")).toHaveLength(1);
    expect(suite.events).not.toContain("drop");
    markers.push("second");
  }));

test("serialized callbacks and delayed failing siblings cannot be dropped underneath", async () => {
  const f = proof();
  await f.initialize();
  const gate = deferred();
  const primary = new Error("primary operation failed");
  const order: string[] = [];
  const first = f.owner.run(async () => {
    await expect(
      f.owner.all([
        Promise.reject(primary),
        gate.promise.then(() => {
          order.push("sibling");
        }),
      ]),
    ).rejects.toBe(primary);
    order.push("first");
  });
  const second = f.owner.run(async () => {
    order.push("second");
  });
  await expect(f.owner.dispose()).rejects.toThrow("still active");
  expect(f.events).not.toContain("close");
  expect(f.events).not.toContain("drop");
  expect(order).toEqual([]);
  gate.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["sibling", "first", "second"]);
  await f.owner.dispose();
  expect(f.catalog.size).toBe(0);
});
test("a pending public query refuses client close and schema disposal", async () => {
  const f = proof();
  await f.initialize();
  const gate = deferred();
  const raw = f.clients[1];
  if (!raw) throw new Error("proof main client missing");
  raw.queryGate = gate.promise;
  const query = f.owner.client.query("pending statement");
  await expect(f.owner.client.end()).rejects.toThrow("active render client");
  await expect(f.owner.dispose()).rejects.toThrow("still active");
  expect(f.events).not.toContain("close");
  expect(f.events).not.toContain("drop");
  gate.resolve();
  await query;
  await f.owner.dispose();
  expect(f.clients.every((client) => client.closed)).toBe(true);
});
test("all auxiliary clients close before DROP, including one already retired by its operation", async () => {
  const f = proof();
  await f.initialize();
  await f.owner.run(async () => {
    const first = f.owner.newClient();
    const second = f.owner.newClient();
    await first.connect();
    await second.connect();
    await first.query("auxiliary operation");
    await first.end();
  });
  await f.owner.dispose();
  expect(f.clients).toHaveLength(4);
  expect(f.clients.every((client) => client.closed)).toBe(true);
  expect(f.events.filter((event) => event === "close")).toHaveLength(4);
  expect(f.catalog.size).toBe(0);
});
test("partial setup failure preserves the primary error and retires a confirmed schema", async () => {
  const f = proof();
  const primary = new Error("migration failed");
  await expect(
    f.owner.initialize(async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  await f.owner.dispose();
  expect(f.catalog.size).toBe(0);
  expect(f.clients.every((client) => client.closed)).toBe(true);
});
test("incomplete initialization remains active until its actual callback settles", async () => {
  const f = proof();
  const gate = deferred();
  const entered = deferred();
  const initialization = f.owner.initialize(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  await expect(f.owner.dispose()).rejects.toThrow("still active");
  expect(f.events).not.toContain("drop");
  gate.resolve();
  await initialization;
  await f.owner.dispose();
});
test("a failed connection closes allocated clients without schema cleanup", async () => {
  const f = proof();
  const admin = f.clients[0];
  if (!admin) throw new Error("proof admin missing");
  admin.connectFailure = true;
  await expect(f.initialize()).rejects.toThrow("connect failed");
  await expect(f.initialize()).rejects.toThrow("not fresh");
  await f.owner.dispose();
  expect(f.events).not.toContain("create");
  expect(f.events).not.toContain("drop");
  expect(f.clients.every((client) => client.closed)).toBe(true);
});
test("a preexisting or unconfirmed namespace is retained without destructive cleanup", async () => {
  for (const lostResponse of [false, true]) {
    const f = proof();
    f.catalog.set(schema, { name: schema, oid: "999", owner: "10", owned: true });
    f.controls.createFailure = lostResponse;
    await expect(f.initialize()).rejects.toThrow(lostResponse ? "response lost" : "already exists");
    await expect(f.owner.dispose()).rejects.toThrow("unverified or replaced");
    expect(f.catalog.get(schema)?.oid).toBe("999");
    expect(f.events).not.toContain("drop");
    expect(f.clients.every((client) => client.closed)).toBe(true);
  }
});
test("failed identity capture never authorizes dropping an unconfirmed schema", async () => {
  const f = proof();
  f.controls.inspectFailure = true;
  await expect(f.initialize()).rejects.toThrow("inspect failed");
  f.controls.inspectFailure = false;
  await expect(f.owner.dispose()).rejects.toThrow("unverified or replaced");
  expect(f.events).not.toContain("drop");
  expect(f.catalog.size).toBe(1);
});
test("replacement, rename, owner drift and a missing initialized schema refuse DROP", async () => {
  for (const mode of ["replacement", "rename", "owner", "missing"] as const) {
    const f = proof();
    await f.initialize();
    f.catalog.delete(schema);
    if (mode !== "missing") {
      const name = mode === "rename" ? `${schema}_renamed` : schema;
      f.catalog.set(name, {
        name,
        oid: mode === "replacement" ? "202" : "101",
        owner: mode === "owner" ? "20" : "10",
        owned: mode !== "owner",
      });
    }
    await expect(f.owner.dispose()).rejects.toThrow("unverified or replaced");
    expect(f.events).not.toContain("drop");
    expect(f.clients.every((client) => client.closed)).toBe(true);
  }
});
test("close failure prevents DROP and preserves the failure without a hidden retry", async () => {
  const f = proof();
  await f.initialize();
  const raw = f.clients[1];
  if (!raw) throw new Error("proof main client missing");
  raw.closeFailure = true;
  await expect(f.owner.dispose()).rejects.toThrow("close failed");
  await expect(f.owner.dispose()).rejects.toThrow("close failed");
  expect(f.events).not.toContain("drop");
  expect(f.catalog.size).toBe(1);
});
test("DROP failure and a surviving namespace are explicit, with admin still closed", async () => {
  for (const mode of ["drop", "retained"] as const) {
    const f = proof();
    await f.initialize();
    f.controls.dropFailure = mode === "drop";
    f.controls.retain = mode === "retained";
    await expect(f.owner.dispose()).rejects.toThrow(
      mode === "drop" ? "drop failed" : "survived disposal",
    );
    expect(f.clients.every((client) => client.closed)).toBe(true);
    expect(f.catalog.size).toBe(1);
  }
});
test("primary callback and cleanup errors remain independently observable", async () => {
  const f = proof();
  await f.initialize();
  const primary = new Error("primary assertion failed");
  await expect(
    f.owner.run(async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  f.controls.dropFailure = true;
  await expect(f.owner.dispose()).rejects.toThrow("drop failed");
});
