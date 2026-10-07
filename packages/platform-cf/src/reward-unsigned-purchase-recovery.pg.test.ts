import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { seedActivePoolLeg, seedSong } from "./rewards-song-offers.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("Postgres test URL required");
const suite = url ? describe : describe.skip;
const suffix = randomUUID().replaceAll("-", "");
const schema = `unsigned_purchase_${suffix}`;
const role = `unsigned_purchase_runtime_${suffix}`;
const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
let db: Client;
let legId: string;
let brakeRevision: string;
let fixtureCounter = 0;

async function recover(changes: Readonly<Record<number, unknown>> = {}) {
  const values: unknown[] = ["purchase", 2, 1, brakeRevision, 13, 13, 111, hash("b"), new Date()];
  for (const [key, value] of Object.entries(changes)) values[Number(key)] = value;
  await db.query("SELECT release_unsigned_test_purchase_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)", values);
}

async function state() {
  return (
    await db.query(
      `SELECT effect.state, effect.nonce::text, effect.version::text,
              drawing.status, leg.reserved_atomic::text,
              nonce.next_nonce::text, nonce.fence_version::text
         FROM reward_chain_effects effect
         JOIN megapot_pool_drawings drawing ON drawing.purchase_effect_id=effect.effect_id
         JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
         JOIN reward_signer_nonces nonce ON nonce.chain_id=effect.chain_id
           AND nonce.signer_address=effect.signer_address WHERE effect.effect_id='purchase'`,
    )
  ).rows[0];
}

async function refused(action: () => Promise<unknown>) {
  const before = await state();
  await db.query("SAVEPOINT refusal");
  await expect(action()).rejects.toThrow();
  await db.query("ROLLBACK TO SAVEPOINT refusal");
  expect(await state()).toEqual(before);
}

