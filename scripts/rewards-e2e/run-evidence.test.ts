import { expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { fixtureAccounts } from "./browser-accounts.mjs";
import { assertNothingOwed } from "./database-evidence.mjs";
import { fixtureJackpot } from "./fixture-chain.mjs";
import { singleParticipantCredit } from "./participant-policy.mjs";
import {
  assertActivityShares,
  expectedTicketLogs,
  fixtureCustody,
  fixturePersonas,
  fixtureSourceTag,
  waitForEvidence,
} from "./run-evidence.mjs";

test("a read completed after its deadline cannot pass evidence acceptance", async () => {
  const deadline = Date.now() + 100;
  await expect(
    waitForEvidence(
      "late read",
      deadline,
      async () => {
        await Bun.sleep(150);
        return true;
      },
      (result: boolean) => result,
    ),
  ).rejects.toThrow("deadline expired");
});

test("shares require different fixture accounts and each activity kind", () => {
  const shares = ["study", "karaoke"].map((role) => ({
    account_id: fixtureAccounts[role as "study"].accountId,
    persona_id: fixturePersonas[role as "study"],
    activity_key: role,
    score_bps: 7000,
  }));
  expect(assertActivityShares(shares)).toBe(true);
  expect(() => assertActivityShares([shares[0], shares[0]])).toThrow();
  expect(() =>
    assertActivityShares([...shares, { ...shares[1], account_id: "another" }]),
  ).toThrow();
  expect(() => assertActivityShares([shares[0], { ...shares[1], score_bps: 6999 }])).toThrow();
});
test("a confirmed receipt with the wrong recipient, drawing, ticket or duplicate event cannot advance", () => {
  const abi = parseAbi([
    "event TicketPurchased(address indexed recipient,uint256 indexed currentDrawingId,bytes32 indexed source,uint256 userTicketId,uint8[] normals,uint8 bonusball,bytes32 referralScheme)",
  ]);
  const log = {
    address: fixtureJackpot,
    topics: encodeEventTopics({
      abi,
      eventName: "TicketPurchased",
      args: { recipient: fixtureCustody, currentDrawingId: 1n, source: fixtureSourceTag },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8[]" }, { type: "uint8" }, { type: "bytes32" }],
      [2n, [1, 2, 3, 4, 5], 6, `0x${"0".repeat(64)}`],
    ),
  };
  expect(expectedTicketLogs({ logs: [log] }, { drawingId: "1", ticketId: "2" })).toBe(1);
  expect(() =>
    expectedTicketLogs({ logs: [log, log] }, { drawingId: "1", ticketId: "2" }),
  ).toThrow();
  expect(() => expectedTicketLogs({ logs: [log] }, { drawingId: "3", ticketId: "2" })).toThrow();
  expect(() => expectedTicketLogs({ logs: [log] }, { drawingId: "1", ticketId: "3" })).toThrow();
  const other = {
    ...log,
    topics: encodeEventTopics({
      abi,
      eventName: "TicketPurchased",
      args: {
        recipient: "0x1111111111111111111111111111111111111111",
        currentDrawingId: 1n,
        source: fixtureSourceTag,
      },
    }),
  };
  expect(() => expectedTicketLogs({ logs: [other] }, { drawingId: "1", ticketId: "2" })).toThrow();
});
test("claim pending and unpaid or reserved balances cannot pass closeout", () => {
  const settled = {
    legs: [
      {
        reserved_atomic: "0",
        funded_atomic: "1000000",
        spent_atomic: "10000",
        fulfilled_atomic: "0",
        refunded_atomic: "990000",
      },
    ],
    credits: [],
    purchases: [{ state: "confirmed", ticket_status: "no_win" }],
    refunds: [{ state: "confirmed" }],
    drawings: [{ status: "no_win" }],
  };
  expect(assertNothingOwed(settled).nothingOwed).toBe(true);
  expect(() =>
    assertNothingOwed({ ...settled, legs: [{ ...settled.legs[0], refunded_atomic: "0" }] }),
  ).toThrow();
  expect(() =>
    assertNothingOwed({
      ...settled,
      purchases: [{ state: "confirmed", ticket_status: "claim_pending" }],
    }),
  ).toThrow();
  expect(() =>
    assertNothingOwed({
      ...settled,
      credits: [
        { state: "credited", paid_atomic: "0", amount_atomic: "500000", reserved_atomic: "0" },
      ],
    }),
  ).toThrow();
});
test("participant claims refuse another persona or a changed allocation", () => {
  const credit = {
    account_id: fixtureAccounts.study.accountId,
    payout_persona_id: fixturePersonas.study,
    amount_atomic: "500000",
  };
  expect(singleParticipantCredit([credit], "study")).toEqual(credit);
  expect(() =>
    singleParticipantCredit([{ ...credit, amount_atomic: "1000000" }], "study"),
  ).toThrow();
  expect(() =>
    singleParticipantCredit([{ ...credit, payout_persona_id: fixturePersonas.karaoke }], "study"),
  ).toThrow();
});
