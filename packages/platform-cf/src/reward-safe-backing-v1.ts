import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  RewardSafeSettlementFailedV1,
  type RewardSafeSignerV1,
  type RewardSafeUnsignedV1,
} from "@pirate/application/rewards/safe-settlement-v1";
import { Effect, type Layer } from "effect";
import {
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from "viem";
import { readMegapotFinalizedHead } from "./megapot-finality.ts";
import { isMegapotLocalForkClient } from "./megapot-local-fork.ts";
import { encodeMegapotUsdcTransfer, validateMegapotUsdcTransferReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { RewardRunAuthority } from "./reward-operations-control.ts";
import type { makeLocalRewardSafeCoordinatorV1 } from "./reward-safe-coordinator-v1.ts";
import {
  makeControlPlaneRewardSafeStoreV1,
  safeSettlementJsonV1,
} from "./reward-safe-repository-v1.ts";

type Backing = Readonly<{
  state: "signing" | "signed" | "broadcast_unknown" | "submitted" | "confirmed" | "held";
  amount_atomic: string;
  unsigned_transaction: RewardSafeUnsignedV1;
  raw_transaction: string | null;
  transaction_hash: string | null;
}>;
const fail = () => new RewardSafeSettlementFailedV1({ reason: "conflict" });
const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: () => new RewardSafeSettlementFailedV1({ reason: "unavailable", stage: "backing-rpc" }),
  });

/** One immutable LOCAL backing intent per policy. It is an EOA-to-Safe funding
 * transfer, distinct from the module's Safe-to-original-wallet settlement. */
