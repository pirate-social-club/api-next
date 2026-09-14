import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import {
  type DisposableCapabilityCommand,
  withPlanetScaleDatabaseCreate,
  writeDisposableCapabilityRecovery,
} from "./staging-persona-disposable-capability.ts";

const now = Date.parse("2026-09-14T12:00:00.000Z");
const id = "abcdefghijkl";
const roleName = "api-next-disposable-reset-fixture";
const baseUsername = "pscale_api_abcdefghijkl";
const branchId = "syu03e00w3ux";
const accessHost = "us-east-3.pg.psdb.cloud";
const role = {
  id,
  name: roleName,
  username: `${baseUsername}.${branchId}`,
  base_username: baseUsername,
  access_host_url: accessHost,
  database_name: "postgres",
  branch: { id: branchId, name: "main" },
  expired: false,
  deleted_at: null,
  dropped_at: null,
  disabled_at: null,
  expires_at: new Date(now + 30 * 60_000).toISOString(),
  inherited_roles: ["postgres"],
};
const created = {
  ...role,
  database_url: `postgresql://${role.username}:fixture-secret@${accessHost}:5432/postgres?sslmode=verify-full&sslrootcert=system`,
};

function provider(
  options: {
    readonly ambiguousCreateFailure?: boolean;
    readonly malformedCreate?: boolean;
    readonly deleteFails?: boolean;
  } = {},
) {
  let deleted = false;
  const calls: readonly string[][] = [];
  const command: DisposableCapabilityCommand = async (args) => {
    (calls as string[][]).push([...args]);
    if (args[1] === "create") {
      if (options.ambiguousCreateFailure) return { ok: false, stdout: "" };
      return {
        ok: true,
        stdout: JSON.stringify(options.malformedCreate ? { name: roleName } : created),
      };
    }
    if (args[0] === "api") return { ok: true, stdout: JSON.stringify(role) };
    if (args[1] === "delete") {
      if (options.deleteFails) return { ok: false, stdout: "" };
      deleted = true;
      return { ok: true, stdout: "{}" };
    }
    if (args[1] === "list") {
      return { ok: true, stdout: JSON.stringify(deleted ? [] : [role]) };
    }
    throw new Error("unexpected command");
  };
  return { command, calls, isDeleted: () => deleted };
}

function client(
  options: { readonly revokeFails?: boolean; readonly loseGrantCommitResponse?: boolean } = {},
) {
  let connected = false;
  let ended = false;
  let granted = false;
  let grantCommitResponseLost = false;
  const queries: string[] = [];
  const value = {
    async connect() {
      connected = true;
    },
    async end() {
      ended = true;
    },
    async query(text: string, _values?: readonly unknown[]) {
      queries.push(text);
      if (text.includes("session_user AS login")) {
        return {
          rows: [{ login: baseUsername, active: baseUsername, database: "postgres", member: true }],
        };
      }
      if (text.startsWith("GRANT CREATE")) granted = true;
      if (text.startsWith("REVOKE CREATE")) {
        if (options.revokeFails) throw new Error("fixture revoke failure");
        granted = false;
      }
      if (text.includes("has_database_privilege")) return { rows: [{ value: granted }] };
      if (
        text === "COMMIT" &&
        granted &&
        options.loseGrantCommitResponse &&
        !grantCommitResponseLost
      ) {
        grantCommitResponseLost = true;
        throw new Error("fixture lost grant commit response");
      }
      return { rows: [] };
    },
  };
  return {
    value: value as unknown as Client,
    queries,
    isConnected: () => connected,
    isEnded: () => ended,
    isGranted: () => granted,
  };
}

const run = <T>(input: {
  readonly execute: () => Promise<T>;
  readonly provider?: ReturnType<typeof provider>;
  readonly client?: ReturnType<typeof client>;
  readonly recordRecovery?: Parameters<typeof withPlanetScaleDatabaseCreate>[0]["recordRecovery"];
}) => {
  const providerFixture = input.provider ?? provider();
  const clientFixture = input.client ?? client();
  return {
    promise: withPlanetScaleDatabaseCreate({
      ownerRole: "api_next",
      roleName,
      accessHost,
      branchId,
      execute: input.execute,
      command: providerFixture.command,
      connect: () => clientFixture.value,
      now: () => now,
      ...(input.recordRecovery === undefined ? {} : { recordRecovery: input.recordRecovery }),
    }),
    provider: providerFixture,
    client: clientFixture,
  };
};

