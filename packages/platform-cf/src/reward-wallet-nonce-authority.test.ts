import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Cause, Effect, Exit } from "effect";
import {
  loadRewardFundingWalletNonceOwnerIn,
  type RewardFundingNonceReservation,
  reserveRewardFundingWalletNonceIn,
  reserveRewardWinnerWalletNonceIn,
} from "./reward-wallet-nonce-authority.ts";
import { makeControlPlaneRewardWinnerSendRepository } from "./reward-winner-send-repository.ts";

const sender = `0x${"ab".repeat(20)}`;
const owner = {
  leaseId: "nonce_lease",
  ownerId: "contribution",
  commandId: "command",
  accountId: "nonce_test_account_123",
  personaId: "persona",
  walletAssignmentId: "wallet",
  chainId: 84532,
  senderAddress: sender,
  requestHash: "a".repeat(64),
};
const reservation: RewardFundingNonceReservation = {
  owner,
  nonce: 4n,
  nowMs: 1000,
  policy: { hash: "b".repeat(64), maxAgeMs: 50 }, // Test-only policy, no runtime default.
  witness: {
    id: "c".repeat(64),
    chainId: owner.chainId,
    senderAddress: sender,
    observedAtMs: 990,
    confirmed: { nonce: 4n, blockNumber: 20n, blockHash: "d".repeat(64) },
    pending: { nonce: 4n, baseBlockNumber: 20n, baseBlockHash: "d".repeat(64) },
  },
};
const lease = {
  lease_id: owner.leaseId,
  owner_id: owner.ownerId,
  command_id: owner.commandId,
  account_id: owner.accountId,
  persona_id: owner.personaId,
  wallet_assignment_id: owner.walletAssignmentId,
  chain_id: String(owner.chainId),
  sender_address: sender,
  request_hash: owner.requestHash,
  nonce: "4",
};

/** Scripted accepted-port responses, not a second allocator/database simulator.
 * The actual SQL/unique/trigger/concurrency proofs live in the UNRUN PG source.
 */
function fixture(
  options: {
    head?: { highest_nonce: string | null; blocked_reason: string | null };
    leaseRows?: readonly unknown[];
    failure?: ControlPlaneError;
    failureAt?: "history.read" | "funding.reserve";
  } = {},
) {
  const queries: ControlPlaneStatement[] = [];
  const transaction: ControlPlaneTransaction = {
    execute: <Row>(statement: ControlPlaneStatement) => {
      queries.push(statement);
      if (statement.label.endsWith(options.failureAt ?? "funding.reserve") && options.failure)
        return Effect.fail(options.failure);
      const rows = statement.label.endsWith("history.read")
        ? [options.head ?? { highest_nonce: "3", blocked_reason: null }]
        : statement.label.endsWith("funding.reserve") ||
            statement.label.endsWith("funding-owner.read")
          ? (options.leaseRows ?? [lease])
          : [];
      return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
    },
  };
  return { transaction, queries };
}
function errors<E>(exit: Exit.Exit<unknown, E>) {
  return Exit.isFailure(exit)
    ? exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)
    : [];
}
const reserve = (input = reservation, options: Parameters<typeof fixture>[0] = {}) => {
  const f = fixture(options);
  return Effect.runPromiseExit(reserveRewardFundingWalletNonceIn(f.transaction, input)).then(
    (exit) => ({ ...f, exit }),
  );
};

