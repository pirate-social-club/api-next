/** Reservations survive failed sends, uncertain receipts and database rebuilds. */
import { mkdir, open, readdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";

export const spendingLimits = Object.freeze({
  usdcAtomic: 10_000_000n,
  ethWei: 50_000_000_000_000_000n,
  principalPerRunAtomic: 1_000_000n,
});

function amount(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Spending amounts must be unsigned decimal strings");
  }
  return BigInt(value);
}

function validate(record) {
  if (
    record.chainId !== 84532 ||
    !/^[a-f0-9]{64}$/.test(record.authoritySha256 ?? "") ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(record.runId ?? "") ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(record.actionId ?? "") ||
    !["principal", "prize", "payout", "send", "gas"].includes(record.kind)
  ) {
    throw new Error("Invalid isolated spending reservation");
  }
  const usdc = amount(record.usdcAtomic);
  const eth = amount(record.ethWei);
  if (usdc + eth === 0n) throw new Error("Empty spending reservation");
  if (record.kind === "principal" && usdc > spendingLimits.principalPerRunAtomic) {
    throw new Error("Per-run principal limit exceeded");
  }
  return { usdc, eth };
}

async function durableWrite(path, record) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function reserveSpending(directory, record) {
  const requested = validate(record);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".reservation-lock");
  // A stale lock requires explicit reconciliation; never silently replay a send.
  await mkdir(lock);
  try {
    let usdc = requested.usdc;
    let eth = requested.eth;
    let principal = record.kind === "principal" ? requested.usdc : 0n;
    const names = await readdir(directory);
    for (const name of names) {
      if (name === ".reservation-lock") continue;
      if (!name.endsWith(".json")) throw new Error("Unknown spending ledger entry");
      const previous = JSON.parse(await readFile(join(directory, name), "utf8"));
      const reserved = validate(previous);
      if (previous.authoritySha256 !== record.authoritySha256) {
        throw new Error("Spending authority changed; reconciliation required");
      }
      if (previous.runId === record.runId && previous.actionId === record.actionId) {
        throw new Error("Spending action already reserved; do not replay");
      }
      usdc += reserved.usdc;
      eth += reserved.eth;
      if (previous.runId === record.runId && previous.kind === "principal") {
        principal += reserved.usdc;
      }
    }
    if (principal > spendingLimits.principalPerRunAtomic) {
      throw new Error("Per-run principal limit exceeded");
    }
    if (usdc > spendingLimits.usdcAtomic || eth > spendingLimits.ethWei) {
      throw new Error("Aggregate isolated spending limit exceeded");
    }
    await durableWrite(join(directory, `${record.runId}--${record.actionId}.json`), record);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return { usdcReservedAtomic: usdc.toString(), ethReservedWei: eth.toString() };
  } finally {
    await rmdir(lock);
  }
}

/**
 * The fee ceiling each kind of action enforces before it reserves. They are far
 * above what Base Sepolia charges and low enough that a whole pair run at every
 * ceiling still fits the allowance. The actions import these; they are not
 * estimates kept beside the real limits.
 */
export const feeCeilings = Object.freeze({
  fixtureTransactionWei: 100_000_000_000_000n,
  fundingWei: 500_000_000_000_000n,
  winnerSendWei: 200_000_000_000_000n,
});

/**
 * The most a pair can do. Per scenario the fixture may be sent a reschedule and a
 * settlement of a stale drawing, a prize refill, the placeholder arm and its
 * settlement, the outcome arm, the advance and one recovery advance. Each
 * scenario funds one offer; the win pays two winners who each send onward.
 */
export const pairShape = Object.freeze({
  scenarios: 2n,
  fixtureTransactionsPerScenario: 8n,
  winnerSends: 2n,
});

/**
 * What one complete win and loss pair reserves: two offer principals, the
 * winners' onward sends of the prize, and the prize refill before the loss once
 * the win has paid it out. A fixture that does not already hold the prize needs
 * one more refill before the win. The ETH figure is every action at its ceiling.
 */
export const pairBudget = Object.freeze({
  usdcAtomic: 4_000_000n,
  prizeAtomic: 1_000_000n,
  ethWei:
    pairShape.scenarios *
      pairShape.fixtureTransactionsPerScenario *
      feeCeilings.fixtureTransactionWei +
    pairShape.scenarios * feeCeilings.fundingWei +
    pairShape.winnerSends * feeCeilings.winnerSendWei,
});
/**
 * Kept free beyond the pair, so that a run which stops after funding can still
 * be recovered, or one funded step repeated under a fresh approval, without
 * first exhausting the allowance.
 */
