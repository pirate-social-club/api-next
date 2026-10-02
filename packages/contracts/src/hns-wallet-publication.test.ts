import { expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { HnsWalletPublicationCommandV1 } from "./hns-wallet-publication.ts";

test("transaction reports require a valid dispatch secret at the contract boundary", () => {
  const report = { command: "report_txid", attempt_id: "attempt-1", txid: "b".repeat(64) };
  const decode = Schema.decodeUnknownOption(HnsWalletPublicationCommandV1);
  expect(Option.isNone(decode(report))).toBe(true);
  expect(Option.isNone(decode({ ...report, dispatch_secret: null }))).toBe(true);
  expect(Option.isNone(decode({ ...report, dispatch_secret: "invalid" }))).toBe(true);
  expect(Option.isSome(decode({ ...report, dispatch_secret: "a".repeat(64) }))).toBe(true);
});
