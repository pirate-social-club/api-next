import { expect, test } from "bun:test";
import { isMegapotStepChainAllowed, MEGAPOT_CHAIN_STEPS } from "./megapot-chain-policy.ts";
import {
  MEGAPOT_LOCAL_FORK_BLOCK,
  MEGAPOT_LOCAL_FORK_HASH,
  makeMegapotLocalForkRpcClient,
  megapotLocalForkUrl,
} from "./megapot-local-fork.ts";
import type { MegapotV2DeploymentAttestation } from "./megapot-v2.ts";

const hash = `0x${"a".repeat(64)}`;
const address = (byte: string) => `0x${byte.repeat(40)}`;
const deployment: MegapotV2DeploymentAttestation = {
  environment: "production",
  chainId: 8453,
  attestationId: "local-simulation-only",
  jackpotAddress: address("1"),
  ticketNftAddress: address("2"),
  usdcAddress: address("3"),
  custodyAddress: address("4"),
  referrerAddress: address("5"),
  jackpotCodeHash: hash,
  ticketNftCodeHash: hash,
  usdcCodeHash: hash,
  usdcImplementationAddress: address("6"),
  usdcImplementationCodeHash: hash,
};

function node() {
  let changed = false;
  const calls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    expect(url).toBe("http://127.0.0.1:8547/");
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    const { id, method } = JSON.parse(String(init?.body));
    calls.push(method);
    const result =
      method === "anvil_nodeInfo"
        ? {
            forkConfig: {
              forkBlockNumber: MEGAPOT_LOCAL_FORK_BLOCK,
              forkUrl: "https://upstream.example.invalid",
            },
          }
        : method === "eth_chainId"
          ? changed
            ? "0x1"
            : "0x2105"
          : method === "eth_getBlockByNumber"
            ? { hash: MEGAPOT_LOCAL_FORK_HASH }
            : hash;
    return Response.json({ jsonrpc: "2.0", id, result });
  };
  return {
    calls,
    fetcher,
    change: () => {
      changed = true;
    },
  };
}

test("no public, credentialed, redirected, or ambiguous local endpoint acquires fork authority", async () => {
  for (const url of [
    "https://mainnet.base.org",
    "http://localhost:8547",
    "http://127.0.0.2:8547",
    "http://user:pass@127.0.0.1:8547",
    "http://127.0.0.1:8547/rpc",
    "http://127.0.0.1:8547/?key=x",
    "http://127.0.0.1:8547/#x",
  ]) {
    expect(() => megapotLocalForkUrl(url)).toThrow();
  }
  const stub = node();
  stub.change();
  await expect(
    makeMegapotLocalForkRpcClient({
      rpcUrl: "http://127.0.0.1:8547",
      attestation: deployment,
      fetcher: stub.fetcher,
    }),
  ).rejects.toThrow("megapot_local_fork_identity_changed");
});

test("only the exact validated client admits mainnet coordinator simulation; runtime signing stays refused", async () => {
  const stub = node();
  const rpc = await makeMegapotLocalForkRpcClient({
    rpcUrl: "http://127.0.0.1:8547",
    attestation: deployment,
    fetcher: stub.fetcher,
  });
  for (const step of MEGAPOT_CHAIN_STEPS) {
    expect(isMegapotStepChainAllowed(step, "production", 8453)).toBe(false);
    expect(isMegapotStepChainAllowed(step, "production", 8453, { ...rpc })).toBe(false);
    expect(isMegapotStepChainAllowed(step, "production", 8453, rpc, deployment)).toBe(
      step !== "transaction-signing",
    );
    expect(isMegapotStepChainAllowed(step, "production", 8453, rpc)).toBe(false);
    expect(isMegapotStepChainAllowed(step, "staging", 8453, rpc, deployment)).toBe(false);
  }
  for (const field of Object.keys(deployment) as (keyof MegapotV2DeploymentAttestation)[]) {
    const changed = {
      ...deployment,
      [field]: typeof deployment[field] === "number" ? 1 : `${deployment[field]}0`,
    };
    expect(isMegapotStepChainAllowed("claim", "production", 8453, rpc, changed)).toBe(false);
  }
  expect(Object.isFrozen(rpc)).toBe(true);
  expect(Object.isFrozen(rpc.deployment)).toBe(true);
  expect(await rpc.sendRawTransaction("0x0102")).toBe(hash);
  stub.change();
  await expect(rpc.sendRawTransaction("0x0102")).rejects.toThrow();
  expect(stub.calls.filter((method) => method === "eth_sendRawTransaction")).toHaveLength(1);
});
