/** SOURCE ONLY: not executed by this source admission. Requires a later,
 * independently admitted PostgreSQL gate and final migration ordinal.
 * Replays the maintained migration prefix through275, then applies276.
 * Replica mode seeds historical/precondition fixtures BEFORE the migration;
 * all new allocation, ownership, concurrency and destructive guards stay on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Exit } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  loadRewardFundingWalletNonceOwnerIn,
  type RewardFundingNonceReservation,
  reserveRewardFundingWalletNonceIn,
} from "./reward-wallet-nonce-authority.ts";
import { makeControlPlaneRewardWinnerSendRepository } from "./reward-winner-send-repository.ts";
import { seedMegapotAuthority } from "./rewards-composed-pool.pg-fixture.ts";
import { seedActivePoolLeg, seedSong } from "./rewards-song-offers.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
const chain = 84532;
const token = `0x${"aa".repeat(20)}`;
const custody = `0x${"cc".repeat(20)}`;
const recipient = `0x${"dd".repeat(20)}`;
const account = "nonce-fixture-account";
const names = [
  "old-open",
  "old-consumed",
  "v2-first",
  "winner-first",
  "concurrent",
  "negative",
  "unknown",
  "provenance",
] as const;
type Name = (typeof names)[number];
const address = (name: Name) =>
  `0x${(names.indexOf(name) + 1).toString(16).padStart(2, "0").repeat(20)}`;
const schema = `wallet_nonce_v2_${process.pid}_${Date.now()}`;
const scoped = (() => {
  if (!url) return "";
  const u = new URL(url);
  u.searchParams.set(
    "options",
    `${u.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim(),
  );
  return u.toString();
})();
const admin = new Client({ connectionString: scoped });
const layer = makeDirectPostgresControlPlaneLayer(scoped);

function input(name: Name, id: string, nonce = 4n): RewardFundingNonceReservation {
  const observedAtMs = Date.now();
  return {
    owner: {
      leaseId: id,
      ownerId: id,
      commandId: `command-${id}`,
      accountId: account,
      personaId: name,
      walletAssignmentId: `wallet-${name}`,
      chainId: chain,
      senderAddress: address(name),
      requestHash: "a".repeat(64),
    },
    nonce,
    nowMs: observedAtMs,
    policy: { hash: "b".repeat(64), maxAgeMs: 60_000 }, // Test-only.
    witness: {
      id: id
        .split("")
        .map((c) => c.charCodeAt(0).toString(16))
        .join("")
        .padEnd(64, "0")
        .slice(0, 64),
      chainId: chain,
      senderAddress: address(name),
      observedAtMs,
      confirmed: { nonce, blockNumber: 20n, blockHash: "c".repeat(64) },
      pending: { nonce, baseBlockNumber: 20n, baseBlockHash: "c".repeat(64) },
    },
  };
}
const reserve = (i: RewardFundingNonceReservation) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) => reserveRewardFundingWalletNonceIn(tx, i));
    }).pipe(Effect.provide(layer)),
  );
const ownerRead = (i: RewardFundingNonceReservation) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((tx) => loadRewardFundingWalletNonceOwnerIn(tx, i.owner));
    }).pipe(Effect.provide(layer)),
  );
function packet(i: RewardFundingNonceReservation) {
  const { owner: o, witness: w } = i;
  return {
    lease_id: o.leaseId,
    owner_id: o.ownerId,
    command_id: o.commandId,
    account_id: o.accountId,
    persona_id: o.personaId,
    wallet_assignment_id: o.walletAssignmentId,
    chain_id: o.chainId,
    sender_address: o.senderAddress,
    request_hash: o.requestHash,
    nonce: String(i.nonce),
    witness_id: w.id,
    observed_at_ms: w.observedAtMs,
    confirmed_block: String(w.confirmed.blockNumber),
    confirmed_block_hash: w.confirmed.blockHash,
    pending_base_block: String(w.pending.baseBlockNumber),
    pending_base_hash: w.pending.baseBlockHash,
    confirmed_nonce: String(w.confirmed.nonce),
    pending_nonce: String(w.pending.nonce),
    freshness_policy_hash: i.policy?.hash,
    max_age_ms: i.policy?.maxAgeMs,
  };
}

async function seed() {
  await admin.query("SET session_replication_role=replica");
  try {
    await admin.query("INSERT INTO users(user_id) VALUES ($1)", [account]);
    await admin.query(
      `INSERT INTO reward_asset_whitelist(chain_id,token_address,decimals,symbol,asset_kind,
        environment,status,policy_version,activated_at,plain_erc20_verified_at)
        VALUES ($1,$2,6,'USDC','settlement_usdc','staging','active',
        'base-sepolia-usdc-v1',statement_timestamp(),statement_timestamp())`,
      [chain, token],
    );
    for (const [index, name] of names.entries()) {
      await admin.query("INSERT INTO personas(persona_id,account_id) VALUES ($1,$2)", [
        name,
        account,
      ]);
      await admin.query(
        `INSERT INTO persona_wallet_assignments(assignment_id,persona_id,account_id,
        chain_account_kind,hd_wallet_index,address,status,reservation_idempotency_key,
        assigned_at,created_at,updated_at)
        VALUES ($1,$2,$3,'evm',$4,$5,'active',$1,now(),now(),now())`,
        [`wallet-${name}`, name, account, index, address(name)],
      );
      await admin.query(
        `INSERT INTO reward_ledger_credits(credit_id,account_id,payout_persona_id,
        chain_id,token_address,amount_atomic,source_kind,source_reference,state,paid_atomic,settled_at)
        VALUES ($1,$2,$3,$4,$5,10,'megapot_allocation',$1,'sent',10,clock_timestamp())`,
        [`credit-${name}`, account, name, chain, token],
      );
      await admin.query(
        `INSERT INTO megapot_participant_claims(credit_id,account_id,pool_leg_id,drawing_id,
        status,subject_key_id,evidence_receipt_id,accepted_at)
        VALUES ($1,$2,'fixture-leg',1,'accepted',$1,'fixture-receipt',clock_timestamp())`,
        [`credit-${name}`, account],
      );
      const txHash = `0x${(index + 100).toString(16).padStart(64, "0")}`;
      await admin.query(
        `INSERT INTO reward_chain_effects(effect_id,effect_kind,state,version,chain_id,
        signer_address,target_address,settled_amount_atomic,nonce,calldata,calldata_hash,signed_transaction,
        signed_transaction_hash,transaction_hash,receipt_status,receipt_block_number,receipt_block_hash,
        receipt_hash,confirmations,prepared_at,broadcast_at,confirmed_at,created_at,updated_at)
        VALUES ($1,'reward_payout','confirmed',5,$2,$3,$4,10,$5,'0x00',$6,'0x01',$7,$7,
        'success',10,$7,$6,3,now(),now(),now(),now(),now())`,
        [`payout-${name}`, chain, custody, token, index, "e".repeat(64), txHash],
      );
      await admin.query(
        `INSERT INTO reward_payout_effects(payout_effect_id,attestation_id,credit_id,
        account_id,payout_persona_id,destination_address,amount_atomic,wallet_assignment_id,
        solvency_observation_id,custody_balance_before_atomic)
        VALUES ($1,'fixture-attestation',$2,$3,$4,$5,10,$6,'fixture-observation',10)`,
        [`payout-${name}`, `credit-${name}`, account, name, address(name), `wallet-${name}`],
      );
      await admin.query(
        `INSERT INTO reward_erc20_transfer_receipt_evidence(effect_id,transfer_purpose,
        attestation_id,token_address,sender_address,recipient_address,amount_atomic,transaction_hash,
        transfer_log_index,custody_balance_after_atomic,block_number,block_hash,receipt_hash,
        confirmations,confirmed_at) VALUES ($1,'reward_payout','fixture-attestation',$2,$3,$4,10,$5,
        0,0,10,$5,$6,3,clock_timestamp())`,
        [`payout-${name}`, token, custody, address(name), txHash, "e".repeat(64)],
      );
    }
    // Historical evidence, deliberately written before the new authority exists.
    for (const [name, nonce, status] of [
      ["old-open", 2, "retryable"],
      ["old-consumed", 9, "confirmed"],
    ] as const) {
      await admin.query(
        `INSERT INTO reward_winner_sends(send_id,credit_id,account_id,persona_id,
        wallet_assignment_id,chain_id,token_address,sender_address,attempt,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,
        [
          name,
          `credit-${name}`,
          account,
          name,
          `wallet-${name}`,
          chain,
          token,
          address(name),
          status,
        ],
      );
      await admin.query(
        `INSERT INTO reward_winner_send_attempts(send_id,attempt,account_id,idempotency_key,
        recipient_address,amount_atomic,nonce) VALUES ($1,1,$2,$1,$3,10,$4)`,
        [name, account, recipient, nonce],
      );
      if (status === "confirmed")
        await admin.query(
          `INSERT INTO reward_winner_send_outcomes(
        send_id,attempt,outcome,transaction_hash,block_number,block_hash,observed_head_block_number,
        observed_confirmed_nonce,confirmations) VALUES ($1,1,'confirmed',$2,10,$2,20,10,3)`,
          [name, `0x${"f".repeat(64)}`],
        );
    }
    await admin.query(
      `INSERT INTO song_reward_leg_funding_effects(funding_effect_id,leg_id,
      funder_account_id,chain_id,token_address,sender_address,recipient_address,
      expected_amount_atomic,required_confirmations,state)
      VALUES ('v1-unknown','fixture-leg',$1,$2,$3,$4,$5,1,3,'planned')`,
      [account, chain, token, address("unknown"), custody],
    );
  } finally {
    await admin.query("SET session_replication_role=origin");
  }
}

suite("shared wallet nonce migration/authority (SOURCE ONLY until PG admission)", () => {
  beforeAll(async () => {
    if (!url) return;
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const migrations = await loadPostgresMigrations();
    const upgradeIndex = migrations.findIndex(
      (entry) => entry.version === "0277_reward_wallet_nonce_authority_v2.sql",
    );
    const upgrade = migrations[upgradeIndex];
    if (
      upgradeIndex !== 276 ||
      upgrade === undefined ||
      migrations[upgradeIndex - 1]?.version !== "0276_wallet_send_palm_assertion_lock.sql"
    )
      throw new Error("The maintained276/277 migration boundary is required");
    const prefix = migrations.slice(0, upgradeIndex);
    const applied = await runPostgresMigrations({
      connectionString: scoped,
      migrations: prefix,
      expectedLedger: [],
    });
    if (applied.dryRun) throw new Error("Nonce upgrade fixture requires an actual owned database");
    expect(applied.result.currentVersion).toBe("0276_wallet_send_palm_assertion_lock.sql");
    expect(applied.result.applied).toEqual(prefix.map((entry) => entry.version));
    expect(
      (await admin.query("SELECT to_regclass('reward_wallet_nonce_leases') AS relation")).rows[0]
        ?.relation,
    ).toBeNull();
    await seed();
    const migration = upgrade.sql;
    // Bad historical input must abort the whole forward migration, not be
    // discarded/deduplicated. Each attempt rolls back both fixtures and DDL.
    for (const corruption of [
      "UPDATE reward_winner_send_attempts SET account_id='foreign' WHERE send_id='old-open'",
      "UPDATE reward_winner_sends SET wallet_assignment_id='wallet-old-consumed' WHERE send_id='old-open'",
    ]) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role=replica");
        await admin.query(corruption);
        await admin.query("SET LOCAL session_replication_role=origin");
        await expect(admin.query(migration)).rejects.toThrow();
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await admin.query("BEGIN");
    try {
      await admin.query(migration);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    // Test fixture only. This never changes an operator's runtime database.
    await admin.query(
      "SELECT set_reward_operations_paused_v1(revision,FALSE,'isolated_nonce_fixture') FROM reward_operations_control WHERE singleton",
    );
  }, 120_000);

  afterAll(async () => {
    if (!url) return;
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("backfills exact stored nonces and owner/account/wallet provenance, retaining open/consumed distinctions", async () => {
    const rows = (
      await admin.query(
        "SELECT owner_id,nonce::text,account_id,source FROM reward_wallet_nonce_leases ORDER BY owner_id",
      )
    ).rows;
    expect(rows).toEqual([
      { owner_id: "old-consumed", nonce: "9", account_id: account, source: "winner_attempt_v1" },
      { owner_id: "old-open", nonce: "2", account_id: account, source: "winner_attempt_v1" },
    ]);
    const head = async (name: Name) =>
      (
        await admin.query("SELECT * FROM reward_wallet_nonce_context_v2($1,$2,NULL)", [
          chain,
          address(name),
        ])
      ).rows[0];
    expect(await head("old-open")).toMatchObject({
      highest_nonce: "2",
      blocked_reason: "other_instruction",
    });
    expect(await head("old-consumed")).toMatchObject({ highest_nonce: "9", blocked_reason: null });
    expect(Exit.isFailure(await reserve(input("old-open", "refuse-old-open")))).toBe(true);
  });

  test("winner and funding serialize on one authority in both directions", async () => {
    expect(Exit.isSuccess(await reserve(input("v2-first", "v2-first")))).toBe(true);
    const repo = makeControlPlaneRewardWinnerSendRepository();
    const create = (name: Name) =>
      repo
        .create({
          sendId: `send-${name}`,
          idempotencyKey: `key-${name}`,
          recipientAddress: recipient,
          amountAtomic: 10n,
          context: {
            creditId: `credit-${name}`,
            accountId: account,
            personaId: name,
            walletAssignmentId: `wallet-${name}`,
            senderAddress: address(name),
            tokenAddress: token,
            chainId: chain,
            paidAtomic: 10n,
          },
          readNonce: Effect.succeed(4n),
        })
        .pipe(Effect.provide(layer));
    expect(Exit.isFailure(await Effect.runPromiseExit(create("v2-first")))).toBe(true);
    const winner = await Effect.runPromise(create("winner-first"));
    expect(winner.nonce).toBe(4n);
    expect(
      (
        await admin.query(
          "SELECT source,owner_id FROM reward_wallet_nonce_leases WHERE sender_address=$1",
          [address("winner-first")],
        )
      ).rows,
    ).toEqual([{ source: "winner_attempt_v1", owner_id: "send-winner-first" }]);
    expect(Exit.isFailure(await reserve(input("winner-first", "blocked-after-winner")))).toBe(true);
  });

  test("two concurrent contribution owners get exactly one immutable lease and no higher skipped nonce", async () => {
    const a = input("concurrent", "concurrent-A"),
      b = input("concurrent", "concurrent-B");
    const results = await Promise.all([reserve(a), reserve(b)]);
    expect(results.filter(Exit.isSuccess)).toHaveLength(1);
    expect(results.filter(Exit.isFailure)).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT nonce::text FROM reward_wallet_nonce_leases WHERE sender_address=$1",
          [address("concurrent")],
        )
      ).rows,
    ).toEqual([{ nonce: "4" }]);
  });

  test("V1 funding with no exact nonce remains unavailable and is never backfilled from an amount/hash", async () => {
    expect(
      (
        await admin.query("SELECT blocked_reason FROM reward_wallet_nonce_context_v2($1,$2,NULL)", [
          chain,
          address("unknown"),
        ])
      ).rows,
    ).toEqual([{ blocked_reason: "unknown_v1_funding" }]);
    expect(Exit.isFailure(await reserve(input("unknown", "unknown-must-stay-unavailable")))).toBe(
      true,
    );
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM reward_wallet_nonce_leases WHERE sender_address=$1",
          [address("unknown")],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });

  test("direct SQL refuses foreign/missing provenance, stale/incoherent/reused/negative and skip-ahead witnesses", async () => {
    const p = packet(input("negative", "negative"));
    for (const override of [
      { account_id: "foreign" },
      { persona_id: "old-open" },
      { command_id: null },
      { request_hash: null },
      { freshness_policy_hash: null },
      { max_age_ms: null },
      { observed_at_ms: 0 },
      { observed_at_ms: Date.now() + 1_000_000 },
      { nonce: "-1" },
      { nonce: "5" },
      { pending_nonce: "5" },
      { pending_base_hash: "d".repeat(64) },
      { source: "winner_attempt_v1" },
    ])
      await expect(
        admin.query("SELECT * FROM reserve_reward_funding_wallet_nonce_v2($1::jsonb)", [
          JSON.stringify({ ...p, ...override }),
        ]),
      ).rejects.toThrow();
    expect(Exit.isSuccess(await reserve(input("negative", "valid-negative-wallet")))).toBe(true);
    await expect(
      admin.query("SELECT * FROM reserve_reward_funding_wallet_nonce_v2($1::jsonb)", [
        JSON.stringify(p),
      ]),
    ).rejects.toThrow();
    const reused = packet(input("provenance", "otherwise-valid-new-owner"));
    reused.witness_id = packet(input("negative", "valid-negative-wallet")).witness_id;
    await expect(
      admin.query("SELECT * FROM reserve_reward_funding_wallet_nonce_v2($1::jsonb)", [
        JSON.stringify(reused),
      ]),
    ).rejects.toThrow();
  });

  test("history is immutable/no-delete/no-truncate; raw V2 function/table grants are absent", async () => {
    for (const sql of [
      "UPDATE reward_wallet_nonce_leases SET nonce=nonce+1",
      "DELETE FROM reward_wallet_nonce_leases",
      "TRUNCATE reward_wallet_nonce_leases",
    ])
      await expect(admin.query(sql)).rejects.toThrow();
    const grants = await admin.query(`SELECT a.privilege_type FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid='reward_wallet_nonce_leases'::regclass AND a.grantee<>c.relowner`);
    expect(grants.rows).toEqual([]);
    const execute = await admin.query(`SELECT p.proname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.pronamespace=current_schema()::regnamespace AND p.proname IN (
        'reserve_reward_funding_wallet_nonce_v2','load_reward_funding_wallet_nonce_owner_v2')
        AND a.grantee<>p.proowner`);
    expect(execute.rows).toEqual([]);
    // Actual deployed-role/inherited-membership negative execution remains an
    // OPEN release gate: this source creates no role or grants/credentials.
  });

  test("cancellation/replacement reads exact original owner without a new nonce or authorization", async () => {
    const i = input("v2-first", "v2-first");
    const before = (await admin.query("SELECT count(*)::int AS n FROM reward_wallet_nonce_leases"))
      .rows;
    expect(await ownerRead(i)).toMatchObject({ nonce: 4n, authority: "nonce_ownership_only" });
    expect(await ownerRead({ ...i, owner: { ...i.owner, accountId: "foreign" } })).toBeNull();
    expect(
      await ownerRead({ ...i, owner: { ...i.owner, requestHash: "f".repeat(64) } }),
    ).toBeNull();
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM reward_wallet_nonce_leases")).rows,
    ).toEqual(before);
    expect(Exit.isFailure(await reserve({ ...i, nowMs: i.nowMs + 1_000_000 }))).toBe(true);
  });

  test("repeated legacy funding keeps its history while a new V2 grant remains refused", async () => {
    const identity = await seedSong(admin, "nonce-legacy-funding", `0x${"71".repeat(20)}`);
    await seedMegapotAuthority(admin);
    const { legId } = await seedActivePoolLeg(admin, identity, {
      fallback: false,
      suffix: "nonce-legacy-funding",
    });
    const sender = `0x${"71".repeat(20)}`;
    const insert = (id: string) =>
      admin.query(
        `INSERT INTO song_reward_leg_funding_effects(funding_effect_id,leg_id,funder_account_id,
        chain_id,token_address,sender_address,recipient_address,expected_amount_atomic,required_confirmations,state)
       VALUES ($1,$2,$3,84532,$4,$5,$6,1,3,'planned')`,
        [id, legId, identity.accountId, `0x${"1".repeat(40)}`, sender, `0x${"4".repeat(40)}`],
      );
    await insert("legacy-funding-first");
    await insert("legacy-funding-second");
    expect(
      (
        await admin.query(
          "SELECT funding_effect_id,state FROM song_reward_leg_funding_effects WHERE sender_address=$1 ORDER BY funding_effect_id",
          [sender],
        )
      ).rows,
    ).toEqual([
      { funding_effect_id: "legacy-funding-first", state: "planned" },
      { funding_effect_id: "legacy-funding-second", state: "planned" },
    ]);
    const wallet = (
      await admin.query<{ assignment_id: string }>(
        "SELECT assignment_id FROM persona_wallet_assignments WHERE persona_id=$1 AND account_id=$2",
        [identity.personaId, identity.accountId],
      )
    ).rows[0];
    if (!wallet) throw new Error("owned fixture wallet missing");
    const i = input("unknown", "legacy-history-no-v2-grant");
    const p = {
      ...packet(i),
      account_id: identity.accountId,
      persona_id: identity.personaId,
      wallet_assignment_id: wallet.assignment_id,
      sender_address: sender,
    };
    expect(
      (
        await admin.query("SELECT blocked_reason FROM reward_wallet_nonce_context_v2($1,$2,NULL)", [
          chain,
          sender,
        ])
      ).rows,
    ).toEqual([{ blocked_reason: "unknown_v1_funding" }]);
    await expect(
      admin.query("SELECT * FROM reserve_reward_funding_wallet_nonce_v2($1::jsonb)", [
        JSON.stringify(p),
      ]),
    ).rejects.toMatchObject({ code: "PWN02" });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM reward_wallet_nonce_leases WHERE sender_address=$1",
          [sender],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);

    // The real guard still rejects a different producer while V2 owns a nonce.
    await expect(
      admin.query(
        `INSERT INTO song_reward_leg_funding_effects(funding_effect_id,leg_id,funder_account_id,
       chain_id,token_address,sender_address,recipient_address,expected_amount_atomic,required_confirmations,state)
       VALUES ('legacy-must-not-race-v2',$1,$2,84532,$3,$4,$5,1,3,'planned')`,
        [legId, account, `0x${"1".repeat(40)}`, address("v2-first"), custody],
      ),
    ).rejects.toMatchObject({ code: "PWN02" });
  });

  test("later legacy sponsored send is allowed without treating its terminal row as V2 nonce evidence", async () => {
    const sender = `0x${"72".repeat(20)}`;
    const identity = await seedSong(admin, "nonce-legacy-sponsored", sender);
    const wallet = (
      await admin.query<{ assignment_id: string; privy_wallet_id: string }>(
        "SELECT assignment_id,privy_wallet_id FROM persona_wallet_assignments WHERE account_id=$1 AND persona_id=$2",
        [identity.accountId, identity.personaId],
      )
    ).rows[0];
    if (!wallet) throw new Error("owned fixture wallet missing");
    const insert = (id: string) =>
      admin.query(
        `INSERT INTO wallet_sponsored_sends(send_id,account_id,persona_id,wallet_assignment_id,privy_wallet_id,
        chain_id,sender_address,token_address,recipient_address,amount_atomic,gas_budget_wei,reference_id,
        idempotency_key,provider_idempotency_key,request_expires_at,status)
       VALUES($1,$2,$3,$4,$5,84532,$6,$7,$8,1,1,$1,$1,$1,clock_timestamp()+interval '3 minutes','reserved')`,
        [
          id,
          identity.accountId,
          identity.personaId,
          wallet.assignment_id,
          wallet.privy_wallet_id,
          sender,
          token,
          recipient,
        ],
      );
    await insert("nonce_sponsored_first_0001");
    await admin.query(
      "UPDATE wallet_sponsored_sends SET status='submitting' WHERE send_id='nonce_sponsored_first_0001'",
    );
    await admin.query(
      "UPDATE wallet_sponsored_sends SET status='submitted',provider_transaction_id='fixture-provider-result',transaction_hash=$1 WHERE send_id='nonce_sponsored_first_0001'",
      [`0x${"73".repeat(32)}`],
    );
    await admin.query(
      "UPDATE wallet_sponsored_sends SET status='confirmed',block_number=22,block_hash=$1 WHERE send_id='nonce_sponsored_first_0001'",
      [`0x${"74".repeat(32)}`],
    );
    expect(
      (
        await admin.query("SELECT blocked_reason FROM reward_wallet_nonce_context_v2($1,$2,NULL)", [
          chain,
          sender,
        ])
      ).rows,
    ).toEqual([{ blocked_reason: "other_instruction" }]);
    const p = {
      ...packet(input("unknown", "sponsored-history-no-v2")),
      account_id: identity.accountId,
      persona_id: identity.personaId,
      wallet_assignment_id: wallet.assignment_id,
      sender_address: sender,
    };
    await expect(
      admin.query("SELECT * FROM reserve_reward_funding_wallet_nonce_v2($1::jsonb)", [
        JSON.stringify(p),
      ]),
    ).rejects.toMatchObject({ code: "PWN02" });
    await insert("nonce_sponsored_second_0002");
    await expect(insert("nonce_sponsored_third_0003")).rejects.toMatchObject({ code: "PWN02" });
    expect(
      (
        await admin.query(
          "SELECT send_id,status FROM wallet_sponsored_sends WHERE sender_address=$1 ORDER BY send_id",
          [sender],
        )
      ).rows,
    ).toEqual([
      { send_id: "nonce_sponsored_first_0001", status: "confirmed" },
      { send_id: "nonce_sponsored_second_0002", status: "reserved" },
    ]);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM reward_wallet_nonce_leases WHERE sender_address=$1",
          [sender],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });

  test("pause and missing required run lease precede the real outstanding-nonce insert refusal", async () => {
    const identity = await seedSong(admin, "nonce-legacy-precedence", `0x${"75".repeat(20)}`);
    const { legId } = await seedActivePoolLeg(admin, identity, {
      fallback: false,
      suffix: "nonce-legacy-precedence",
    });
    await admin.query(
      `INSERT INTO song_reward_leg_funding_effects(funding_effect_id,leg_id,funder_account_id,
       chain_id,token_address,sender_address,recipient_address,expected_amount_atomic,required_confirmations,state)
       VALUES('legacy-precedence-issued',$1,$2,84532,$3,$4,$5,1,3,'planned')`,
      [legId, identity.accountId, `0x${"1".repeat(40)}`, `0x${"75".repeat(20)}`, custody],
    );
    await admin.query("BEGIN");
    try {
      const insert = () =>
        admin.query(
          `INSERT INTO song_reward_leg_funding_effects(funding_effect_id,leg_id,funder_account_id,
         chain_id,token_address,sender_address,recipient_address,expected_amount_atomic,required_confirmations,state)
         VALUES('legacy-precedence-refused',$1,$2,84532,$3,$4,$5,1,3,'planned')`,
          [legId, account, `0x${"1".repeat(40)}`, address("v2-first"), custody],
        );
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,TRUE,'nonce_precedence') FROM reward_operations_control WHERE singleton",
      );
      await admin.query("SAVEPOINT paused");
      await expect(insert()).rejects.toMatchObject({ code: "PR001" });
      await admin.query("ROLLBACK TO SAVEPOINT paused");
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,FALSE,'nonce_precedence') FROM reward_operations_control WHERE singleton",
      );
      await admin.query("SET LOCAL pirate.reward_run_lease_requirement_change='deployment'");
      await admin.query("UPDATE reward_operations_run_lease SET required=TRUE WHERE singleton");
      await admin.query("SAVEPOINT missing_lease");
      await expect(insert()).rejects.toMatchObject({ code: "PR001" });
      await admin.query("ROLLBACK TO SAVEPOINT missing_lease");
      await admin.query("UPDATE reward_operations_run_lease SET required=FALSE WHERE singleton");
      await admin.query("SAVEPOINT outstanding_nonce");
      await expect(insert()).rejects.toMatchObject({ code: "PWN02" });
      await admin.query("ROLLBACK TO SAVEPOINT outstanding_nonce");
      // Already-issued observation remains possible even while admissions pause.
      await admin.query(
        "SELECT set_reward_operations_paused_v1(revision,TRUE,'nonce_precedence') FROM reward_operations_control WHERE singleton",
      );
      expect(
        (
          await admin.query(
            "UPDATE song_reward_leg_funding_effects SET state='reconciliation_required' WHERE funding_effect_id='legacy-precedence-issued' RETURNING state",
          )
        ).rows,
      ).toEqual([{ state: "reconciliation_required" }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM song_reward_leg_funding_effects WHERE funding_effect_id='legacy-precedence-refused'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("audio closure admits exactly the owned operation column and refuses unknown guest dependencies or broken provenance/fences", async () => {
    expect(
      (await admin.query("SELECT require_guest_practice_only_schema_phase_v1()")).rowCount,
    ).toBe(1);
    for (const mutation of [
      "ALTER TABLE reward_wallet_nonce_leases ADD COLUMN unexpected_owner_id TEXT",
      "CREATE TABLE unexpected_guest_relation(owner_id TEXT)",
      "CREATE TABLE unexpected_guest_fk(source_ref TEXT REFERENCES participation_owners(owner_id))",
      "ALTER TABLE reward_wallet_nonce_leases ADD CONSTRAINT unexpected_guest_fk FOREIGN KEY(owner_id) REFERENCES participation_owners(owner_id) NOT VALID",
      "ALTER TABLE reward_wallet_nonce_leases ALTER COLUMN owner_id DROP NOT NULL",
      "ALTER TABLE reward_wallet_nonce_leases DROP CONSTRAINT reward_wallet_nonce_provenance",
      "ALTER TABLE reward_wallet_nonce_leases DISABLE TRIGGER reward_wallet_nonce_leases_append_only",
      "ALTER TABLE reward_wallet_nonce_leases DISABLE TRIGGER reward_wallet_nonce_leases_no_truncate",
      "ALTER TABLE reward_wallet_nonce_leases RENAME TO unexpected_nonce_relation",
    ]) {
      await admin.query("BEGIN");
      try {
        await admin.query(mutation);
        await expect(
          admin.query("SELECT require_guest_practice_only_schema_phase_v1()"),
        ).rejects.toMatchObject({ code: "GP003" });
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    expect(
      (await admin.query("SELECT require_guest_practice_only_schema_phase_v1()")).rowCount,
    ).toBe(1);
    expect(
      (
        await admin.query(`SELECT a.privilege_type FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='reward_wallet_nonce_ownership_open_v2(bigint,text)'::regprocedure AND a.grantee<>p.proowner`)
      ).rows,
    ).toEqual([]);
  });
});
