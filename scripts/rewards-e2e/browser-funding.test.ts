import { expect, test } from "bun:test";
import { trackFundingObservations, verifyTransferReview } from "./browser-funding.mjs";

const expected = {
  chainId: 84532,
  sender: `0x${"a".repeat(40)}`,
  recipient: `0x${"b".repeat(40)}`,
  token: `0x${"c".repeat(40)}`,
  amountAtomic: "1000000",
  maximumExecutionFeeWei: "1000000000000000",
};
const review = {
  network: "Base Sepolia · testnet",
  wallet: expected.sender,
  recipient: expected.recipient,
  token: expected.token,
  amount: "1 USDC",
  confirmations: "3",
  executionFee: "0.0001 ETH",
};
test("rendered isolated wallet transfer matches all exact terms", () => {
  expect(verifyTransferReview(review, expected).amountAtomic).toBe("1000000");
});
test("another wallet, custody, token, chain, amount or confirmation threshold refuses", () => {
  for (const changed of [
    { wallet: `0x${"d".repeat(40)}` },
    { recipient: `0x${"d".repeat(40)}` },
    { token: `0x${"d".repeat(40)}` },
    { network: "Base · mainnet" },
    { amount: "2 USDC" },
    { confirmations: "1" },
  ])
    expect(() => verifyTransferReview({ ...review, ...changed }, expected)).toThrow("differs");
});
test("fee overflow, negative amounts and malformed fee text refuse before transfer", () => {
  for (const executionFee of ["0.002 ETH", "-1 ETH", "1.0 USDC", "1e-4 ETH"])
    expect(() => verifyTransferReview({ ...review, executionFee }, expected)).toThrow("fee");
});

function fakePage() {
  const listeners = new Map<string, Set<(value: unknown) => unknown>>();
  return {
    on: (event: string, listener: (value: unknown) => unknown) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    },
    off: (event: string, listener: (value: unknown) => unknown) => {
      listeners.get(event)?.delete(listener);
    },
    emit: async (event: string, value: unknown) => {
      for (const listener of listeners.get(event) ?? []) await listener(value);
    },
  };
}
const observationUrl =
  "https://web.invalid/api/reward-offer-legs/leg-1/funding/effect-1/observations";
const request = (url = observationUrl, method = "POST") => ({
  method: () => method,
  url: () => url,
});
const response = (of: unknown, status: number, body: unknown) => ({
  request: () => of,
  status: () => status,
  json: async () => {
    if (body === undefined) throw new Error("not json");
    return body;
  },
});

test("each HTTP observation of the funding is counted until its answer arrives", async () => {
  const page = fakePage();
  const tracker = trackFundingObservations(page, "leg-1", "effect-1");
  expect(tracker.snapshot()).toEqual({ started: 0, answers: [], unanswered: 0 });
  const first = request();
  await page.emit("request", first);
  expect(tracker.snapshot()).toEqual({ started: 1, answers: [], unanswered: 1 });
  await page.emit("response", response(first, 200, { funding: { status: "confirming" } }));
  expect(tracker.snapshot()).toEqual({ started: 1, answers: ["confirming"], unanswered: 0 });
});

test("other requests are ignored and an unusable answer is never read as still waiting", async () => {
  const page = fakePage();
  const tracker = trackFundingObservations(page, "leg-1", "effect-1");
  for (const other of [
    request(observationUrl, "GET"),
    request("https://web.invalid/api/reward-offer-legs/leg-2/funding/effect-1/observations"),
    request("https://web.invalid/api/reward-offer-legs/leg-1/funding/effect-1"),
  ]) {
    await page.emit("request", other);
    await page.emit("response", response(other, 200, { funding: { status: "confirming" } }));
  }
  expect(tracker.snapshot().started).toBe(0);
  const refused = request();
  const unreadable = request();
  const shapeless = request();
  for (const made of [refused, unreadable, shapeless]) await page.emit("request", made);
  await page.emit("response", response(refused, 503, { funding: { status: "confirming" } }));
  await page.emit("response", response(unreadable, 200, undefined));
  await page.emit("response", response(shapeless, 200, { funding: {} }));
  expect(tracker.snapshot()).toEqual({
    started: 3,
    answers: ["http-503", "unreadable", "http-200"],
    unanswered: 0,
  });
});

test("a request that never gets an answer stays unanswered, and stopping ends the watch", async () => {
  const page = fakePage();
  const tracker = trackFundingObservations(page, "leg-1", "effect-1");
  await page.emit("request", request());
  // A failure in transit is not an answer: the server may still act on it.
  await page.emit("requestfailed", request());
  expect(tracker.snapshot()).toEqual({ started: 1, answers: [], unanswered: 1 });
  tracker.stop();
  await page.emit("request", request());
  expect(tracker.snapshot().started).toBe(1);
});
