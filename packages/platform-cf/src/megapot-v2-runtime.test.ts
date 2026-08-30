import { describe, expect, test } from "bun:test";
import type { CustodySolvencyStore } from "@pirate/application";
import { Effect } from "effect";
import {
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverMessageAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makeCustodySolvencyCoordinator } from "./custody-solvency-coordinator.ts";
import { encodeMegapotV2ClaimRevert } from "./megapot-v2.ts";
import {
  findMegapotV2ClaimRevert,
  type MegapotV2RpcClientOptions,
  MegapotV2RpcFailed,
  makeMegapotV2RpcClient,
} from "./megapot-v2-rpc.ts";
import {
  deriveBaseSepoliaMegapotAddress,
  MegapotV2SignerFailed,
  makeBaseSepoliaMegapotCommitmentSigner,
  makeBaseSepoliaMegapotV2PrivateKeySigner,
} from "./megapot-v2-signer.ts";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const quantity = (value: bigint): Hex => `0x${value.toString(16)}`;
const code = {
  jackpot: "0x6001600155" as Hex,
  ticket: "0x6002600255" as Hex,
  usdc: "0x6003600355" as Hex,
};

const readAbi = parseAbi([
  "function allowTicketPurchases() view returns (bool)",
  "function currentDrawingId() view returns (uint256)",
  "function jackpotNFT() view returns (address)",
  "function usdc() view returns (address)",
  "function getDrawingState(uint256 _drawingId) view returns ((uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
]);

const currentDrawingData = encodeFunctionData({ abi: readAbi, functionName: "currentDrawingId" });
const purchasesAllowedData = encodeFunctionData({
  abi: readAbi,
  functionName: "allowTicketPurchases",
});
const jackpotNftData = encodeFunctionData({ abi: readAbi, functionName: "jackpotNFT" });
const usdcData = encodeFunctionData({ abi: readAbi, functionName: "usdc" });

function attestation(): MegapotV2RpcClientOptions["attestation"] {
  return {
    environment: "staging",
    chainId: 84_532,
    jackpotAddress: address("1"),
    ticketNftAddress: address("2"),
    usdcAddress: address("3"),
    custodyAddress: address("4"),
    referrerAddress: address("5"),
    jackpotCodeHash: keccak256(code.jackpot),
    ticketNftCodeHash: keccak256(code.ticket),
    usdcCodeHash: keccak256(code.usdc),
    attestationId: "base-sepolia-v2",
  };
}

function rpcResponse(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function attestationFetcher(options?: {
  readonly chainId?: bigint;
  readonly jackpotCode?: Hex;
  readonly ticketNftAddress?: string;
}): (input: string, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
    const params = request.params as readonly unknown[];
    if (request.method === "eth_chainId") {
      return rpcResponse(request.id, quantity(options?.chainId ?? 84_532n));
    }
    if (request.method === "eth_getCode") {
      const contract = params[0];
      return rpcResponse(
        request.id,
        contract === address("1")
          ? (options?.jackpotCode ?? code.jackpot)
          : contract === address("2")
            ? code.ticket
            : code.usdc,
      );
    }
    if (request.method === "eth_call") {
      const call = params[0] as Readonly<Record<string, unknown>>;
      if (call.data === jackpotNftData) {
        return rpcResponse(
          request.id,
          encodeFunctionResult({
            abi: readAbi,
            functionName: "jackpotNFT",
            result: (options?.ticketNftAddress ?? address("2")) as `0x${string}`,
          }),
        );
      }
      if (call.data === usdcData) {
        return rpcResponse(
          request.id,
          encodeFunctionResult({
            abi: readAbi,
            functionName: "usdc",
            result: address("3") as `0x${string}`,
          }),
        );
      }
    }
    throw new Error("unexpected attestation RPC method");
  };
}