describe("disposable staging database CREATE capability", () => {
  test("grants only around the callback, then revokes and deletes the role", async () => {
    const fixture = client();
    const providerFixture = provider();
    const execution = run({
      client: fixture,
      provider: providerFixture,
      async execute() {
        expect(fixture.isGranted()).toBeTrue();
        return "replaced";
      },
    });
    expect(await execution.promise).toBe("replaced");
    expect(fixture.isConnected()).toBeTrue();
    expect(fixture.isEnded()).toBeTrue();
    expect(fixture.isGranted()).toBeFalse();
    expect(providerFixture.isDeleted()).toBeTrue();
    expect(providerFixture.calls.map((args) => args[1])).toEqual([
      "create",
      `organizations/{org}/databases/pirate-staging/branches/main/roles/${id}`,
      "delete",
      "list",
    ]);
  });

  test("preserves the reset failure after successful capability cleanup", async () => {
    const resetFailure = new Error("reset_schema_replacement_unproven");
    const execution = run({ execute: async () => Promise.reject(resetFailure) });
    await expect(execution.promise).rejects.toBe(resetFailure);
    expect(execution.client.isGranted()).toBeFalse();
    expect(execution.client.isEnded()).toBeTrue();
    expect(execution.provider.isDeleted()).toBeTrue();
  });

  test("revokes and retires the role after a lost grant COMMIT response", async () => {
    const execution = run({
      client: client({ loseGrantCommitResponse: true }),
      execute: async () => {
        throw new Error("callback must not run after an ambiguous grant");
      },
    });
    await expect(execution.promise).rejects.toThrow("fixture lost grant commit response");
    expect(execution.client.isGranted()).toBeFalse();
    expect(execution.client.isEnded()).toBeTrue();
    expect(execution.provider.isDeleted()).toBeTrue();
    expect(execution.client.queries.some((query) => query.startsWith("REVOKE CREATE"))).toBeTrue();
  });

  test("reports unresolved cleanup when CREATE cannot be revoked", async () => {
    const recovery: unknown[] = [];
    const execution = run({
      client: client({ revokeFails: true }),
      execute: async () => "done",
      recordRecovery: async (evidence) => {
        recovery.push(evidence);
      },
    });
    await expect(execution.promise).rejects.toThrow(
      "staging_disposable_capability_cleanup_unresolved",
    );
    expect(execution.client.isEnded()).toBeTrue();
    expect(execution.provider.isDeleted()).toBeFalse();
    expect(recovery).toEqual([
      {
        roleId: id,
        roleName,
        expiresAt: new Date(now + 30 * 60_000).toISOString(),
        databaseCreateRetired: false,
      },
    ]);
  });

  test("discovers and deletes a created role after a malformed creation response", async () => {
    const providerFixture = provider({ malformedCreate: true });
    const execution = run({ provider: providerFixture, execute: async () => "unused" });
    await expect(execution.promise).rejects.toThrow("staging_disposable_role_shape_unproven");
    expect(providerFixture.isDeleted()).toBeTrue();
    expect(providerFixture.calls.map((args) => args[1])).toEqual([
      "create",
      "list",
      "delete",
      "list",
    ]);
  });

  test("discovers and deletes a role after an ambiguous create command failure", async () => {
    const providerFixture = provider({ ambiguousCreateFailure: true });
    const execution = run({ provider: providerFixture, execute: async () => "unused" });
    await expect(execution.promise).rejects.toThrow("staging_disposable_role_create_unproven");
    expect(providerFixture.isDeleted()).toBeTrue();
    expect(providerFixture.calls.map((args) => args[1])).toEqual([
      "create",
      "list",
      "delete",
      "list",
    ]);
  });

  test("writes only redacted recovery metadata with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "disposable-capability-recovery-"));
    try {
      await writeDisposableCapabilityRecovery(directory, {
        roleId: id,
        roleName,
        expiresAt: new Date(now + 30 * 60_000).toISOString(),
        databaseCreateRetired: false,
      });
      const path = join(directory, "staging-disposable-capability-recovery.json");
      const value = await readFile(path, "utf8");
      expect(value).toContain(id);
      expect(value).not.toContain("fixture-secret");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
