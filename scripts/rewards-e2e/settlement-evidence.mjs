import { decodeEventLog, parseAbi } from "viem";
import { canonicalFixtureTransaction, fixtureJackpot, fixtureToken } from "./fixture-chain.mjs";
import { fixtureCustody, fixtureSponsorWallet } from "./run-evidence.mjs";

const transferAbi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export function assertSettlementTransfer(receipt, expected) {
  const transfers = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== fixtureToken) continue;
    let event;
    try {
      event = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (event.eventName === "Transfer") transfers.push(event.args);
  }
  if (
    transfers.length !== 1 ||
    transfers[0].from.toLowerCase() !== expected.sender ||
    transfers[0].to.toLowerCase() !== expected.recipient ||
    transfers[0].value.toString() !== expected.amountAtomic
  )
    throw Error("Canonical settlement transfer differs");
  return true;
}

/** Database completion is independently checked against canonical public receipts. */
export async function verifySettlementReceipts(run, inventory) {
  const payments = await run.db.read(
    `SELECT effect.transaction_hash, payout.destination_address AS recipient,
    payout.amount_atomic::text AS amount_atomic FROM reward_payout_effects payout
    JOIN reward_chain_effects effect ON effect.effect_id=payout.payout_effect_id
    WHERE payout.credit_id=ANY($1::text[]) AND effect.state='confirmed'`,
    [inventory.credits.map((credit) => credit.credit_id)],
  );
  if (payments.length !== (run.outcome === "win" ? 2 : 0))
    throw Error("Confirmed participant payout count differs");
  const expected = payments.map((payment) => ({
    hash: payment.transaction_hash,
    sender: fixtureCustody,
    recipient: payment.recipient,
    amountAtomic: payment.amount_atomic,
  }));
  for (const refund of inventory.refunds)
    expected.push({
      hash: refund.transaction_hash,
      sender: fixtureCustody,
      recipient: fixtureSponsorWallet,
      amountAtomic: refund.amount_atomic,
    });
  if (run.outcome === "win") {
    const claims = await run.db.read(
      `SELECT effect.transaction_hash FROM reward_chain_effects effect
      JOIN megapot_pool_drawings drawing ON drawing.claim_effect_id=effect.effect_id
      WHERE drawing.pool_leg_id=$1 AND effect.state='confirmed'`,
      [run.legId],
    );
    if (claims.length !== 1) throw Error("Confirmed jackpot claim count differs");
    expected.push({
      hash: claims[0].transaction_hash,
      sender: fixtureJackpot,
      recipient: fixtureCustody,
      amountAtomic: "1000000",
    });
  }
  const receipts = [];
  for (const transfer of expected) {
    const receipt = await canonicalFixtureTransaction(run.chain, transfer.hash, run.deadline);
    assertSettlementTransfer(receipt, transfer);
    receipts.push({
      ...transfer,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
    });
  }
  return receipts;
}
