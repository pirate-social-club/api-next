import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;
const address = (byte: string) => `0x${byte.repeat(40)}`;
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const EOA = address("1");
const SAFE = address("2");
const USDC = address("3");
const BLOCK = hash("a");
const CALL = `0xa9059cbb${"00".repeat(64)}`;
const OTHER_CALL = `0xa9059cbb${"11".repeat(64)}`;
const CALL_HASH = "c".repeat(64);
const OTHER_CALL_HASH = "d".repeat(64);

suite("owner-executed Safe reward chain effects", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `reward_safe_mode_${suffix}`;
  const db = new Client({ connectionString: url });
  let sequence = 0;

  beforeAll(async () => {
    await db.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await db.query(
      await Bun.file(new URL("../../../db/postgres/schema.sql", import.meta.url)).text(),
    );
    await db.query(`SET search_path TO "${schema}"`);
    await db.query("SELECT set_reward_operations_paused_v1(0,FALSE,'safe_mode_test')");
    for (const [signer, authority] of [
      [EOA, "eoa_pending_nonce"],
      [SAFE, "safe_owner_v1"],
    ] as const) {
      await db.query(
        `INSERT INTO reward_signer_nonces (chain_id,signer_address,next_nonce,
           observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,
           nonce_authority)
         VALUES (8453,$1,0,0,1,$2,clock_timestamp(),$3)`,
        [signer, BLOCK, authority],
      );
    }
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  });

  async function effect(mode: "eoa" | "safe_owner_v1", signer = mode === "eoa" ? EOA : SAFE) {
    sequence += 1;
    const id = `safe-mode-${sequence}`;
    await db.query(
      `INSERT INTO reward_chain_effects (effect_id,effect_kind,state,chain_id,signer_address,
         target_address,reserved_amount_atomic,execution_mode)
       VALUES ($1,'reward_payout','planned',8453,$2,$3,1000000,$4)`,
      [id, signer, USDC, mode],
    );
    return id;
  }

  /** One versioned transition with its paired event, committed together. */
  async function move(id: string, version: number, assignments: string, values: unknown[] = []) {
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO reward_chain_effect_transitions (effect_id,target_version,event_type,event)
         VALUES ($1,$2,'test_transition','{}'::jsonb)`,
        [id, version],
      );
      const updated = await db.query(
        `UPDATE reward_chain_effects SET ${assignments}, version=$2, updated_at=clock_timestamp()
          WHERE effect_id=$1`,
        [id, version, ...values],
      );
      if (updated.rowCount !== 1) throw new Error(`transition updated ${updated.rowCount} rows`);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  const prepare = (id: string, call = CALL, callHash = CALL_HASH) =>
    move(
      id,
      2,
      "state='prepared', calldata=$3, calldata_hash=$4, prepared_at=clock_timestamp(), safe_prepared_block_number=1",
      [call, callHash],
    );

  let observed = 0;
  const unique = (prefix: string) => {
    observed += 1;
    return `0x${prefix}${observed.toString(16).padStart(64 - prefix.length, "0")}`;
  };
  const observe = (id: string, safeNonce: number, outcome: "success" | "failure" = "success") =>
    move(
      id,
      3,
      `state='confirming', transaction_hash=$3, broadcast_at=clock_timestamp(),
       safe_nonce=$4, safe_transaction_hash=$5, safe_executor_address=$6,
       safe_execution_outcome=$7, safe_execution_log_index=2`,
      [unique("a1"), safeNonce, unique("b2"), address("4"), outcome],
    );

  const settle = (id: string, state: "confirmed" | "reverted", receipt: "success" | "reverted") =>
    move(
      id,
      4,
      `state=$3, receipt_status=$4, receipt_block_number=10, receipt_block_hash=$5,
       receipt_hash=$6, confirmations=3, confirmed_at=clock_timestamp(),
       settled_amount_atomic=CASE WHEN $3='confirmed' THEN reserved_amount_atomic END`,
      [state, receipt, BLOCK, "f".repeat(64)],
    );

  test("a Safe effect must use the Safe's nonce authority and vice versa", async () => {
    await expect(effect("safe_owner_v1", EOA)).rejects.toThrow(/execution mode does not match/u);
    await expect(effect("eoa", SAFE)).rejects.toThrow(/execution mode does not match/u);
  });

  test("a Safe call is prepared without a nonce or signed bytes and executes once", async () => {
    const id = await effect("safe_owner_v1");
    await expect(
      move(
        id,
        2,
        "state='prepared', calldata=$3, calldata_hash=$4, prepared_at=clock_timestamp(), safe_prepared_block_number=1, nonce=1",
        [CALL, CALL_HASH],
      ),
    ).rejects.toThrow(/reward_chain_effect_prepared_shape/u);
    // A regex check on NULL is NULL, which a CHECK accepts; the Safe branch must not.
    await expect(
      move(
        id,
        2,
        "state='prepared', calldata_hash=$3, prepared_at=clock_timestamp(), safe_prepared_block_number=1",
        [CALL_HASH],
      ),
    ).rejects.toThrow(/reward_chain_effect_prepared_shape/u);
    await expect(
      move(
        id,
        2,
        "state='prepared', calldata=$3, prepared_at=clock_timestamp(), safe_prepared_block_number=1",
        [CALL],
      ),
    ).rejects.toThrow(/reward_chain_effect_prepared_shape/u);
    await prepare(id);
    await expect(
      move(id, 3, "state='terminal_failed', failure_class='x', failure_reason='y'"),
    ).rejects.toThrow(/invalid Safe reward chain effect transition/u);
    await expect(move(id, 3, "calldata=$3", [OTHER_CALL])).rejects.toThrow(
      /prepared Safe reward call is immutable/u,
    );
    await observe(id, 41);
    await expect(move(id, 4, "safe_nonce=42")).rejects.toThrow(
      /observed Safe execution is immutable/u,
    );
    await settle(id, "confirmed", "success");
    const row = (
      await db.query(
        `SELECT state, nonce, signed_transaction, safe_nonce::text, safe_execution_outcome
           FROM reward_chain_effects WHERE effect_id=$1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      state: "confirmed",
      nonce: null,
      signed_transaction: null,
      safe_nonce: "41",
      safe_execution_outcome: "success",
    });
  });

  test("an inner ExecutionFailure is reverted with the outer receipt kept truthful", async () => {
    const id = await effect("safe_owner_v1");
    await prepare(id, OTHER_CALL, OTHER_CALL_HASH);
    await observe(id, 43, "failure");
    await expect(settle(id, "reverted", "reverted")).rejects.toThrow(
      /reward_chain_effect_receipt_shape/u,
    );
    await settle(id, "reverted", "success");
    const failed = await effect("safe_owner_v1");
    await prepare(failed, `0xa9059cbb${"22".repeat(64)}`, "2".repeat(64));
    await observe(failed, 44, "failure");
    await expect(settle(failed, "confirmed", "success")).rejects.toThrow(
      /reward_chain_effect_receipt_shape/u,
    );
  });

  test("identical unresolved Safe calls and reused Safe nonces are refused", async () => {
    const first = await effect("safe_owner_v1");
    await prepare(first, `0xa9059cbb${"33".repeat(64)}`, "3".repeat(64));
    const twin = await effect("safe_owner_v1");
    await expect(prepare(twin, `0xa9059cbb${"33".repeat(64)}`, "3".repeat(64))).rejects.toThrow(
      /reward_chain_effects_safe_open_call_unique/u,
    );
    await observe(first, 45);
    await settle(first, "confirmed", "success");
    await prepare(twin, `0xa9059cbb${"33".repeat(64)}`, "3".repeat(64));
    await expect(observe(twin, 45)).rejects.toThrow(/reward_chain_effects_safe_nonce_unique/u);
  });

  test("preparing a Safe call is refused while reward operations are paused", async () => {
    const id = await effect("safe_owner_v1");
    await db.query("SELECT set_reward_operations_paused_v1(1,TRUE,'safe_mode_pause')");
    try {
      await expect(
        prepare(id, `0xa9059cbb${"44".repeat(64)}`, "4".repeat(64)),
      ).rejects.toMatchObject({
        code: "PR001",
      });
    } finally {
      await db.query("SELECT set_reward_operations_paused_v1(2,FALSE,'safe_mode_resume')");
    }
    await prepare(id, `0xa9059cbb${"44".repeat(64)}`, "4".repeat(64));
  });

  const setPaused = async (paused: boolean) => {
    const { revision } = (
      await db.query<{ revision: string }>(
        "SELECT revision::text FROM reward_operations_control WHERE singleton",
      )
    ).rows[0] ?? { revision: "" };
    await db.query("SELECT set_reward_operations_paused_v1($1::bigint,$2,'safe_mode_lease')", [
      revision,
      paused,
    ]);
  };
  /** Only a deployment that says so may change whether a lease is required. */
  const setLeaseRequired = async (required: boolean) => {
    await db.query("BEGIN");
    await db.query("SET LOCAL pirate.reward_run_lease_requirement_change = 'deployment'");
    await db.query("UPDATE reward_operations_run_lease SET required=$1 WHERE singleton", [
      required,
    ]);
    await db.query("COMMIT");
  };
  /** A lease is acquired while paused; operations then resume under it. */
  const acquireLease = async (runId: string) => {
    await setPaused(true);
    const { fence } = (
      await db.query<{ fence: string }>(
        "SELECT acquire_reward_run_lease_v1($1,60,600)::text AS fence",
        [runId],
      )
    ).rows[0] ?? { fence: "" };
    await setPaused(false);
    return fence;
  };
  const callFor = (byte: string) => [`0xa9059cbb${byte.repeat(128)}`, byte.repeat(64)] as const;

  test("where a run lease is required, only a live lease prepares a Safe call", async () => {
    await setLeaseRequired(true);
    try {
      // Required, running, and no lease was ever acquired.
      const missing = await effect("safe_owner_v1");
      await expect(prepare(missing, ...callFor("5"))).rejects.toMatchObject({ code: "PR001" });

      await acquireLease("safe-mode-live");
      await prepare(missing, ...callFor("5"));

      // The lease's time ran out while operations were still running.
      await db.query(
        `UPDATE reward_operations_run_lease
            SET expires_at = clock_timestamp() - interval '1 second' WHERE singleton`,
      );
      const expired = await effect("safe_owner_v1");
      await expect(prepare(expired, ...callFor("6"))).rejects.toMatchObject({ code: "PR001" });

      const fence = await acquireLease("safe-mode-released");
      await db.query("SELECT release_reward_run_lease_v1('safe-mode-released',$1::bigint)", [
        fence,
      ]);
      const released = await effect("safe_owner_v1");
      await expect(prepare(released, ...callFor("7"))).rejects.toMatchObject({ code: "PR001" });

      // What the chain did is still recorded after the run stopped: the call prepared
      // under the live lease is observed and settled without one.
      await observe(missing, 60);
      await settle(missing, "confirmed", "success");
      expect(
        (
          await db.query<{ state: string }>(
            "SELECT state FROM reward_chain_effects WHERE effect_id=$1",
            [missing],
          )
        ).rows,
      ).toEqual([{ state: "confirmed" }]);
    } finally {
      await setLeaseRequired(false);
    }
    // Where no lease is required, a running brake alone still prepares.
    const unrequired = await effect("safe_owner_v1");
    await prepare(unrequired, ...callFor("8"));
  });

  test("the server-signed path keeps its signed-bytes shape and transitions", async () => {
    const id = await effect("eoa");
    await move(id, 2, "state='nonce_reserved', nonce=0");
    await move(
      id,
      3,
      `state='prepared', calldata=$3, calldata_hash=$4, signed_transaction='0x02aa',
       signed_transaction_hash=$5, prepared_at=clock_timestamp()`,
      [CALL, CALL_HASH, hash("9")],
    );
    await expect(
      move(
        id,
        4,
        "state='broadcast_pending', transaction_hash=$3, broadcast_at=clock_timestamp(), safe_nonce=1",
        [hash("8")],
      ),
    ).rejects.toThrow(/reward_chain_effect_prepared_shape/u);
    await move(
      id,
      4,
      "state='broadcast_pending', transaction_hash=$3, broadcast_at=clock_timestamp()",
      [hash("8")],
    );
    await move(
      id,
      5,
      `state='reverted', receipt_status='reverted', receipt_block_number=10, receipt_block_hash=$3,
       receipt_hash=$4, confirmations=3, confirmed_at=clock_timestamp()`,
      [BLOCK, "7".repeat(64)],
    );
  });
});
