import { expect, test } from "bun:test";
import { encodeFunctionResult, type Hex, keccak256, parseAbi, toEventSelector } from "viem";
import { MegapotV2RpcFailed, makeMegapotV2RpcClient } from "./megapot-v2-rpc.ts";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const quantity = (value: bigint): Hex => `0x${value.toString(16)}`;
const SAFE = address("6");
const success = toEventSelector("ExecutionSuccess(bytes32,uint256)");
const failure = toEventSelector("ExecutionFailure(bytes32,uint256)");
const payment = `0x${"00".repeat(32)}`;

type Request = Readonly<{ id: unknown; method: string; params: readonly unknown[] }>;

function client(answer: (request: Request) => unknown) {
  const requests: Request[] = [];
  return {
    requests,
    rpc: makeMegapotV2RpcClient({
      rpcUrl: "https://base.example.invalid",
      attestation: {
        environment: "staging",
        chainId: 84_532,
        jackpotAddress: address("1"),
        ticketNftAddress: address("2"),
        usdcAddress: address("3"),
        custodyAddress: SAFE,
        referrerAddress: address("5"),
        jackpotCodeHash: keccak256("0x01"),
        ticketNftCodeHash: keccak256("0x02"),
        usdcCodeHash: keccak256("0x03"),
        attestationId: "safe-rpc-test",
      },
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as Request;
        requests.push(request);
        return Response.json({ jsonrpc: "2.0", id: request.id, result: answer(request) });
      },
    }),
  };
}

function log(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    address: SAFE,
    topics: [success, hash("a")],
    data: payment,
    blockNumber: quantity(100n),
    blockHash: hash("b"),
    transactionHash: hash("c"),
    logIndex: quantity(3n),
    removed: false,
    ...overrides,
  };
}

const range = { safe: SAFE, fromBlock: 90n, toBlock: 110n, maximumBlocks: 50, maximumLogs: 10 };

test("forwards the snapshot block to native balance RPC and preserves latest by default", async () => {
  const { rpc, requests } = client(() => "0x2a");
  expect(await rpc.readNativeBalance(SAFE, 100n)).toBe(42n);
  expect(await rpc.readNativeBalance(SAFE)).toBe(42n);
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "eth_getBalance", params: [SAFE, "0x64"] },
    { method: "eth_getBalance", params: [SAFE, "latest"] },
  ]);
});

test("reads both Safe execution events in one bounded topic query", async () => {
  const { rpc, requests } = client(() => [
    log(),
    log({ topics: [failure, hash("d")], logIndex: quantity(4n) }),
  ]);
  const logs = await rpc.readSafeExecutionLogs?.(range);
  expect(logs).toEqual([
    {
      transactionHash: hash("c"),
      blockNumber: 100n,
      blockHash: hash("b"),
      logIndex: 3,
      safeTransactionHash: hash("a"),
      outcome: "success",
    },
    {
      transactionHash: hash("c"),
      blockNumber: 100n,
      blockHash: hash("b"),
      logIndex: 4,
      safeTransactionHash: hash("d"),
      outcome: "failure",
    },
  ]);
  expect(requests[0]).toMatchObject({
    method: "eth_getLogs",
    params: [{ address: SAFE, topics: [[success, failure]], fromBlock: "0x5a", toBlock: "0x6e" }],
  });
});

test("refuses unbounded ranges and malformed or foreign Safe logs", async () => {
  const { rpc } = client(() => []);
  for (const invalid of [
    { ...range, toBlock: 89n },
    { ...range, maximumBlocks: 20 },
    { ...range, maximumLogs: 0 },
  ]) {
    await expect(rpc.readSafeExecutionLogs?.(invalid)).rejects.toMatchObject({
      reason: "invalid-config",
    });
  }
  for (const bad of [
    log({ address: address("7") }),
    log({ removed: true }),
    log({ topics: [success] }),
    log({ topics: [hash("e"), hash("a")] }),
    log({ blockNumber: quantity(111n) }),
    log({ data: "0x" }),
  ]) {
    const { rpc: reader } = client(() => [bad]);
    await expect(reader.readSafeExecutionLogs?.(range)).rejects.toBeInstanceOf(MegapotV2RpcFailed);
  }
  const { rpc: flooded } = client(() => Array.from({ length: 11 }, () => log()));
  await expect(flooded.readSafeExecutionLogs?.(range)).rejects.toMatchObject({
    reason: "invalid-response",
  });
});

test("reads the Safe nonce at an exact block", async () => {
  const { rpc, requests } = client(() =>
    encodeFunctionResult({
      abi: parseAbi(["function nonce() view returns (uint256)"]),
      functionName: "nonce",
      result: 42n,
    }),
  );
  expect(await rpc.readSafeNonce?.(SAFE, 99n)).toBe(42n);
  expect(requests[0]).toMatchObject({
    method: "eth_call",
    params: [{ to: SAFE, data: "0xaffed0e0" }, "0x63"],
  });
  await expect(rpc.readSafeNonce?.(SAFE, -1n)).rejects.toMatchObject({
    reason: "invalid-config",
  });
});
