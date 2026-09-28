import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneSponsoredSendStore } from "./reward-sponsored-send-repository.ts";
import { makeRewardSponsoredSendService } from "./reward-sponsored-send-service.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;
const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const token = address("0a");
const custody = address("cc");
const sender = address("a1");
const recipient = address("d1");

suite("Postgres sponsored reward send reservation", () => {
  const schema = `reward_sponsored_send_${Date.now()}`;
  const scoped = connectionString
    ? `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`
    : "";
  const admin = new Client({ connectionString });
  const contender = new Client({ connectionString: scoped });

  async function seedCredit(number: number) {
    const creditId = `sponsored-credit-${number}`;
    const effectId = `sponsored-payout-${number}`;
    const transactionHash = hash(number.toString(16).padStart(2, "0"));
    await admin.query(
      `INSERT INTO reward_ledger_credits (
         credit_id, account_id, payout_persona_id, chain_id, token_address, amount_atomic,
         source_kind, source_reference, state, paid_atomic, settled_at
       ) VALUES ($1,'winner','persona-1',84532,$2,1000000,
         'megapot_allocation',$1,'sent',1000000,clock_timestamp())`,
      [creditId, token],
    );
    await admin.query(
      `INSERT INTO megapot_participant_claims (
         credit_id, account_id, pool_leg_id, drawing_id, status, subject_key_id,
         evidence_receipt_id, accepted_at
       ) VALUES ($1,'winner','leg-1',$2,'accepted','subject-1','receipt',clock_timestamp())`,
      [creditId, number],
    );
    await admin.query(
      `INSERT INTO reward_chain_effects (
         effect_id, effect_kind, state, version, chain_id, signer_address, target_address,
         settled_amount_atomic, nonce, calldata, calldata_hash, signed_transaction,
         signed_transaction_hash, transaction_hash, receipt_status, receipt_block_number,
         receipt_block_hash, receipt_hash, confirmations, prepared_at, broadcast_at,
         confirmed_at, created_at, updated_at
       ) VALUES ($1,'reward_payout','confirmed',5,84532,$2,$3,1000000,$4,'0x00',$5,
         '0x01',$6,$6,'success',10,$7,$5,3,now(),now(),now(),now(),now())`,
      [effectId, custody, token, number, "ab".repeat(32), transactionHash, hash("11")],
    );
    await admin.query(
      `INSERT INTO reward_payout_effects (
         payout_effect_id, attestation_id, credit_id, account_id, payout_persona_id,
         destination_address, amount_atomic, wallet_assignment_id,
         solvency_observation_id, custody_balance_before_atomic
       ) VALUES ($1,'attestation-1',$2,'winner','persona-1',$3,1000000,
         'assignment-1','observation',1000000)`,
      [effectId, creditId, sender],
    );
    await admin.query(
      `INSERT INTO reward_erc20_transfer_receipt_evidence (
         effect_id, transfer_purpose, attestation_id, token_address, sender_address,
         recipient_address, amount_atomic, transaction_hash, transfer_log_index,
         custody_balance_after_atomic, block_number, block_hash, receipt_hash,
         confirmations, confirmed_at
       ) VALUES ($1,'reward_payout','attestation-1',$2,$3,$4,1000000,$5,0,0,10,$6,$7,3,now())`,
      [effectId, token, custody, sender, transactionHash, hash("11"), "ab".repeat(32)],
    );
  }

  function sponsoredInsert(credit: number, id = `sponsored-send-${credit}`) {
    return admin.query(
      `INSERT INTO reward_sponsored_sends (
         send_id, credit_id, account_id, persona_id, wallet_assignment_id,
         privy_wallet_id, chain_id, sender_address, token_address, recipient_address,
         amount_atomic, reference_id, idempotency_key, provider_idempotency_key,
         request_expires_at, status
       ) VALUES ($1,$2,'winner','persona-1','assignment-1','wallet_12345678',84532,
         $3,$4,$5,1000000,$6,$7,$8,clock_timestamp() + interval '2 minutes','reserved')`,
      [
        id,
        `sponsored-credit-${credit}`,
        sender,
        token,
        recipient,
        `reference_${id}`,
        `idempotency_${id}`,
        `provider_${id}`,
      ],
    );
  }

  function directInsert(client: Client, credit: number, id = `direct-send-${credit}`) {
    return client.query(
      `INSERT INTO reward_winner_sends (
         send_id, credit_id, account_id, persona_id, wallet_assignment_id,
         chain_id, token_address, sender_address, attempt, status
       ) VALUES ($1,$2,'winner','persona-1','assignment-1',84532,$3,$4,1,'retryable')`,
      [id, `sponsored-credit-${credit}`, token, sender],
    );
  }

  beforeAll(async () => {
    if (!connectionString) return;
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query("INSERT INTO users (user_id) VALUES ('winner')");
      await admin.query(
        "INSERT INTO personas (persona_id, account_id) VALUES ('persona-1','winner')",
      );
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id, persona_id, account_id, chain_account_kind, privy_wallet_id,
           hd_wallet_index, address, status, reservation_idempotency_key,
           assigned_at, created_at, updated_at
         ) VALUES ('assignment-1','persona-1','winner','evm','wallet_12345678',0,$1,
           'active','assignment-1',now(),now(),now())`,
        [sender],
      );
      for (let number = 1; number <= 6; number++) await seedCredit(number);
    } finally {
      await admin.query("SET session_replication_role = origin");
    }
    await contender.connect();
  }, 120_000);

  afterAll(async () => {
    if (!connectionString) return;
    await contender.end().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("a sponsored reservation locks out a direct send and cannot exceed the payout", async () => {
    await expect(
      admin.query(
        `INSERT INTO reward_sponsored_sends (
         send_id, credit_id, account_id, persona_id, wallet_assignment_id,
         privy_wallet_id, chain_id, sender_address, token_address, recipient_address,
         amount_atomic, reference_id, idempotency_key, provider_idempotency_key,
         request_expires_at, status
       ) VALUES ('wrong-wallet','sponsored-credit-1','winner','persona-1','assignment-1',
         'wallet_wrong',84532,$1,$2,$3,1000001,'reference_wrong_wallet',
         'idempotency_wrong_wallet','provider_wrong_wallet',
         clock_timestamp() + interval '2 minutes','reserved')`,
        [sender, token, recipient],
      ),
    ).rejects.toThrow("claimed and paid credit wallet");
    await sponsoredInsert(1);
    await expect(directInsert(admin, 1)).rejects.toThrow(
      "a credit with a sponsored send cannot start a direct send",
    );
    await expect(sponsoredInsert(1, "sponsored-send-1-duplicate")).rejects.toThrow("duplicate key");
    await admin.query(
      "UPDATE reward_sponsored_sends SET status='submitting' WHERE send_id='sponsored-send-1'",
    );
    await admin.query(
      "UPDATE reward_sponsored_sends SET status='held' WHERE send_id='sponsored-send-1'",
    );
    await expect(
      admin.query(
        "UPDATE reward_sponsored_sends SET status='abandoned' WHERE send_id='sponsored-send-1'",
      ),
    ).rejects.toThrow("invalid sponsored reward send transition");
  });

  test("a direct send locks out a sponsored reservation", async () => {
    await admin.query("BEGIN");
    try {
      await directInsert(admin, 2);
      await admin.query(
        `INSERT INTO reward_winner_send_attempts (
           send_id, attempt, account_id, idempotency_key, recipient_address,
           amount_atomic, nonce
         ) VALUES ('direct-send-2',1,'winner','direct-idempotency-2',$1,1000000,0)`,
        [recipient],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    await expect(sponsoredInsert(2)).rejects.toThrow(
      "a credit with a direct send cannot start a sponsored send",
    );
  });

  test("two modes racing for the same credit serialize on its row", async () => {
    await admin.query("BEGIN");
    try {
      await sponsoredInsert(3);
      let finished = false;
      const racing = directInsert(contender, 3).finally(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finished).toBe(false);
      await admin.query("COMMIT");
      await expect(racing).rejects.toThrow(
        "a credit with a sponsored send cannot start a direct send",
      );
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });

  test("the runtime reserves the paid wallet before submission and cannot submit twice", async () => {
    const store = makeControlPlaneSponsoredSendStore(makeDirectPostgresControlPlaneLayer(scoped), {
      perAccountUtcDay: 20,
      perWalletUtcDay: 20,
      platformUtcDay: 20,
    });
    const request = {
      accountId: "winner",
      creditId: "sponsored-credit-4",
      recipientAddress: recipient,
      amountAtomic: 1_000_000n,
      idempotencyKey: "runtime_idempotency_4",
      providerIdempotencyKey: "runtime_provider_key_4",
      sendId: "runtime-send-4",
      referenceId: "runtime_reference_4",
    };
    const record = await Effect.runPromise(store.reserve(request));
    expect(record.walletId).toBe("wallet_12345678");
    expect(record.senderAddress).toBe(sender);
    expect(record.status).toBe("reserved");
    expect((await Effect.runPromise(store.reserve(request))).sendId).toBe(record.sendId);
    expect(
      await Effect.runPromise(store.get({ accountId: "other", sendId: record.sendId })),
    ).toBeNull();
    await Effect.runPromise(store.markSubmitting({ accountId: "winner", sendId: record.sendId }));
    await expect(
      Effect.runPromise(store.markSubmitting({ accountId: "winner", sendId: record.sendId })),
    ).rejects.toThrow("sponsored send conflict");
    const pending = await Effect.runPromise(
      store.findByCredit({
        accountId: "winner",
        creditId: request.creditId,
      }),
    );
    expect(pending?.status).toBe("submitting");
    await expect(
      Effect.runPromise(
        store.abandonUnsigned({
          accountId: "winner",
          sendId: record.sendId,
        }),
      ),
    ).rejects.toThrow("sponsored send conflict");
    await Effect.runPromise(store.markHeld({ accountId: "winner", sendId: record.sendId }));
    await Effect.runPromise(
      store.attachObservation({
        accountId: "winner",
        sendId: record.sendId,
        providerTransactionId: "provider-transaction-4",
        transactionHash: hash("44"),
      }),
    );
    await Effect.runPromise(
      store.recordFinal({
        accountId: "winner",
        sendId: record.sendId,
        outcome: "confirmed",
        transactionHash: hash("44"),
        blockNumber: 44n,
        blockHash: hash("55"),
      }),
    );
    expect(
      (await Effect.runPromise(store.get({ accountId: "winner", sendId: record.sendId })))?.status,
    ).toBe("confirmed");
    await expect(
      Effect.runPromise(
        store.reserve({
          ...request,
          idempotencyKey: "runtime_idempotency_different",
          referenceId: "runtime_ref_different",
          providerIdempotencyKey: "runtime_provider_different",
          sendId: "runtime-send-duplicate",
          recipientAddress: address("d2"),
        }),
      ),
    ).rejects.toThrow("sponsored send conflict");
  });

  test("one exact signed request submits once and reconciles only its linked Transfer", async () => {
    const store = makeControlPlaneSponsoredSendStore(makeDirectPostgresControlPlaneLayer(scoped), {
      perAccountUtcDay: 20,
      perWalletUtcDay: 20,
      platformUtcDay: 20,
    });
    let calls = 0;
    const service = makeRewardSponsoredSendService({
      store,
      appId: "app_test_1234",
      appSecret: "test_secret_1234",
      requiredConfirmations: 3,
      ids: () => crypto.randomUUID().replaceAll("-", ""),
      submit: async () => {
        calls++;
        return {
          transactionId: "provider-transaction-5",
          transactionHash: null,
          userOperationHash: hash("aa"),
        };
      },
      findByReference: async (query) => ({
        id: "provider-transaction-5",
        walletId: query.walletId,
        referenceId: query.referenceId,
        caip2: `eip155:${query.chainId}`,
        status: "confirmed",
        transactionHash: hash("55"),
      }),
      chain: {
        readReceipt: async () => ({
          canonical: true,
          status: "success",
          transactionHash: hash("55"),
          blockNumber: 50n,
          blockHash: hash("66"),
          transfers: [
            { tokenAddress: token, from: sender, to: recipient, amountAtomic: 1_000_000n },
          ],
        }),
        readHead: async () => 52n,
        readFinalizedHead: async () => 52n,
      },
    });
    const request = {
      accountId: "winner",
      creditId: "sponsored-credit-5",
      recipientAddress: recipient,
      amountAtomic: 1_000_000n,
      idempotencyKey: "live_test_key_5",
    };
    const prepared = await service.reserve(request);
    expect(prepared.authorization?.walletId).toBe("wallet_12345678");
    expect(prepared.authorization?.payloadBase64.length).toBeGreaterThan(100);
    const settled = await service.submit({
      accountId: "winner",
      sendId: prepared.record.sendId,
      signature: "c2lnbmF0dXJl",
    });
    expect(settled.record.status).toBe("confirmed");
    expect(calls).toBe(1);
    await expect(
      service.submit({
        accountId: "winner",
        sendId: prepared.record.sendId,
        signature: "c2lnbmF0dXJl",
      }),
    ).rejects.toThrow("sponsored send conflict");
    expect(calls).toBe(1);
    expect((await service.reserve(request)).record.sendId).toBe(prepared.record.sendId);
  });

  test("a lost provider response holds the winning even when reference lookup is empty", async () => {
    const store = makeControlPlaneSponsoredSendStore(makeDirectPostgresControlPlaneLayer(scoped), {
      perAccountUtcDay: 20,
      perWalletUtcDay: 20,
      platformUtcDay: 20,
    });
    let calls = 0;
    const service = makeRewardSponsoredSendService({
      store,
      appId: "app_test_1234",
      appSecret: "test_secret_1234",
      requiredConfirmations: 3,
      ids: () => crypto.randomUUID().replaceAll("-", ""),
      submit: async () => {
        calls++;
        throw new Error("response lost");
      },
      findByReference: async () => null,
      chain: {
        readReceipt: async () => null,
        readHead: async () => 0n,
        readFinalizedHead: async () => 0n,
      },
    });
    const request = {
      accountId: "winner",
      creditId: "sponsored-credit-6",
      recipientAddress: recipient,
      amountAtomic: 1_000_000n,
      idempotencyKey: "lost_test_key_6",
    };
    const prepared = await service.reserve(request);
    await expect(
      service.submit({
        accountId: "winner",
        sendId: prepared.record.sendId,
        signature: "c2lnbmF0dXJl",
      }),
    ).rejects.toThrow("outcome unknown");
    expect(
      (await service.get({ accountId: "winner", sendId: prepared.record.sendId })).record.status,
    ).toBe("held");
    await expect(
      service.submit({
        accountId: "winner",
        sendId: prepared.record.sendId,
        signature: "c2lnbmF0dXJl",
      }),
    ).rejects.toThrow("sponsored send conflict");
    expect(calls).toBe(1);
  });
});
