import { type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MegapotCommitmentSigner } from "./megapot-commitment-coordinator.ts";

export class MegapotV2SignerFailed extends Error {
  readonly _tag = "MegapotV2SignerFailed";

  constructor(
    readonly reason: "invalid-config" | "invalid-request" | "signer-mismatch" | "unsupported-chain",
  ) {
    super(reason);
  }
}

export type MegapotV2SignRequest = Readonly<{
  chainId: number;
  signerAddress: string;
  targetAddress: string;
  nonce: bigint;
  data: Hex;
  valueWei: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;

export type MegapotV2SignedTransaction = Readonly<{
  signedTransaction: Hex;
  signedTransactionHash: Hex;
}>;

export interface MegapotV2TransactionSigner {
  readonly address: string;
  readonly sign: (request: MegapotV2SignRequest) => Promise<MegapotV2SignedTransaction>;
}

const addressPattern = /^0x[0-9a-f]{40}$/u;
const privateKeyPattern = /^0x[0-9a-f]{64}$/u;

function canonicalAddress(value: string): `0x${string}` {
  const canonical = value.toLowerCase();
  if (!addressPattern.test(canonical)) throw new MegapotV2SignerFailed("invalid-request");
  return canonical as `0x${string}`;
}

/** Derives a public Base Sepolia signer identity without exposing key material. */
export function deriveBaseSepoliaMegapotAddress(privateKeyValue: string): string {
  const privateKey = privateKeyValue.toLowerCase();
  if (!privateKeyPattern.test(privateKey)) throw new MegapotV2SignerFailed("invalid-config");
  return privateKeyToAccount(privateKey as Hex).address.toLowerCase();
}

export function makeBaseSepoliaMegapotV2PrivateKeySigner(input: {
  readonly privateKey: string;
  readonly expectedAddress: string;
}): MegapotV2TransactionSigner {
  const privateKey = input.privateKey.toLowerCase();
  deriveBaseSepoliaMegapotAddress(privateKey);
  const account = privateKeyToAccount(privateKey as Hex);
  const expectedAddress = canonicalAddress(input.expectedAddress);
  if (account.address.toLowerCase() !== expectedAddress) {
    throw new MegapotV2SignerFailed("signer-mismatch");
  }
  return {
    address: expectedAddress,
    sign: async (request) => {
      if (request.chainId !== 84_532) throw new MegapotV2SignerFailed("unsupported-chain");
      if (
        canonicalAddress(request.signerAddress) !== expectedAddress ||
        request.nonce < 0n ||
        request.nonce > BigInt(Number.MAX_SAFE_INTEGER) ||
        request.valueWei < 0n ||
        request.gas <= 0n ||
        request.maxFeePerGas <= 0n ||
        request.maxPriorityFeePerGas < 0n ||
        request.maxFeePerGas < request.maxPriorityFeePerGas ||
        !/^0x(?:[0-9a-f]{2})*$/u.test(request.data)
      ) {
        throw new MegapotV2SignerFailed("invalid-request");
      }
      const signedTransaction = await account.signTransaction({
        type: "eip1559",
        chainId: request.chainId,
        to: canonicalAddress(request.targetAddress),
        nonce: Number(request.nonce),
        data: request.data,
        value: request.valueWei,
        gas: request.gas,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      });
      return {
        signedTransaction,
        signedTransactionHash: keccak256(signedTransaction),
      };
    },
  };
}

export function makeBaseSepoliaMegapotCommitmentSigner(input: {
  readonly privateKey: string;
  readonly expectedAddress: string;
}): MegapotCommitmentSigner {
  const privateKey = input.privateKey.toLowerCase();
  deriveBaseSepoliaMegapotAddress(privateKey);
  const account = privateKeyToAccount(privateKey as Hex);
  const expectedAddress = canonicalAddress(input.expectedAddress);
  if (account.address.toLowerCase() !== expectedAddress) {
    throw new MegapotV2SignerFailed("signer-mismatch");
  }
  return {
    sign: async (payload) => ({
      signingKeyId: `eip191:84532:${expectedAddress}`,
      signature: await account.signMessage({ message: { raw: payload } }),
    }),
  };
}
