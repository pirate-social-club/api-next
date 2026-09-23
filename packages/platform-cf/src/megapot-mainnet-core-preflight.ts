import { Schema } from "effect";
import { createPublicClient, type Hex, http, keccak256 } from "viem";
import { base } from "viem/chains";

// Read-only candidate evidence. Matching proxy bytecode alone does not attest
// upgradeable implementation slots or authorize custody, signing, or rollout.
const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const Hash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));

const MegapotMainnetCoreCandidateSchema = Schema.Struct({
  domain: Schema.Literal("pirate.megapot-mainnet-core-candidate.v1"),
  environment: Schema.Literal("production"),
  chain_id: Schema.Literal(8_453),
  jackpot_address: Address,
  ticket_nft_address: Address,
  usdc_address: Address,
  jackpot_code_hash: Hash,
  ticket_nft_code_hash: Hash,
  usdc_code_hash: Hash,
  abi_version: Schema.Literal("megapot_v2"),
});

export type MegapotMainnetCoreCandidate = Schema.Schema.Type<
  typeof MegapotMainnetCoreCandidateSchema
>;

export function decodeMegapotMainnetCoreCandidate(value: unknown): MegapotMainnetCoreCandidate {
  return Schema.decodeUnknownSync(MegapotMainnetCoreCandidateSchema, {
    onExcessProperty: "error",
  })(value);
}

export class MegapotMainnetCorePreflightFailed extends Error {
  constructor(
    readonly reason:
      | "invalid-rpc-url"
      | "chain-mismatch"
      | "block-mismatch"
      | "code-missing"
      | "code-mismatch"
      | "linked-contract-mismatch",
  ) {
    super(reason);
  }
}

export interface MegapotMainnetCoreReader {
  readonly chainId: () => Promise<number>;
  readonly head: () => Promise<bigint>;
  readonly blockHash: (blockNumber: bigint) => Promise<string>;
  readonly code: (address: string, blockNumber: bigint) => Promise<Hex | undefined>;
  readonly linkedAddress: (
    jackpotAddress: string,
    functionName: "jackpotNFT" | "usdc",
    blockNumber: bigint,
  ) => Promise<string>;
}

const jackpotIdentityAbi = [
  {
    type: "function",
    name: "jackpotNFT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export function makeMegapotMainnetCoreReader(rpcUrl: string): MegapotMainnetCoreReader {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new MegapotMainnetCorePreflightFailed("invalid-rpc-url");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new MegapotMainnetCorePreflightFailed("invalid-rpc-url");
  }
  const client = createPublicClient({ chain: base, transport: http(parsed.toString()) });
  return {
    chainId: () => client.getChainId(),
    head: () => client.getBlockNumber(),
    blockHash: async (blockNumber) => (await client.getBlock({ blockNumber })).hash,
    code: (address, blockNumber) =>
      client.getBytecode({ address: address as `0x${string}`, blockNumber }),
    linkedAddress: (jackpotAddress, functionName, blockNumber) =>
      client.readContract({
        address: jackpotAddress as `0x${string}`,
        abi: jackpotIdentityAbi,
        functionName,
        blockNumber,
      }),
  };
}

export type MegapotMainnetCoreProof = Readonly<{
  chainId: 8_453;
  blockNumber: bigint;
  blockHash: string;
  jackpotCodeHash: string;
  ticketNftCodeHash: string;
  usdcCodeHash: string;
  jackpotTicketNftAddress: string;
  jackpotUsdcAddress: string;
}>;

async function observe(
  reader: MegapotMainnetCoreReader,
  candidate: MegapotMainnetCoreCandidate,
  blockNumber: bigint,
): Promise<MegapotMainnetCoreProof> {
  const blockHashBefore = await reader.blockHash(blockNumber);
  const [jackpotCode, ticketNftCode, usdcCode, jackpotTicketNftAddress, jackpotUsdcAddress] =
    await Promise.all([
      reader.code(candidate.jackpot_address, blockNumber),
      reader.code(candidate.ticket_nft_address, blockNumber),
      reader.code(candidate.usdc_address, blockNumber),
      reader.linkedAddress(candidate.jackpot_address, "jackpotNFT", blockNumber),
      reader.linkedAddress(candidate.jackpot_address, "usdc", blockNumber),
    ]);
  const blockHashAfter = await reader.blockHash(blockNumber);
  if (blockHashBefore.toLowerCase() !== blockHashAfter.toLowerCase()) {
    throw new MegapotMainnetCorePreflightFailed("block-mismatch");
  }
  if (!jackpotCode || !ticketNftCode || !usdcCode) {
    throw new MegapotMainnetCorePreflightFailed("code-missing");
  }
  return {
    chainId: 8_453,
    blockNumber,
    blockHash: blockHashAfter.toLowerCase(),
    jackpotCodeHash: keccak256(jackpotCode).toLowerCase(),
    ticketNftCodeHash: keccak256(ticketNftCode).toLowerCase(),
    usdcCodeHash: keccak256(usdcCode).toLowerCase(),
    jackpotTicketNftAddress: jackpotTicketNftAddress.toLowerCase(),
    jackpotUsdcAddress: jackpotUsdcAddress.toLowerCase(),
  };
}

export async function inspectMegapotMainnetCore(input: {
  readonly candidate: MegapotMainnetCoreCandidate;
  readonly readers: readonly [MegapotMainnetCoreReader, MegapotMainnetCoreReader];
}): Promise<MegapotMainnetCoreProof> {
  const [first, second] = input.readers;
  const [firstChainId, secondChainId, firstHead, secondHead] = await Promise.all([
    first.chainId(),
    second.chainId(),
    first.head(),
    second.head(),
  ]);
  if (firstChainId !== 8_453 || secondChainId !== 8_453) {
    throw new MegapotMainnetCorePreflightFailed("chain-mismatch");
  }
  const blockNumber = firstHead < secondHead ? firstHead : secondHead;
  const [left, right] = await Promise.all([
    observe(first, input.candidate, blockNumber),
    observe(second, input.candidate, blockNumber),
  ]);
  if (left.blockHash !== right.blockHash) {
    throw new MegapotMainnetCorePreflightFailed("block-mismatch");
  }
  if (
    left.jackpotCodeHash !== right.jackpotCodeHash ||
    left.ticketNftCodeHash !== right.ticketNftCodeHash ||
    left.usdcCodeHash !== right.usdcCodeHash
  ) {
    throw new MegapotMainnetCorePreflightFailed("code-mismatch");
  }
  if (
    left.jackpotCodeHash !== input.candidate.jackpot_code_hash ||
    left.ticketNftCodeHash !== input.candidate.ticket_nft_code_hash ||
    left.usdcCodeHash !== input.candidate.usdc_code_hash
  ) {
    throw new MegapotMainnetCorePreflightFailed("code-mismatch");
  }
  if (
    left.jackpotTicketNftAddress !== right.jackpotTicketNftAddress ||
    left.jackpotUsdcAddress !== right.jackpotUsdcAddress ||
    left.jackpotTicketNftAddress !== input.candidate.ticket_nft_address ||
    left.jackpotUsdcAddress !== input.candidate.usdc_address
  ) {
    throw new MegapotMainnetCorePreflightFailed("linked-contract-mismatch");
  }
  return left;
}
