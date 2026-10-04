import { writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { executeOnce } from "./single-use.mjs";
import { reserveSpending } from "./spending-ledger.mjs";
export const fixtureJackpot = "0xf856b59a9a9a5397aba89c647742b2a69d03d3c8";
export const fixtureToken = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
export const fixtureOperator = "0x8fb9941a4782e4fc05467f9a3138c66c7f2aacaf";
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
]);
const fixtureAbi = parseAbi([
  "function operator() view returns(address)",
  "function currentDrawingId() view returns(uint256)",
  "function armDrawingWithOutcome(uint256,uint256,bool)",
  "function settlePurchasedDrawing(uint256,uint256)",
]);
export function fixtureChain() {
  const account = privateKeyToAccount(process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY);
  if (account.address.toLowerCase() !== fixtureOperator) throw Error("Fixture operator differs");
  const transport = http("https://base-sepolia-rpc.publicnode.com", {
    retryCount: 0,
    timeout: 20000,
  });
  return {
    account,
    publicClient: createPublicClient({ chain: baseSepolia, transport }),
    wallet: createWalletClient({ chain: baseSepolia, transport, account }),
  };
}
export async function canonicalFixtureTransaction(chain, hash, deadline) {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw Error("Invalid transaction hash");
  while (Date.now() < deadline) {
    let receipt;
    try {
      receipt = await chain.publicClient.getTransactionReceipt({ hash });
    } catch {
      await Bun.sleep(2000);
      continue;
    }
    const [block, head] = await Promise.all([
      chain.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
      chain.publicClient.getBlockNumber(),
    ]);
    if (receipt.status !== "success" || block.hash !== receipt.blockHash)
      throw Error("Fixture transaction failed or reorganized");
    if (head - receipt.blockNumber + 1n >= 3n) return receipt;
    await Bun.sleep(2000);
  }
  throw Error("Fixture transaction confirmation uncertain; do not replay");
}
async function sendFixtureTransaction(chain, plan, run, check) {
  let request;
  return executeOnce(
    run.directory,
    plan.actionId,
    async () => {
      await check();
      if ((await chain.publicClient.getChainId()) !== 84532) throw Error("Wrong fixture chain");
      const [nonce, pending] = await Promise.all([
        chain.publicClient.getTransactionCount({
          address: chain.account.address,
          blockTag: "latest",
        }),
        chain.publicClient.getTransactionCount({
          address: chain.account.address,
          blockTag: "pending",
        }),
      ]);
      if (nonce !== pending) throw Error("Fixture operator has a pending transaction");
      const simulation = await chain.publicClient.simulateContract({
        ...plan.call,
        account: chain.account,
      });
      const gas = await chain.publicClient.estimateContractGas({
        ...plan.call,
        account: chain.account,
      });
      const fees = await chain.publicClient.estimateFeesPerGas();
      const gasLimit = (gas * 125n) / 100n;
      const maximumFee = gasLimit * fees.maxFeePerGas;
      if (maximumFee > 5000000000000000n) throw Error("Fixture fee exceeds limit");
      await reserveSpending(run.ledgerDirectory, {
        authoritySha256: run.authoritySha256,
        chainId: 84532,
        runId: run.runId,
        actionId: plan.actionId,
        kind: plan.kind,
        usdcAtomic: plan.usdcAtomic,
        ethWei: maximumFee.toString(),
      });
      request = { ...simulation.request, nonce, gas: gasLimit, ...fees };
    },
    async () => {
      const hash = await chain.wallet.writeContract(request);
      writeFileSync(
        `${run.directory}/${plan.actionId}-submitted.json`,
        JSON.stringify({ hash, chainId: 84532 }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      const receipt = await canonicalFixtureTransaction(chain, hash, Date.now() + 120000);
      return { hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
    },
    { recheck: check, deadline: run.deadline },
  );
}
export async function fundFixturePrize(chain, run, check) {
  const balance = await chain.publicClient.readContract({
    address: fixtureToken,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [fixtureJackpot],
  });
  if (balance >= 1000000n) return { alreadyFunded: true, balanceAtomic: balance.toString() };
  return sendFixtureTransaction(
    chain,
    {
      actionId: "fund-fixture-prize",
      kind: "prize",
      usdcAtomic: "1000000",
      call: {
        address: fixtureToken,
        abi: tokenAbi,
        functionName: "transfer",
        args: [fixtureJackpot, 1000000n],
      },
    },
    run,
    check,
  );
}
export async function armFixtureDrawing(chain, run, drawingTime, forceLoss, check) {
  if (
    !Number.isSafeInteger(drawingTime) ||
    drawingTime * 1000 < Date.now() + 120000 ||
    !["win", "loss"].includes(run.outcome)
  )
    throw Error("Fixture drawing plan differs");
  if (forceLoss !== (run.outcome === "loss")) throw Error("Fixture outcome differs");
  return sendFixtureTransaction(
    chain,
    {
      actionId: "arm-drawing",
      kind: "gas",
      usdcAtomic: "0",
      call: {
        address: fixtureJackpot,
        abi: fixtureAbi,
        functionName: "armDrawingWithOutcome",
        args: [BigInt(drawingTime), 1000000n, forceLoss],
      },
    },
    run,
    check,
  );
}
export async function advancePurchasedDrawing(chain, run, drawingId, ticketId, check) {
  return sendFixtureTransaction(
    chain,
    {
      actionId: "advance-purchased-drawing",
      kind: "gas",
      usdcAtomic: "0",
      call: {
        address: fixtureJackpot,
        abi: fixtureAbi,
        functionName: "settlePurchasedDrawing",
        args: [BigInt(drawingId), BigInt(ticketId)],
      },
    },
    run,
    check,
  );
}