export function makeLocalRewardSafeBackingV1(input: {
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  rpc: MegapotV2RpcClient;
  signer: RewardSafeSignerV1;
  authority: RewardRunAuthority;
  localGasLimit: bigint;
  settlement: Pick<ReturnType<typeof makeLocalRewardSafeCoordinatorV1>, "observe">;
}) {
  const { rpc } = input;
  const store = makeControlPlaneRewardSafeStoreV1(input.layer);
  const use = <A, E>(body: (db: ControlPlaneDb["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* body(yield* ControlPlaneDb);
    }).pipe(
      Effect.provide(input.layer),
      Effect.mapError((e) =>
        e instanceof RewardSafeSettlementFailedV1
          ? e
          : new RewardSafeSettlementFailedV1({
              reason: "unavailable",
              stage:
                e instanceof ControlPlaneStatementFailed
                  ? `${e.label}:${e.sqlState}`
                  : "backing-storage",
            }),
      ),
    );
  const transaction = <A, E>(body: (tx: ControlPlaneTransaction) => Effect.Effect<A, E>) =>
    use((db) => db.withTransaction(body));
  const find = (policyId: string) =>
    use((db) =>
      Effect.gen(function* () {
        const r = yield* db.execute<Backing>({
          label: "reward-safe-backing-v1.read",
          text: "SELECT state,amount_atomic::text,unsigned_transaction,raw_transaction,transaction_hash FROM reward_safe_backing_v1 WHERE policy_id=$1",
          values: [policyId],
          readonly: true,
        });
        return r.rows[0] ?? null;
      }),
    );
  const transition = (
    policyId: string,
    from: Backing["state"],
    to: Backing["state"],
    raw: string | null = null,
    hash: string | null = null,
    evidence: unknown = null,
  ) =>
    transaction((tx) =>
      Effect.gen(function* () {
        if (to === "broadcast_unknown")
          yield* tx.execute({
            label: "reward-safe-backing-v1.authority",
            text: "SELECT require_reward_run_authority_v1()",
            values: [],
            readonly: false,
          });
        const r = yield* tx.execute({
          label: "reward-safe-backing-v1.transition",
          text: `UPDATE reward_safe_backing_v1 SET state=$3,raw_transaction=COALESCE(raw_transaction,$4),transaction_hash=COALESCE(transaction_hash,$5),evidence=$6::jsonb,updated_at=clock_timestamp() WHERE policy_id=$1 AND state=$2`,
          values: [
            policyId,
            from,
            to,
            raw,
            hash,
            evidence === null ? null : safeSettlementJsonV1(evidence),
          ],
          readonly: false,
        });
        if (r.rowCount !== 1) return yield* fail();
      }),
    );
  const validate = (
    row: Backing,
    policy: { collectionRoot: string; token: string; safeRoot: string },
    signed: { rawTransaction: string; transactionHash: string },
  ) =>
    io(async () => {
      const u = row.unsigned_transaction;
      const parsed = parseTransaction(signed.rawTransaction as Hex);
      if (
        u.chainId !== 8453 ||
        u.signerAddress !== policy.collectionRoot ||
        u.targetAddress !== policy.token ||
        u.data !== encodeMegapotUsdcTransfer(policy.safeRoot, BigInt(row.amount_atomic)) ||
        u.valueWei !== "0" ||
        !signed.rawTransaction.startsWith("0x02") ||
        keccak256(signed.rawTransaction as Hex) !== signed.transactionHash ||
        (
          await recoverTransactionAddress({
            serializedTransaction: signed.rawTransaction as TransactionSerializedEIP1559,
          })
        ).toLowerCase() !== u.signerAddress ||
        parsed.type !== "eip1559" ||
        parsed.chainId !== 8453 ||
        parsed.to?.toLowerCase() !== u.targetAddress ||
        parsed.data !== u.data ||
        (parsed.value ?? 0n) !== 0n ||
        BigInt(parsed.nonce ?? -1) !== BigInt(u.nonce) ||
        parsed.gas !== BigInt(u.gas) ||
        parsed.maxFeePerGas !== BigInt(u.maxFeePerGas) ||
        parsed.maxPriorityFeePerGas !== BigInt(u.maxPriorityFeePerGas)
      )
        throw fail();
    });
  const fund = Effect.fn("reward-safe-backing-v1.fund")(function* (
    policyId: string,
    amountAtomic: bigint,
  ) {
    if (!isMegapotLocalForkClient(rpc) || input.localGasLimit <= 0n)
      return yield* new RewardSafeSettlementFailedV1({ reason: "production-disabled" });
    const policy = yield* store.policy(policyId);
    if (
      rpc.deployment?.attestationId !== policy.attestationId ||
      rpc.deployment.chainId !== 8453 ||
      rpc.deployment.custodyAddress !== policy.collectionRoot ||
      rpc.deployment.usdcAddress !== policy.token ||
      policy.collectionRoot !== policy.relayer ||
      amountAtomic <= 0n ||
      amountAtomic > policy.aggregateCapAtomic
    )
      return yield* fail();
    let row = yield* find(policyId);
    let fresh = false;
    if (row === null) {
      const backing = yield* input.settlement.observe(policyId);
      const protectedCollection =
        backing.reservedPurchaseAtomic +
        backing.pendingRefundAtomic +
        backing.sharedSponsorshipAtomic;
      if (
        !backing.solvent ||
        backing.collectionBalanceAtomic < protectedCollection + amountAtomic ||
        amountAtomic > backing.outstandingCreditAtomic ||
        backing.safeBalanceAtomic !== 0n
      )
        return yield* fail();
      const [pending, fee] = yield* io(() =>
        Promise.all([rpc.readPendingNonce(policy.relayer), rpc.readFeeQuote()]),
      );
      yield* transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute({
            label: "reward-safe-backing-v1.authority",
            text: "SELECT require_reward_run_authority_v1()",
            values: [],
            readonly: false,
          });
          yield* tx.execute({
            label: "reward-safe-backing-v1.policy.lock",
            text: "SELECT policy_id FROM reward_safe_policies_v1 WHERE policy_id=$1 FOR UPDATE",
            values: [policyId],
            readonly: false,
          });
          const existing = yield* tx.execute({
            label: "reward-safe-backing-v1.existing",
            text: "SELECT policy_id FROM reward_safe_backing_v1 WHERE policy_id=$1",
            values: [policyId],
            readonly: true,
          });
          if (existing.rowCount !== 0) return yield* fail();
          yield* tx.execute({
            label: "reward-safe-backing-v1.nonce.initialize",
            text: `INSERT INTO reward_signer_nonces(chain_id,signer_address,next_nonce,observed_pending_nonce,observed_block_number,observed_block_hash,observed_at) VALUES(8453,$1,$2,$2,$3,$4,clock_timestamp()) ON CONFLICT DO NOTHING`,
            values: [
              policy.relayer,
              pending.toString(),
              fee.observedBlockNumber.toString(),
              fee.observedBlockHash,
            ],
            readonly: false,
          });
          const n = yield* tx.execute<{ next_nonce: string; observed_block_number: string }>({
            label: "reward-safe-backing-v1.nonce.lock",
            text: "SELECT next_nonce::text,observed_block_number::text FROM reward_signer_nonces WHERE chain_id=8453 AND signer_address=$1 FOR UPDATE",
            values: [policy.relayer],
            readonly: false,
          });
          const next = n.rows[0];
          if (next === undefined || BigInt(next.observed_block_number) > fee.observedBlockNumber)
            return yield* fail();
          const nonce = BigInt(next.next_nonce) > pending ? BigInt(next.next_nonce) : pending;
          yield* tx.execute({
            label: "reward-safe-backing-v1.nonce.reserve",
            text: `UPDATE reward_signer_nonces SET next_nonce=$2,observed_pending_nonce=$3,observed_block_number=$4,observed_block_hash=$5,observed_at=GREATEST(observed_at,clock_timestamp()),fence_version=fence_version+1,updated_at=clock_timestamp() WHERE chain_id=8453 AND signer_address=$1`,
            values: [
              policy.relayer,
              (nonce + 1n).toString(),
              pending.toString(),
              fee.observedBlockNumber.toString(),
              fee.observedBlockHash,
            ],
            readonly: false,
          });
          const unsigned: RewardSafeUnsignedV1 = {
            chainId: 8453,
            signerAddress: policy.relayer,
            targetAddress: policy.token,
            data: encodeMegapotUsdcTransfer(policy.safeRoot, amountAtomic),
            nonce: nonce.toString(),
            valueWei: "0",
            gas: input.localGasLimit.toString(),
            maxFeePerGas: fee.maxFeePerGas.toString(),
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString(),
          };
          yield* tx.execute({
            label: "reward-safe-backing-v1.prepare",
            text: "INSERT INTO reward_safe_backing_v1(policy_id,amount_atomic,state,unsigned_transaction) VALUES($1,$2,'signing',$3::jsonb)",
            values: [policyId, amountAtomic.toString(), safeSettlementJsonV1(unsigned)],
            readonly: false,
          });
        }),
      );
      row = yield* find(policyId);
      fresh = true;
    }
    if (row === null || BigInt(row.amount_atomic) !== amountAtomic) return yield* fail();
    if (row.state === "confirmed" || row.state === "held") return row;
    const signerKey = `safe-backing-v1:${policyId}`;
    if (row.state === "signing") {
      yield* input.authority
        .ensure()
        .pipe(Effect.mapError(() => new RewardSafeSettlementFailedV1({ reason: "authority" })));
      const signed = yield* fresh
        ? input.signer.sign(signerKey, row.unsigned_transaction)
        : input.signer.lookup(signerKey);
      if (signed === null) return row;
      yield* validate(row, policy, signed);
      yield* transition(
        policyId,
        "signing",
        "signed",
        signed.rawTransaction,
        signed.transactionHash,
      );
      row = yield* find(policyId);
    }
    if (row === null || row.raw_transaction === null || row.transaction_hash === null)
      return yield* fail();
    yield* validate(row, policy, {
      rawTransaction: row.raw_transaction,
      transactionHash: row.transaction_hash,
    });
    if (row.state === "signed") {
      const backing = yield* input.settlement.observe(policyId);
      if (
        !backing.solvent ||
        backing.collectionBalanceAtomic <
          backing.reservedPurchaseAtomic +
            backing.pendingRefundAtomic +
            backing.sharedSponsorshipAtomic +
            amountAtomic
      )
        return yield* fail();
      yield* input.authority
        .ensure()
        .pipe(Effect.mapError(() => new RewardSafeSettlementFailedV1({ reason: "authority" })));
      yield* transition(policyId, "signed", "broadcast_unknown");
      const hash = yield* io(() => rpc.sendRawTransaction(row!.raw_transaction as Hex)).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (hash === null) return (yield* find(policyId))!;
      if (hash !== row.transaction_hash) return yield* fail();
      yield* transition(policyId, "broadcast_unknown", "submitted");
      row = (yield* find(policyId))!;
    }
    const receipt = yield* io(() => rpc.readReceipt(row!.transaction_hash!));
    if (receipt === null) return row;
    const block = yield* io(() => readMegapotFinalizedHead(rpc));
    if (receipt.blockNumber > block.blockNumber) return row;
    const canonical = yield* io(() => rpc.readBlock(receipt.blockNumber));
    if (canonical.blockHash !== receipt.blockHash) return yield* fail();
    const tx = yield* io(async () => {
      if (rpc.readTransaction === undefined) throw fail();
      return rpc.readTransaction(row!.transaction_hash!);
    });
    if (
      tx === null ||
      tx.chainId !== 8453 ||
      tx.from !== policy.collectionRoot ||
      tx.to !== policy.token ||
      tx.nonce !== BigInt(row.unsigned_transaction.nonce) ||
      tx.input !== row.unsigned_transaction.data ||
      tx.valueWei !== 0n ||
      tx.blockNumber !== receipt.blockNumber ||
      receipt.transactionHash !== row.transaction_hash ||
      receipt.from !== policy.collectionRoot ||
      receipt.to !== policy.token
    )
      return yield* fail();
    yield* io(() => rpc.attestDeployment());
    const evidence =
      receipt.status === "success"
        ? yield* Effect.try({
            try: () =>
              validateMegapotUsdcTransferReceipt({
                receipt,
                deployment: rpc.deployment!,
                recipient: policy.safeRoot,
                amountAtomic,
              }),
            catch: fail,
          })
        : { reverted: true };
    const reread = yield* io(() => rpc.readBlock(receipt.blockNumber));
    if (reread.blockHash !== receipt.blockHash) return yield* fail();
    yield* transition(
      policyId,
      row.state,
      receipt.status === "success" ? "confirmed" : "held",
      null,
      null,
      {
        ...evidence,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: row.transaction_hash,
      },
    );
    return (yield* find(policyId))!;
  });
  return { fund, find };
}
