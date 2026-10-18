/** Offline tests of the actual pre-DDL callback helper; no pg mocks or sockets. */
import { expect, test } from "bun:test";
import { provisionNotificationsVideoAclRoles } from "./notifications-video-acl.pg-fixture.ts";

const roles = {
  runtimeRole: "notifications_acl_offline_r",
  operatorRole: "notifications_acl_offline_o",
  inheritedRole: "notifications_acl_offline_g",
};
const creation = (role: string) =>
  role === roles.inheritedRole
    ? `CREATE ROLE "${role}" NOLOGIN`
    : `CREATE ROLE "${role}" LOGIN PASSWORD 'offline-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`;
const membership = `GRANT "${roles.inheritedRole}" TO "${roles.runtimeRole}"`;
const removal = (role: string) => [`DROP OWNED BY "${role}"`, `DROP ROLE "${role}"`];

function fixture(
  fault?: { statement: string; error: unknown },
  closeFaults: readonly { error: unknown }[] = [],
) {
  const events: string[] = [];
  const admin = {
    query: async (sql: string) => {
      events.push(sql);
      if (fault && sql === fault.statement) throw fault.error;
    },
  };
  const clients = [0, 1].map((index) => ({
    end: async () => {
      events.push(`end-${index}`);
      const fault = closeFaults[index];
      if (fault) throw fault.error;
    },
  }));
  return {
    events,
    start: () =>
      provisionNotificationsVideoAclRoles({
        admin,
        schema: "offline_schema",
        ...roles,
        password: "offline-only",
        clients,
      }),
  };
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  const [outcome] = await Promise.allSettled([promise]);
  if (!outcome || outcome.status !== "rejected") throw new Error("Expected fixture rejection");
  return outcome.reason;
}

test("the actual ACL provisioner preserves grant/default order and closes before owned role removal", async () => {
  const f = fixture();
  const cleanup = await f.start();
  expect(f.events).toEqual([
    creation(roles.inheritedRole),
    creation(roles.runtimeRole),
    creation(roles.operatorRole),
    membership,
    `GRANT USAGE ON SCHEMA "offline_schema" TO "${roles.runtimeRole}","${roles.operatorRole}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "offline_schema" GRANT ALL ON TABLES TO "${roles.runtimeRole}","${roles.inheritedRole}",PUBLIC`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "offline_schema" GRANT EXECUTE ON FUNCTIONS TO "${roles.runtimeRole}","${roles.inheritedRole}"`,
  ]);
  await cleanup();
  expect(f.events.slice(7)).toEqual([
    "end-0",
    "end-1",
    ...removal(roles.runtimeRole),
    ...removal(roles.operatorRole),
    ...removal(roles.inheritedRole),
  ]);
});

for (const failedRole of [roles.inheritedRole, roles.runtimeRole, roles.operatorRole])
  for (const primary of [new Error("CREATE outcome unknown"), undefined])
    test(`partial CREATE for ${failedRole} retains ${primary === undefined ? "undefined" : "Error"} and only removes acknowledged roles`, async () => {
      const f = fixture({ statement: creation(failedRole), error: primary });
      expect(await rejected(f.start())).toBe(primary);
      const created =
        failedRole === roles.inheritedRole
          ? []
          : failedRole === roles.runtimeRole
            ? [roles.inheritedRole]
            : [roles.runtimeRole, roles.inheritedRole];
      expect(f.events.filter((event) => event.startsWith("DROP"))).toEqual(
        created.flatMap(removal),
      );
      expect(f.events.filter((event) => event.startsWith("end-"))).toEqual(["end-0", "end-1"]);
      expect(f.events.filter((event) => event === creation(failedRole))).toHaveLength(1);
      expect(f.events).not.toContain(membership);
    });

test("failed GRANT preserves its primary and cleans acknowledged roles before callback return", async () => {
  const primary = new Error("GRANT outcome unknown");
  const f = fixture({ statement: membership, error: primary });
  expect(await rejected(f.start())).toBe(primary);
  expect(f.events.slice(4)).toEqual([
    "end-0",
    "end-1",
    ...removal(roles.runtimeRole),
    ...removal(roles.operatorRole),
    ...removal(roles.inheritedRole),
  ]);
});

test("first close rejection cannot skip the second independent close or remove uncertain roles", async () => {
  const closeError = new Error("first close failed");
  const f = fixture(undefined, [{ error: closeError }]);
  const cleanup = await f.start();
  expect(await rejected(cleanup())).toBe(closeError);
  expect(f.events.slice(7)).toEqual(["end-0", "end-1"]);
});

test("two close failures retain both original identities without destructive DDL", async () => {
  const first = new Error("first close failed");
  const second = new Error("second close failed");
  const f = fixture(undefined, [{ error: first }, { error: second }]);
  const cleanup = await f.start();
  const failure = await rejected(cleanup());
  if (!(failure instanceof AggregateError)) throw new Error("Expected close aggregate");
  expect(failure.cause).toBe(first);
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toBe(first);
  expect(failure.errors[1]).toBe(second);
  expect(f.events.slice(7)).toEqual(["end-0", "end-1"]);
});

test("partial setup plus independent close failures retains primary and every closure failure", async () => {
  const primary = new Error("GRANT failed");
  const first = new Error("first close failed");
  const second = new Error("second close failed");
  const f = fixture({ statement: membership, error: primary }, [
    { error: first },
    { error: second },
  ]);
  const failure = await rejected(f.start());
  if (!(failure instanceof AggregateError)) throw new Error("Expected setup aggregate");
  expect(failure.cause).toBe(primary);
  expect(failure.errors[0]).toBe(primary);
  const closes = failure.errors[1];
  if (!(closes instanceof AggregateError)) throw new Error("Expected close aggregate");
  expect(closes.errors[0]).toBe(first);
  expect(closes.errors[1]).toBe(second);
  expect(f.events.slice(4)).toEqual(["end-0", "end-1"]);
});

for (const statement of removal(roles.runtimeRole))
  test(`failed owned cleanup stops before subsequent DDL: ${statement}`, async () => {
    const primary = new Error("cleanup outcome unknown");
    const f = fixture({ statement, error: primary });
    const cleanup = await f.start();
    expect(await rejected(cleanup())).toBe(primary);
    expect(f.events.at(-1)).toBe(statement);
    expect(f.events.filter((event) => event === statement)).toHaveLength(1);
    expect(f.events).not.toContain(removal(roles.operatorRole)[0]);
    expect(f.events).not.toContain(removal(roles.inheritedRole)[0]);
  });

test("partial CREATE and failed cleanup keep the original setup cause and unknown resource failure", async () => {
  const primary = new Error("CREATE failed");
  const closeError = new Error("close failed");
  const f = fixture({ statement: creation(roles.operatorRole), error: primary }, [
    { error: closeError },
  ]);
  const failure = await rejected(f.start());
  if (!(failure instanceof AggregateError)) throw new Error("Expected setup/cleanup aggregate");
  expect(failure.cause).toBe(primary);
  expect(failure.errors[0]).toBe(primary);
  expect(failure.errors[1]).toBe(closeError);
  expect(f.events.slice(-2)).toEqual(["end-0", "end-1"]);
  expect(f.events.some((event) => event.startsWith("DROP"))).toBe(false);
});
