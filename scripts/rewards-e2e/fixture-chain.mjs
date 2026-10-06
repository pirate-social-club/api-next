import { writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { fixtureCustody, fixtureSponsorWallet } from "./run-evidence.mjs";
import { executeOnce } from "./single-use.mjs";
import { feeCeilings, reserveSpending } from "./spending-ledger.mjs";
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
  "function allowTicketPurchases() view returns(bool)",
  "function armDrawingWithOutcome(uint256,uint256,bool)",
  "function rescheduleEmptyDrawing(uint256)",
  "function settleDrawing()",
  "function settlePurchasedDrawing(uint256,uint256)",
]);
export function fixtureChain() {
  const account = privateKeyToAccount(process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY);
  if (account.address.toLowerCase() !== fixtureOperator) throw Error("Fixture operator differs");
  const transport = http("https://base-sepolia-rpc.publicnode.com", {
    // Reads may retry. A resent write is the same signed bytes and nonce, never a second one.
    retryCount: 2,
    timeout: 20000,
  });
  return {
    account,
    publicClient: createPublicClient({ chain: baseSepolia, transport }),
    wallet: createWalletClient({ chain: baseSepolia, transport, account }),
  };
}
export async function canonicalFixtureTransaction(
  chain,
  hash,
  deadline,
  { now = Date.now, sleep = (ms) => Bun.sleep(ms) } = {},
) {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw Error("Invalid transaction hash");
  while (now() < deadline) {
    let receipt;
    try {
      receipt = await chain.publicClient.getTransactionReceipt({ hash });
    } catch {
      await sleep(2000);
      continue;
    }
    // A mined revert is final for this hash; reject it before any further read.
    if (receipt.status !== "success") throw Error("Fixture transaction reverted");
    let block, head;
    try {
      [block, head] = await Promise.all([
        chain.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
        chain.publicClient.getBlockNumber(),
      ]);
    } catch {
      await sleep(2000);
      continue;
    }
    // Evidence that arrives after the deadline is not accepted.
    if (now() >= deadline) break;
    // Load-balanced public nodes can briefly disagree about a fresh block. A receipt
    // is accepted only once the block read back by number has the same hash and
    // three confirmations; until then this keeps reading, and never resubmits.
    if (block.hash === receipt.blockHash && head - receipt.blockNumber + 1n >= 3n) return receipt;
    await sleep(2000);
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
      if (maximumFee > feeCeilings.fixtureTransactionWei) throw Error("Fixture fee exceeds limit");
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
      const receipt = await canonicalFixtureTransaction(
        chain,
        hash,
        Math.min(Date.now() + 120000, run.deadline),
      );
      return { hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
    },
    { recheck: check, deadline: run.deadline },
  );
}
/**
 * The ETH the Workers and the sponsor wallet can spend on their own. It is one
 * exposure, reserved once for the authorization and not again per run.
 */
export async function readManagedFloat(chain) {
  const balances = await Promise.all(
    [fixtureCustody, fixtureSponsorWallet, "0x85ea2bce79f4cf8489457577ce75f98c47c90c6a"].map(
      (address) => chain.publicClient.getBalance({ address }),
    ),
  );
  return balances.reduce((sum, value) => sum + value, 0n);
}
/** The prize the fixture can pay out now; the pair budget counts a refill when it is short. */
export function readFixturePrize(chain) {
  return chain.publicClient.readContract({
    address: fixtureToken,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [fixtureJackpot],
  });
}
export async function fundFixturePrize(chain, run, check) {
  const balance = await readFixturePrize(chain);
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
/** Only a contract revert means "no"; a refused read must not look like one. */
const simulates = async (chain, functionName, args = []) => {
  try {
    await chain.publicClient.simulateContract({
      address: fixtureJackpot,
      abi: fixtureAbi,
      functionName,
      args,
      account: chain.account,
    });
    return true;
  } catch (error) {
    const reverted =
      typeof error?.walk === "function" &&
      error.walk(
        (cause) => /revert/i.test(cause?.name ?? "") || /revert/i.test(cause?.shortMessage ?? ""),
      );
    if (reverted) return false;
    throw error;
  }
};
const fixtureCall = (functionName, args = []) => ({
  address: fixtureJackpot,
  abi: fixtureAbi,
  functionName,
  args,
});
/**
 * The product starts a new leg on the drawing after the last one jobs observed.
 * A short empty placeholder is therefore armed first, and the outcome drawing
 * is armed only after the leg exists and the placeholder has settled.
 */
export async function armFixtureDrawing(chain, run, plan, check) {
  const { actionId, drawingTime, payoutAtomic, forceLoss, placeholder = false } = plan;
  if (
    !Number.isSafeInteger(drawingTime) ||
    drawingTime * 1000 < Date.now() + 120000 ||
    typeof payoutAtomic !== "bigint" ||
    payoutAtomic <= 0n ||
    !["win", "loss"].includes(run.outcome)
  )
    throw Error("Fixture drawing plan differs");
  if (!placeholder && forceLoss !== (run.outcome === "loss"))
    throw Error("Fixture outcome differs");
  if (placeholder && (forceLoss !== true || payoutAtomic !== 1n))
    throw Error("Fixture placeholder must be an empty forced loss");
  return sendFixtureTransaction(
    chain,
    {
      actionId,
      kind: "gas",
      usdcAtomic: "0",
      call: fixtureCall("armDrawingWithOutcome", [BigInt(drawingTime), payoutAtomic, forceLoss]),
    },
    run,
    check,
  );
}
/** Anyone may settle a due drawing; an empty one releases its reserved payout. */
export async function settleDueDrawing(chain, run, actionId, deadline, check) {
  while (!(await simulates(chain, "settleDrawing"))) {
    if (Date.now() >= deadline) throw Error("Fixture drawing did not become due");
    await check();
    await Bun.sleep(3000);
  }
  return sendFixtureTransaction(
    chain,
    { actionId, kind: "gas", usdcAtomic: "0", call: fixtureCall("settleDrawing") },
    run,
    check,
  );
}
/** A failed earlier run can leave the fixture armed, which refuses the next arm. */
export async function clearStaleFixtureDrawing(chain, run, check) {
  const open = await chain.publicClient.readContract(fixtureCall("allowTicketPurchases"));
  const actions = [];
  if (open) {
    const sooner = Math.floor(Date.now() / 1000) + 135;
    if (await simulates(chain, "rescheduleEmptyDrawing", [BigInt(sooner)]))
      actions.push(
        await sendFixtureTransaction(
          chain,
          {
            actionId: "reschedule-stale-drawing",
            kind: "gas",
            usdcAtomic: "0",
            call: fixtureCall("rescheduleEmptyDrawing", [BigInt(sooner)]),
          },
          run,
          check,
        ),
      );
  } else if (!(await simulates(chain, "settleDrawing"))) return { stale: false, actions };
  actions.push(
    await settleDueDrawing(chain, run, "settle-stale-drawing", Date.now() + 6 * 60000, check),
  );
  return { stale: true, actions };
}
export async function advancePurchasedDrawing(
  chain,
  run,
  drawingId,
  ticketId,
  check,
  actionId = "advance-purchased-drawing",
) {
  return sendFixtureTransaction(
    chain,
    {
      actionId,
      kind: "gas",
      usdcAtomic: "0",
      call: fixtureCall("settlePurchasedDrawing", [BigInt(drawingId), BigInt(ticketId)]),
    },
    run,
    check,
  );
}