suite("unsigned isolated purchase recovery", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},pg_temp`);
    const migrations = await loadPostgresMigrations();
    for (const migration of migrations.slice(0, -1)) await db.query(migration.sql);
    await db.query(`CREATE ROLE ${role} NOLOGIN`);
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await db.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await db.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${role}`,
    );
    expect(migrations.at(-1)?.version).toBe("0245_reward_unsigned_purchase_recovery.sql");
    await db.query(migrations.at(-1)?.sql ?? "");
  }, 180_000);

  afterAll(async () => {
    await db.query("RESET ROLE");
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.query(`DROP OWNED BY ${role}`);
    await db.query(`DROP ROLE ${role}`);
    await db.end();
  });

  beforeEach(async () => {
    await db.query(
      "SELECT set_reward_operations_paused_v1(revision,FALSE,'test fixture') FROM reward_operations_control WHERE singleton",
    );
    // Persona activation owns a transaction, so finish that fixture before the
    // rollback boundary used by the money assertions.
    const identity = await seedSong(
      db,
      `unsigned-${++fixtureCounter}`,
      `0x${fixtureCounter.toString(16).padStart(40, "0")}`,
    );
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO reward_asset_whitelist (
         chain_id,token_address,decimals,symbol,asset_kind,environment,status,
         policy_version,activated_at,plain_erc20_verified_at
       ) VALUES (84532,$1,6,'USDC','settlement_usdc','test','active','test',
         statement_timestamp(),statement_timestamp())`,
      [address("1")],
    );
    await db.query(
      `INSERT INTO megapot_deployment_attestations (
         attestation_id,environment,chain_id,jackpot_address,usdc_address,ticket_nft_address,
         custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,
         ticket_nft_code_hash,attestation_block_number,attestation_block_hash,abi_version,status,verified_at
       ) VALUES ('megapot-base-sepolia-v2','test',84532,$1,$2,$3,$4,$5,$6,$7,$8,$9,100,$10,
         'megapot_v2','active',clock_timestamp())`,
      [
        address("2"),
        address("1"),
        address("3"),
        address("4"),
        address("5"),
        hash("6"),
        hash("7"),
        hash("8"),
        hash("9"),
        hash("a"),
      ],
    );
    ({ legId } = await seedActivePoolLeg(db, identity, {
      suffix: "unsigned",
      fallback: false,
      expired: true,
    }));
    // Only the historical committed drawing is fixture data. Recovery and all
    // assertions below run with every production guard enabled.
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query(
      `INSERT INTO megapot_drawing_observations (
         observation_id,attestation_id,chain_id,drawing_id,ticket_price_atomic,drawing_time,
         ball_max,bonusball_max,drawing_locked,referral_fee_wei,referral_win_share_wei,
         block_number,block_hash,block_timestamp,confirmations,observed_at,expires_at,raw_state_hash
       ) VALUES ('observation','megapot-base-sepolia-v2',84532,101,10000,
         clock_timestamp()-interval '10 minutes',25,13,false,0,0,110,$1,
         clock_timestamp()-interval '20 minutes',3,clock_timestamp()-interval '15 minutes',
         clock_timestamp()-interval '10 minutes',$2)`,
      [hash("6"), "6".repeat(64)],
    );
    await db.query(
      `INSERT INTO megapot_pool_drawings (
         pool_leg_id,drawing_id,observation_id,status,version,entry_cutoff_at,
         ticket_price_ceiling_atomic,reserved_ticket_cost_atomic,actual_ticket_cost_atomic,
         frozen_share_count,fallback_beneficiary,snapshot_id,commitment_effect_id,cutoff_frozen_at,created_at
       ) VALUES ($1,101,'observation','committed',3,clock_timestamp()-interval '15 minutes',
         50000,50000,0,1,false,'snapshot','commitment',clock_timestamp()-interval '20 minutes',
         clock_timestamp()-interval '25 minutes')`,
      [legId],
    );
    await db.query(
      `INSERT INTO megapot_pool_beneficiary_snapshots (
         snapshot_id,pool_leg_id,drawing_id,domain,terms_hash,algorithm_version,
         fallback,leaf_count,snapshot_hash,published_artifact,frozen_at
       ) VALUES ('snapshot',$1,101,'pirate.megapot-pool-beneficiary-snapshot.v2',$2,
         'equal_v1',false,1,$3,'{}',clock_timestamp()-interval '20 minutes')`,
      [legId, hash("b"), hash("7")],
    );
    await db.query(
      `INSERT INTO megapot_pool_commitment_effects (
         commitment_effect_id,snapshot_id,payload_hash,signing_key_id,signature,state,
         prepared_at,published_at,public_reference
       ) VALUES ('commitment','snapshot',$1,'test','test-signature','published',
         clock_timestamp()-interval '18 minutes',clock_timestamp()-interval '17 minutes','urn:test')`,
      ["7".repeat(64)],
    );
    await db.query("SET LOCAL session_replication_role=origin");
    await db.query("UPDATE song_reward_offer_legs SET reserved_atomic=50000 WHERE leg_id=$1", [
      legId,
    ]);
    await db.query(
      `INSERT INTO reward_signer_nonces(chain_id,signer_address,next_nonce,observed_pending_nonce,
         observed_block_number,observed_block_hash,observed_at)
       VALUES (84532,$1,14,13,110,$2,clock_timestamp()-interval '1 second')`,
      [address("4"), hash("a")],
    );
    await db.query(
      `INSERT INTO reward_chain_effects(effect_id,effect_kind,state,chain_id,signer_address,
         target_address,reserved_amount_atomic) VALUES ('purchase','ticket_purchase','planned',84532,$1,$2,10000)`,
      [address("4"), address("2")],
    );
    await db.query(
      "INSERT INTO reward_chain_effect_transitions(effect_id,target_version,event_type,event) VALUES ('purchase',2,'nonce_reserved','{\"nonce\":\"13\"}')",
    );
    await db.query(
      "UPDATE reward_chain_effects SET state='nonce_reserved',version=2,nonce=13,updated_at=clock_timestamp() WHERE effect_id='purchase'",
    );
    await db.query(
      `INSERT INTO megapot_ticket_purchase_effects (
         purchase_effect_id,attestation_id,pool_leg_id,drawing_id,drawing_observation_id,
         snapshot_id,commitment_effect_id,source_tag,recipient_address,ticket_price_atomic,
         normal_one,normal_two,normal_three,normal_four,normal_five,bonusball
       ) VALUES ('purchase','megapot-base-sepolia-v2',$1,101,'observation','snapshot',
         'commitment',$2,$3,10000,1,2,3,4,5,6)`,
      [legId, hash("6"), address("4")],
    );
    await db.query(
      "INSERT INTO megapot_pool_drawing_transitions(pool_leg_id,drawing_id,target_version,event_type,event) VALUES ($1,101,4,'purchase_pending','{}')",
      [legId],
    );
    await db.query(
      "UPDATE megapot_pool_drawings SET status='purchase_pending',purchase_effect_id='purchase',version=4,updated_at=clock_timestamp() WHERE pool_leg_id=$1",
      [legId],
    );
    await db.query("SET LOCAL pirate.reward_run_lease_requirement_change='deployment'");
    await db.query("UPDATE reward_operations_run_lease SET required=TRUE WHERE singleton");
    brakeRevision = (
      await db.query(
        "SELECT set_reward_operations_paused_v1(revision,TRUE,'test recovery')::text AS revision FROM reward_operations_control WHERE singleton",
      )
    ).rows[0].revision;
  });

  afterEach(async () => {
    await db.query("ROLLBACK");
  });

  test("atomically retires the unsigned purchase, preserves evidence and frees the tail nonce", async () => {
    await recover();
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    expect(await state()).toEqual({
      state: "terminal_failed",
      nonce: null,
      version: "3",
      status: "closed_purchase_unavailable",
      reserved_atomic: "0",
      next_nonce: "13",
      fence_version: "2",
    });
    const events = await db.query(
      "SELECT event FROM reward_chain_effect_transitions WHERE effect_id='purchase' AND target_version=3",
    );
    expect(events.rows[0].event).toMatchObject({
      nonce: "13",
      nonce_fence: "1",
      latest_nonce: "13",
      pending_nonce: "13",
      block_hash: hash("b"),
    });
    await refused(() => recover());
  });

  test("runtime cannot call recovery, even with default function grants", async () => {
    await db.query(`SET LOCAL ROLE ${role}`);
    await refused(() => recover());
  });

  test("runtime cannot rewind directly after owner recovery", async () => {
    await recover();
    await db.query(`SET LOCAL ROLE ${role}`);
    await refused(() =>
      db.query(
        "UPDATE reward_signer_nonces SET next_nonce=12,fence_version=fence_version+1,updated_at=clock_timestamp()",
      ),
    );
  });

  test("refuses stale or changed chain and version proof without changing balances", async () => {
    for (const changes of [
      { 1: 3 },
      { 2: 2 },
      { 3: "999" },
      { 4: 14 },
      { 5: 14 },
      { 6: 109 },
      { 7: hash("c").toUpperCase() },
      { 8: new Date(Date.now() - 120_000) },
      { 1: null },
    ])
      await refused(() => recover(changes));
  });

  test("refuses a subsequent reserved nonce", async () => {
    await db.query(
      "INSERT INTO reward_chain_effects(effect_id,effect_kind,state,chain_id,signer_address,target_address,reserved_amount_atomic) VALUES ('later','reward_refund','planned',84532,$1,$2,1)",
      [address("4"), address("2")],
    );
    await db.query(
      "INSERT INTO reward_chain_effect_transitions(effect_id,target_version,event_type,event) VALUES ('later',2,'nonce_reserved','{}')",
    );
    await db.query(
      "UPDATE reward_chain_effects SET state='nonce_reserved',version=2,nonce=14,updated_at=clock_timestamp() WHERE effect_id='later'",
    );
    await refused(() => recover());
  });

  test("refuses any prepared signature", async () => {
    await db.query("UPDATE reward_operations_run_lease SET required=FALSE WHERE singleton");
    await db.query(
      "INSERT INTO reward_chain_effect_transitions(effect_id,target_version,event_type,event) VALUES ('purchase',3,'prepared','{}')",
    );
    await db.query(
      "UPDATE reward_chain_effects SET state='prepared',version=3,calldata='0xdead',calldata_hash=$1,signed_transaction='0xbeef',signed_transaction_hash=$2,prepared_at=clock_timestamp(),updated_at=clock_timestamp() WHERE effect_id='purchase'",
      ["c".repeat(64), hash("c")],
    );
    await db.query("UPDATE reward_operations_run_lease SET required=TRUE WHERE singleton");
    await refused(() => recover({ 1: 3 }));
  });

  test("refuses running authority and a live lease", async () => {
    await db.query("SELECT acquire_reward_run_lease_v1('recovery-test',60,600)");
    await refused(() => recover());
    await db.query(
      "UPDATE reward_operations_run_lease SET expires_at=clock_timestamp()-interval '1 second' WHERE singleton",
    );
    await db.query(
      "SELECT set_reward_operations_paused_v1(revision,FALSE,'test running') FROM reward_operations_control WHERE singleton",
    );
    await refused(() => recover());
  });

  test("a failure at the final nonce write rolls back the release and both transition events", async () => {
    await db.query(`CREATE FUNCTION refuse_tail_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected write failure'; END $$`);
    await db.query(`CREATE TRIGGER refuse_tail_write BEFORE UPDATE ON reward_signer_nonces
      FOR EACH ROW EXECUTE FUNCTION refuse_tail_write()`);
    await refused(() => recover());
    const events =
      await db.query(`SELECT count(*)::text AS count FROM reward_chain_effect_transitions
      WHERE event_type='unsigned_purchase_released'`);
    expect(events.rows).toEqual([{ count: "0" }]);
    const drawings =
      await db.query(`SELECT count(*)::text AS count FROM megapot_pool_drawing_transitions
      WHERE event_type='closed_purchase_unavailable'`);
    expect(drawings.rows).toEqual([{ count: "0" }]);
  });

  test("a stale coordinator cannot store its old signed reservation after release", async () => {
    await recover();
    await refused(() =>
      db.query(
        `UPDATE reward_chain_effects SET state='prepared',version=version+1,
         calldata='0xdead',calldata_hash=$1,signed_transaction='0xbeef',
         signed_transaction_hash=$2,nonce=13,prepared_at=clock_timestamp(),
         updated_at=clock_timestamp() WHERE effect_id='purchase'`,
        ["c".repeat(64), hash("c")],
      ),
    );
    expect(await state()).toMatchObject({
      state: "terminal_failed",
      nonce: null,
      next_nonce: "13",
    });
  });
});
