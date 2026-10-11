import { expect, test } from "bun:test";
import { readBrowserAccount, waitForBrowserAccount } from "./browser-accounts.mjs";

test("an asynchronous app exchange repeats only reads before accepting the exact account", async () => {
  let time = 0,
    reads = 0;
  const result = await waitForBrowserAccount(
    async () => {
      reads++;
      return reads < 3
        ? { status: 401, complete: false }
        : { status: 200, complete: true, accountId: "fixture-account" };
    },
    "fixture-account",
    {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    },
  );
  expect(result.verified).toBe(true);
  expect(reads).toBe(3);
});
test("another authenticated account, form refusal and unexpected API statuses refuse", async () => {
  for (const observed of [
    { status: 200, complete: true, accountId: "other-account" },
    { status: 401, complete: false, failed: true },
    { status: 503, complete: false },
  ])
    await expect(waitForBrowserAccount(async () => observed, "fixture-account")).rejects.toThrow(
      "refused",
    );
});
test("a read arriving after the authentication deadline cannot complete preparation", async () => {
  let time = 0;
  await expect(
    waitForBrowserAccount(
      async () => {
        time = 30_001;
        return { status: 200, complete: true, accountId: "fixture-account" };
      },
      "fixture-account",
      { now: () => time },
    ),
  ).rejects.toMatchObject({ phase: "completion-timeout" });
});
test("account reads refuse shared origins before any browser request", async () => {
  let requests = 0;
  await expect(
    readBrowserAccount({
      url: () => "https://web-next-staging.pirate.sc/",
      evaluate: async () => {
        requests++;
      },
    }),
  ).rejects.toMatchObject({ phase: "wrong-origin" });
  expect(requests).toBe(0);
});
test("provider failures never propagate credentials or raw diagnostics", async () => {
  const secret = "private-provider-value";
  try {
    await waitForBrowserAccount(async () => {
      throw new Error(secret);
    }, "fixture-account");
    throw new Error("Expected refusal");
  } catch (error) {
    expect(String(error)).not.toContain(secret);
    expect(error).toMatchObject({ phase: "account-read-failed" });
  }
});
