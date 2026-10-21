import { afterAll, describe, expect, test } from "bun:test";
import {
  encodeRewardWinnerSendCalldata,
  makeRewardWinnerSendService,
  type RewardWinnerSendChain,
  type RewardWinnerSendChainTransaction,
  type RewardWinnerSendReceiptRead,
  type RewardWinnerSendRecord,
  RewardWinnerSendStorageFailed,
  RewardWinnerSendVerificationRequired,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { seedVeryRewardEvidence } from "./activity-participation-composed-identity.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { seedWinnerSendPrerequisites } from "./reward-winner-send.pg-fixture.ts";
import { makeControlPlaneRewardWinnerSendStore } from "./reward-winner-send-repository.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw Error("PostgreSQL test URL required");
const suite = url ? describe : describe.skip;
const reusable = createReusablePostgresTestSchemaOwner();
const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const token = address("0a");
const recipient = address("d1");

async function context(admin: Client, connectionString: string) {
  await applyPostgresTestBaselineConnection({ connectionString });
  const accounts = ["missing", "expired", "revoked", "recovered", "holder", "ambiguous", "valid"];
  await seedWinnerSendPrerequisites(
    admin,
    accounts.map((account, index) => ({
      account,
      persona: `persona-${account}`,
      address: address((index + 1).toString(16).padStart(2, "0")),
      state: "sent" as const,
      claimed: true,
      paidOut: true,
    })),
    { chainId: 84_532, tokenAddress: token, custodyAddress: address("cc"), paidAtomic: 1_000_000n },
  );
  const store = makeControlPlaneRewardWinnerSendStore(
    makeDirectPostgresControlPlaneLayer(connectionString),
  );
  let sequence = 0;
  let nonceReads = 0;
  let pendingNonce = 0n;
  let confirmedNonce = 0n;
  const transactions = new Map<string, RewardWinnerSendChainTransaction>();
  const receipts = new Map<string, RewardWinnerSendReceiptRead>();
  const chain: RewardWinnerSendChain = {
    readPendingNonce: () =>
      Effect.sync(() => {
        nonceReads++;
        return pendingNonce;
      }),
    readTransaction: (id) => Effect.sync(() => transactions.get(id) ?? null),
    readHead: () => Effect.succeed(102n),
    readFinalizedHead: () => Effect.succeed(102n),
    readTransactionCount: () => Effect.sync(() => confirmedNonce),
    readReceipt: (id) => Effect.sync(() => receipts.get(id) ?? null),
  };
  const service = makeRewardWinnerSendService({
    store,
    chain,
    requiredConfirmations: 3,
    ids: { next: Effect.sync(() => `palm-${++sequence}`) },
  });
  const request = (accountId: string, key = `key-${++sequence}`) => ({
    accountId,
    creditId: `credit-persona-${accountId}`,
    recipientAddress: recipient,
    amountAtomic: 400_000n,
    idempotencyKey: key,
  });
  const createInput = async (accountId: string) => ({
    context: await Effect.runPromise(store.loadContext(request(accountId))),
    sendId: `direct-${++sequence}`,
    idempotencyKey: `direct-key-${sequence}`,
    recipientAddress: recipient,
    amountAtomic: 400_000n,
    readNonce: chain.readPendingNonce(address("07")),
  });
  const broadcast = (record: RewardWinnerSendRecord, cancel = false) => {
    const id = hash(cancel ? "c1" : "e1");
    transactions.set(id, {
      transactionHash: id,
      chainId: record.chainId,
      from: record.senderAddress,
      to: cancel ? record.senderAddress : record.tokenAddress,
      nonce: record.nonce,
      valueWei: 0n,
      input: cancel
        ? "0x"
        : encodeRewardWinnerSendCalldata(record.recipientAddress, record.amountAtomic),
    });
    return id;
  };
  const mine = (record: RewardWinnerSendRecord, id: string, reverted = false) => {
    pendingNonce = record.nonce + 1n;
    confirmedNonce = pendingNonce;
    receipts.set(id, {
      canonical: true,
      transactionHash: id,
      status: reverted ? "reverted" : "success",
      blockNumber: 100n,
      blockHash: hash("b1"),
      transfers: reverted
        ? []
        : [
            {
              tokenAddress: token,
              from: record.senderAddress,
              to: recipient,
              amountAtomic: record.amountAtomic,
            },
          ],
    });
  };
  return {
    admin,
    connectionString,
    store,
    service,
    chain,
    request,
    createInput,
    broadcast,
    mine,
    nonceReads: () => nonceReads,
  };
}

suite("PostgreSQL current Palm for winnings Send", () => {
  afterAll(() => reusable.dispose());
  async function fixture(use: (value: Awaited<ReturnType<typeof context>>) => Promise<void>) {
    if (!url) throw Error("PostgreSQL test URL required");
    await reusable.run({
      baseConnectionString: url,
      schemaName: "winner_send_palm",
      use: async ({ admin, connectionString }) => use(await context(admin, connectionString)),
    });
  }
  async function revoke(admin: Client, account: string, suffix: string) {
    await admin.query(
      `INSERT INTO assertion_revalidation_events
      (assertion_revalidation_event_id,assertion_id,user_id,evidence_receipt_id,outcome,observed_at)
      VALUES ($1,$2,$3,$4,'revoked',clock_timestamp())`,
      [
        `revoked-${suffix}`,
        `composed-assertion-person-${suffix}`,
        account,
        `composed-receipt-${suffix}`,
      ],
    );
  }

  test("an accepted paid Claim does not authorize a nonce without current account evidence", async () => {
    await fixture(async ({ admin, service, request, nonceReads }) => {
      await seedVeryRewardEvidence(admin, "expired", "expired", "2".repeat(64), "expired");
      await seedVeryRewardEvidence(admin, "revoked", "revoked", "3".repeat(64));
      await revoke(admin, "revoked", "revoked");
      await seedVeryRewardEvidence(admin, "recovered", "original", "4".repeat(64));
      await seedVeryRewardEvidence(admin, "holder", "recovery", "9".repeat(64), "current", {
        subject: "original",
        previous: "original",
        epoch: 2,
      });
      await seedVeryRewardEvidence(admin, "ambiguous", "ambiguous-a", "5".repeat(64));
      await seedVeryRewardEvidence(admin, "ambiguous", "ambiguous-b", "6".repeat(64));
      for (const account of ["missing", "expired", "revoked", "recovered", "ambiguous"]) {
        expect(
          await Effect.runPromise(Effect.flip(service.request(request(account)))),
        ).toBeInstanceOf(RewardWinnerSendVerificationRequired);
      }
      expect(nonceReads()).toBe(0);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM reward_winner_sends")).rows,
      ).toEqual([{ count: 0 }]);
    });
  }, 120_000);

  test("revocation preserves private replay, cancellation reporting and late transfer settlement", async () => {
    await fixture(async ({ admin, service, request, nonceReads, broadcast, mine }) => {
      await seedVeryRewardEvidence(admin, "valid", "current", "7".repeat(64));
      const original = request("valid", "original");
      const record = await Effect.runPromise(service.request(original));
      await revoke(admin, "valid", "current");
      expect(await Effect.runPromise(service.request(original))).toEqual(record);
      expect((await Effect.runPromise(service.getByCredit(original))).sendId).toBe(record.sendId);
      const cancel = broadcast(record, true);
      expect(
        (
          await Effect.runPromise(
            service.cancel({ accountId: "valid", sendId: record.sendId, transactionHash: cancel }),
          )
        ).cancellationHashes,
      ).toEqual([cancel]);
      const transfer = broadcast(record);
      await Effect.runPromise(
        service.attachTransaction({
          accountId: "valid",
          sendId: record.sendId,
          transactionHash: transfer,
        }),
      );
      mine(record, transfer);
      expect(
        await Effect.runPromise(service.get({ accountId: "valid", sendId: record.sendId })),
      ).toMatchObject({ status: "confirmed", nonce: record.nonce });
      expect(nonceReads()).toBe(1);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM reward_winner_send_attempts")).rows,
      ).toEqual([{ count: 1 }]);
    });
  }, 120_000);

  test("a reverted attempt needs fresh proof before allocating its next nonce", async () => {
    await fixture(async ({ admin, service, request, nonceReads, broadcast, mine }) => {
      await seedVeryRewardEvidence(admin, "valid", "current", "7".repeat(64));
      const original = request("valid", "original");
      const record = await Effect.runPromise(service.request(original));
      const transfer = broadcast(record);
      mine(record, transfer, true);
      expect(
        (
          await Effect.runPromise(
            service.attachTransaction({
              accountId: "valid",
              sendId: record.sendId,
              transactionHash: transfer,
            }),
          )
        ).status,
      ).toBe("reverted");
      await revoke(admin, "valid", "current");
      expect(
        await Effect.runPromise(Effect.flip(service.request(request("valid", "retry")))),
      ).toBeInstanceOf(RewardWinnerSendVerificationRequired);
      expect((await Effect.runPromise(service.request(original))).status).toBe("reverted");
      expect(nonceReads()).toBe(1);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM reward_winner_send_attempts")).rows,
      ).toEqual([{ count: 1 }]);
      await seedVeryRewardEvidence(admin, "valid", "renewed", "8".repeat(64));
      expect(await Effect.runPromise(service.request(request("valid", "retry")))).toMatchObject({
        sendId: record.sendId,
        attempt: 2,
        nonce: 1n,
      });
      expect(nonceReads()).toBe(2);
    });
  }, 120_000);

  test("revocation committed during admission wins before the nonce reader runs", async () => {
    await fixture(async ({ admin, connectionString, store, createInput, nonceReads }) => {
      await seedVeryRewardEvidence(admin, "valid", "concurrent", "a".repeat(64));
      const input = await createInput("valid");
      const contender = new Client({ connectionString });
      await contender.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await contender.query("BEGIN");
        const pid = (await contender.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await revoke(contender, "valid", "concurrent");
        pending = Effect.runPromise(Effect.flip(store.create(input)));
        let blocked = false;
        for (let n = 0; n < 200; n++) {
          if (
            (
              await admin.query(
                "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows.length > 0
          ) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await contender.query("COMMIT");
        expect(await pending).toBeInstanceOf(RewardWinnerSendVerificationRequired);
        expect(nonceReads()).toBe(0);
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM reward_winner_sends")).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        await contender.query("ROLLBACK");
        await contender.end();
        await pending;
      }
    });
  }, 120_000);

  test("the restricted legacy runtime uses narrow EXECUTE, without assertion UPDATE", async () => {
    await fixture(async ({ admin, connectionString, createInput, nonceReads }) => {
      await seedVeryRewardEvidence(admin, "valid", "restricted", "b".repeat(64));
      const migration = (await loadPostgresMigrations()).find(
        (value) => value.version === "0276_wallet_send_palm_assertion_lock.sql",
      );
      if (migration === undefined) throw Error("Send Palm lock migration missing");
      await admin.query("DROP FUNCTION lock_wallet_send_palm_assertions_v1(text,text)");
      await admin.query(migration.sql);
      const role = `winner_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
      const schema: string = (await admin.query("SELECT current_schema() AS name")).rows[0].name;
      await admin.query(
        `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      let runtime: Client | undefined;
      try {
        await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
        await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
        await admin.query(`GRANT UPDATE(subject_key_id) ON subject_keys TO "${role}"`);
        await admin.query(
          `GRANT UPDATE(binding_event_id) ON active_subject_key_bindings TO "${role}"`,
        );
        await admin.query(
          `GRANT INSERT,UPDATE ON reward_winner_sends,reward_winner_send_attempts TO "${role}"`,
        );
        const scoped = new URL(connectionString);
        scoped.searchParams.set(
          "options",
          `${scoped.searchParams.get("options") ?? ""} -c role=${role}`,
        );
        runtime = new Client({ connectionString: scoped.toString() });
        await runtime.connect();
        expect((await runtime.query("SELECT current_user AS name")).rows[0].name).toBe(role);
        const restricted = makeControlPlaneRewardWinnerSendStore(
          makeDirectPostgresControlPlaneLayer(scoped.toString()),
        );
        const input = await createInput("valid");
        expect(await Effect.runPromise(Effect.flip(restricted.create(input)))).toBeInstanceOf(
          RewardWinnerSendStorageFailed,
        );
        expect(nonceReads()).toBe(0);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION lock_wallet_send_palm_assertions_v1(text,text) TO "${role}"`,
        );
        expect((await Effect.runPromise(restricted.create(input))).sendId).toBe(input.sendId);
        expect(
          (
            await runtime.query(
              "SELECT has_any_column_privilege(current_user,'assertions','UPDATE') AS allowed",
            )
          ).rows[0].allowed,
        ).toBe(false);
        await expect(
          runtime.query("SELECT assertion_id FROM assertions FOR UPDATE"),
        ).rejects.toMatchObject({ code: "42501" });
        expect(nonceReads()).toBe(1);
      } finally {
        await runtime?.end();
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
    });
  }, 120_000);
});
