import { Client } from "pg";

type SchemaIdentity = Readonly<{ name: string; oid: string; owner: string; owned: boolean }>;
export type SongVideoFixtureDriver<C> = Readonly<{
  client: (connectionString: string | undefined) => C;
  create: (client: C, schema: string) => Promise<void>;
  select: (client: C, schema: string) => Promise<void>;
  inspect: (
    client: C,
    schema: string,
    oid: string | undefined,
  ) => Promise<readonly SchemaIdentity[]>;
  drop: (client: C, identity: SchemaIdentity) => Promise<void>;
}>;

function failuresOrThrow(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message, { cause: failures[0] });
}

/** One suite lifetime, with no per-case reset: these render cases intentionally share rows. */
export function songVideoFixtureOwner<C extends object>(options: {
  readonly connectionString: string | undefined;
  readonly scopedConnectionString: string;
  readonly schema: string;
  readonly driver: SongVideoFixtureDriver<C>;
}) {
  const { driver, schema } = options;
  if (!/^song_video_[a-f0-9]{32}$/u.test(schema)) throw new Error("Invalid owned render schema");
  type OwnedClient = { raw: C; pending: number; closing: Promise<void> | undefined };
  const clients: OwnedClient[] = [];
  let pending = 0;
  let initializationStarted = false;
  let initialized = false;
  let attempted = false;
  let identity: SchemaIdentity | undefined;
  let closed = false;
  let disposal: Promise<void> | undefined;
  let queue = Promise.resolve();

  function invoke(raw: C, method: string, args: unknown[]): Promise<unknown> {
    const fn: unknown = Reflect.get(raw, method, raw);
    if (typeof fn !== "function") throw new Error(`Fixture client lacks ${method}`);
    const result: unknown = Reflect.apply(fn, raw, args);
    if (!(result instanceof Promise)) throw new Error("Fixture clients require promise APIs");
    return result;
  }
  function close(record: OwnedClient): Promise<void> {
    if (record.pending !== 0)
      return Promise.reject(new Error("Refusing to close an active render client"));
    record.closing ??= invoke(record.raw, "end", []).then(() => undefined);
    return record.closing;
  }
  function ownedClient(connectionString: string | undefined): C {
    if (closed) throw new Error("Render fixture is disposed");
    const record: OwnedClient = {
      raw: driver.client(connectionString),
      pending: 0,
      closing: undefined,
    };
    clients.push(record);
    // Instrument the public promise APIs, not pg's private socket/query fields.
    return new Proxy(record.raw, {
      get(raw, property) {
        const value: unknown = Reflect.get(raw, property, raw);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "end") {
            if (args.length !== 0) throw new Error("Fixture clients require promise APIs");
            return close(record);
          }
          if (property !== "connect" && property !== "query")
            return Reflect.apply(value, raw, args);
          if (closed || record.closing !== undefined)
            throw new Error("Render fixture client is closed");
          if (args.some((arg) => typeof arg === "function"))
            throw new Error("Fixture clients require promise APIs");
          record.pending += 1;
          try {
            return invoke(raw, property, args).finally(() => {
              record.pending -= 1;
            });
          } catch (error) {
            record.pending -= 1;
            throw error;
          }
        };
      },
    });
  }
  const admin = ownedClient(options.connectionString);
  const client = ownedClient(options.scopedConnectionString);
  const firstClient = clients[0];
  if (firstClient === undefined) throw new Error("Render fixture admin missing");
  const adminRecord: OwnedClient = firstClient;

  async function initialize(use: () => Promise<void>): Promise<void> {
    if (closed || initializationStarted || pending !== 0)
      throw new Error("Render fixture initialization is not fresh");
    initializationStarted = true;
    pending += 1;
    try {
      await invoke(admin, "connect", []);
      attempted = true;
      await driver.create(adminRecord.raw, schema);
      const rows = await driver.inspect(adminRecord.raw, schema, undefined);
      const found = rows[0];
      if (
        rows.length !== 1 ||
        found?.name !== schema ||
        !found.owned ||
        !/^\d+$/u.test(found.oid) ||
        !/^\d+$/u.test(found.owner)
      )
        throw new Error("Created render schema identity is unconfirmed");
      identity = { ...found };
      await driver.select(adminRecord.raw, schema);
      await use();
      initialized = true;
    } finally {
      pending -= 1;
    }
  }
  async function run<A>(use: () => Promise<A>): Promise<A> {
    if (closed || !initialized) throw new Error("Render fixture is not available");
    pending += 1;
    const previous = queue;
    let release: () => void = () => undefined;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await use();
    } finally {
      pending -= 1;
      release();
    }
  }
  async function all<const A extends readonly unknown[]>(values: A) {
    const settled = await Promise.allSettled(values);
    failuresOrThrow(
      settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      "Concurrent render fixture operations failed",
    );
    return Promise.all(values);
  }
  async function cleanup(): Promise<void> {
    const failures: unknown[] = [];
    for (const record of clients.slice(1)) {
      try {
        await close(record);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0 && attempted) {
      try {
        // Roll back a failed test transaction before inspecting the owned catalog.
        await invoke(adminRecord.raw, "query", ["ROLLBACK"]);
        const rows = await driver.inspect(adminRecord.raw, schema, identity?.oid);
        if (rows.length !== 0 || initialized) {
          const found = rows[0];
          if (
            identity === undefined ||
            rows.length !== 1 ||
            found?.name !== schema ||
            !found.owned ||
            found.oid !== identity.oid ||
            found.owner !== identity.owner
          )
            throw new Error("Refusing to drop an unverified or replaced render schema");
          await driver.drop(adminRecord.raw, identity);
          if ((await driver.inspect(adminRecord.raw, schema, identity.oid)).length !== 0)
            throw new Error("Owned render schema survived disposal");
        }
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await close(adminRecord);
    } catch (error) {
      failures.push(error);
    }
    failuresOrThrow(failures, "Render fixture schema/client disposal failed");
  }
  async function dispose(): Promise<void> {
    // Bun can time out a test without settling its returned callback. Preserve
    // that unknown work and fail admission instead of closing or dropping under it.
    if (pending !== 0 || clients.some((record) => record.pending !== 0))
      throw new Error("Render fixture work is still active; cleanup refused");
    closed = true;
    disposal ??= cleanup();
    await disposal;
  }
  return {
    admin,
    client,
    newClient: () => ownedClient(options.scopedConnectionString),
    initialize,
    run,
    all,
    dispose,
  };
}

export function createSongVideoRenderFixture(connectionString: string | undefined) {
  const schema = `song_video_${crypto.randomUUID().replaceAll("-", "")}`;
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const driver: SongVideoFixtureDriver<Client> = {
    client: (url) => new Client({ connectionString: url }),
    create: async (admin, name) => {
      await admin.query(`CREATE SCHEMA "${name}"`);
    },
    select: async (admin, name) => {
      await admin.query(`SET search_path TO "${name}"`);
    },
    inspect: async (admin, name, oid) =>
      (
        await admin.query<SchemaIdentity>(
          `SELECT nspname AS name,oid::text,nspowner::text AS owner,
              nspowner=current_user::regrole AS owned FROM pg_catalog.pg_namespace
        WHERE nspname=$1 OR oid=$2::oid`,
          [name, oid ?? null],
        )
      ).rows,
    drop: async (admin, identity) => {
      // Repeat the exact OID/creator check at the destructive statement boundary.
      await admin.query(`DO $dispose$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
          WHERE nspname='${schema}' AND oid=${identity.oid}::oid
            AND nspowner=${identity.owner}::oid AND nspowner=current_user::regrole)
        THEN RAISE EXCEPTION 'render fixture namespace identity changed'; END IF;
        DROP SCHEMA "${schema}" CASCADE;
      END $dispose$`);
    },
  };
  return {
    scoped,
    ...songVideoFixtureOwner({
      connectionString,
      scopedConnectionString: scoped.toString(),
      schema,
      driver,
    }),
  };
}
