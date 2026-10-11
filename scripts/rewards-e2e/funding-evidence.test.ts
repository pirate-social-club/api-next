import { expect, test } from "bun:test";
import { verifyConfirmedFunding } from "./funding-evidence.mjs";

const now = Date.parse("2026-10-04T12:00:00Z");
const hash = `0x${"a".repeat(64)}`,
  blockHash = `0x${"b".repeat(64)}`;
const token = `0x${"c".repeat(40)}`,
  sender = `0x${"d".repeat(40)}`,
  custody = `0x${"e".repeat(40)}`;
const expected = {
  chainId: 84532,
  transactionHash: hash,
  sender,
  custody,
  token,
  amountAtomic: "1000000",
  offerId: "offer-1",
  legId: "leg-1",
  effectId: "fund-1",
  accountId: "actor-1",
  attestationId: "fixture-1",
  communityId: "community-1",
  postId: "post-1",
  drawingId: "1",
  controlRevision: "1",
  startedAt: now - 60000,
  deadline: now + 60000,
};
function fixture() {
  const row = {
    offer_id: "offer-1",
    leg_id: "leg-1",
    funding_effect_id: "fund-1",
    state: "confirmed",
    transaction_hash: hash,
    kind: "megapot_pool",
    offer_status: "active",
    leg_status: "active",
    creator: "actor-1",
    community_id: "community-1",
    post_id: "post-1",
    audio_revision: "1",
    attestation_status: "active",
    leg_funder: "actor-1",
    funder_account_id: "actor-1",
    sender_address: sender,
    recipient_address: custody,
    custody_address: custody,
    token_address: token,
    leg_token: token,
    usdc_address: token,
    chain_id: "84532",
    leg_chain_id: "84532",
    attestation_chain_id: "84532",
    environment: "test",
    attestation_id: "fixture-1",
    drawing_id: "1",
    tickets_per_drawing: 1,
    max_ticket_price_atomic: "50000",
    entry_cutoff_seconds: 300,
    expected_amount_atomic: "1000000",
    confirmed_amount_atomic: "1000000",
    funded_atomic: "1000000",
    window_offer_count: "1",
    leg_count: "1",
    funding_count: "1",
    paused: false,
    control_revision: "1",
    failure_reason: null,
    required_confirmations: 3,
    block_hash: blockHash,
    block_number: "100",
    log_index: 0,
    offer_created_at: new Date(now - 50000),
    leg_created_at: new Date(now - 40000),
    created_at: new Date(now - 30000),
    confirmed_at: new Date(now - 10000),
  };
  const log = {
    address: token,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${sender.slice(2).padStart(64, "0")}`,
      `0x${custody.slice(2).padStart(64, "0")}`,
    ],
    data: `0x${(1000000).toString(16).padStart(64, "0")}`,
    removed: false,
    transactionHash: hash,
    blockHash,
    blockNumber: "0x64",
    logIndex: "0x0",
  };
  const chain = {
    chainId: "0x14a34",
    receipt: { status: "0x1", transactionHash: hash, blockHash, blockNumber: "0x64", logs: [log] },
    block: { hash: blockHash, number: "0x64" },
    head: {
      hash: `0x${"f".repeat(64)}`,
      number: "0x66",
      timestamp: `0x${(now / 1000).toString(16)}`,
    },
  };
  return { row, chain };
}
test("exact confirmed database funding and canonical transfer establish funding phase", () => {
  const { row, chain } = fixture();
  expect(verifyConfirmedFunding([row], chain, expected, now).phase).toBe("funding-confirmed");
});
test("a mismatched funding hash, pending effect, wrong leg or changed brake refuses", () => {
  const { row, chain } = fixture();
  for (const change of [
    { transaction_hash: `0x${"f".repeat(64)}` },
    { state: "confirming" },
    { leg_id: "another-leg" },
    { paused: true },
    { control_revision: "2" },
    { attestation_status: "retired" },
    { community_id: "another-community" },
    { environment: "staging" },
  ])
    expect(() => verifyConfirmedFunding([{ ...row, ...change }], chain, expected, now)).toThrow(
      "Database",
    );
});
test("a reorg, missing confirmations, stale head or duplicate transfer refuses", () => {
  for (const change of ["reorg", "confirmations", "stale", "duplicate", "amount"]) {
    const { row, chain } = fixture();
    if (change === "reorg") chain.block.hash = `0x${"f".repeat(64)}`;
    if (change === "confirmations") chain.head.number = "0x65";
    if (change === "stale") chain.head.timestamp = "0x1";
    if (change === "duplicate") chain.receipt.logs.push({ ...chain.receipt.logs[0]! });
    if (change === "amount") chain.receipt.logs[0]!.data = `0x${"0".repeat(64)}`;
    expect(() => verifyConfirmedFunding([row], chain, expected, now)).toThrow();
  }
});
test("the funding deadline cannot be extended by a confirmed receipt", () => {
  const { row, chain } = fixture();
  expect(() => verifyConfirmedFunding([row], chain, { ...expected, deadline: now }, now)).toThrow(
    "expired",
  );
});
