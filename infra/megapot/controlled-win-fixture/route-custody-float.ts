/** Route the owner's excess isolated test ETH to the custody signer. */
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const operator = getAddress("0x8fB9941a4782E4fc05467f9A3138c66C7F2aaCaF");
const custody = getAddress("0x544881290138fe0E66C1EC7D1A1f141395246f20");
const amount = 7_000_000_000_000_000n;
const maxGasCost = 10_000_000_000_000n;
const recordPath = "/tmp/megapot-e2e-config-20260926/custody-float.json";
if (Bun.argv.slice(2).some((arg) => arg !== "--execute")) throw new Error("unknown option");
const execute = Bun.argv.includes("--execute");
const key = process.env.MEGAPOT_E2E_OPERATOR_PRIVATE_KEY;
const rpcUrl = process.env.MEGAPOT_V2_RPC_URL;
if (!/^0x[0-9a-fA-F]{64}$/u.test(key ?? "") || !rpcUrl?.startsWith("https://")) {
  throw new Error("isolated operator key and HTTPS RPC are required");
}
const account = privateKeyToAccount(key as `0x${string}`);
if (account.address !== operator) throw new Error("operator key mismatch");
const rpc = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await rpc.getChainId() !== baseSepolia.id) throw new Error("wrong chain");
const [fromBalance, toBalance, latest, pending, fees] = await Promise.all([
  rpc.getBalance({ address: operator }), rpc.getBalance({ address: custody }),
  rpc.getTransactionCount({ address: operator, blockTag: "latest" }),
  rpc.getTransactionCount({ address: operator, blockTag: "pending" }),
  rpc.estimateFeesPerGas(),
]);
const gasLimit = 21_000n;
const maxFeePerGas = fees.maxFeePerGas;
const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
if (toBalance !== 0n || latest !== 2 || pending !== latest ||
    !maxFeePerGas || !maxPriorityFeePerGas ||
    gasLimit * maxFeePerGas > maxGasCost ||
    fromBalance - amount - gasLimit * maxFeePerGas < 5_000_000_000_000_000n) {
  throw new Error("custody-float recipient, nonce, gas cap or operator reserve failed");
}
const plan = { action: execute ? "execute" : "dry-run", chainId: baseSepolia.id,
  from: operator, to: custody, amountWei: amount.toString(), nonce: latest,
  gasLimit: gasLimit.toString(), maxCostWei: (gasLimit * maxFeePerGas).toString(),
  hardGasCostCapWei: maxGasCost.toString(), operatorBalanceBeforeWei: fromBalance.toString(),
  custodyBalanceBeforeWei: toBalance.toString() };
console.log(JSON.stringify(plan));
if (!execute) process.exit(0);
if (process.env.E2E_APPROVED_CUSTODY_FLOAT_WEI !== amount.toString()) {
  throw new Error("exact custody float was not approved");
}
try {
  await readFile(recordPath);
  throw new Error("custody float record already exists");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const hash = await wallet.sendTransaction({ to: custody, value: amount, gas: gasLimit,
  maxFeePerGas, maxPriorityFeePerGas });
console.log(JSON.stringify({ action: "submitted", hash }));
const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 3 });
const tx = await rpc.getTransaction({ hash });
const [afterOperator, afterCustody] = await Promise.all([
  rpc.getBalance({ address: operator }), rpc.getBalance({ address: custody }),
]);
if (receipt.status !== "success" || getAddress(tx.from) !== operator || !tx.to ||
    getAddress(tx.to) !== custody || tx.value !== amount || tx.nonce !== latest ||
    afterCustody !== amount || afterOperator < 5_000_000_000_000_000n) {
  throw new Error("custody-float receipt or final balances failed");
}
await writeFile(recordPath, `${JSON.stringify({ ...plan, hash,
  blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
  operatorBalanceAfterWei: afterOperator.toString(),
  custodyBalanceAfterWei: afterCustody.toString() })}\n`,
{ flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: "confirmed", hash,
  blockNumber: receipt.blockNumber.toString(), custodyBalanceWei: afterCustody.toString() }));
