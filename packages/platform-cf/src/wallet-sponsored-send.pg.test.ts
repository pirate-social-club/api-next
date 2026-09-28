import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneSponsoredSendStore } from "./wallet-sponsored-send-repository.ts";
import { makeWalletSponsoredSendService } from "./wallet-sponsored-send-service.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;
const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const token = address("0a");
const sender = address("a1");
const otherSender = address("a2");
const recipient = address("d1");
const limits = {
  perAccountUtcDay: 3,
  perWalletUtcDay: 2,
  platformUtcDay: 4,
  gasBudgetPerSendWei: 100_000_000_000_000n,
  accountDailyGasBudgetWei: 300_000_000_000_000n,
  walletDailyGasBudgetWei: 200_000_000_000_000n,
  platformDailyGasBudgetWei: 400_000_000_000_000n,
} as const;

suite("Postgres shared Wallet sponsored send", () => {
  const schema = `wallet_sponsored_send_${Date.now()}`;
  const scoped = connectionString
    ? `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`
    : "";
  const admin = new Client({ connectionString });
  const contender = new Client({ connectionString: scoped });
  const store = makeControlPlaneSponsoredSendStore(
    makeDirectPostgresControlPlaneLayer(scoped),
    limits,
  );
  let nextId = 0;
  const request = (personaId = "persona-1", overrides: Record<string, unknown> = {}) => ({
    accountId: "winner",
    personaId,
    chainId: 84_532 as const,
    tokenAddress: token,
    recipientAddress: recipient,
    amountAtomic: 1_000_000n,
    idempotencyKey: `wallet_idempotency_${++nextId}`,
    providerIdempotencyKey: `provider_idempotency_${nextId}`,
    sendId: `wallet_send_${nextId}`,
    referenceId: `wallet_reference_${nextId}`,
    ...overrides,
  });

  beforeAll(async () => {
    if (!connectionString) return;
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query("INSERT INTO users (user_id) VALUES ('winner'),('stranger')");
      await admin.query(
        "INSERT INTO personas (persona_id, account_id) VALUES ('persona-1','winner'),('persona-2','winner')",
      );
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
          assignment_id, persona_id, account_id, chain_account_kind, privy_wallet_id,
          hd_wallet_index, address, status, reservation_idempotency_key,
          assigned_at, created_at, updated_at
        ) VALUES
          ('assignment-1','persona-1','winner','evm','wallet_12345678',0,$1,'active','assignment-1',now(),now(),now()),
          ('assignment-2','persona-2','winner','evm','wallet_87654321',1,$2,'active','assignment-2',now(),now(),now())`,
        [sender, otherSender],
      );
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

  test("requires the caller's active assigned wallet, without a reward credit", async () => {
    const first = request();
    const reserved = await Effect.runPromise(store.reserve(first));
    expect(reserved.personaId).toBe("persona-1");
    expect(reserved.senderAddress).toBe(sender);
    expect(reserved.gasBudgetWei).toBe(limits.gasBudgetPerSendWei);
    expect((await Effect.runPromise(store.reserve(first))).sendId).toBe(reserved.sendId);
    expect(
      await Effect.runPromise(store.get({ accountId: "stranger", sendId: reserved.sendId })),
    ).toBeNull();
    await expect(
      Effect.runPromise(
        store.reserve(
          request("persona-2", {
            accountId: "stranger",
          }),
        ),
      ),
    ).rejects.toThrow("sponsored send not-found");
    await expect(
      admin.query(
        `INSERT INTO wallet_sponsored_sends (
        send_id, account_id, persona_id, wallet_assignment_id, privy_wallet_id,
        chain_id, sender_address, token_address, recipient_address,
        amount_atomic, gas_budget_wei, reference_id, idempotency_key,
        provider_idempotency_key, request_expires_at, status
      ) VALUES ('wrong-wallet','winner','persona-2','assignment-2','wallet_wrong',
        84532,$1,$2,$3,1000000,100000000000000,'reference_wrong_wallet',
        'idempotency_wrong_wallet','provider_wrong_wallet',
        now()+interval '2 minutes','reserved')`,
        [otherSender, token, recipient],
      ),
    ).rejects.toThrow("active assigned persona wallet");
  });

  test("holds an uncertain send, prevents a second wallet send, and confirms exact chain evidence", async () => {
    const first = await Effect.runPromise(
      store.findByPersona({ accountId: "winner", personaId: "persona-1" }),
    );
    if (first === null) throw new Error("reservation missing");
    await Effect.runPromise(store.markSubmitting({ accountId: "winner", sendId: first.sendId }));
    await Effect.runPromise(store.markHeld({ accountId: "winner", sendId: first.sendId }));
    await expect(
      Effect.runPromise(
        store.reserve(
          request("persona-1", {
            recipientAddress: address("d2"),
          }),
        ),
      ),
    ).rejects.toThrow("sponsored send conflict");
    await expect(
      admin.query("UPDATE wallet_sponsored_sends SET status='abandoned' WHERE send_id=$1", [
        first.sendId,
      ]),
    ).rejects.toThrow("invalid sponsored Wallet send transition");
    await Effect.runPromise(
      store.attachObservation({
        accountId: "winner",
        sendId: first.sendId,
        providerTransactionId: "provider_tx_1",
        transactionHash: hash("11"),
      }),
    );
    await Effect.runPromise(
      store.recordFinal({
        accountId: "winner",
        sendId: first.sendId,
        outcome: "confirmed",
        transactionHash: hash("11"),
        blockNumber: 100n,
        blockHash: hash("22"),
      }),
    );
    expect(
      (await Effect.runPromise(store.get({ accountId: "winner", sendId: first.sendId })))?.status,
    ).toBe("confirmed");
  });

  test("permits a deliberate later transfer while enforcing wallet gas budget", async () => {
    const second = await Effect.runPromise(store.reserve(request()));
    expect(second.status).toBe("reserved");
    await expect(
      Effect.runPromise(
        store.reserve(
          request("persona-1", {
            recipientAddress: address("d3"),
          }),
        ),
      ),
    ).rejects.toThrow("sponsored send conflict");
    await Effect.runPromise(store.markSubmitting({ accountId: "winner", sendId: second.sendId }));
    await Effect.runPromise(store.markHeld({ accountId: "winner", sendId: second.sendId }));
    await Effect.runPromise(
      store.attachObservation({
        accountId: "winner",
        sendId: second.sendId,
        providerTransactionId: "provider_tx_2",
        transactionHash: hash("33"),
      }),
    );
    await Effect.runPromise(
      store.recordFinal({
        accountId: "winner",
        sendId: second.sendId,
        outcome: "confirmed",
        transactionHash: hash("33"),
        blockNumber: 101n,
        blockHash: hash("44"),
      }),
    );
    await expect(Effect.runPromise(store.reserve(request()))).rejects.toThrow(
      "sponsored send limit",
    );
  });

  test("a server submission never retries after a lost Privy response", async () => {
    let submits = 0;
    const service = makeWalletSponsoredSendService({
      store,
      appId: "app_12345678",
      appSecret: "secret_12345678",
      eligibleAsset: { chainId: 84_532, tokenAddress: token },
      requiredConfirmations: 2,
      ids: () => `generated_identifier_${++nextId}`,
      chain: {
        readTokenBalance: async () => 1_000_000n,
        readReceipt: async () => null,
        readHead: async () => 101n,
        readFinalizedHead: async () => 100n,
      },
      submit: async () => {
        submits++;
        throw new Error("lost response");
      },
      findByReference: async () => null,
    });
    const reserved = await service.reserve({
      accountId: "winner",
      personaId: "persona-2",
      chainId: 84_532,
      recipientAddress: recipient,
      amountAtomic: 1_000_000n,
      idempotencyKey: "service_idempotency_1",
    });
    if (reserved.authorization === null) throw new Error("authorization missing");
    await expect(
      service.submit({
        accountId: "winner",
        sendId: reserved.record.sendId,
        signature: "YWJjZA==",
      }),
    ).rejects.toThrow("outcome unknown");
    expect(submits).toBe(1);
    await expect(
      service.submit({
        accountId: "winner",
        sendId: reserved.record.sendId,
        signature: "YWJjZA==",
      }),
    ).rejects.toThrow("sponsored send conflict");
    expect(submits).toBe(1);
    expect(
      (await service.get({ accountId: "winner", sendId: reserved.record.sendId })).record.status,
    ).toBe("held");
  });
});
