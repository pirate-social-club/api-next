import { Predicate } from "effect";
import {
  type Abi,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  type Hex,
  keccak256,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadMainnetArtifact } from "./megapot-mainnet-artifacts.fixture.ts";
import type { openMainnetLocalFixture } from "./megapot-mainnet-local.fixture.ts";

export type LocalMainnetFixture = Awaited<ReturnType<typeof openMainnetLocalFixture>>;

export async function deployLocalArtifact(
  f: LocalMainnetFixture,
  artifact: { abi: Abi; bytecode: Hex },
  args: readonly unknown[],
) {
  const result = await f.setupTransaction(encodeDeployData({ ...artifact, args }));
  if (result.receipt.status !== "0x1" || result.receipt.contractAddress === null)
    throw new Error("local_deployment_failed");
  return result.receipt.contractAddress.toLowerCase() as Hex;
}

export async function readLocalContract(
  f: LocalMainnetFixture,
  address: Hex,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
) {
  const result = await f.rpc("eth_call", [
    { to: address, data: encodeFunctionData({ abi, functionName, args }) },
    "latest",
  ]);
  return decodeFunctionResult({ abi, functionName, data: result as Hex });
}

/** Actual released Safe singleton/factory; setup/signers/issuer are ephemeral LOCAL fixtures. */
export async function createLocalSafeSettlement(f: LocalMainnetFixture, cap: bigint, token?: Hex) {
  const safeArtifact = await loadMainnetArtifact("Safe");
  const factoryArtifact = await loadMainnetArtifact("SafeProxyFactory");
  const moduleArtifact = await loadMainnetArtifact("RewardCreditSettlement");
  const singleton = "0x41675c099f32341bf84bfc5382af534df5c7461a" as Hex;
  const factory = "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67" as Hex;
  const code = await f.rpc("eth_getCode", [singleton, "latest"]);
  if (
    keccak256(code as Hex) !== "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4"
  )
    throw new Error("safe_singleton_code_changed");
  if (
    keccak256((await f.rpc("eth_getCode", [factory, "latest"])) as Hex) !==
    "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317"
  )
    throw new Error("safe_factory_code_changed");
  const initializer = encodeFunctionData({
    abi: safeArtifact.abi,
    functionName: "setup",
    args: [
      [f.testAccount.address],
      1n,
      zeroAddress,
      "0x",
      zeroAddress,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
  const proxyResult = await f.setupTransaction(
    encodeFunctionData({
      abi: factoryArtifact.abi,
      functionName: "createProxyWithNonce",
      args: [singleton, initializer, 1n],
    }),
    factory,
  );
  let safe: Hex | undefined;
  for (const log of proxyResult.receipt.logs) {
    if (log.address.toLowerCase() !== factory) continue;
    try {
      const event = decodeEventLog({
        abi: factoryArtifact.abi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
        eventName: "ProxyCreation",
      });
      const args: unknown = event.args;
      if (
        !Predicate.isObject(args) ||
        !("proxy" in args) ||
        typeof args.proxy !== "string" ||
        !/^0x[0-9a-f]{40}$/i.test(args.proxy)
      )
        throw new Error("local_proxy_event_invalid");
      safe = args.proxy.toLowerCase() as Hex;
    } catch {
      /* only the exact factory event is intake */
    }
  }
  if (proxyResult.receipt.status !== "0x1" || safe === undefined)
    throw new Error("safe_proxy_setup_failed");
  const issuer = privateKeyToAccount(generatePrivateKey());
  const asset = token ?? (f.deployment.usdcAddress as Hex);
  const module = await deployLocalArtifact(f, moduleArtifact, [safe, asset, issuer.address, cap]);
  const executeOwnerCall = async (data: Hex) => {
    const nonce = (await readLocalContract(f, safe, safeArtifact.abi, "nonce")) as bigint;
    const tx = {
      to: safe,
      value: 0n,
      data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce,
    };
    const signature = await f.testAccount.signTypedData({
      domain: { chainId: 8453, verifyingContract: safe },
      types: {
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      message: tx,
    });
    const result = await f.setupTransaction(
      encodeFunctionData({
        abi: safeArtifact.abi,
        functionName: "execTransaction",
        args: [safe, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature],
      }),
      safe,
    );
    if (result.receipt.status !== "0x1") throw new Error("safe_owner_transaction_reverted");
    const successes = result.receipt.logs.filter((log) => {
      if (log.address.toLowerCase() !== safe) return false;
      try {
        return (
          decodeEventLog({
            abi: safeArtifact.abi,
            eventName: "ExecutionSuccess",
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data,
          }).eventName === "ExecutionSuccess"
        );
      } catch {
        return false;
      }
    });
    if (successes.length !== 1) throw new Error("safe_owner_execution_failed");
  };
  return {
    safe,
    module,
    token: asset,
    issuer,
    moduleAbi: moduleArtifact.abi,
    enable: () =>
      executeOwnerCall(
        encodeFunctionData({ abi: safeArtifact.abi, functionName: "enableModule", args: [module] }),
      ),
    disable: () =>
      executeOwnerCall(
        encodeFunctionData({
          abi: safeArtifact.abi,
          functionName: "disableModule",
          args: ["0x0000000000000000000000000000000000000001", module],
        }),
      ),
    enabled: async () =>
      readLocalContract(f, safe, safeArtifact.abi, "isModuleEnabled", [module]) as Promise<boolean>,
  };
}