describe("shared EOA nonce authority (offline)", () => {
  test("new funding uses the shared lock, exact history and one guarded SQL allocation", async () => {
    const { exit, queries } = await reserve();
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit))
      expect(exit.value).toEqual({ owner, nonce: 4n, authority: "nonce_ownership_only" });
    expect(queries.map((q) => q.label)).toEqual([
      "reward-wallet-nonce.sender.lock",
      "reward-wallet-nonce.history.read",
      "reward-wallet-nonce.funding.reserve",
    ]);
    expect(queries[0]?.values).toEqual([owner.chainId, sender]);
    const packet = JSON.parse(String(queries[2]?.values[0]));
    expect(packet).toMatchObject({
      nonce: "4",
      confirmed_nonce: "4",
      pending_nonce: "4",
      owner_id: owner.ownerId,
      command_id: owner.commandId,
      account_id: owner.accountId,
      request_hash: owner.requestHash,
      freshness_policy_hash: "b".repeat(64),
      max_age_ms: 50,
    });
    expect(queries.every((q) => !q.text.includes(owner.accountId))).toBe(true);
  });

  test("required unselected policy is unavailable before any DB work", async () => {
    const { exit, queries } = await reserve({ ...reservation, policy: null });
    expect(errors(exit)).toMatchObject([{ code: "policy_unavailable" }]);
    expect(queries).toHaveLength(0);
  });

  test("negative, overflowing, non-bigint and skip-ahead requested nonces refuse before SQL", async () => {
    for (const nonce of [-1n, 9223372036854775808n, "4", 5n]) {
      const { exit, queries } = await reserve({
        ...reservation,
        nonce,
      } as RewardFundingNonceReservation);
      expect(errors(exit)).toMatchObject([
        { code: nonce === 5n ? "witness_incoherent" : "invalid_input" },
      ]);
      expect(queries).toHaveLength(0);
    }
  });

  test("coherence requires exact chain/sender, both nonce values and one anchored block", async () => {
    const w = reservation.witness;
    for (const witness of [
      { ...w, chainId: 1 },
      { ...w, senderAddress: `0x${"cd".repeat(20)}` },
      { ...w, confirmed: { ...w.confirmed, nonce: 3n } },
      { ...w, pending: { ...w.pending, nonce: 5n } },
      { ...w, pending: { ...w.pending, baseBlockNumber: 21n } },
      { ...w, pending: { ...w.pending, baseBlockHash: "e".repeat(64) } },
    ]) {
      const { exit, queries } = await reserve({ ...reservation, witness });
      expect(errors(exit)).toMatchObject([{ code: "witness_incoherent" }]);
      expect(queries).toHaveLength(0);
    }
  });

  test("future and stale observations refuse; exact policy age is inclusive", async () => {
    for (const observedAtMs of [1001, 949]) {
      const { exit, queries } = await reserve({
        ...reservation,
        witness: { ...reservation.witness, observedAtMs },
      });
      expect(errors(exit)).toMatchObject([{ code: "witness_stale" }]);
      expect(queries).toHaveLength(0);
    }
    expect(
      Exit.isSuccess(
        (await reserve({ ...reservation, witness: { ...reservation.witness, observedAtMs: 950 } }))
          .exit,
      ),
    ).toBe(true);
  });

  test("closed input refuses extra fields, invalid identity and unavailable/invalid freshness values", async () => {
    for (const input of [
      { ...reservation, purpose: "nonce_cancellation" },
      { ...reservation, owner: { ...owner, source: "winner_attempt_v1" } },
      { ...reservation, owner: { ...owner, senderAddress: sender.toUpperCase() } },
      { ...reservation, policy: { hash: "b".repeat(64), maxAgeMs: 0 } },
      { ...reservation, nowMs: Number.NaN },
      { ...reservation, witness: { ...reservation.witness, observedAtMs: -1 } },
    ]) {
      const { exit, queries } = await reserve(input as RewardFundingNonceReservation);
      expect(errors(exit)).toMatchObject([{ code: "invalid_input" }]);
      expect(queries).toHaveLength(0);
    }
  });

  test("unknown V1 funding, other open instructions and unconsumed ownership all remain busy", async () => {
    for (const blocked_reason of ["unknown_v1_funding", "other_instruction", "outstanding_nonce"]) {
      const { exit, queries } = await reserve(reservation, {
        head: { highest_nonce: "3", blocked_reason },
      });
      expect(errors(exit)).toMatchObject([{ code: "wallet_nonce_busy" }]);
      expect(queries).toHaveLength(2);
    }
  });

  test("known consumed history is still never reused, even by the same account", async () => {
    for (const highest_nonce of ["4", "5", "9223372036854775807"]) {
      const { exit, queries } = await reserve(reservation, {
        head: { highest_nonce, blocked_reason: null },
      });
      expect(errors(exit)).toMatchObject([{ code: "nonce_not_consumed" }]);
      expect(queries).toHaveLength(2);
    }
  });

  test("the exact BIGINT representation boundary is usable without a new economic cap", async () => {
    const nonce = 9223372036854775807n;
    const i = {
      ...reservation,
      nonce,
      witness: {
        ...reservation.witness,
        confirmed: { ...reservation.witness.confirmed, nonce },
        pending: { ...reservation.witness.pending, nonce },
      },
    };
    const { exit } = await reserve(i, {
      head: { highest_nonce: String(nonce - 1n), blocked_reason: null },
      leaseRows: [{ ...lease, nonce: String(nonce) }],
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.nonce).toBe(nonce);
  });

  test("unknown or malformed history never becomes an empty sender or a reader/allocation retry", async () => {
    const failure = new ControlPlaneStatementFailed({
      label: "history",
      sqlState: null,
      constraint: null,
      outcomeCertainty: "unknown",
    });
    const { exit, queries } = await reserve(reservation, { failure, failureAt: "history.read" });
    expect(errors(exit)[0]).toBe(failure);
    expect(queries).toHaveLength(2);
    for (const highest_nonce of ["invalid", "-1", "9223372036854775808"]) {
      const result = await reserve(reservation, { head: { highest_nonce, blocked_reason: null } });
      expect(errors(result.exit)).toMatchObject([{ code: "invalid_row" }]);
      expect(result.queries).toHaveLength(2);
    }
    let reads = 0;
    const f = fixture({ failure, failureAt: "history.read" });
    const winner = await Effect.runPromiseExit(
      reserveRewardWinnerWalletNonceIn(f.transaction, {
        chainId: owner.chainId,
        senderAddress: sender,
        readNonce: Effect.sync(() => {
          reads++;
          return 4n;
        }),
      }),
    );
    expect(errors(winner)[0]).toBe(failure);
    expect(reads).toBe(0);
    expect(f.queries).toHaveLength(2);
  });

  test("a lock wait becoming stale or concurrent conflict is a typed refusal, never an allocation retry", async () => {
    for (const [sqlState, code] of [
      ["PWN01", "foreign_owner"],
      ["PWN02", "wallet_nonce_busy"],
      ["PWN03", "nonce_not_consumed"],
      ["PWN04", "witness_stale"],
    ] as const) {
      const failure = new ControlPlaneStatementFailed({
        label: "nonce",
        sqlState,
        constraint: null,
        outcomeCertainty: "completed",
      });
      const { exit, queries } = await reserve(reservation, { failure });
      expect(errors(exit)).toMatchObject([{ code }]);
      expect(queries.filter((q) => q.label.endsWith("funding.reserve"))).toHaveLength(1);
    }
  });

  test("unknown commit, read/error uncertainty and duplicate provenance are not misses or retries", async () => {
    for (const failure of [
      new ControlPlaneTransactionOutcomeUnknown({
        phase: "commit",
        label: "commit",
        limitMs: 1,
        elapsedMs: 1,
      }),
      new ControlPlaneStatementFailed({
        label: "nonce",
        sqlState: null,
        constraint: null,
        outcomeCertainty: "unknown",
      }),
      new ControlPlaneStatementFailed({
        label: "nonce",
        sqlState: "23505",
        constraint: "unique_nonce",
        outcomeCertainty: "completed",
      }),
    ]) {
      const { exit, queries } = await reserve(reservation, { failure });
      expect(errors(exit)[0]).toBe(failure);
      expect(queries.filter((q) => q.label.endsWith("funding.reserve"))).toHaveLength(1);
    }
  });

  test("unexpected returned identity, nonce or missing row cannot become an owned lease", async () => {
    for (const leaseRows of [
      [],
      [{ ...lease, account_id: "other" }],
      [{ ...lease, nonce: "5" }],
      [{ ...lease, nonce: "-1" }],
    ]) {
      const { exit } = await reserve(reservation, { leaseRows });
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("original owner lookup is read-only with no fresh witness, nonce allocation or submission grant", async () => {
    const f = fixture();
    const result = await Effect.runPromise(
      loadRewardFundingWalletNonceOwnerIn(f.transaction, owner),
    );
    expect(result).toEqual({ owner, nonce: 4n, authority: "nonce_ownership_only" });
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]?.readonly).toBe(true);
    expect(JSON.parse(String(f.queries[0]?.values[0]))).toMatchObject({
      account_id: owner.accountId,
      request_hash: owner.requestHash,
    });
    expect(result).not.toHaveProperty("grant_id");
    expect(result).not.toHaveProperty("fresh_grant");
    expect(
      await Effect.runPromise(
        loadRewardFundingWalletNonceOwnerIn(fixture({ leaseRows: [] }).transaction, owner),
      ),
    ).toBeNull();
    const foreign = await Effect.runPromiseExit(
      loadRewardFundingWalletNonceOwnerIn(
        fixture({ leaseRows: [{ ...lease, account_id: "foreign" }] }).transaction,
        owner,
      ),
    );
    expect(errors(foreign)).toMatchObject([{ code: "foreign_owner" }]);
  });

  test("winner preserves bigint-only semantics and reads once only after shared lock/history", async () => {
    const f = fixture();
    let reads = 0;
    const nonce = await Effect.runPromise(
      reserveRewardWinnerWalletNonceIn(f.transaction, {
        chainId: owner.chainId,
        senderAddress: sender,
        readNonce: Effect.sync(() => {
          reads++;
          expect(f.queries).toHaveLength(2);
          return 9n;
        }),
      }),
    );
    expect(nonce).toBe(9n); // Original API may advance above history; it is NOT V2 coherent proof.
    expect(reads).toBe(1);
    expect(f.queries.map((q) => q.label)).toEqual([
      "reward-wallet-nonce.sender.lock",
      "reward-wallet-nonce.history.read",
    ]);
    for (const n of [-1n, 3n, 9223372036854775808n]) {
      const exit = await Effect.runPromiseExit(
        reserveRewardWinnerWalletNonceIn(fixture().transaction, {
          chainId: owner.chainId,
          senderAddress: sender,
          readNonce: Effect.succeed(n),
        }),
      );
      expect(errors(exit)).toMatchObject([{ reason: "nonce-not-consumed" }]);
    }
  });

  test("winner refuses outstanding shared operations without invoking its reader", async () => {
    for (const blocked_reason of ["unknown_v1_funding", "other_instruction", "outstanding_nonce"]) {
      let reads = 0;
      const f = fixture({ head: { highest_nonce: "3", blocked_reason } });
      const exit = await Effect.runPromiseExit(
        reserveRewardWinnerWalletNonceIn(f.transaction, {
          chainId: owner.chainId,
          senderAddress: sender,
          readNonce: Effect.sync(() => {
            reads++;
            return 4n;
          }),
        }),
      );
      expect(errors(exit)).toMatchObject([{ reason: "sender-busy" }]);
      expect(reads).toBe(0);
    }
  });

  test("accepted winner create actually delegates before original guarded record/attempt writes", async () => {
    const calls: ControlPlaneStatement[] = [];
    const tx: ControlPlaneTransaction = {
      execute: <Row>(q: ControlPlaneStatement) => {
        calls.push(q);
        const rows: readonly unknown[] = q.label.endsWith("history.read")
          ? [{ highest_nonce: "3", blocked_reason: null }]
          : q.label === "reward-winner-send.record.read"
            ? [
                {
                  send_id: "send",
                  credit_id: "credit",
                  account_id: owner.accountId,
                  status: "retryable",
                  chain_id: owner.chainId,
                  sender_address: sender,
                  token_address: `0x${"cd".repeat(20)}`,
                  attempt: 1,
                  recipient_address: `0x${"ef".repeat(20)}`,
                  amount_atomic: "10",
                  nonce: "4",
                  transaction_hashes: "",
                  cancellation_hashes: "",
                },
              ]
            : [];
        return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
      },
    };
    let transactions = 0;
    const db: ControlPlaneDb["Service"] = {
      execute: tx.execute,
      withTransaction: (use) => {
        transactions++;
        return use(tx);
      },
    };
    const result = await Effect.runPromise(
      makeControlPlaneRewardWinnerSendRepository()
        .create({
          context: {
            creditId: "credit",
            accountId: owner.accountId,
            personaId: owner.personaId,
            walletAssignmentId: owner.walletAssignmentId,
            senderAddress: sender,
            tokenAddress: `0x${"cd".repeat(20)}`,
            chainId: owner.chainId,
            paidAtomic: 10n,
          },
          sendId: "send",
          idempotencyKey: "key",
          recipientAddress: `0x${"ef".repeat(20)}`,
          amountAtomic: 10n,
          readNonce: Effect.succeed(4n),
        })
        .pipe(Effect.provideService(ControlPlaneDb, db)),
    );
    expect(result.nonce).toBe(4n);
    expect(transactions).toBe(1);
    expect(calls.map((q) => q.label)).toEqual([
      "reward-wallet-nonce.sender.lock",
      "reward-wallet-nonce.history.read",
      "reward-winner-send.create",
      "reward-winner-send.attempt.create",
      "reward-winner-send.record.read",
    ]);
    expect(calls[3]?.values.at(-1)).toBe("4");
    expect(calls.some((q) => q.label === "reward-wallet-nonce.funding.reserve")).toBe(false);
  });
});
