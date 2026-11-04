import {
  type IndependentRewardCreditIssuerV1,
  type RewardSafePolicyV1,
  type RewardSafeRecordV1,
  RewardSafeSettlementFailedV1,
  type RewardSafeSettlementStoreV1,
  type RewardSafeSignerV1,
} from "@pirate/application/rewards/safe-settlement-v1";
import { Effect } from "effect";
import {
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  sha256,
  type TransactionSerializedEIP1559,
  toBytes,
} from "viem";
import { readMegapotFinalizedHead } from "./megapot-finality.ts";
import { isMegapotLocalForkClient, readMegapotLocalSafeIdentity } from "./megapot-local-fork.ts";
import { type MegapotV2RpcClient, MegapotV2RpcFailed } from "./megapot-v2-rpc.ts";
import type { RewardRunAuthority } from "./reward-operations-control.ts";
import {
  encodeRewardSafeSettlementV1,
  rewardSafeCreditDigestV1,
  validateRewardSafeReceiptV1,
  verifyRewardSafeAuthorizationV1,
} from "./reward-safe-credit-v1.ts";
import { safeSettlementJsonV1 } from "./reward-safe-repository-v1.ts";

const fail = (reason: RewardSafeSettlementFailedV1["reason"] = "invalid") =>
  new RewardSafeSettlementFailedV1({ reason });
const io = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: (error) =>
      error instanceof RewardSafeSettlementFailedV1
        ? error
        : new RewardSafeSettlementFailedV1({
            reason: "unavailable",
            stage: error instanceof MegapotV2RpcFailed ? `rpc:${error.reason}` : "adapter",
          }),
  });
const safeCreditFromRecordV1 = (r: RewardSafeRecordV1) => ({
  creditId: keccak256(toBytes(r.candidate.creditId)),
  safeRoot: r.policy.safeRoot as Hex,
  token: r.policy.token as Hex,
  module: r.policy.module as Hex,
  recipient: r.candidate.recipient as Hex,
  amount: r.candidate.amountAtomic,
  validUntil: r.authorization.validUntil,
});

