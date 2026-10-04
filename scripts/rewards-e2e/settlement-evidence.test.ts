import { expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { fixtureToken } from "./fixture-chain.mjs";
import { assertSettlementTransfer } from "./settlement-evidence.mjs";

const abi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const log = {
  address: fixtureToken,
  topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }),
  data: encodeAbiParameters([{ type: "uint256" }], [500000n]),
};
test("settlement requires exactly the expected canonical USDC transfer", () => {
  const expected = { sender: from, recipient: to, amountAtomic: "500000" };
  expect(assertSettlementTransfer({ logs: [log] }, expected)).toBe(true);
  for (const logs of [[], [log, log], [{ ...log, address: from }]])
    expect(() => assertSettlementTransfer({ logs }, expected)).toThrow();
  for (const change of [{ sender: to }, { recipient: from }, { amountAtomic: "499999" }])
    expect(() => assertSettlementTransfer({ logs: [log] }, { ...expected, ...change })).toThrow();
});
