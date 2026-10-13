// Actual248+250+251 against private minimal parent schema. Not populated249 proof.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
const origin = "https://community.example";
const owner = (n: number) => `owner_00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64);
const families = [
  "study_sessions_v2",
  "study_review_items",
  "study_session_items_v2",
  "study_spoken_answer_commands",
  "learner_audio_artifacts",
];
const resources = [
  "guest_resource_global_lock",
  "guest_resource_edge_locks",
  "guest_resource_policy_snapshots",
  "guest_resource_cost_policy_snapshots",
  "guest_resource_session_reservations",
  "guest_resource_provider_calls",
  "guest_resource_release_receipts",
];
const publicRoutines = [
  "reserve_guest_resource_session_v1(text,jsonb,text,integer,text,text,jsonb)",
  "reserve_guest_provider_call_v1(text,jsonb,text,text,integer,text,text)",
  "complete_guest_provider_call_v1(text,jsonb,text,text,text,text,text)",
  "release_guest_resource_session_v1(text,jsonb,text,text,text)",
];
const fixturePolicy = (overrides: Record<string, unknown> = {}) => ({
  version: "synthetic-policy-v1",
  costPolicyVersion: "synthetic-cost-v1",
  maximumOwnerActiveSessions: 2,
  maximumOwnerReservedPaidCallsPerRollingDay: 60,
  maximumGlobalActiveSessions: 100,
  maximumGlobalPaidCallsPerRollingDay: 1000,
  maximumGlobalCostMicrosPerRollingDay: "100000000",
  maximumOwnerCostMicrosPerRollingDay: "100000000",
  maximumTrustedEdgeSessionsPerWindow: 100,
  trustedEdgeWindowSeconds: 3600,
  maximumProviderCallCostMicros: "1000",
  ...overrides,
});
type Operation = {
  sourceOwnerId: string;
  kind: "study_start" | "study_answer";
  idempotencyKey: string;
  requestHash: string;
};
type Reply = {
  state: string;
  outcome_id?: string;
  result?: {
    state: string;
    reservationId?: string;
    callId?: string;
    checkpointId?: string;
    maximumCostMicros?: string;
  };
};
type Fixture = {
  admin: Client;
  runtime: Client;
  schema: string;
  role: string;
  runtimeUrl: string;
  connect: () => Promise<Client>;
};
const op = (n: number, key: string, kind: Operation["kind"] = "study_start"): Operation => ({
  sourceOwnerId: owner(n),
  kind,
  idempotencyKey: key,
  requestHash: hash,
});
async function reply(client: Client, sql: string, values: unknown[]) {
  const result = (await client.query<{ result: Reply }>(sql, values)).rows[0]?.result;
  if (!result) throw new Error("missing resource envelope");
  return result;
}
async function seedOwner(f: Fixture, n: number) {
  await f.admin.query(
    "INSERT INTO participation_owners(owner_id,kind,guest_origin,state,created_at) VALUES($1,'guest',$2,'empty',clock_timestamp()-INTERVAL '26 hours')",
    [owner(n), origin],
  );
}
async function reserve(
  f: Fixture,
  n: number,
  key: string,
  units = 20,
  policy: Record<string, unknown> = fixturePolicy(),
  edge = `trusted-edge-${n}`,
  client = f.runtime,
  session = `session-${key}`,
) {
  return reply(
    client,
    "SELECT reserve_guest_resource_session_v1($1,$2::jsonb,$3,$4::integer,$5,$6,$7::jsonb) AS result",
    [
      owner(n),
      JSON.stringify(op(n, key)),
      session,
      units,
      (BigInt(String(policy.maximumProviderCallCostMicros)) * BigInt(units)).toString(),
      edge,
      JSON.stringify(policy),
    ],
  );
}
async function reserveCall(
  f: Fixture,
  n: number,
  key: string,
  reservation: Reply,
  session: string,
  maximum = "1000",
  costVersion = "synthetic-cost-v1",
) {
  return reply(
    f.runtime,
    "SELECT reserve_guest_provider_call_v1($1,$2::jsonb,$3,$4,1,$5,$6) AS result",
    [
      owner(n),
      JSON.stringify(op(n, key, "study_answer")),
      session,
      reservation.outcome_id,
      maximum,
      costVersion,
    ],
  );
}
async function disposition(
  f: Fixture,
  n: number,
  key: string,
  reservation: Reply,
  call: Reply,
  state: string,
  checkpoint: string | null = null,
  cost: string | null = null,
) {
  return reply(
    f.runtime,
    "SELECT complete_guest_provider_call_v1($1,$2::jsonb,$3,$4,$5,$6,$7) AS result",
    [
      owner(n),
      JSON.stringify(op(n, key, "study_answer")),
      reservation.outcome_id,
      call.outcome_id,
      state,
      checkpoint,
      cost,
    ],
  );
}
async function terminal(f: Fixture, n: number, session: string, expired = false) {
  await f.admin.query(
    "INSERT INTO study_sessions_v2(fixture_id,session_id,participation_owner_id,participation_owner_kind,status,expires_at) VALUES($1,$1,$2,'guest',$3,clock_timestamp()+$4::interval)",
    [session, owner(n), expired ? "active" : "completed", expired ? "-1 second" : "24 hours"],
  );
}
async function release(
  f: Fixture,
  n: number,
  key: string,
  reservation: Reply,
  session: string,
  state = "completed",
) {
  return reply(
    f.runtime,
    "SELECT release_guest_resource_session_v1($1,$2::jsonb,$3,$4,$5) AS result",
    [owner(n), JSON.stringify(op(n, key)), session, reservation.outcome_id, state],
  );
}
async function usage(f: Fixture, n: number) {
  return (
    await f.admin.query(
      "SELECT owner_active::int,global_active::int,owner_calls::text,global_calls::text,owner_cost::text,global_cost::text FROM guest_resource_usage_v1($1::text[],clock_timestamp())",
      [[owner(n)]],
    )
  ).rows[0];
}

async function fixture(use: (f: Fixture) => Promise<void>) {
  if (!url) throw new Error("test URL missing");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `guest_resource_${suffix}`;
  const role = `resource_login_${suffix}`;
  const password = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const admin = new Client({
    connectionString: url,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  const clients: Client[] = [];
  let createdRole = false;
  await admin.connect();
  try {
    const command = (
      await admin.query<{ command: string }>(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',$1::name,$2::text) AS command",
        [role, password],
      )
    ).rows[0]?.command;
    if (!command) throw new Error("owned role command missing");
    await admin.query(command);
    createdRole = true;
    await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${role}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${role}";
      CREATE TABLE users(user_id TEXT PRIMARY KEY);
      CREATE TABLE communities(community_id TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE posts(community_id TEXT,post_id TEXT,post_type TEXT,status TEXT,visibility TEXT,content_rating TEXT);
      GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(
      await Bun.file(
        `${process.cwd()}/db/postgres/migrations/0248_guest_learning_authority_foundation.sql`,
      ).text(),
    );
    for (const family of families)
      await admin.query(`CREATE TABLE ${family}(fixture_id TEXT PRIMARY KEY,
      participation_owner_id TEXT NOT NULL,participation_owner_kind TEXT NOT NULL,
      ${family === "study_sessions_v2" ? "session_id TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'active',expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+INTERVAL '24 hours'," : ""}
      FOREIGN KEY(participation_owner_id,participation_owner_kind) REFERENCES participation_owners(owner_id,kind));
      REVOKE ALL ON ${family} FROM PUBLIC,"${role}"`);
    await admin.query(`REVOKE ALL ON users,communities,posts FROM PUBLIC,"${role}"`);
    await admin.query(
      await Bun.file(
        `${process.cwd()}/db/postgres/migrations/0250_guest_browser_authority_transitions.sql`,
      ).text(),
    );
    // Apply the ACTUAL packet as one transaction; topology-before-DDL cannot
    // protect an autocommit-only application. Failed packet rolls back wholly.
    await admin.query("BEGIN");
    try {
      await admin.query(
        await Bun.file(
          `${process.cwd()}/db/postgres/migrations/0251_guest_learning_resource_reservations.sql`,
        ).text(),
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    for (const signature of publicRoutines)
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${role}"`);
    const parsed = new URL(url);
    parsed.username = role;
    parsed.password = password;
    const runtimeUrl = parsed.toString();
    const connect = async () => {
      const client = new Client({
        connectionString: runtimeUrl,
        connectionTimeoutMillis: 3000,
        query_timeout: 5000,
      });
      await client.connect();
      clients.push(client);
      await client.query(
        `SET search_path TO "${schema}"; SET lock_timeout='2s'; SET statement_timeout='4s'`,
      );
      return client;
    };
    const runtime = await connect();
    const identity = (await runtime.query("SELECT current_user AS current,session_user AS session"))
      .rows[0];
    expect(identity).toEqual({ current: role, session: role });
    process.stdout.write(
      `${JSON.stringify({ fixture: "guest-resource-restricted-login", currentEqualsSession: true, roleSha256: createHash("sha256").update(role).digest("hex") })}\n`,
    );
    await use({ admin, runtime, schema, role, runtimeUrl, connect });
  } finally {
    for (const client of clients.reverse()) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (createdRole) {
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE "${role}"`);
    }
    await admin.end();
  }
}

async function blockers(admin: Client, waiting: number, expected: number) {
  const deadline = performance.now() + 1000;
  while (performance.now() < deadline) {
    const ids =
      (
        await admin.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [
          waiting,
        ])
      ).rows[0]?.blockers ?? [];
    if (ids.includes(expected)) return ids;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("actual expected blocker not observed within bound");
}
const pid = async (client: Client) =>
  Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);

suite("guest resource reservations against actual private source", () => {
  test("inherited table/helper privileges are removed and actual definer defeats temporary shadowing", async () =>
    fixture(async (f) => {
      for (const table of [...resources, "guest_learning_schema_phase", ...families]) {
        await expect(f.runtime.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(f.runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(f.runtime.query(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        f.runtime.query("SELECT guest_resource_usage_v1(ARRAY[]::text[],clock_timestamp())"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.runtime.query(`CREATE TABLE "${f.schema}".unowned_write(id TEXT)`),
      ).rejects.toMatchObject({ code: "42501" });
      const migrationRole = (await f.admin.query("SELECT current_user AS role")).rows[0]?.role;
      const roleSwitch = (
        await f.admin.query<{ command: string }>(
          "SELECT format('SET ROLE %I',$1::name) AS command",
          [migrationRole],
        )
      ).rows[0]?.command;
      if (!roleSwitch) throw new Error();
      await expect(f.runtime.query(roleSwitch)).rejects.toMatchObject({ code: "42501" });
      await f.runtime.query("CREATE TEMP TABLE guest_resource_global_lock(singleton BOOLEAN)");
      await seedOwner(f, 1);
      expect((await reserve(f, 1, "real-frame")).result?.state).toBe("reserved");
      expect((await f.admin.query("SELECT phase FROM guest_learning_schema_phase")).rows).toEqual([
        { phase: "practice_only_owner_resource_history_v2" },
      ]);
    }));

  test("session limit2, stable original/refused replay and exact policy/version admission", async () =>
    fixture(async (f) => {
      await seedOwner(f, 1);
      const first = await reserve(f, 1, "first");
      const replay = await reserve(
        f,
        1,
        "first",
        20,
        fixturePolicy(),
        "trusted-edge-1",
        f.runtime,
        "fresh-server-candidate",
      );
      expect(replay).toEqual(first);
      expect(
        (
          await f.admin.query(
            "SELECT session_id FROM guest_resource_session_reservations WHERE reservation_id=$1",
            [first.outcome_id],
          )
        ).rows,
      ).toEqual([{ session_id: "session-first" }]);
      await expect(reserve(f, 1, "first", 19)).rejects.toMatchObject({ code: "GP005" });
      await reserve(f, 1, "second");
      const refused = await reserve(f, 1, "third");
      expect(refused.result?.state).toBe("rate_limited");
      await terminal(f, 1, "session-first");
      await release(f, 1, "release-first", first, "session-first");
      expect(await reserve(f, 1, "third")).toEqual(refused);
      await expect(
        reserve(f, 1, "changed-policy", 1, fixturePolicy({ maximumOwnerActiveSessions: 3 })),
      ).rejects.toMatchObject({ code: "GP006" });
      await expect(
        reserve(f, 1, "changed-version", 1, fixturePolicy({ maximumGlobalActiveSessions: 101 })),
      ).rejects.toMatchObject({ code: "GP006" });
      await expect(
        reserve(f, 1, "partial", 1, {
          ...fixturePolicy(),
          maximumOwnerCostMicrosPerRollingDay: undefined,
        }),
      ).rejects.toMatchObject({ code: "GP006" });
      expect((await usage(f, 1)).owner_active).toBe(1);
    }));

  test(
    "owner rolling60 counts spent calls and does not acquire another allowance on same-key replay",
    async () =>
      fixture(async (f) => {
        await seedOwner(f, 1);
        for (let batch = 0; batch < 2; batch++) {
          const key = `batch-${batch}`;
          const reservation = await reserve(f, 1, key);
          for (let i = 0; i < 20; i++) {
            const callKey = `call-${batch}-${i}`;
            const call = await reserveCall(f, 1, callKey, reservation, `session-${key}`);
            expect(call.result?.state).toBe("reserved");
            await disposition(f, 1, callKey, reservation, call, "failed");
            expect((await reserveCall(f, 1, callKey, reservation, `session-${key}`)).state).toBe(
              "known_aborted",
            );
          }
          await terminal(f, 1, `session-${key}`);
          await release(f, 1, `release-${batch}`, reservation, `session-${key}`);
        }
        expect((await usage(f, 1)).owner_calls).toBe("40");
        await reserve(f, 1, "last-twenty");
        expect((await usage(f, 1)).owner_calls).toBe("60");
        expect((await reserve(f, 1, "sixty-first", 1)).result?.state).toBe("budget_refused");
      }),
    20000,
  );

  test("three simultaneous owner/global admissions obey actual serialized ceilings", async () => {
    await fixture(async (f) => {
      await seedOwner(f, 1);
      const second = await f.connect();
      const third = await f.connect();
      const replies = await Promise.all([
        reserve(f, 1, "race-one", 0),
        reserve(f, 1, "race-two", 0, fixturePolicy(), "trusted-edge-1", second),
        reserve(f, 1, "race-three", 0, fixturePolicy(), "trusted-edge-1", third),
      ]);
      expect(replies.filter((r) => r.result?.state === "reserved")).toHaveLength(2);
      expect(replies.filter((r) => r.result?.state === "rate_limited")).toHaveLength(1);
    });
    await fixture(async (f) => {
      for (const n of [1, 2, 3]) await seedOwner(f, n);
      const second = await f.connect();
      const third = await f.connect();
      const policy = fixturePolicy({ maximumGlobalActiveSessions: 1 });
      const replies = await Promise.all([
        reserve(f, 1, "global-race-one", 0, policy),
        reserve(f, 2, "global-race-two", 0, policy, "edge-2", second),
        reserve(f, 3, "global-race-three", 0, policy, "edge-3", third),
      ]);
      expect(replies.filter((r) => r.result?.state === "reserved")).toHaveLength(1);
      expect(replies.filter((r) => r.result?.state === "rate_limited")).toHaveLength(2);
    });
  }, 20000);

  test("explicit global and edge counters bind all owners; exact micros above2^53 are not coerced", async () => {
    await fixture(async (f) => {
      await seedOwner(f, 1);
      await seedOwner(f, 2);
      const policy = fixturePolicy({ maximumGlobalActiveSessions: 1 });
      await reserve(f, 1, "global-first", 1, policy);
      expect((await reserve(f, 2, "global-second", 1, policy)).result?.state).toBe("rate_limited");
    });
    await fixture(async (f) => {
      await seedOwner(f, 1);
      await seedOwner(f, 2);
      const policy = fixturePolicy({ maximumTrustedEdgeSessionsPerWindow: 1 });
      const first = await reserve(f, 1, "edge-first", 1, policy, "same-trusted-edge");
      await terminal(f, 1, "session-edge-first");
      await release(f, 1, "edge-terminal", first, "session-edge-first");
      expect(
        (await reserve(f, 2, "edge-second", 1, policy, "same-trusted-edge")).result?.state,
      ).toBe("rate_limited");
    });
    await fixture(async (f) => {
      await seedOwner(f, 1);
      await seedOwner(f, 2);
      const policy = fixturePolicy({ maximumGlobalPaidCallsPerRollingDay: 1 });
      await reserve(f, 1, "global-unit-first", 1, policy);
      expect((await reserve(f, 2, "global-unit-second", 1, policy)).result?.state).toBe(
        "budget_refused",
      );
    });
    await fixture(async (f) => {
      await seedOwner(f, 1);
      const policy = fixturePolicy({ maximumOwnerCostMicrosPerRollingDay: "1000" });
      await reserve(f, 1, "owner-cost-first", 1, policy);
      expect((await reserve(f, 1, "owner-cost-second", 1, policy)).result?.state).toBe(
        "budget_refused",
      );
    });
    await fixture(async (f) => {
      await seedOwner(f, 1);
      await seedOwner(f, 2);
      const amount = "9007199254740993";
      const policy = fixturePolicy({
        maximumProviderCallCostMicros: amount,
        maximumGlobalCostMicrosPerRollingDay: amount,
        maximumOwnerCostMicrosPerRollingDay: amount,
      });
      const reservation = await reserve(f, 1, "exact-one", 1, policy);
      expect((await usage(f, 1)).owner_cost).toBe(amount);
      expect((await reserve(f, 2, "over-global-cost", 1, policy)).result?.state).toBe(
        "budget_refused",
      );
      const call = await reserveCall(
        f,
        1,
        "exact-provider",
        reservation,
        "session-exact-one",
        amount,
      );
      expect(call.result?.maximumCostMicros).toBe(amount);
      expect(
        (
          await f.admin.query(
            "SELECT held_cost_micros::text FROM guest_resource_provider_calls WHERE call_id=$1",
            [call.outcome_id],
          )
        ).rows,
      ).toEqual([{ held_cost_micros: amount }]);
    });
  }, 20000);

  test("existing call never redispatches; exact not_invoked returns its same planned hold once; checkpoint stub stays closed", async () =>
    fixture(async (f) => {
      await seedOwner(f, 1);
      const reservation = await reserve(f, 1, "provider-plan", 2);
      const call = await reserveCall(
        f,
        1,
        "provider-once",
        reservation,
        "session-provider-plan",
        "700",
      );
      expect(call.result?.state).toBe("reserved");
      expect(
        (await reserveCall(f, 1, "provider-once", reservation, "session-provider-plan", "700"))
          .result?.state,
      ).toBe("unknown");
      expect((await usage(f, 1)).owner_cost).toBe("2000");
      await disposition(f, 1, "provider-once", reservation, call, "unknown");
      await expect(
        disposition(
          f,
          1,
          "provider-once",
          reservation,
          call,
          "completed",
          "unproved-checkpoint",
          "700",
        ),
      ).rejects.toMatchObject({ code: "GP006" });
      await disposition(f, 1, "provider-once", reservation, call, "not_invoked");
      const after = await usage(f, 1);
      expect(after.owner_calls).toBe("2");
      expect(after.owner_cost).toBe("2000");
      await disposition(f, 1, "provider-once", reservation, call, "not_invoked");
      expect(await usage(f, 1)).toEqual(after);
      expect(
        (await reserveCall(f, 1, "provider-once", reservation, "session-provider-plan", "700"))
          .state,
      ).toBe("known_aborted");
      const next = await reserveCall(
        f,
        1,
        "deliberate-next-command",
        reservation,
        "session-provider-plan",
      );
      expect(next.outcome_id).not.toBe(call.outcome_id);
      await expect(
        disposition(f, 1, "provider-once", reservation, call, "failed"),
      ).rejects.toMatchObject({ code: "GP005" });
    }));

  test("terminal words/absence cannot free a plan; actual expiry releases only remaining units while unknown call remains held", async () =>
    fixture(async (f) => {
      await seedOwner(f, 1);
      const reservation = await reserve(f, 1, "held-plan", 2);
      const call = await reserveCall(f, 1, "held-call", reservation, "session-held-plan");
      await disposition(f, 1, "held-call", reservation, call, "unknown");
      await expect(
        release(f, 1, "fabricated-end", reservation, "session-held-plan"),
      ).rejects.toMatchObject({ code: "GP006" });
      await terminal(f, 1, "session-held-plan", true);
      const released = await release(
        f,
        1,
        "actual-expiry",
        reservation,
        "session-held-plan",
        "expired",
      );
      expect(
        await release(f, 1, "actual-expiry", reservation, "session-held-plan", "expired"),
      ).toEqual(released);
      expect((await usage(f, 1)).owner_calls).toBe("1");
      expect((await usage(f, 1)).owner_cost).toBe("1000");
      expect(
        (await reserveCall(f, 1, "held-call", reservation, "session-held-plan")).result?.state,
      ).toBe("unknown");
      // Raw admin synthetic historic seed models an unresolved invocation older
      // than the rolling window. No immutable timestamps are rewritten.
      await f.admin.query(
        `INSERT INTO guest_resource_provider_calls(call_id,source_owner_id,operation_kind,idempotency_key,request_hash,reservation_id,session_id,units,
      cost_policy_version,maximum_provider_cost_micros,held_cost_micros,disposition,created_at)
      SELECT 'gpc_'||gen_random_uuid()::text,source_owner_id,operation_kind,'old-unknown',request_hash,reservation_id,session_id,units,cost_policy_version,
      maximum_provider_cost_micros,held_cost_micros,'unknown',clock_timestamp()-INTERVAL '25 hours' FROM guest_resource_provider_calls WHERE call_id=$1`,
        [call.outcome_id],
      );
      expect((await usage(f, 1)).owner_calls).toBe("2");
      expect((await usage(f, 1)).owner_cost).toBe("2000");
    }));

  test("resource history remains in the protected full reverse component instead of qualifying as empty", async () =>
    fixture(async (f) => {
      await seedOwner(f, 1);
      await seedOwner(f, 2);
      await seedOwner(f, 3);
      await f.admin.query("BEGIN");
      await f.admin.query(
        "INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at) VALUES($1,$2,$3,clock_timestamp())",
        [owner(2), owner(1), origin],
      );
      await f.admin.query(
        "UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=$1",
        [owner(2)],
      );
      await f.admin.query("COMMIT");
      const template = await reserve(f, 3, "unrelated-template", 0);
      // Valid retained source FK, synthetic stale root state. No original
      // source row is moved or deleted; copied snapshot is correlated to child.
      await f.admin.query(
        `WITH saved_id AS (SELECT 'gr_'||gen_random_uuid()::text AS id)
      INSERT INTO guest_resource_session_reservations(reservation_id,source_owner_id,operation_kind,idempotency_key,request_hash,session_id,
      edge_fingerprint,policy_version,cost_policy_version,initial_units,remaining_units,unit_hold_micros,worst_case_cost_micros,state,original_result,created_at,reservation_expires_at)
      SELECT saved_id.id,$2::text,operation_kind,'child-source-history',request_hash,'child-source-session',edge_fingerprint,policy_version,cost_policy_version,
      0,0,unit_hold_micros,0,'active',jsonb_build_object('state','reserved','reservationId',saved_id.id,'sourceOwnerId',$2::text,'operation',jsonb_build_object('sourceOwnerId',$2::text,'kind','study_start',
      'idempotencyKey','child-source-history','requestHash',request_hash),'remainingUnits',0,'policyVersion',policy_version,'costPolicyVersion',cost_policy_version),
      created_at,reservation_expires_at FROM guest_resource_session_reservations CROSS JOIN saved_id WHERE reservation_id=$1`,
        [template.outcome_id, owner(2)],
      );
      const components = [owner(1), owner(2)];
      expect(
        (
          await f.admin.query(
            "SELECT guest_resource_component_has_history_v1($1::text[]) AS history",
            [components],
          )
        ).rows,
      ).toEqual([{ history: true }]);
      const proofId = () =>
        btoa(String.fromCharCode(...randomBytes(16)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
      const rootProof = proofId();
      const childProof = proofId();
      const peerProof = proofId();
      // Metadata-only privileged seeds for an existing empty alias component.
      // Counter fixture is not a browser proof-verifier acceptance claim.
      for (const [id, source] of [
        [rootProof, owner(1)],
        [childProof, owner(2)],
      ])
        await f.admin.query(
          "INSERT INTO guest_credentials(credential_id,owner_id,origin,secret_digest,state,created_at,pending_expires_at) SELECT $1,$2,$3,$4,'pending_bootstrap',at,at+INTERVAL '15 minutes' FROM (SELECT clock_timestamp() AS at) AS seeded",
          [id, source, origin, hash],
        );
      await seedOwner(f, 4);
      await f.admin.query(
        "INSERT INTO guest_credentials(credential_id,owner_id,origin,secret_digest,state,created_at,pending_expires_at) SELECT $1,$2,$3,$4,'pending_bootstrap',at,at+INTERVAL '15 minutes' FROM (SELECT clock_timestamp() AS at) AS seeded",
        [peerProof, owner(4), origin, hash],
      );
      await expect(
        f.admin.query("SELECT confirm_guest_pending_v1($1,$2::text[],$3,$4)", [
          origin,
          [childProof, peerProof],
          peerProof,
          owner(4),
        ]),
      ).rejects.toMatchObject({ code: "GP003" });
      expect(
        (await f.admin.query("SELECT count(*)::int AS n FROM guest_empty_owner_aliases")).rows,
      ).toEqual([{ n: 1 }]);
      expect(
        (
          await f.admin.query(
            "SELECT source_owner_id FROM guest_resource_session_reservations WHERE idempotency_key='child-source-history'",
          )
        ).rows,
      ).toEqual([{ source_owner_id: owner(2) }]);
    }));

  test("expired uncaptured plan releases only after the exact durable main abort witness", async () =>
    fixture(async (f) => {
      await seedOwner(f, 1);
      const template = await reserve(f, 1, "template-plan", 0);
      const saved = (
        await f.admin.query<{ id: string }>(
          `WITH saved_id AS (SELECT 'gr_'||gen_random_uuid()::text AS id,clock_timestamp() AS at_time)
      INSERT INTO guest_resource_session_reservations(reservation_id,source_owner_id,operation_kind,idempotency_key,request_hash,session_id,
      edge_fingerprint,policy_version,cost_policy_version,initial_units,remaining_units,unit_hold_micros,worst_case_cost_micros,state,original_result,created_at,reservation_expires_at)
      SELECT saved_id.id,source_owner_id,operation_kind,'uncaptured-expired',request_hash,'uncaptured-session',edge_fingerprint,policy_version,cost_policy_version,
      1,1,unit_hold_micros,unit_hold_micros,'active',jsonb_build_object('state','reserved','reservationId',saved_id.id,'sourceOwnerId',source_owner_id,
      'operation',jsonb_build_object('sourceOwnerId',source_owner_id,'kind','study_start','idempotencyKey','uncaptured-expired','requestHash',request_hash),
      'remainingUnits',1,'policyVersion',policy_version,'costPolicyVersion',cost_policy_version),saved_id.at_time-INTERVAL '25 hours',saved_id.at_time-INTERVAL '1 hour'
      FROM guest_resource_session_reservations CROSS JOIN saved_id WHERE reservation_id=$1 RETURNING reservation_id AS id`,
          [template.outcome_id],
        )
      ).rows[0]?.id;
      if (!saved) throw new Error("historic private reservation missing");
      const historic: Reply = { state: "completed", outcome_id: saved };
      await expect(
        release(f, 1, "release-uncaptured", historic, "uncaptured-session", "expired"),
      ).rejects.toMatchObject({ code: "GP006" });
      await f.admin.query(
        "INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at,resolved_at) VALUES($1,$2,'study_start','uncaptured-session','uncaptured-expired',$3,'known_aborted',clock_timestamp()-INTERVAL '25 hours',clock_timestamp())",
        [`operation_${crypto.randomUUID()}`, owner(1), hash],
      );
      expect(
        (await release(f, 1, "release-uncaptured", historic, "uncaptured-session", "expired"))
          .state,
      ).toBe("completed");
      expect(
        (
          await f.admin.query(
            "SELECT state,remaining_units FROM guest_resource_session_reservations WHERE reservation_id=$1",
            [saved],
          )
        ).rows,
      ).toEqual([{ state: "expired", remaining_units: 0 }]);
    }));

  test(
    "real blockers prove global before edge and edge/global before owner, with finite owned clients",
    async () =>
      fixture(async (f) => {
        await seedOwner(f, 1);
        await f.admin.query("INSERT INTO guest_resource_edge_locks VALUES('ordering-edge')");
        const edgeHolder = await f.connect();
        const waiter = await f.connect();
        const probe = await f.connect();
        // Only owned admin can hold raw anchors; runtime probes use the approved
        // routine. Metadata/blocker reads remain on owned admin.
        const holder = new Client({
          connectionString: url,
          connectionTimeoutMillis: 3000,
          query_timeout: 5000,
        });
        await holder.connect();
        let pending: Promise<Reply> | null = null;
        try {
          await holder.query(`SET search_path TO "${f.schema}"; BEGIN`);
          await holder.query(
            "SELECT 1 FROM guest_resource_edge_locks WHERE fingerprint='ordering-edge' FOR UPDATE",
          );
          const holderPid = await pid(holder);
          const waiterPid = await pid(waiter);
          pending = reserve(f, 1, "edge-wait", 0, fixturePolicy(), "ordering-edge", waiter);
          const handled = pending.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          const edgeBlocks = await blockers(f.admin, waiterPid, holderPid);
          const probePid = await pid(probe);
          const probing = reserve(f, 1, "global-probe", 0, fixturePolicy(), "other-edge", probe);
          const handledProbe = probing.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          const globalBlocks = await blockers(f.admin, probePid, waiterPid);
          process.stdout.write(
            `${JSON.stringify({ fixture: "resource-lock-order", edgeBlocks, globalBlocks, holderPid, waiterPid, probePid })}\n`,
          );
          await holder.query("COMMIT");
          const outcome = await handled;
          const probeOutcome = await handledProbe;
          if (!("value" in outcome) || !("value" in probeOutcome))
            throw new Error("owned ordering calls failed");
          expect(outcome.value.result?.state).toBe("reserved");
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          if (pending) await pending.catch(() => undefined);
          await holder.end();
        }
        // edgeHolder is an owned reserved client; confirm actual LOGIN cannot raw
        // lock the anchors. Do not grant it raw access merely to simplify a test.
        await expect(
          edgeHolder.query("SELECT 1 FROM guest_resource_global_lock FOR UPDATE"),
        ).rejects.toMatchObject({ code: "42501" });
        await seedOwner(f, 2);
        await seedOwner(f, 3);
        await seedOwner(f, 4);
        await f.admin.query("BEGIN");
        await f.admin.query(
          "INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at) VALUES($1,$2,$3,clock_timestamp())",
          [owner(4), owner(2), origin],
        );
        await f.admin.query(
          "UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=$1",
          [owner(4)],
        );
        await f.admin.query("COMMIT");
        await f.admin.query("INSERT INTO guest_resource_edge_locks VALUES('owner-ordering-edge')");
        const ownerHolder = new Client({
          connectionString: url,
          connectionTimeoutMillis: 3000,
          query_timeout: 5000,
        });
        const rootProbe = new Client({
          connectionString: url,
          connectionTimeoutMillis: 3000,
          query_timeout: 5000,
        });
        const edgeProbe = new Client({
          connectionString: url,
          connectionTimeoutMillis: 3000,
          query_timeout: 5000,
        });
        const waits: Promise<unknown>[] = [];
        try {
          await Promise.all([ownerHolder.connect(), rootProbe.connect(), edgeProbe.connect()]);
          for (const client of [ownerHolder, rootProbe, edgeProbe])
            await client.query(`SET search_path TO "${f.schema}"`);
          await ownerHolder.query("BEGIN");
          // Hold the reverse-alias CHILD, not the root. Actual helper must lock all
          // component members, with lower-C root already acquired first.
          await ownerHolder.query(
            "SELECT 1 FROM participation_owners WHERE owner_id=$1 FOR UPDATE",
            [owner(4)],
          );
          const ownerHolderPid = await pid(ownerHolder);
          const waiterPid = await pid(waiter);
          const waiting = reserve(
            f,
            2,
            "owner-wait",
            0,
            fixturePolicy(),
            "owner-ordering-edge",
            waiter,
          );
          const handled = waiting.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          waits.push(handled);
          const childBlocks = await blockers(f.admin, waiterPid, ownerHolderPid);
          const rootPid = await pid(rootProbe);
          const edgePid = await pid(edgeProbe);
          const globalPid = await pid(probe);
          const rootWait = rootProbe
            .query("SELECT 1 FROM participation_owners WHERE owner_id=$1 FOR UPDATE", [owner(2)])
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
          const edgeWait = edgeProbe
            .query(
              "SELECT 1 FROM guest_resource_edge_locks WHERE fingerprint='owner-ordering-edge' FOR UPDATE",
            )
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
          const globalWait = reserve(
            f,
            3,
            "owner-global-probe",
            0,
            fixturePolicy(),
            "new-edge",
            probe,
          ).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          waits.push(rootWait, edgeWait, globalWait);
          const [rootBlocks, heldEdgeBlocks, heldGlobalBlocks] = await Promise.all([
            blockers(f.admin, rootPid, waiterPid),
            blockers(f.admin, edgePid, waiterPid),
            blockers(f.admin, globalPid, waiterPid),
          ]);
          process.stdout.write(
            `${JSON.stringify({
              fixture: "resource-complete-component-lock-order",
              childBlocks,
              rootBlocks,
              heldEdgeBlocks,
              heldGlobalBlocks,
              ownerHolderPid,
              waiterPid,
              rootPid,
              edgePid,
              globalPid,
            })}\n`,
          );
          await ownerHolder.query("COMMIT");
          const outcome = await handled;
          if (!("value" in outcome)) throw new Error("owned complete-component call failed");
          expect(outcome.value.result?.state).toBe("reserved");
        } finally {
          await ownerHolder.query("ROLLBACK").catch(() => undefined);
          await Promise.allSettled(waits);
          await Promise.allSettled([ownerHolder.end(), rootProbe.end(), edgeProbe.end()]);
        }
      }),
    20000,
  );
  // Proposal fragment for insertion inside the existing resource suite.
  // Reuses its fixture, seedOwner, reserve, release, usage, owner, hash and op helpers.
  // Not executed; no changes to the sealed original validation packet.
  test("schema phase refuses oddly named foreign references to all three resource identities", async () =>
    fixture(async (f) => {
      const targets = [
        ["guest_resource_session_reservations", "reservation_id"],
        ["guest_resource_provider_calls", "call_id"],
        ["guest_resource_release_receipts", "receipt_id"],
      ] as const;
      await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
      for (const [relation, id] of targets) {
        // Neither table nor column has an owner_id suffix. FK identity inventory
        // must close this relation even with zero rows and no known financial name.
        await f.admin.query(
          `CREATE TABLE unreviewed_resource_link(locator TEXT REFERENCES ${relation}(${id}))`,
        );
        await expect(
          f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()"),
        ).rejects.toMatchObject({ code: "GP003" });
        expect(
          (await f.admin.query("SELECT count(*)::int AS n FROM unreviewed_resource_link")).rows,
        ).toEqual([{ n: 0 }]);
        await f.admin.query("DROP TABLE unreviewed_resource_link");
        // A previous failure must not poison later independent inventory checks.
        await f.admin.query("SELECT require_guest_practice_only_schema_phase_v1()");
      }
    }));

  test("retained nonterminal session defeats an expired known-aborted uncaptured-plan release", async () =>
    fixture(async (f) => {
      await seedOwner(f, 1);
      const template = await reserve(f, 1, "contradiction-template", 0);
      const saved = (
        await f.admin.query<{ id: string }>(
          `WITH saved_id AS (SELECT 'gr_'||gen_random_uuid()::text AS id,clock_timestamp() AS at_time)
         INSERT INTO guest_resource_session_reservations(
           reservation_id,source_owner_id,operation_kind,idempotency_key,request_hash,session_id,
           edge_fingerprint,policy_version,cost_policy_version,initial_units,remaining_units,
           unit_hold_micros,worst_case_cost_micros,state,original_result,created_at,reservation_expires_at)
         SELECT saved_id.id,source_owner_id,operation_kind,'contradictory-start',request_hash,
           'contradictory-session',edge_fingerprint,policy_version,cost_policy_version,
           1,1,unit_hold_micros,unit_hold_micros,'active',
           jsonb_build_object('state','reserved','reservationId',saved_id.id,'sourceOwnerId',source_owner_id,
             'operation',jsonb_build_object('sourceOwnerId',source_owner_id,'kind','study_start',
               'idempotencyKey','contradictory-start','requestHash',request_hash),
             'remainingUnits',1,'policyVersion',policy_version,'costPolicyVersion',cost_policy_version),
           saved_id.at_time-INTERVAL '25 hours',saved_id.at_time-INTERVAL '1 hour'
         FROM guest_resource_session_reservations CROSS JOIN saved_id
         WHERE reservation_id=$1 RETURNING reservation_id AS id`,
          [template.outcome_id],
        )
      ).rows[0]?.id;
      if (!saved) throw new Error("historic contradictory plan missing");
      // Privileged synthetic contradiction only. This proves fail-closed handling;
      // it does not claim the currently closed actual249 guest writer can emit it.
      await f.admin.query(
        "INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at,resolved_at) VALUES($1,$2,'study_start','contradictory-session','contradictory-start',$3,'known_aborted',clock_timestamp()-INTERVAL '25 hours',clock_timestamp())",
        [`operation_${crypto.randomUUID()}`, owner(1), hash],
      );
      await f.admin.query(
        "INSERT INTO study_sessions_v2(fixture_id,session_id,participation_owner_id,participation_owner_kind,status,expires_at) VALUES('retained-contradiction','contradictory-session',$1,'guest','active',clock_timestamp()+INTERVAL '1 hour')",
        [owner(1)],
      );
      const before = await usage(f, 1);
      await expect(
        release(
          f,
          1,
          "contradictory-release",
          { state: "completed", outcome_id: saved },
          "contradictory-session",
          "expired",
        ),
      ).rejects.toMatchObject({ code: "GP006" });
      expect(await usage(f, 1)).toEqual(before);
      expect(
        (
          await f.admin.query(
            "SELECT state,remaining_units,released_at FROM guest_resource_session_reservations WHERE reservation_id=$1",
            [saved],
          )
        ).rows,
      ).toEqual([{ state: "active", remaining_units: 1, released_at: null }]);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM guest_resource_release_receipts WHERE source_owner_id=$1 AND idempotency_key='contradictory-release'",
            [owner(1)],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await f.admin.query(
            "SELECT status FROM study_sessions_v2 WHERE session_id='contradictory-session'",
          )
        ).rows,
      ).toEqual([{ status: "active" }]);
    }));

  test("refused reservation history prevents empty cleanup even when source remains empty", async () =>
    fixture(async (f) => {
      await seedOwner(f, 1);
      await seedOwner(f, 2);
      const constrained = fixturePolicy({ maximumGlobalActiveSessions: 1 });
      await reserve(f, 1, "occupy-global", 0, constrained);
      const refusal = await reserve(f, 2, "retained-refusal", 0, constrained);
      expect(refusal.result?.state).toBe("rate_limited");
      expect(
        (
          await f.admin.query("SELECT state FROM participation_owners WHERE owner_id=$1", [
            owner(2),
          ])
        ).rows,
      ).toEqual([{ state: "empty" }]);
      expect(
        (
          await f.admin.query("SELECT guest_authority_component_is_empty_v1($1) AS empty", [
            owner(2),
          ])
        ).rows,
      ).toEqual([{ empty: false }]);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM guest_resource_session_reservations WHERE source_owner_id=$1",
            [owner(2)],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    }));
});
