const hash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const address = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
const quantity = (value) => {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value))
    throw new Error("Malformed public chain quantity");
  return BigInt(value);
};
const word = (value) => `0x${value.slice(2).padStart(64, "0")}`;
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The window's exact database effect must agree with the independently canonical transfer. */
export function verifyConfirmedFunding(rows, chain, expected, now = Date.now()) {
  if (
    expected.chainId !== 84532 ||
    !hash(expected.transactionHash) ||
    ![expected.sender, expected.custody, expected.token].every(address) ||
    expected.amountAtomic !== "1000000" ||
    !expected.offerId ||
    !expected.legId ||
    !expected.effectId ||
    !expected.communityId ||
    !expected.postId ||
    !expected.accountId ||
    !expected.attestationId ||
    !/^[1-9][0-9]*$/.test(expected.drawingId ?? "") ||
    !/^(0|[1-9][0-9]*)$/.test(expected.controlRevision ?? "") ||
    !Number.isFinite(expected.startedAt) ||
    !Number.isFinite(expected.deadline) ||
    expected.startedAt > now ||
    now >= expected.deadline
  )
    throw new Error("Funding plan is invalid or expired");
  if (rows.length !== 1) throw new Error("Funding effect must be unique");
  const row = rows[0];
  if (
    row.offer_id !== expected.offerId ||
    row.leg_id !== expected.legId ||
    row.funding_effect_id !== expected.effectId ||
    row.community_id !== expected.communityId ||
    row.post_id !== expected.postId ||
    String(row.audio_revision) !== "1" ||
    row.attestation_status !== "active" ||
    row.state !== "confirmed" ||
    row.transaction_hash !== expected.transactionHash ||
    row.kind !== "megapot_pool" ||
    row.offer_status !== "active" ||
    row.leg_status !== "active" ||
    row.creator !== expected.accountId ||
    row.leg_funder !== expected.accountId ||
    row.funder_account_id !== expected.accountId ||
    row.sender_address !== expected.sender ||
    row.recipient_address !== expected.custody ||
    row.custody_address !== expected.custody ||
    row.token_address !== expected.token ||
    row.leg_token !== expected.token ||
    row.usdc_address !== expected.token ||
    String(row.chain_id) !== "84532" ||
    String(row.leg_chain_id) !== "84532" ||
    String(row.attestation_chain_id) !== "84532" ||
    row.environment !== "test" ||
    row.attestation_id !== expected.attestationId ||
    String(row.drawing_id) !== expected.drawingId ||
    String(row.tickets_per_drawing) !== "1" ||
    String(row.max_ticket_price_atomic) !== "50000" ||
    String(row.entry_cutoff_seconds) !== "300" ||
    [row.expected_amount_atomic, row.confirmed_amount_atomic, row.funded_atomic].some(
      (value) => String(value) !== expected.amountAtomic,
    ) ||
    [row.window_offer_count, row.leg_count, row.funding_count].some(
      (value) => String(value) !== "1",
    ) ||
    row.paused !== false ||
    String(row.control_revision) !== expected.controlRevision ||
    row.failure_reason !== null ||
    row.required_confirmations !== 3 ||
    !hash(row.block_hash) ||
    !/^[1-9][0-9]*$/.test(String(row.block_number)) ||
    !Number.isSafeInteger(row.log_index) ||
    row.log_index < 0
  )
    throw new Error("Database funding differs from the isolated run");
  let previous = expected.startedAt;
  for (const value of [
    row.offer_created_at,
    row.leg_created_at,
    row.created_at,
    row.confirmed_at,
  ]) {
    const at = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(at) || at < previous || at > now || at >= expected.deadline)
      throw new Error("Database funding timestamps differ from this run");
    previous = at;
  }
  const { receipt, block, head } = chain;
  if (
    quantity(chain.chainId) !== 84532n ||
    receipt?.status !== "0x1" ||
    receipt.transactionHash !== expected.transactionHash ||
    receipt.blockHash !== row.block_hash ||
    quantity(receipt.blockNumber) !== BigInt(row.block_number) ||
    block?.hash !== receipt.blockHash ||
    quantity(block.number) !== quantity(receipt.blockNumber) ||
    !hash(head?.hash) ||
    quantity(head.number) - quantity(block.number) + 1n < 3n ||
    Math.abs(now - Number(quantity(head.timestamp)) * 1000) > 30000 ||
    !Array.isArray(receipt.logs)
  )
    throw new Error("Funding receipt is reverted, stale or noncanonical");
  const transfers = receipt.logs.filter(
    (log) => log.address?.toLowerCase() === expected.token && log.topics?.[0] === transferTopic,
  );
  const log = transfers[0];
  if (
    transfers.length !== 1 ||
    log.removed !== false ||
    log.transactionHash !== expected.transactionHash ||
    log.blockHash !== receipt.blockHash ||
    quantity(log.blockNumber) !== BigInt(row.block_number) ||
    quantity(log.logIndex) !== BigInt(row.log_index) ||
    log.topics.length !== 3 ||
    log.topics[1] !== word(expected.sender) ||
    log.topics[2] !== word(expected.custody) ||
    !hash(log.data) ||
    quantity(log.data) !== 1000000n
  )
    throw new Error("Funding receipt must contain exactly the expected transfer");
  return {
    phase: "funding-confirmed",
    offerId: expected.offerId,
    legId: expected.legId,
    effectId: expected.effectId,
    transactionHash: expected.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: row.block_number.toString(),
    confirmedAt:
      row.confirmed_at instanceof Date ? row.confirmed_at.toISOString() : row.confirmed_at,
    attestationId: expected.attestationId,
  };
}
