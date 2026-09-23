import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type Hex, keccak256 } from "viem";
import {
  decodeMegapotMainnetCoreCandidate,
  inspectMegapotMainnetCore,
  type MegapotMainnetCoreReader,
  makeMegapotMainnetCoreReader,
} from "./megapot-mainnet-core-preflight.ts";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const code = "0x6000" as Hex;

const candidate = () =>
  decodeMegapotMainnetCoreCandidate({
    domain: "pirate.megapot-mainnet-core-candidate.v1",
    environment: "production",
    chain_id: 8_453,
    jackpot_address: address("1"),
    ticket_nft_address: address("2"),
    usdc_address: address("3"),
    jackpot_code_hash: keccak256(code),
    ticket_nft_code_hash: keccak256(code),
    usdc_code_hash: keccak256(code),
    usdc_implementation_address: address("4"),
    usdc_implementation_code_hash: keccak256(code),
    abi_version: "megapot_v2",
  });

function reader(
  changes: Partial<{
    chainId: number;
    head: bigint;
    blockHash: string;
    bytecode: Hex | undefined;
    implementationSlot: Hex | undefined;
    implementationCode: Hex | undefined;
    ticketNft: string;
    usdc: string;
  }> = {},
): MegapotMainnetCoreReader {
  const expected = candidate();
  return {
    chainId: async () => changes.chainId ?? 8_453,
    head: async () => changes.head ?? 500n,
    blockHash: async (blockNumber) => {
      expect(blockNumber).toBe(500n);
      return changes.blockHash ?? hash("a");
    },
    code: async (contractAddress, blockNumber) => {
      expect(blockNumber).toBe(500n);
      if (contractAddress === expected.usdc_implementation_address) {
        return "implementationCode" in changes ? changes.implementationCode : code;
      }
      return "bytecode" in changes ? changes.bytecode : code;
    },
    storage: async (contractAddress, slot, blockNumber) => {
      expect(contractAddress).toBe(expected.usdc_address);
      expect(slot).toBe("0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3");
      expect(blockNumber).toBe(500n);
      return "implementationSlot" in changes
        ? changes.implementationSlot
        : (`0x${"0".repeat(24)}${expected.usdc_implementation_address.slice(2)}` as Hex);
    },
    linkedAddress: async (_jackpot, functionName, blockNumber) => {
      expect(blockNumber).toBe(500n);
      return functionName === "jackpotNFT"
        ? (changes.ticketNft ?? expected.ticket_nft_address)
        : (changes.usdc ?? expected.usdc_address);
    },
  };
}

describe("Megapot Base mainnet core preflight", () => {
  test("pins both readers to one block and confirms the candidate identity", async () => {
    const result = await inspectMegapotMainnetCore({
      candidate: candidate(),
      readers: [reader({ head: 501n }), reader()],
    });
    expect(result).toMatchObject({
      chainId: 8_453,
      blockNumber: 500n,
      blockHash: hash("a"),
      jackpotCodeHash: keccak256(code),
      ticketNftCodeHash: keccak256(code),
      usdcCodeHash: keccak256(code),
      usdcImplementationAddress: address("4"),
      usdcImplementationCodeHash: keccak256(code),
    });
  });

  test("rejects a wrong chain or divergent block", async () => {
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ chainId: 84_532 }), reader()],
      }),
    ).rejects.toMatchObject({ reason: "chain-mismatch" });
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ blockHash: hash("b") }), reader()],
      }),
    ).rejects.toMatchObject({ reason: "block-mismatch" });
    let blockRead = 0;
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [
          {
            ...reader(),
            blockHash: async () => (++blockRead === 1 ? hash("a") : hash("b")),
          },
          reader(),
        ],
      }),
    ).rejects.toMatchObject({ reason: "block-mismatch" });
  });

  test("rejects missing or changed code", async () => {
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ bytecode: undefined }), reader()],
      }),
    ).rejects.toMatchObject({ reason: "code-missing" });
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ bytecode: "0x6001" }), reader()],
      }),
    ).rejects.toMatchObject({ reason: "code-mismatch" });
  });

  test("rejects changed USDC proxy implementation despite identical proxy code", async () => {
    const changedSlot = `0x${"0".repeat(24)}${address("5").slice(2)}` as Hex;
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ implementationSlot: changedSlot }), reader()],
      }),
    ).rejects.toMatchObject({ reason: "implementation-mismatch" });
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [
          reader({ implementationCode: "0x6001" }),
          reader({ implementationCode: "0x6001" }),
        ],
      }),
    ).rejects.toMatchObject({ reason: "implementation-mismatch" });
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ implementationSlot: undefined }), reader()],
      }),
    ).rejects.toMatchObject({ reason: "implementation-mismatch" });
  });

  test("rejects a Jackpot linked to a different token or NFT", async () => {
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ ticketNft: address("4") }), reader()],
      }),
    ).rejects.toMatchObject({ reason: "linked-contract-mismatch" });
    await expect(
      inspectMegapotMainnetCore({
        candidate: candidate(),
        readers: [reader({ usdc: address("4") }), reader({ usdc: address("4") })],
      }),
    ).rejects.toMatchObject({ reason: "linked-contract-mismatch" });
  });

  test("candidate file is strictly typed and cannot supply custody authority", async () => {
    const raw: unknown = JSON.parse(
      await readFile(
        new URL(
          "../../../infra/megapot/base-mainnet-v2-deployment-candidate.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const parsed = decodeMegapotMainnetCoreCandidate(raw);
    expect(parsed.chain_id).toBe(8_453);
    expect(parsed.jackpot_address).toBe("0x3bae643002069dbcbcd62b1a4eb4c4a397d042a2");
    expect(parsed.usdc_address).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(parsed.usdc_implementation_address).toBe("0x2ce6311ddae708829bc0784c967b7d77d19fd779");
    expect(() =>
      decodeMegapotMainnetCoreCandidate({ ...parsed, custody_address: address("5") }),
    ).toThrow();
    expect(() => makeMegapotMainnetCoreReader("http://mainnet.base.org")).toThrow();
  });
});
