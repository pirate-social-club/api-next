import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("Postgres test URL required");
const suite = connectionString ? describe : describe.skip;
const leaseMigration = "0242_reward_operations_run_lease.sql";

const suffix = randomUUID().replaceAll("-", "");
const schema = `run_lease_${suffix}`;
const runtimeRole = `run_lease_runtime_${suffix}`;
const readerRole = `run_lease_reader_${suffix}`;
const scoped = (role?: string) => {
  const url = new URL(connectionString ?? "postgres://invalid");
  url.searchParams.set(
    "options",
    `-c search_path=${schema},pg_temp${role === undefined ? "" : ` -c role=${role}`}`,
  );
  return url.toString();
};
let admin: Client;
let second: Client;
let runtime: Client;
let reader: Client;

/** The SQLSTATE a statement fails with, or null when it succeeds. */
async function refused(client: Client, text: string, values: unknown[] = []) {
  try {
    await client.query(text, values);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}
const one = async <Row extends Record<string, unknown>>(
  client: Client,
  text: string,
  values: unknown[] = [],
) => (await client.query<Row>(text, values)).rows[0] as Row;
const control = () =>
  one<{ paused: boolean; revision: string }>(
    admin,
    "SELECT paused, revision::text FROM reward_operations_control WHERE singleton",
  );
const lease = () =>
  one<{
    required: boolean;
    run_id: string | null;
    fence: string;
    live: boolean | null;
    capped: boolean | null;
  }>(
    admin,
    `SELECT required, run_id, fence::text,
            clock_timestamp() < expires_at AND clock_timestamp() < absolute_deadline AS live,
            expires_at <= absolute_deadline AS capped
       FROM reward_operations_run_lease WHERE singleton`,
  );
async function setPaused(paused: boolean) {
  const { revision } = await control();
  await admin.query("SELECT set_reward_operations_paused_v1($1::bigint,$2,'run lease test')", [
    revision,
    paused,
  ]);
}
/** Only a deployment that says so may change whether a lease is required. */
async function setRequired(required: boolean) {
  await admin.query("BEGIN");
  await admin.query("SET LOCAL pirate.reward_run_lease_requirement_change = 'deployment'");
  await admin.query("UPDATE reward_operations_run_lease SET required=$1 WHERE singleton", [
    required,
  ]);
  await admin.query("COMMIT");
}
/** Moves the database's view of the lease into the past; the functions never do this. */
const expire = () =>
  admin.query(
    `UPDATE reward_operations_run_lease
        SET expires_at = clock_timestamp() - interval '1 second' WHERE singleton`,
  );
const acquire = async (runId: string, ttl = 60, max = 600) =>
  (
    await one<{ fence: string }>(
      admin,
      "SELECT acquire_reward_run_lease_v1($1,$2,$3)::text AS fence",
      [runId, ttl, max],
    )
  ).fence;
let runCounter = 0;
const freshRun = () => `run-${suffix.slice(0, 8)}-${++runCounter}`;
let nonceCounter = 0;
/** A nonce reservation as the runtime role makes it: the signing admission point. */
const reserveNonce = (client: Client = runtime) =>
  refused(
    client,
    `INSERT INTO reward_signer_nonces (
       chain_id, signer_address, next_nonce, observed_pending_nonce,
       observed_block_number, observed_block_hash, observed_at
     ) VALUES (84532, $1, 1, 0, 1, $2, clock_timestamp())`,
    [`0x${(++nonceCounter).toString(16).padStart(40, "0")}`, `0x${"a".repeat(64)}`],
  );
/** Returns everything to the starting state: paused, not required, no live lease. */
async function reset() {
  if ((await lease()).live) await expire();
  if (!(await control()).paused) await setPaused(true);
  if ((await lease()).required) await setRequired(false);
}

suite("rewards run lease", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}, pg_temp`);
    const migrations = await loadPostgresMigrations();
    const index = migrations.findIndex((migration) => migration.version === leaseMigration);
    expect(index).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, index)) await admin.query(migration.sql);
    // A runtime role as a deployment provisions it, before the lease exists: the
    // migration must take away whatever it would inherit and grant only reads.
    await admin.query(`CREATE ROLE ${runtimeRole} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ${runtimeRole}`,
    );
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${runtimeRole}`,
    );
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON reward_signer_nonces, reward_chain_effects,
         reward_chain_effect_transitions TO ${runtimeRole}`,
    );
    // A role that can only read the nonce table, as a reporting role might.
    await admin.query(`CREATE ROLE ${readerRole} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${readerRole}`);
    await admin.query(`GRANT SELECT ON reward_signer_nonces TO ${readerRole}`);
    await admin.query(migrations[index]?.sql ?? "");
    second = new Client({ connectionString: scoped() });
    runtime = new Client({ connectionString: scoped(runtimeRole) });
    reader = new Client({ connectionString: scoped(readerRole) });
    await second.connect();
    await runtime.connect();
    await reader.connect();
  }, 180_000);

  afterAll(async () => {
    await runtime?.end().catch(() => undefined);
    await reader?.end().catch(() => undefined);
    await second?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      for (const role of [runtimeRole, readerRole]) {
        await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });

  test("the runtime role may read the lease, pause on expiry and ask for authority, and nothing else", async () => {
    await reset();
    expect((await runtime.query("SELECT current_user AS role")).rows).toEqual([
      { role: runtimeRole },
    ]);
    for (const table of ["reward_operations_run_lease", "reward_operations_run_lease_events"]) {
      expect(await refused(runtime, `SELECT * FROM ${table}`)).toBeNull();
      for (const write of [
        `UPDATE ${table} SET fence = fence`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ])
        expect(await refused(runtime, write)).toBe("42501");
    }
    expect(
      await refused(runtime, "INSERT INTO reward_operations_run_lease(singleton) VALUES (TRUE)"),
    ).toBe("42501");
    for (const call of [
      "SELECT acquire_reward_run_lease_v1('run-a',60,600)",
      "SELECT renew_reward_run_lease_v1('run-a',1,60)",
      "SELECT release_reward_run_lease_v1('run-a',1)",
      "SELECT set_reward_operations_paused_v1(0,false,'resume')",
      "SELECT guard_reward_run_lease_admission()",
      "SELECT guard_reward_run_lease_signature()",
    ])
      expect(await refused(runtime, call)).toBe("42501");
    expect(
      await refused(runtime, "SELECT pause_reward_operations_on_lease_expiry_v1()"),
    ).toBeNull();
    expect(await refused(runtime, "SELECT require_reward_run_authority_v1()")).toBeNull();
    // Nor may anyone else by default.
    const open = await admin.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p
        WHERE p.pronamespace = $1::regnamespace AND p.proname LIKE '%run_lease%'
          AND has_function_privilege('public', p.oid, 'EXECUTE')`,
      [schema],
    );
    expect(open.rows).toEqual([]);
  });

  test("a role that can only read the nonce table may read the lease and do nothing with it", async () => {
    await reset();
    expect((await reader.query("SELECT current_user AS role")).rows).toEqual([
      { role: readerRole },
    ]);
    expect(await refused(reader, "SELECT * FROM reward_operations_run_lease")).toBeNull();
    // Being able to read nonces is not being a runtime writer: it may not pause
    // operations, and it has no signing to ask authority for.
    for (const call of [
      "SELECT pause_reward_operations_on_lease_expiry_v1()",
      "SELECT require_reward_run_authority_v1()",
      "SELECT acquire_reward_run_lease_v1('run-a',60,600)",
      "SELECT renew_reward_run_lease_v1('run-a',1,60)",
      "SELECT release_reward_run_lease_v1('run-a',1)",
    ])
      expect(await refused(reader, call)).toBe("42501");
    // Even with an expired required lease and a running brake, it cannot pause.
    await setRequired(true);
    await acquire(freshRun());
    await setPaused(false);
    await expire();
    expect(await refused(reader, "SELECT pause_reward_operations_on_lease_expiry_v1()")).toBe(
      "42501",
    );
    expect((await control()).paused).toBe(false);
  });

  test("authority is never granted for a combination of brake and lease that was not committed", async () => {
    await reset();
    await setRequired(true);
    // The committed state only ever alternates between paused with a live lease
    // and running with a released lease. Neither carries authority, so a caller
    // that read the two rows at different moments would be the only one let through.
    let runId = freshRun();
    let fence = await acquire(runId, 600, 600);
    let done = false;
    let allowed = 0;
    let refusals = 0;
    const asking = (async () => {
      while (!done) {
        const code = await refused(runtime, "SELECT require_reward_run_authority_v1()");
        if (code === null) allowed += 1;
        else if (code === "PR001") refusals += 1;
        else throw new Error(`unexpected refusal ${code}`);
      }
    })();
    for (let turn = 0; turn < 150; turn++) {
      await admin.query("BEGIN");
      await admin.query("SELECT release_reward_run_lease_v1($1,$2::bigint)", [runId, fence]);
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,false,'release then resume') FROM reward_operations_control",
      );
      await admin.query("COMMIT");
      await admin.query("BEGIN");
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,true,'pause then acquire') FROM reward_operations_control",
      );
      runId = freshRun();
      fence = (
        await admin.query<{ fence: string }>(
          "SELECT acquire_reward_run_lease_v1($1,600,600)::text AS fence",
          [runId],
        )
      ).rows[0]?.fence as string;
      await admin.query("COMMIT");
    }
    done = true;
    await asking;
    expect(refusals).toBeGreaterThan(0);
    expect(allowed).toBe(0);
  }, 120_000);

  test("the owner cannot change the requirement by accident, nor rewrite or delete the evidence", async () => {
    await reset();
    expect(
      await refused(
        admin,
        "UPDATE reward_operations_run_lease SET required = TRUE WHERE singleton",
      ),
    ).toBe("PR003");
    expect((await lease()).required).toBe(false);
    expect(await refused(admin, "DELETE FROM reward_operations_run_lease")).toBe("PR003");
    await acquire(freshRun());
    expect(
      await refused(
        admin,
        "UPDATE reward_operations_run_lease SET fence = fence - 1 WHERE singleton",
      ),
    ).toBe("PR003");
    expect(await refused(admin, "DELETE FROM reward_operations_run_lease_events")).not.toBeNull();
    expect(
      await refused(admin, "UPDATE reward_operations_run_lease_events SET actor_role = 'other'"),
    ).not.toBeNull();
  });

  test("where no lease is required, admission behaves exactly as the brake alone decides", async () => {
    await reset();
    // Paused: the brake's own guard refuses, with or without a lease.
    expect(await reserveNonce()).toBe("PR001");
    await setPaused(false);
    expect(await reserveNonce()).toBeNull();
    // Authority is granted without reading the brake.
    await setPaused(true);
    expect(await refused(runtime, "SELECT require_reward_run_authority_v1()")).toBeNull();
    // And the pause function does nothing.
    await setPaused(false);
    expect(
      await one(runtime, "SELECT pause_reward_operations_on_lease_expiry_v1() AS paused"),
    ).toEqual({ paused: false });
    expect((await control()).paused).toBe(false);
  });

  test("acquisition is bounded, needs a paused brake and a new run, and grants nothing by itself", async () => {
    await reset();
    await setRequired(true);
    for (const [runId, ttl, max] of [
      ["Bad Run", 60, 600],
      ["run-ok", 29, 600],
      ["run-ok", 601, 7200],
      ["run-ok", 120, 60],
      ["run-ok", 60, 7201],
    ] as const)
      expect(
        await refused(admin, "SELECT acquire_reward_run_lease_v1($1,$2,$3)", [runId, ttl, max]),
      ).toBe("PR003");
    await setPaused(false);
    expect(
      await refused(admin, "SELECT acquire_reward_run_lease_v1($1,60,600)", [freshRun()]),
    ).toBe("PR003");
    await setPaused(true);
    const runId = freshRun();
    const before = await lease();
    const fence = await acquire(runId, 600, 600);
    expect(BigInt(fence)).toBe(BigInt(before.fence) + 1n);
    expect(await lease()).toMatchObject({ run_id: runId, fence, live: true, capped: true });
    // Acquisition left the brake paused, and with it nothing may sign or be admitted.
    expect((await control()).paused).toBe(true);
    expect(await refused(runtime, "SELECT require_reward_run_authority_v1()")).toBe("PR001");
    expect(await reserveNonce()).toBe("PR001");
    // A held lease and a used run identifier are both refused.
    expect(
      await refused(admin, "SELECT acquire_reward_run_lease_v1($1,60,600)", [freshRun()]),
    ).toBe("PR003");
    await expire();
    expect(await refused(admin, "SELECT acquire_reward_run_lease_v1($1,60,600)", [runId])).toBe(
      "PR003",
    );
    // Only after the operator resumes does a live lease carry authority.
    await acquire(freshRun());
    await setPaused(false);
    expect(await refused(runtime, "SELECT require_reward_run_authority_v1()")).toBeNull();
    expect(await reserveNonce()).toBeNull();
  });

  test("losing the runner stops admission and authority at expiry, before any job runs", async () => {
    await reset();
    await setRequired(true);
    await acquire(freshRun());
    await setPaused(false);
    expect(await reserveNonce()).toBeNull();
    await expire();
    // No renewal came. The brake row still says running, and nothing has paused it.
    expect((await control()).paused).toBe(false);
    expect(await reserveNonce()).toBe("PR001");
    expect(await refused(runtime, "SELECT require_reward_run_authority_v1()")).toBe("PR001");
    const paused = await control();
    // A delayed job then pauses it once, and cannot do anything else.
    expect(
      await one(runtime, "SELECT pause_reward_operations_on_lease_expiry_v1() AS paused"),
    ).toEqual({ paused: true });
    expect(await control()).toEqual({
      paused: true,
      revision: (BigInt(paused.revision) + 1n).toString(),
    });
    expect(
      await one(runtime, "SELECT pause_reward_operations_on_lease_expiry_v1() AS paused"),
    ).toEqual({ paused: false });
    expect((await control()).paused).toBe(true);
    // The event records the session's login. This test reaches the runtime role by
    // SET ROLE on one login, so only the kind is asserted here.
    const recorded = await admin.query<{ event_kind: string }>(
      `SELECT event_kind FROM reward_operations_run_lease_events ORDER BY event_id DESC LIMIT 1`,
    );
    expect(recorded.rows).toEqual([{ event_kind: "expiry_paused" }]);
  });

  test("a live lease is never paused by the job", async () => {
    await reset();
    await setRequired(true);
    await acquire(freshRun());
    await setPaused(false);
    expect(
      await one(runtime, "SELECT pause_reward_operations_on_lease_expiry_v1() AS paused"),
    ).toEqual({ paused: false });
    expect((await control()).paused).toBe(false);
  });

  test("renewal is fenced, never revives an expired run and never touches the brake", async () => {
    await reset();
    await setRequired(true);
    const runId = freshRun();
    const first = await acquire(runId, 60, 600);
    await setPaused(false);
    const renew = (fence: string, ttl = 60) =>
      refused(admin, "SELECT renew_reward_run_lease_v1($1,$2::bigint,$3)", [runId, fence, ttl]);
    expect(await renew(first, 29)).toBe("PR003");
    expect(await renew(first)).toBeNull();
    const current = (await lease()).fence;
    expect(BigInt(current)).toBe(BigInt(first) + 1n);
    // A stale holder presents the superseded fence; the current holder is unaffected.
    expect(await renew(first)).toBe("PR003");
    expect(await lease()).toMatchObject({ fence: current, live: true });
    expect(
      await refused(admin, "SELECT renew_reward_run_lease_v1($1,$2::bigint,60)", [
        "another-run",
        current,
      ]),
    ).toBe("PR003");
    expect((await control()).paused).toBe(false);
    // Renewal cannot pass the absolute deadline however often it is repeated.
    await admin.query(
      `UPDATE reward_operations_run_lease
          SET expires_at = clock_timestamp() + interval '5 seconds',
              absolute_deadline = clock_timestamp() + interval '5 seconds'
        WHERE singleton`,
    );
    let fence = current;
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(await renew(fence, 600)).toBeNull();
      fence = (await lease()).fence;
    }
    expect(
      await one(
        admin,
        `SELECT expires_at = absolute_deadline AS at_deadline,
                absolute_deadline < clock_timestamp() + interval '6 seconds' AS unmoved
           FROM reward_operations_run_lease WHERE singleton`,
      ),
    ).toEqual({ at_deadline: true, unmoved: true });
    // Once expired, the right fence is refused too, and the brake is still as it was.
    await expire();
    expect(await renew(fence)).toBe("PR003");
    expect(await lease()).toMatchObject({ fence, live: false });
    expect((await control()).paused).toBe(false);
  });

  test("a lease past its absolute deadline is not live even if its expiry had been later", async () => {
    await reset();
    await setRequired(true);
    await acquire(freshRun());
    await setPaused(false);
    // Both bounds are checked: here only the absolute deadline has passed.
    await admin.query("ALTER TABLE reward_operations_run_lease DISABLE TRIGGER USER");
    try {
      await admin.query(
        `ALTER TABLE reward_operations_run_lease DROP CONSTRAINT reward_operations_run_lease_deadline`,
      );
      await admin.query(
        `UPDATE reward_operations_run_lease
            SET absolute_deadline = clock_timestamp() - interval '1 second' WHERE singleton`,
      );
      expect(await reserveNonce()).toBe("PR001");
      expect(await refused(runtime, "SELECT require_reward_run_authority_v1()")).toBe("PR001");
      expect(
        await one(runtime, "SELECT pause_reward_operations_on_lease_expiry_v1() AS paused"),
      ).toEqual({ paused: true });
    } finally {
      await admin.query(
        `UPDATE reward_operations_run_lease SET expires_at = absolute_deadline WHERE singleton`,
      );
      await admin.query(
        `ALTER TABLE reward_operations_run_lease
           ADD CONSTRAINT reward_operations_run_lease_deadline CHECK (expires_at <= absolute_deadline)`,
      );
      await admin.query("ALTER TABLE reward_operations_run_lease ENABLE TRIGGER USER");
    }
  });

  test("release only shortens, and works late and repeatedly", async () => {
    await reset();
    await setRequired(true);
    const runId = freshRun();
    const fence = await acquire(runId, 600, 600);
    const release = (holder = fence) =>
      refused(admin, "SELECT release_reward_run_lease_v1($1,$2::bigint)", [runId, holder]);
    expect(await release("999999")).toBe("PR003");
    expect((await lease()).live).toBe(true);
    expect(await release()).toBeNull();
    expect((await lease()).live).toBe(false);
    const expiry = () =>
      one<{ at: string }>(
        admin,
        "SELECT expires_at::text AS at FROM reward_operations_run_lease WHERE singleton",
      );
    const released = await expiry();
    // Repeated, and after both the expiry and the absolute deadline have passed.
    expect(await release()).toBeNull();
    await admin.query(
      `UPDATE reward_operations_run_lease
          SET expires_at = clock_timestamp() - interval '2 hours',
              absolute_deadline = clock_timestamp() - interval '1 hour'
        WHERE singleton`,
    );
    const late = await expiry();
    expect(await release()).toBeNull();
    expect(await expiry()).toEqual(late);
    expect(Date.parse(late.at)).toBeLessThan(Date.parse(released.at));
    expect((await lease()).capped).toBe(true);
  });

  test("a renewal racing expiry admits work only if it committed first", async () => {
    await reset();
    await setRequired(true);
    const runId = freshRun();
    const fence = await acquire(runId);
    await setPaused(false);
    // The renewal holds its locks; the reservation queues behind it and sees a live lease.
    await second.query("BEGIN");
    await second.query("SELECT renew_reward_run_lease_v1($1,$2::bigint,60)", [runId, fence]);
    const queued = reserveNonce();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await second.query("COMMIT");
    expect(await queued).toBeNull();
    // The other order: expiry is seen first, and the renewal that follows is refused.
    await expire();
    expect(await reserveNonce()).toBe("PR001");
    expect(
      await refused(second, "SELECT renew_reward_run_lease_v1($1,$2::bigint,60)", [
        runId,
        (await lease()).fence,
      ]),
    ).toBe("PR003");
    // A reservation that holds the lease's share lock makes the renewal wait, not fail.
    const next = freshRun();
    await setPaused(true);
    const nextFence = await acquire(next);
    await setPaused(false);
    await runtime.query("BEGIN");
    expect(await reserveNonce()).toBeNull();
    const waiting = refused(second, "SELECT renew_reward_run_lease_v1($1,$2::bigint,60)", [
      next,
      nextFence,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runtime.query("COMMIT");
    expect(await waiting).toBeNull();
  });

  test("an old run cannot renew or release once a replacement holds the lease", async () => {
    await reset();
    await setRequired(true);
    const oldRun = freshRun();
    const oldFence = await acquire(oldRun);
    await expire();
    const replacement = freshRun();
    const fence = await acquire(replacement);
    expect(
      await refused(second, "SELECT renew_reward_run_lease_v1($1,$2::bigint,60)", [
        oldRun,
        oldFence,
      ]),
    ).toBe("PR003");
    expect(
      await refused(second, "SELECT renew_reward_run_lease_v1($1,$2::bigint,60)", [oldRun, fence]),
    ).toBe("PR003");
    expect(
      await refused(second, "SELECT release_reward_run_lease_v1($1,$2::bigint)", [
        oldRun,
        oldFence,
      ]),
    ).toBe("PR003");
    expect(await lease()).toMatchObject({ run_id: replacement, fence, live: true });
  });

  test("a signature made after expiry cannot be stored, while what was already sent is still recorded", async () => {
    await reset();
    await setRequired(true);
    await acquire(freshRun());
    await setPaused(false);
    const address = (digit: string) => `0x${digit.repeat(40)}`;
    const hex = (digit: string, length = 64) => `0x${digit.repeat(length)}`;
    // Every state change is recorded with its transition event in one transaction,
    // as the repositories do; a refused change takes its event with it.
    const transition = async (
      effectId: string,
      version: number,
      event: string,
      assignments: string,
      values: unknown[] = [],
    ) => {
      await runtime.query("BEGIN");
      try {
        await runtime.query(
          `INSERT INTO reward_chain_effect_transitions (effect_id, target_version, event_type, event)
           VALUES ($1,$2,$3,'{}'::jsonb)`,
          [effectId, version, event],
        );
        const updated = await runtime.query(
          `UPDATE reward_chain_effects
              SET ${assignments}, version=${version}, updated_at=clock_timestamp()
            WHERE effect_id=$1 AND version=${version - 1}`,
          [effectId, ...values],
        );
        if (updated.rowCount !== 1) throw Object.assign(new Error("no row"), { code: "no-row" });
        await runtime.query("COMMIT");
        return null;
      } catch (error) {
        await runtime.query("ROLLBACK");
        return (error as { code?: string }).code ?? "unknown";
      }
    };
    const plan = async (effectId: string, nonce: number) => {
      await runtime.query(
        `INSERT INTO reward_chain_effects (
           effect_id, effect_kind, state, chain_id, signer_address, target_address,
           reserved_amount_atomic
         ) VALUES ($1,'reward_payout','planned',84532,$2,$3,1000)`,
        [effectId, address("4"), address("1")],
      );
      expect(
        await transition(effectId, 2, "nonce_reserved", "state='nonce_reserved', nonce=$2", [
          nonce,
        ]),
      ).toBeNull();
    };
    const store = (effectId: string, digit: string) =>
      transition(
        effectId,
        3,
        "prepared",
        `state='prepared', calldata=$2, calldata_hash=$3, signed_transaction=$4,
         signed_transaction_hash=$5, prepared_at=clock_timestamp()`,
        [hex(digit, 8), digit.repeat(64), hex(digit, 16), hex(digit)],
      );
    const recordSend = (effectId: string, digit: string) =>
      transition(
        effectId,
        4,
        "broadcast_pending",
        "state='broadcast_pending', transaction_hash=$2, broadcast_at=clock_timestamp()",
        [hex(digit)],
      );
    const stateOf = async (effectId: string) =>
      (
        await one<{ state: string }>(
          admin,
          "SELECT state FROM reward_chain_effects WHERE effect_id=$1",
          [effectId],
        )
      ).state;
    const reserved = `lease-reserved-${suffix}`;
    const prepared = `lease-prepared-${suffix}`;
    // The signer's nonce fence, reserved under the live lease.
    await runtime.query(
      `INSERT INTO reward_signer_nonces (
         chain_id, signer_address, next_nonce, observed_pending_nonce,
         observed_block_number, observed_block_hash, observed_at
       ) VALUES (84532, $1, 20, 0, 1, $2, clock_timestamp())`,
      [address("4"), hex("a")],
    );
    await plan(reserved, 11);
    await plan(prepared, 12);
    // Under a live lease and a running brake a signature is stored as usual.
    expect(await store(prepared, "b")).toBeNull();

    await expire();
    // Reserved before expiry: its signature can no longer be stored.
    expect(await store(reserved, "a")).toBe("PR001");
    expect(await stateOf(reserved)).toBe("nonce_reserved");
    // Signed and stored before expiry: recording that it was sent is never refused,
    // because the send may already have happened.
    expect(await recordSend(prepared, "c")).toBeNull();
    expect(await stateOf(prepared)).toBe("broadcast_pending");
    // And what the chain did with it can still be recorded afterwards.
    expect(await transition(prepared, 5, "confirming", "state='confirming'")).toBeNull();
    expect(await stateOf(prepared)).toBe("confirming");

    // A fresh lease acquired while paused still stores nothing until the brake resumes.
    await setPaused(true);
    await acquire(freshRun());
    expect(await store(reserved, "a")).toBe("PR001");
    await setPaused(false);
    expect(await store(reserved, "a")).toBeNull();
    expect(await stateOf(reserved)).toBe("prepared");

    // Where no lease is required the same store is left to the existing guards.
    await reset();
    const plain = `lease-plain-${suffix}`;
    await setPaused(false);
    await plan(plain, 13);
    await setPaused(true);
    expect(await store(plain, "d")).toBeNull();
  });

  test("the lease guards sit on every admission table and on the nonce table", async () => {
    const triggers = await admin.query<{ table_name: string; trigger_name: string }>(
      `SELECT c.relname AS table_name, t.tgname AS trigger_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal
          AND p.proname IN ('guard_reward_run_lease_admission','guard_reward_run_lease_signature')
        ORDER BY 1, 2`,
      [schema],
    );
    expect(triggers.rows).toEqual([
      { table_name: "reward_chain_effects", trigger_name: "reward_run_lease_signature_guard" },
      { table_name: "reward_signer_nonces", trigger_name: "reward_run_lease_nonce_advance_guard" },
      { table_name: "reward_signer_nonces", trigger_name: "reward_run_lease_nonce_insert_guard" },
      {
        table_name: "song_reward_leg_funding_effects",
        trigger_name: "reward_run_lease_admission_guard",
      },
      { table_name: "song_reward_offer_legs", trigger_name: "reward_run_lease_admission_guard" },
      { table_name: "song_reward_offers", trigger_name: "reward_run_lease_admission_guard" },
    ]);
  });
});