describe("Megapot v2 Worker runtime adapters", () => {
  test("derives and decodes typed v2 claim reverts through nested provider errors", async () => {
    const noTickets = encodeMegapotV2ClaimRevert("no_tickets_to_claim");
    const notOwner = encodeMegapotV2ClaimRevert("not_ticket_owner");
    expect(noTickets).toBe("0x2da2704e");
    expect(notOwner).toBe("0xe18d39ad");
    expect(
      findMegapotV2ClaimRevert({
        cause: { details: { error: { data: noTickets } } },
      }),
    ).toBe("no_tickets_to_claim");
    expect(findMegapotV2ClaimRevert({ errorName: "NotTicketOwner" })).toBe("not_ticket_owner");
    expect(findMegapotV2ClaimRevert({ data: "0xdeadbeef" })).toBeNull();

    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_000, data: { originalError: { data: notOwner } } },
        });
      },
    });
    await expect(client.readCurrentDrawingId()).rejects.toMatchObject({
      reason: "provider-error",
      claimRevert: "not_ticket_owner",
    });
  });

  test("derives a public address while rejecting malformed private keys", () => {
    const privateKey = generatePrivateKey();
    expect(deriveBaseSepoliaMegapotAddress(privateKey)).toBe(
      privateKeyToAccount(privateKey).address.toLowerCase(),
    );
    expect(() => deriveBaseSepoliaMegapotAddress("0x1234")).toThrow(MegapotV2SignerFailed);
  });

  test("attests code and reads the live drawing through bounded JSON-RPC", async () => {
    const requests: Readonly<Record<string, unknown>>[] = [];
    const fetcher = async (_input: string, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
      requests.push(request);
      const id = request.id;
      const params = request.params as readonly unknown[];
      if (request.method === "eth_chainId") return rpcResponse(id, quantity(84_532n));
      if (request.method === "eth_getCode") {
        const contract = params[0];
        return rpcResponse(
          id,
          contract === address("1")
            ? code.jackpot
            : contract === address("2")
              ? code.ticket
              : code.usdc,
        );
      }
      if (request.method === "eth_call") {
        const call = params[0] as Readonly<Record<string, unknown>>;
        if (call.data === jackpotNftData) {
          return rpcResponse(
            id,
            encodeFunctionResult({
              abi: readAbi,
              functionName: "jackpotNFT",
              result: address("2") as `0x${string}`,
            }),
          );
        }
        if (call.data === usdcData) {
          return rpcResponse(
            id,
            encodeFunctionResult({
              abi: readAbi,
              functionName: "usdc",
              result: address("3") as `0x${string}`,
            }),
          );
        }
        if (call.data === currentDrawingData) {
          return rpcResponse(
            id,
            encodeFunctionResult({
              abi: readAbi,
              functionName: "currentDrawingId",
              result: 8_328n,
            }),
          );
        }
        if (call.data === purchasesAllowedData) {
          return rpcResponse(
            id,
            encodeFunctionResult({
              abi: readAbi,
              functionName: "allowTicketPurchases",
              result: true,
            }),
          );
        }
        return rpcResponse(
          id,
          encodeFunctionResult({
            abi: readAbi,
            functionName: "getDrawingState",
            result: {
              prizePool: 10_000_000n,
              ticketPrice: 10_000n,
              edgePerTicket: 1_000n,
              referralWinShare: 100_000_000_000_000_000n,
              referralFee: 100_000_000_000_000_000n,
              globalTicketsBought: 55n,
              lpEarnings: 900n,
              drawingTime: 1_787_689_200n,
              winningTicket: 0n,
              ballMax: 25,
              bonusballMax: 13,
              payoutCalculator: address("6") as `0x${string}`,
              jackpotLock: false,
            },
          }),
        );
      }
      throw new Error("unexpected RPC method");
    };
    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher,
    });
    await expect(client.attestDeployment()).resolves.toEqual({
      jackpotCodeHash: keccak256(code.jackpot),
      ticketNftCodeHash: keccak256(code.ticket),
      usdcCodeHash: keccak256(code.usdc),
    });
    await expect(client.readCurrentDrawing()).resolves.toMatchObject({
      drawingId: 8_328n,
      state: { ticketPrice: 10_000n, ballMax: 25, bonusballMax: 13, jackpotLock: false },
    });
    await expect(client.readTicketPurchasesAllowed()).resolves.toBe(true);
    expect(requests.map((request) => request.method)).toEqual([
      "eth_chainId",
      "eth_getCode",
      "eth_getCode",
      "eth_getCode",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
    ]);
  });

  test("reuses one successful deployment attestation per RPC client", async () => {
    let requestCount = 0;
    const fetchAttestation = attestationFetcher();
    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      reuseSuccessfulAttestation: true,
      fetcher: async (input, init) => {
        requestCount += 1;
        return fetchAttestation(input, init);
      },
    });

    const [first, second] = await Promise.all([
      client.attestDeployment(),
      client.attestDeployment(),
    ]);
    expect(first).toEqual(second);
    expect(requestCount).toBe(6);

    await expect(client.attestDeployment()).resolves.toEqual(first);
    expect(requestCount).toBe(6);
  });

  test("does not cache a failed deployment attestation", async () => {
    let requestCount = 0;
    let failNextChainRead = true;
    const fetchAttestation = attestationFetcher();
    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      reuseSuccessfulAttestation: true,
      fetcher: async (input, init) => {
        requestCount += 1;
        const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        if (request.method === "eth_chainId" && failNextChainRead) {
          failNextChainRead = false;
          return rpcResponse(request.id, quantity(8_453n));
        }
        return fetchAttestation(input, init);
      },
    });

    await expect(client.attestDeployment()).rejects.toMatchObject({
      reason: "invalid-response",
    });
    expect(requestCount).toBe(6);

    await expect(client.attestDeployment()).resolves.toEqual({
      jackpotCodeHash: keccak256(code.jackpot),
      ticketNftCodeHash: keccak256(code.ticket),
      usdcCodeHash: keccak256(code.usdc),
    });
    expect(requestCount).toBe(12);
  });

  test("reattests by default for long-lived RPC clients", async () => {
    let requestCount = 0;
    const fetchAttestation = attestationFetcher();
    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher: async (input, init) => {
        requestCount += 1;
        return fetchAttestation(input, init);
      },
    });

    await client.attestDeployment();
    await client.attestDeployment();
    expect(requestCount).toBe(12);
  });

  test("paces request starts only when the bounded client opts in", async () => {
    const requestStarts: number[] = [];
    const fetchAttestation = attestationFetcher();
    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      reuseSuccessfulAttestation: true,
      minimumRequestIntervalMs: 20,
      fetcher: async (input, init) => {
        requestStarts.push(performance.now());
        return fetchAttestation(input, init);
      },
    });

    await client.attestDeployment();
    expect(requestStarts).toHaveLength(6);
    for (let index = 1; index < requestStarts.length; index += 1) {
      expect(
        (requestStarts[index] as number) - (requestStarts[index - 1] as number),
      ).toBeGreaterThan(15);
    }
  });

  test("classifies the exact solvency RPC stage without exposing provider details", async () => {
    const deployment = attestation();
    const fetchAttestation = attestationFetcher();
    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: deployment,
      reuseSuccessfulAttestation: true,
      fetcher: async (input, init) => {
        const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        if (request.method === "eth_getBlockByNumber") {
          return new Response(null, { status: 503 });
        }
        return fetchAttestation(input, init);
      },
    });
    const store: CustodySolvencyStore = {
      listTokenAddresses: () => Effect.succeed([deployment.usdcAddress]),
      loadCandidate: () => Effect.succeed({ ...deployment, tokenAddress: deployment.usdcAddress }),
      findObservation: () => Effect.succeed(null),
      record: () => Effect.die("unexpected solvency record"),
    };

    await expect(
      Effect.runPromise(
        makeCustodySolvencyCoordinator({ store, rpc: client, requiredConfirmations: 3 }).observe(
          deployment.attestationId,
        ),
      ),
    ).rejects.toMatchObject({
      reason: "observation_invalid",
      stage: "head",
      rpcReason: "unavailable",
      message: "observation_invalid:head:unavailable",
    });
  });

  test("fails closed on the wrong chain, stale code, or mismatched Jackpot wiring", async () => {
    const wrongChainClient = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher: attestationFetcher({ chainId: 8_453n }),
    });
    await expect(wrongChainClient.attestDeployment()).rejects.toMatchObject({
      reason: "invalid-response",
    });

    const wrongCodeClient = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher: attestationFetcher({ jackpotCode: "0x6000" }),
    });
    await expect(wrongCodeClient.attestDeployment()).rejects.toBeInstanceOf(MegapotV2RpcFailed);

    const wrongWiringClient = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher: attestationFetcher({ ticketNftAddress: address("9") }),
    });
    await expect(wrongWiringClient.attestDeployment()).rejects.toMatchObject({
      reason: "invalid-response",
    });
  });

  test("fails closed on removed receipt logs", async () => {
    const receiptClient = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        return rpcResponse(request.id, {
          transactionHash: hash("7"),
          from: address("4"),
          to: address("1"),
          status: "0x1",
          blockNumber: "0x64",
          blockHash: hash("8"),
          logs: [
            {
              address: address("1"),
              topics: [hash("9")],
              data: "0x",
              logIndex: "0x0",
              transactionHash: hash("7"),
              blockNumber: "0x64",
              blockHash: hash("8"),
              removed: true,
            },
          ],
        });
      },
    });
    await expect(receiptClient.readReceipt(hash("7"))).rejects.toMatchObject({ reason: "reorg" });
  });

  test("signs exact EIP-1559 bytes only for the attested Base Sepolia custody key", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const signer = makeBaseSepoliaMegapotV2PrivateKeySigner({
      privateKey,
      expectedAddress: account.address,
    });
    const signed = await signer.sign({
      chainId: 84_532,
      signerAddress: account.address,
      targetAddress: address("1"),
      nonce: 7n,
      data: "0xdeadbeef",
      valueWei: 0n,
      gas: 250_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    expect(keccak256(signed.signedTransaction)).toBe(signed.signedTransactionHash);
    expect(parseTransaction(signed.signedTransaction)).toMatchObject({
      chainId: 84_532,
      nonce: 7,
      to: address("1"),
      data: "0xdeadbeef",
      gas: 250_000n,
    });
    await expect(
      signer.sign({
        chainId: 8_453,
        signerAddress: account.address,
        targetAddress: address("1"),
        nonce: 7n,
        data: "0xdeadbeef",
        valueWei: 0n,
        gas: 250_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    ).rejects.toBeInstanceOf(MegapotV2SignerFailed);
  });

  test("signs commitment bytes with a publicly recoverable custody-key identity", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const payload = new TextEncoder().encode("frozen-beneficiary-snapshot");
    const signed = await makeBaseSepoliaMegapotCommitmentSigner({
      privateKey,
      expectedAddress: account.address,
    }).sign(payload);
    expect(signed.signingKeyId).toBe(`eip191:84532:${account.address.toLowerCase()}`);
    await expect(
      recoverMessageAddress({ message: { raw: payload }, signature: signed.signature as Hex }),
    ).resolves.toBe(account.address);
  });

  test("quotes fees and serializes quantities without decimal ambiguity", async () => {
    const fetcher = async (_input: string, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
      if (request.method === "eth_maxPriorityFeePerGas") {
        return rpcResponse(request.id, quantity(2n));
      }
      return rpcResponse(request.id, {
        number: quantity(100n),
        hash: hash("a"),
        baseFeePerGas: quantity(10n),
      });
    };
    const client = makeMegapotV2RpcClient({
      rpcUrl: "https://base-sepolia.example.invalid",
      attestation: attestation(),
      fetcher,
    });
    await expect(client.readFeeQuote()).resolves.toEqual({
      baseFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
      maxFeePerGas: 22n,
      observedBlockNumber: 100n,
      observedBlockHash: hash("a"),
    });
  });
});
