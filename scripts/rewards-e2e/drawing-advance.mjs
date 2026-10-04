/** The controller must obtain this evidence from the database, jobs logs and public RPC. */
export function assertDrawingAdvanceReady({ purchase, firstRead, receipt, expected }) {
  const hash = /^0x[0-9a-f]{64}$/i;
  const nonzeroHash = (value) => hash.test(value ?? "") && !/^0x0{64}$/i.test(value);
  const natural = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
  if (
    expected.chainId !== 84532 ||
    !natural(expected.drawingId) ||
    !natural(expected.ticketId) ||
    !nonzeroHash(expected.transactionHash) ||
    typeof expected.jobsVersionId !== "string" ||
    expected.jobsVersionId.length === 0 ||
    typeof expected.effectId !== "string" ||
    expected.effectId.length === 0
  ) {
    throw new Error("Invalid isolated drawing identity");
  }
  if (
    purchase.status !== "confirmed" ||
    purchase.effectId !== expected.effectId ||
    purchase.drawingId !== expected.drawingId ||
    purchase.ticketId !== expected.ticketId ||
    purchase.transactionHash !== expected.transactionHash
  ) {
    throw new Error("Jobs ticket purchase is not confirmed for this drawing");
  }
  if (
    firstRead.source !== "jobs-worker" ||
    firstRead.versionId !== expected.jobsVersionId ||
    firstRead.effectId !== expected.effectId ||
    firstRead.transactionHash !== expected.transactionHash ||
    !Number.isSafeInteger(firstRead.attempt) ||
    firstRead.attempt < 1 ||
    !Number.isFinite(Date.parse(firstRead.observedAt))
  ) {
    throw new Error("The first jobs Worker receipt read is missing or mismatched");
  }
  if (
    receipt.chainId !== expected.chainId ||
    receipt.transactionHash !== expected.transactionHash ||
    receipt.status !== "success" ||
    !natural(receipt.blockNumber) ||
    !nonzeroHash(receipt.blockHash) ||
    receipt.blockHash !== receipt.canonicalBlockHash ||
    !Number.isSafeInteger(receipt.confirmations) ||
    receipt.confirmations < 3 ||
    receipt.expectedPurchaseLogCount !== 1
  ) {
    throw new Error("Canonical ticket purchase receipt is not independently confirmed");
  }
  return { drawingId: expected.drawingId, ticketId: expected.ticketId };
}
