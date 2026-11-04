import {
  decodeEventLog,
  encodeFunctionData,
  type Hex,
  hashTypedData,
  parseAbi,
  recoverTypedDataAddress,
} from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";

const rewardSafeModuleAbiV1 = parseAbi([
  "function settle(bytes32 creditId,address recipient,uint256 amountAtomic,uint256 validUntil,uint8 v,bytes32 r,bytes32 s)",
  "event CreditSettled(bytes32 indexed creditId,address indexed recipient,uint256 amountAtomic)",
]);
const rewardSafeCreditTypesV1 = {
  RewardCredit: [
    { name: "creditId", type: "bytes32" },
    { name: "safeRoot", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "validUntil", type: "uint256" },
  ],
} as const;

export type RewardSafeCreditV1 = Readonly<{
  creditId: Hex;
  safeRoot: Hex;
  token: Hex;
  recipient: Hex;
  amount: bigint;
  validUntil: bigint;
  module: Hex;
}>;

export function rewardSafeTypedDataV1(credit: RewardSafeCreditV1) {
  return {
    domain: {
      name: "Pirate Reward Credit",
      version: "1",
      chainId: 8453,
      verifyingContract: credit.module,
    },
    types: rewardSafeCreditTypesV1,
    primaryType: "RewardCredit" as const,
    message: {
      creditId: credit.creditId,
      safeRoot: credit.safeRoot,
      token: credit.token,
      recipient: credit.recipient,
      amount: credit.amount,
      validUntil: credit.validUntil,
    },
  };
}

export const rewardSafeCreditDigestV1 = (credit: RewardSafeCreditV1) =>
  hashTypedData(rewardSafeTypedDataV1(credit));

export async function verifyRewardSafeAuthorizationV1(
  credit: RewardSafeCreditV1,
  signature: Hex,
  authority: string,
) {
  if (!/^0x[0-9a-f]{130}$/i.test(signature) || credit.amount <= 0n)
    throw new Error("safe_credit_authorization_invalid");
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (
    s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
    (v !== 27 && v !== 28)
  )
    throw new Error("safe_credit_signature_noncanonical");
  const signer = await recoverTypedDataAddress({ ...rewardSafeTypedDataV1(credit), signature });
  if (signer.toLowerCase() !== authority.toLowerCase())
    throw new Error("safe_credit_authority_mismatch");
}

export function encodeRewardSafeSettlementV1(credit: RewardSafeCreditV1, signature: Hex) {
  return encodeFunctionData({
    abi: rewardSafeModuleAbiV1,
    functionName: "settle",
    args: [
      credit.creditId,
      credit.recipient,
      credit.amount,
      credit.validUntil,
      Number.parseInt(signature.slice(130, 132), 16),
      `0x${signature.slice(2, 66)}`,
      `0x${signature.slice(66, 130)}`,
    ],
  });
}

const transferAbi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

/** Outer relayer/module inclusion and inner Safe debit are distinct identities. */
export function validateRewardSafeReceiptV1(input: {
  credit: RewardSafeCreditV1;
  relayer: string;
  transactionHash: string;
  receipt: MegapotTransactionReceipt;
}) {
  const { receipt, credit } = input;
  if (
    receipt.chainId !== 8453 ||
    receipt.status !== "success" ||
    receipt.from.toLowerCase() !== input.relayer.toLowerCase() ||
    receipt.to?.toLowerCase() !== credit.module.toLowerCase() ||
    receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()
  )
    throw new Error("safe_settlement_outer_receipt_invalid");
  const moduleLogs: number[] = [];
  const transferLogs: number[] = [];
  for (const log of receipt.logs) {
    if (
      log.removed ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      log.blockNumber !== receipt.blockNumber
    )
      throw new Error("safe_settlement_log_identity_invalid");
    if (log.address.toLowerCase() === credit.module.toLowerCase()) {
      const event = decodeEventLog({
        abi: rewardSafeModuleAbiV1,
        eventName: "CreditSettled",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (
        event.args.creditId.toLowerCase() !== credit.creditId.toLowerCase() ||
        event.args.recipient.toLowerCase() !== credit.recipient.toLowerCase() ||
        event.args.amountAtomic !== credit.amount
      )
        throw new Error("safe_settlement_module_event_invalid");
      moduleLogs.push(log.logIndex);
    }
    if (log.address.toLowerCase() === credit.token.toLowerCase()) {
      try {
        const event = decodeEventLog({
          abi: transferAbi,
          eventName: "Transfer",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data,
        });
        if (
          event.args.from.toLowerCase() !== credit.safeRoot.toLowerCase() ||
          event.args.to.toLowerCase() !== credit.recipient.toLowerCase() ||
          event.args.value !== credit.amount
        )
          throw new Error("safe_settlement_transfer_invalid");
        transferLogs.push(log.logIndex);
      } catch {
        throw new Error("safe_settlement_token_event_invalid");
      }
    }
  }
  if (moduleLogs.length !== 1 || transferLogs.length !== 1 || moduleLogs[0] === transferLogs[0])
    throw new Error("safe_settlement_unique_evidence_required");
  return {
    moduleLogIndex: moduleLogs[0] as number,
    transferLogIndex: transferLogs[0] as number,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  };
}
