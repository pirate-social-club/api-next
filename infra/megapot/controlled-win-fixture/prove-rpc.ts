import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makeMegapotV2RpcClient } from "../../../packages/platform-cf/src/megapot-v2-rpc.ts";
import {
  encodeMegapotBuyTickets,
  encodeMegapotClaimWinnings,
  validateMegapotClaimReceipt,
  validateMegapotPurchaseReceipt,
  type MegapotV2DeploymentAttestation,
} from "../../../packages/platform-cf/src/megapot-v2.ts";
import { type Abi, type Hex, createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

type Artifact = { abi: Abi; bytecode: { object: Hex } };
const artifact = async (path: string): Promise<Artifact> =>
  JSON.parse(await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as Artifact;

const rpcUrl = "http://127.0.0.1:18545";
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const account = privateKeyToAccount(generatePrivateKey());
const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
const prize = 1_000_000n;
const price = 10_000n;
const referrer = "0x000000000000000000000000000000000000cafe";
const source = toHex(7n, { size: 32 });
const tickets = [{ normals: [1, 2, 3, 4, 5], bonusball: 1 }] as const;

async function localRpc(method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const body = (await response.json()) as { error?: { message?: string }; result?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
  return body.result;
}

async function mined(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

async function deploy(contract: Artifact, args: readonly unknown[]): Promise<Hex> {
  const hash = await walletClient.deployContract({
    abi: contract.abi,
    bytecode: contract.bytecode.object,
    args,
  });
  const receipt = await mined(hash);
  assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}

async function send(to: Hex, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await walletClient.sendTransaction({
    to,
    data: encodeFunctionData({ abi, functionName, args }),
  });
  await mined(hash);
  return hash;
}

async function codeHash(address: Hex): Promise<Hex> {
  const code = await publicClient.getCode({ address });
  assert.ok(code && code !== "0x", `missing code at ${address}`);
  return keccak256(code);
}

async function main() {
  // Anvil may still be ahead after a prior proof advanced its test clock.
  await localRpc("anvil_reset", []);
  assert.equal(await publicClient.getChainId(), 84_532, "local chain must be Base Sepolia ID");
  await localRpc("anvil_setBalance", [account.address, toHex(10n ** 18n)]);
  const token = await artifact("./out/ControlledUsdc.sol/ControlledUsdc.json");
  const fixture = await artifact("./out/ControlledMegapot.sol/ControlledMegapot.json");
  const usdcAddress = await deploy(token, [2n * prize + price]);
  const jackpotAddress = await deploy(fixture, [usdcAddress, account.address, price]);
  const ticketNftAddress = await publicClient.readContract({
    address: jackpotAddress,
    abi: fixture.abi,
    functionName: "jackpotNFT",
  }) as Hex;
  const deployment: MegapotV2DeploymentAttestation = {
    attestationId: "controlled-megapot-local",
    environment: "staging",
    chainId: 84_532,
    jackpotAddress: jackpotAddress.toLowerCase(),
    ticketNftAddress: ticketNftAddress.toLowerCase(),
    usdcAddress: usdcAddress.toLowerCase(),
    custodyAddress: account.address.toLowerCase(),
    referrerAddress: referrer,
    jackpotCodeHash: await codeHash(jackpotAddress),
    ticketNftCodeHash: await codeHash(ticketNftAddress),
    usdcCodeHash: await codeHash(usdcAddress),
  };
  const rpc = makeMegapotV2RpcClient({ rpcUrl, attestation: deployment });
  await rpc.attestDeployment();

  await send(usdcAddress, token.abi, "transfer", [jackpotAddress, prize]);
  const drawingTime = BigInt(Math.floor(Date.now() / 1000) + 300);
  await send(jackpotAddress, fixture.abi, "armDrawing", [drawingTime, prize]);
  await send(usdcAddress, token.abi, "approve", [jackpotAddress, price]);
  const before = await rpc.readCurrentDrawing();
  assert.equal(before.drawingId, 1n);
  assert.equal(before.state.prizePool, prize);

  const purchaseHash = await walletClient.sendTransaction({
    to: jackpotAddress,
    data: encodeMegapotBuyTickets({
      tickets,
      recipient: account.address,
      referrers: [referrer],
      referralSplit: [1_000_000_000_000_000_000n],
      source,
    }),
  });
  await mined(purchaseHash);
  const purchaseReceipt = await rpc.readReceipt(purchaseHash);
  assert.ok(purchaseReceipt);
  const purchase = validateMegapotPurchaseReceipt({
    deployment,
    receipt: purchaseReceipt,
    drawingId: 1n,
    source,
    tickets,
  });
  assert.equal(purchase.ticketIds.length, 1);
  const ticketId = purchase.ticketIds[0];
  assert.ok(ticketId !== undefined);
  assert.equal(await rpc.readTicketOwner(ticketId), account.address.toLowerCase());

  await localRpc("evm_setNextBlockTimestamp", [Number(drawingTime + 1n)]);
  await send(jackpotAddress, fixture.abi, "settleDrawing", []);
  const winning = await rpc.readDrawing(1n);
  assert.equal(winning.winningTicket, ticketId);
  assert.equal((await rpc.readTicketTierIds([ticketId]))[0], 1n);
  assert.equal((await rpc.readDrawingTierPayouts(1n))[1], prize);
  assert.equal(await rpc.readCurrentDrawingId(), 2n);

  const balanceBefore = await rpc.readUsdcBalance(account.address);
  const claimHash = await walletClient.sendTransaction({
    to: jackpotAddress,
    data: encodeMegapotClaimWinnings([ticketId]),
  });
  await mined(claimHash);
  const claimReceipt = await rpc.readReceipt(claimHash);
  assert.ok(claimReceipt);
  const claim = validateMegapotClaimReceipt({
    deployment,
    receipt: claimReceipt,
    drawingId: 1n,
    ticketIds: [ticketId],
    expectedGrossWinningsAtomic: prize,
    expectedNetWinningsAtomic: prize,
    expectedReferralAccrualAtomic: 0n,
  });
  assert.equal(claim.netWinningsAtomic, prize);
  assert.equal(await rpc.readUsdcBalance(account.address), balanceBefore + prize);
  process.stdout.write(JSON.stringify({
    chainId: 84_532,
    jackpotAddress,
    ticketNftAddress,
    purchaseHash,
    claimHash,
    ticketId: ticketId.toString(),
    paidToCustodyAtomic: prize.toString(),
  }) + "\n");
}

await main();