export const recoveryHeadroom = Object.freeze({
  usdcAtomic: 1_000_000n,
  ethWei: 2_000_000_000_000_000n,
});
const managedFloatEntry = "managed-float--worker-gas-float.json";

/** Read-only total of everything reserved so far under one authority. */
export async function readSpendingTotals(directory, authoritySha256) {
  let usdc = 0n;
  let eth = 0n;
  let entries = 0;
  let managedFloatReserved = false;
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    names = [];
  }
  for (const name of names) {
    // A leftover lock means a reservation may be half written; it needs reconciliation.
    if (name === ".reservation-lock") throw new Error("Spending ledger is locked; reconcile it");
    if (!name.endsWith(".json")) throw new Error("Unknown spending ledger entry");
    const record = JSON.parse(await readFile(join(directory, name), "utf8"));
    const reserved = validate(record);
    if (record.authoritySha256 !== authoritySha256)
      throw new Error("Spending authority changed; reconciliation required");
    usdc += reserved.usdc;
    eth += reserved.eth;
    entries += 1;
    if (name === managedFloatEntry) managedFloatReserved = true;
  }
  return { usdcAtomic: usdc, ethWei: eth, entries, managedFloatReserved };
}

/**
 * What a forced loss run alone reserves: its offer principal and every fixture
 * and funding action at its ceiling. It has no winners, so no onward sends; a
 * prize refill is added by the check when the fixture does not hold the prize.
 */
export const lossBudget = Object.freeze({
  usdcAtomic: 1_000_000n,
  prizeAtomic: pairBudget.prizeAtomic,
  ethWei:
    pairShape.fixtureTransactionsPerScenario * feeCeilings.fixtureTransactionWei +
    feeCeilings.fundingWei,
});

function assertRunBudget(
  label,
  base,
  directory,
  { authoritySha256, fixturePrizeAtomic, managedFloatWei },
) {
  if (typeof fixturePrizeAtomic !== "bigint" || fixturePrizeAtomic < 0n)
    throw new Error(`Fixture prize balance required for the ${label} budget`);
  if (typeof managedFloatWei !== "bigint" || managedFloatWei < 0n)
    throw new Error(`Managed float balance required for the ${label} budget`);
  return readSpendingTotals(directory, authoritySha256).then((reserved) => {
    const firstRefill = fixturePrizeAtomic >= base.prizeAtomic ? 0n : base.prizeAtomic;
    const unreservedFloat = reserved.managedFloatReserved ? 0n : managedFloatWei;
    const run = {
      usdcAtomic: base.usdcAtomic + firstRefill,
      ethWei: base.ethWei + unreservedFloat,
    };
    const after = {
      usdcAtomic: reserved.usdcAtomic + run.usdcAtomic + recoveryHeadroom.usdcAtomic,
      ethWei: reserved.ethWei + run.ethWei + recoveryHeadroom.ethWei,
    };
    const report = {
      reservedUsdcAtomic: reserved.usdcAtomic.toString(),
      reservedEthWei: reserved.ethWei.toString(),
      pairUsdcAtomic: run.usdcAtomic.toString(),
      pairEthWei: run.ethWei.toString(),
      unreservedManagedFloatWei: unreservedFloat.toString(),
      headroomUsdcAtomic: recoveryHeadroom.usdcAtomic.toString(),
      headroomEthWei: recoveryHeadroom.ethWei.toString(),
      limitUsdcAtomic: spendingLimits.usdcAtomic.toString(),
      limitEthWei: spendingLimits.ethWei.toString(),
    };
    const name = label === "pair" ? "Whole-pair" : "Loss-run";
    const what = label === "pair" ? "a pair" : "a loss run";
    if (after.usdcAtomic > spendingLimits.usdcAtomic)
      throw new Error(`${name} budget refused: USDC allowance cannot cover ${what} and recovery`);
    if (after.ethWei > spendingLimits.ethWei)
      throw new Error(`${name} budget refused: ETH allowance cannot cover ${what} and recovery`);
    return report;
  });
}

/**
 * Refuses before any funded action unless the whole pair, run at every fee
 * ceiling, and its recovery headroom fit under both limits. The managed gas
 * float is reserved once per authorization; if that has not happened yet, the
 * first scenario will reserve the wallets' current balances, so they count too.
 * It reserves nothing: each action still makes its own durable reservation, and
 * a refund never gives allowance back.
 */
export async function assertPairBudget(directory, options) {
  return assertRunBudget("pair", pairBudget, directory, options);
}

/** The same check for a forced loss run on its own, after a win already ran. */
export async function assertLossBudget(directory, options) {
  return assertRunBudget("loss", lossBudget, directory, options);
}
