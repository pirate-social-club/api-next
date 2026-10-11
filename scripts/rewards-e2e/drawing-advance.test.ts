import { expect, test } from "bun:test";
import { assertDrawingAdvanceReady } from "./drawing-advance.mjs";

function proof() {
  const expected = {
    chainId: 84532,
    drawingId: "2",
    ticketId: "1",
    transactionHash: `0x${"a".repeat(64)}`,
    jobsVersionId: "isolated-jobs-version",
    effectId: "purchase-effect-1",
  };
  return {
    expected,
    purchase: { ...expected, status: "confirmed" },
    firstRead: {
      ...expected,
      source: "jobs-worker",
      versionId: expected.jobsVersionId,
      attempt: 1,
      observedAt: "2026-10-04T06:10:00Z",
    },
    receipt: {
      ...expected,
      status: "success",
      blockNumber: "12",
      blockHash: `0x${"b".repeat(64)}`,
      canonicalBlockHash: `0x${"b".repeat(64)}`,
      confirmations: 3,
      expectedPurchaseLogCount: 1,
    },
  };
}

test("a confirmed purchase without a jobs receipt read cannot advance", () => {
  const input = proof();
  input.firstRead.attempt = 0;
  expect(() => assertDrawingAdvanceReady(input)).toThrow("first jobs Worker");
});

test("an operator receipt read cannot substitute for the jobs Worker", () => {
  const input = proof();
  input.firstRead.source = "operator";
  expect(() => assertDrawingAdvanceReady(input)).toThrow("first jobs Worker");
});

test("a receipt read for a different effect or Worker version refuses", () => {
  for (const key of ["effectId", "versionId"] as const) {
    const input = proof();
    input.firstRead[key] = "another-value";
    expect(() => assertDrawingAdvanceReady(input)).toThrow("first jobs Worker");
  }
});

test("a canonical receipt cannot compensate for an unconfirmed database effect", () => {
  const input = proof();
  input.purchase.status = "pending";
  expect(() => assertDrawingAdvanceReady(input)).toThrow("purchase is not confirmed");
});

test("a reorged or uncertain purchase receipt refuses", () => {
  const reorg = proof();
  reorg.receipt.canonicalBlockHash = `0x${"c".repeat(64)}`;
  expect(() => assertDrawingAdvanceReady(reorg)).toThrow("Canonical");
  const uncertain = proof();
  uncertain.receipt.confirmations = 2;
  expect(() => assertDrawingAdvanceReady(uncertain)).toThrow("Canonical");
});

test("a fully verified receipt returns only the exact controller identities", () => {
  expect(assertDrawingAdvanceReady(proof())).toEqual({ drawingId: "2", ticketId: "1" });
});

test("a later jobs receipt read cannot be presented as the first read", () => {
  const input = proof();
  input.firstRead.attempt = 2;
  expect(() => assertDrawingAdvanceReady(input)).toThrow("first jobs Worker");
});