/** No operational factory. A registered pinned loopback capability is mandatory. */
export function makeLocalRewardSafeCoordinatorV1(input: {
  rpc: MegapotV2RpcClient;
  store: RewardSafeSettlementStoreV1;
  issuer: IndependentRewardCreditIssuerV1;
  signer: RewardSafeSignerV1;
  authority: RewardRunAuthority;
  localGasLimit: bigint;
}) {
  const { rpc, store } = input;
  const local = () =>
    Effect.gen(function* () {
      if (!isMegapotLocalForkClient(rpc) || input.localGasLimit <= 0n)
        return yield* fail("production-disabled");
    });
  const identity = (p: RewardSafePolicyV1, block: bigint, requireEnabled = true) =>
    io(async () => {
      if (
        p.posture !== "local_only" ||
        rpc.deployment?.chainId !== 8453 ||
        rpc.deployment.attestationId !== p.attestationId ||
        rpc.deployment.custodyAddress !== p.collectionRoot ||
        rpc.deployment.usdcAddress !== p.token
      )
        throw fail();
      await rpc.attestDeployment();
      const found = await readMegapotLocalSafeIdentity(rpc, {
        safe: p.safeRoot,
        module: p.module,
        block,
        singleton: p.safeSingleton,
      });
      if (
        keccak256(found.safeCode as Hex) !== p.safeCodeHash ||
        keccak256(found.moduleCode as Hex) !== p.moduleCodeHash ||
        keccak256(found.singletonCode as Hex) !== p.safeSingletonCodeHash ||
        BigInt(found.singletonSlot) !== BigInt(p.safeSingleton) ||
        (requireEnabled && BigInt(found.enabled) !== 1n) ||
        found.configuration.map((value) => BigInt(value).toString()).join(":") !==
          [BigInt(p.safeRoot), BigInt(p.token), BigInt(p.creditAuthority), p.aggregateCapAtomic]
            .map(String)
            .join(":")
      )
        throw fail();
      const canonical = await rpc.readBlock(block);
      return canonical;
    });
  const authorized = (r: RewardSafeRecordV1) =>
    io(async () => {
      const credit = safeCreditFromRecordV1(r);
      if (
        rewardSafeCreditDigestV1(credit) !== r.authorization.digest ||
        !r.authorization.issuerKeyId
      )
        throw fail();
      await verifyRewardSafeAuthorizationV1(
        credit,
        r.authorization.signature as Hex,
        r.policy.creditAuthority,
      );
      return credit;
    });
  const validateSigned = (
    r: RewardSafeRecordV1,
    signed: { rawTransaction: string; transactionHash: string },
  ) =>
    io(async () => {
      const u = r.unsigned;
      if (
        u === null ||
        !signed.rawTransaction.startsWith("0x02") ||
        keccak256(signed.rawTransaction as Hex) !== signed.transactionHash
      )
        throw fail();
      if (
        u.chainId !== 8453 ||
        u.signerAddress !== r.policy.relayer ||
        u.targetAddress !== r.policy.module ||
        u.valueWei !== "0" ||
        u.data !==
          encodeRewardSafeSettlementV1(safeCreditFromRecordV1(r), r.authorization.signature as Hex)
      )
        throw fail();
      const t = parseTransaction(signed.rawTransaction as Hex);
      const from = await recoverTransactionAddress({
        serializedTransaction: signed.rawTransaction as TransactionSerializedEIP1559,
      });
      if (
        t.type !== "eip1559" ||
        t.chainId !== 8453 ||
        t.to?.toLowerCase() !== u.targetAddress ||
        from.toLowerCase() !== u.signerAddress ||
        BigInt(t.nonce ?? -1) !== BigInt(u.nonce) ||
        (t.value ?? 0n) !== 0n ||
        t.data !== u.data ||
        t.gas !== BigInt(u.gas) ||
        t.maxFeePerGas !== BigInt(u.maxFeePerGas) ||
        t.maxPriorityFeePerGas !== BigInt(u.maxPriorityFeePerGas)
      )
        throw fail();
    });
  const observe = Effect.fn("reward-safe-v1.solvency")(function* (policyId: string) {
    yield* local();
    const p = yield* store.policy(policyId);
    const block = yield* io(() => readMegapotFinalizedHead(rpc));
    yield* identity(p, block.blockNumber);
    const balances = yield* io(() =>
      Promise.all([
        rpc.readUsdcBalance(p.collectionRoot, block.blockNumber),
        rpc.readUsdcBalance(p.safeRoot, block.blockNumber),
      ]),
    );
    const canonical = yield* io(() => rpc.readBlock(block.blockNumber));
    if (canonical.blockHash !== block.blockHash) return yield* fail();
    return yield* store.recordSolvency({
      policyId,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      collectionBalanceAtomic: balances[0],
      safeBalanceAtomic: balances[1],
    });
  });
  const reconcile = Effect.fn("reward-safe-v1.reconcile")(function* (creditId: string) {
    yield* local();
    let r = yield* store.find(creditId);
    if (r === null) return yield* fail();
    if (r.state === "confirmed" || r.state === "held") return r;
    const validatedCredit = yield* authorized(r);
    if (r.state === "authorized") {
      const head = yield* io(() => rpc.readHead());
      yield* identity(r.policy, head.blockNumber);
      if (head.blockTimestamp === undefined || head.blockTimestamp >= r.authorization.validUntil)
        return yield* fail();
      const [pending, fee] = yield* io(() =>
        Promise.all([rpc.readPendingNonce(r!.policy.relayer), rpc.readFeeQuote()]),
      );
      const prepared = yield* store.prepare(
        creditId,
        {
          chainId: 8453,
          signerAddress: r.policy.relayer,
          targetAddress: r.policy.module,
          nonce: pending.toString(),
          data: encodeRewardSafeSettlementV1(validatedCredit, r.authorization.signature as Hex),
          valueWei: "0",
          gas: input.localGasLimit.toString(),
          maxFeePerGas: fee.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString(),
        },
        fee.observedBlockNumber,
        fee.observedBlockHash,
        crypto.randomUUID(),
      );
      r=prepared.record;
      if (prepared.ownership==="acquired" && r.state === "signing" && r.unsigned !== null) {
        yield* input.authority.ensure().pipe(Effect.mapError(() => fail("authority")));
        const signed = yield* input.signer.sign(r.authorization.digest, r.unsigned);
        yield* validateSigned(r, signed);
        r = yield* store.signed(creditId, signed);
      }
    }
    if (r.state === "signing") {
      const signed = yield* input.signer.lookup(r.authorization.digest);
      if (signed === null) return r;
      yield* validateSigned(r, signed);
      r = yield* store.signed(creditId, signed);
    }
    if (r.signed === null || r.unsigned === null) return yield* fail();
    yield* validateSigned(r, r.signed);
    if (r.state === "signed") {
      const backing = yield* observe(r.policy.policyId);
      if (!backing.solvent) return yield* fail();
      const head = yield* io(() => rpc.readHead());
      yield* identity(r.policy, head.blockNumber);
      if (head.blockTimestamp === undefined || head.blockTimestamp >= r.authorization.validUntil)
        return yield* fail();
      yield* input.authority.ensure().pipe(Effect.mapError(() => fail("authority")));
      // Winning this CAS is the only authorization to invoke send. A crash or
      // lost acknowledgement leaves durable uncertainty; recovery never resends.
      r = yield* store.transition(creditId, "signed", "broadcast_unknown");
      const hash = yield* io(() => rpc.sendRawTransaction(r!.signed!.rawTransaction as Hex)).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (hash === null) return r;
      if (hash !== r.signed?.transactionHash) return yield* fail();
      r = yield* store.transition(creditId, "broadcast_unknown", "submitted");
    }
    if (r.state !== "submitted" && r.state !== "broadcast_unknown") return r;
    const receipt = yield* io(() => rpc.readReceipt(r!.signed!.transactionHash));
    if (receipt === null) return r;
    const finalized = yield* io(() => readMegapotFinalizedHead(rpc));
    if (finalized.blockNumber < receipt.blockNumber) return r;
    const canonical = yield* io(() => rpc.readBlock(receipt.blockNumber));
    if (canonical.blockHash !== receipt.blockHash) return yield* fail();
    const tx = yield* io(() => {
      if (rpc.readTransaction === undefined) throw fail();
      return rpc.readTransaction(r!.signed!.transactionHash);
    });
    if (
      tx === null ||
      tx.chainId !== 8453 ||
      tx.transactionHash !== r.signed?.transactionHash ||
      tx.from !== r.policy.relayer ||
      tx.to !== r.policy.module ||
      tx.nonce !== BigInt(r.unsigned!.nonce) ||
      tx.input !== r.unsigned!.data ||
      tx.valueWei !== 0n ||
      tx.blockNumber !== receipt.blockNumber
    )
      return yield* fail();
    yield* identity(r.policy, receipt.blockNumber, receipt.status === "success");
    if (receipt.status !== "success") return yield* store.transition(creditId, r.state, "held");
    yield* authorized(r);
    const evidence = yield* Effect.try({
      try: () =>
        validateRewardSafeReceiptV1({
          credit: validatedCredit,
          relayer: r!.policy.relayer,
          transactionHash: r!.signed!.transactionHash,
          receipt,
        }),
      catch: () => fail(),
    });
    const reread = yield* io(() => rpc.readBlock(receipt.blockNumber));
    if (reread.blockHash !== receipt.blockHash) return yield* fail();
    const receiptHash = awaitDigest(receipt);
    return yield* store.confirm(creditId, {
      ...evidence,
      transactionHash: r.signed!.transactionHash,
      receiptHash,
    });
  });
  const settle = Effect.fn("reward-safe-v1.settle")(function* (creditId: string, policyId: string) {
    yield* local();
    let r = yield* store.find(creditId);
    if (r !== null) {
      if (r.policy.policyId !== policyId) return yield* fail();
      return yield* reconcile(creditId);
    }
    const p = yield* store.policy(policyId);
    const head = yield* io(() => rpc.readHead());
    yield* identity(p, head.blockNumber);
    const candidate = yield* store.candidate(creditId, policyId);
    const backing = yield* observe(policyId);
    if (!backing.solvent) return yield* fail();
    yield* input.authority.ensure().pipe(Effect.mapError(() => fail("authority")));
    const authorization = yield* input.issuer.authorize(candidate, p);
    r = { candidate, policy: p, authorization, state: "authorized", unsigned: null, signed: null,preparationOwner:null };
    yield* authorized(r);
    if (head.blockTimestamp === undefined || authorization.validUntil <= head.blockTimestamp)
      return yield* fail();
    r = yield* store.reserve(candidate, p, authorization);
    return yield* reconcile(creditId);
  });
  return { settle, reconcile, observe };
}

function awaitDigest(receipt: unknown) {
  // Durable receipt identity uses SHA-256, matching the maintained ledger convention.
  return sha256(toBytes(safeSettlementJsonV1(receipt))).slice(2);
}
