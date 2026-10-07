import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstJobsReceiptRead, receiptEvents } from "./receipt-evidence.mjs";
import { subscribeJobsEvidence, subscribeJobsReceipts } from "./receipt-observer.mjs";
import { isolatedEnvironment } from "./worker-plan.mjs";

const transactionHash = `0x${"a".repeat(64)}`;
const expected = {
  transactionHash,
  effectId: "purchase-1",
  jobsVersionId: "jobs-1",
  attestationId: "fixture-1",
};
function observation(sequence = 1) {
  return {
    event: "megapot_receipt_read",
    job: "megapot-rewards.cycle",
    environment: isolatedEnvironment,
    chainId: 84532,
    workerVersion: { id: "jobs-1", secret: "must-not-copy" },
    attemptId: "attempt-1",
    rpcClientId: "rpc-1",
    clientReadSequence: sequence + 4,
    transactionReadSequence: sequence,
    observedAt: new Date().toISOString(),
    requestedTransactionHash: transactionHash,
    attestationId: "fixture-1",
    result: "not_found",
    token: "must-not-copy",
  };
}
function capture() {
  return {
    worker: "pirate-jobs-worker-megapot-e2e-staging",
    outcome: "subscribed",
    connectedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    subscriptionGaps: 0,
    parseFailures: 0,
    events: receiptEvents({ logs: [{ message: [observation()] }] }),
  };
}

test("a jobs not-found first read counts as an observation before canonical confirmation", () => {
  expect(firstJobsReceiptRead(capture(), expected)).toMatchObject({
    source: "jobs-worker",
    effectId: "purchase-1",
    attempt: 1,
    result: "not_found",
  });
});
test("later reads and another transaction cannot stand in for the first read", () => {
  const input = capture();
  if (!input.events[0]) throw new Error("Missing fixture event");
  input.events[0].transactionReadSequence = 2;
  expect(() => firstJobsReceiptRead(input, expected)).toThrow("not captured");
  input.events[0].transactionReadSequence = 1;
  input.events[0].transactionHash = `0x${"b".repeat(64)}`;
  expect(() => firstJobsReceiptRead(input, expected)).toThrow("not captured");
});
test("gaps, parse failures, expiry and changed receipt sources fail closed", () => {
  for (const change of [
    { subscriptionGaps: 1 },
    { parseFailures: 1 },
    { outcome: "connecting" },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
  ])
    expect(() => firstJobsReceiptRead({ ...capture(), ...change }, expected)).toThrow("incomplete");
  for (const change of [
    { versionId: "another-version" },
    { attestationId: "another-fixture" },
    { observedAt: "2026-01-01T00:00:00Z" },
  ]) {
    const input = capture();
    if (!input.events[0]) throw new Error("Missing fixture event");
    Object.assign(input.events[0], change);
    expect(() => firstJobsReceiptRead(input, expected)).toThrow("source changed");
  }
});
test("sanitization strips nested extras and rejects malformed relevant observations", () => {
  const safe = receiptEvents({ logs: [{ message: ["irrelevant log", observation()] }] });
  expect(JSON.stringify(safe)).not.toContain("must-not-copy");
  expect(() => receiptEvents({ logs: [{ message: ['{"event":"megapot_receipt_read"'] }] })).toThrow(
    "Unparseable",
  );
  expect(() =>
    receiptEvents({ logs: [{ message: [{ ...observation(), environment: "staging" }] }] }),
  ).toThrow("Invalid isolated");
});

class Socket extends EventTarget {
  static last: Socket;
  constructor() {
    super();
    Socket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send() {}
  close() {
    this.dispatchEvent(new Event("close"));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
test("subscription captures before use, preserves public evidence and deletes exactly its own tail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rewards-tail-"));
  const calls: string[] = [];
  try {
    const observer = await subscribeJobsReceipts(directory, {
      Socket,
      api: async (path: string, init: RequestInit) => {
        calls.push(`${init.method} ${path}`);
        return {
          id: "tail-1",
          url: "wss://fixture.invalid/private-tail-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    });
    expect(observer.capture.outcome).toBe("subscribed");
    Socket.last.message({ logs: [{ message: [observation()] }] });
    await observer.flush();
    expect(firstJobsReceiptRead(observer.capture, expected).attempt).toBe(1);
    const closed = await observer.close();
    expect(closed.outcome).toBe("capture-ended");
    expect(calls).toEqual([
      "POST /workers/scripts/pirate-jobs-worker-megapot-e2e-staging/tails",
      "DELETE /workers/scripts/pirate-jobs-worker-megapot-e2e-staging/tails/tail-1",
    ]);
    const evidence =
      readFileSync(join(directory, "receipt-observations.jsonl"), "utf8") +
      readFileSync(join(directory, "receipt-observer.json"), "utf8");
    expect(evidence).not.toContain("private-tail-token");
    expect(evidence).not.toContain("must-not-copy");
    await expect(subscribeJobsReceipts(directory, { Socket })).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("an unexpected disconnect makes already captured evidence unusable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rewards-tail-gap-"));
  try {
    const observer = await subscribeJobsReceipts(directory, {
      Socket,
      api: async () => ({
        id: "tail-2",
        url: "wss://fixture.invalid/tail",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    Socket.last.message({ logs: [{ message: [observation()] }] });
    await observer.flush();
    Socket.last.dispatchEvent(new Event("close"));
    expect(() => firstJobsReceiptRead(observer.capture, expected)).toThrow("incomplete");
    expect((await observer.close()).outcome).toBe("capture-incomplete");
  } finally {
    rmSync(directory, { recursive: true });
  }
});

for (const type of ["overload", "overload-stop"]) {
  test(`native ${type} tail control refuses later sequence-one evidence`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "rewards-tail-overload-"));
    try {
      const observer = await subscribeJobsReceipts(directory, {
        Socket,
        api: async () => ({
          id: "tail-overload",
          url: "wss://fixture.invalid/tail",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      Socket.last.message({ event: { type }, logs: [], exceptions: [] });
      Socket.last.message({ logs: [{ message: [observation()] }] });
      await observer.flush();
      expect(() => firstJobsReceiptRead(observer.capture, expected)).toThrow("incomplete");
      expect((await observer.close()).outcome).toBe("capture-incomplete");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
test("metadata storage failure taints evidence and still deletes the owned tail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rewards-tail-storage-"));
  const calls: string[] = [];
  const observer = await subscribeJobsReceipts(directory, {
    Socket,
    api: async (path: string, init: RequestInit) => {
      calls.push(`${init.method} ${path}`);
      return {
        id: "tail-storage",
        url: "wss://fixture.invalid/tail",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  });
  rmSync(directory, { recursive: true });
  Socket.last.message({ logs: [{ message: [observation()] }] });
  await observer.flush();
  expect(() => firstJobsReceiptRead(observer.capture, expected)).toThrow("incomplete");
  Socket.last.dispatchEvent(new Event("close"));
  expect((await observer.close()).outcome).toBe("capture-incomplete");
  expect(calls).toEqual([
    "POST /workers/scripts/pirate-jobs-worker-megapot-e2e-staging/tails",
    "DELETE /workers/scripts/pirate-jobs-worker-megapot-e2e-staging/tails/tail-storage",
  ]);
});

test("one shared jobs tail captures receipts and cycles and is deleted only once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rewards-jobs-tail-"));
  const calls: string[] = [];
  try {
    const observer = await subscribeJobsEvidence(directory, {
      Socket,
      api: async (path: string, init: RequestInit) => {
        calls.push(`${init.method} ${path}`);
        if (init.method === "POST")
          expect(JSON.parse(String(init.body))).toEqual({ filters: [{ query: "megapot" }] });
        if (calls.filter((call) => call.startsWith("DELETE")).length > 1)
          throw Error("already deleted");
        return {
          id: "shared-tail",
          url: "wss://fixture.invalid/private-tail-token",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        };
      },
    });
    Socket.last.message({
      logs: [
        {
          message: [
            observation(),
            {
              event: "megapot.rewards.cycle",
              schema_version: 5,
              environment: "development",
              worker_version_id: "jobs-1",
              emitted_at: new Date().toISOString(),
              duration_ms: 30000,
              funding_step_status: "ran",
              funding_observed_count: 1,
              funding_confirmed_count: 1,
              funding_deferred_count: 0,
              failure_tags: [],
              secret: "must-not-copy",
            },
          ],
        },
      ],
    });
    await observer.flush();
    expect(firstJobsReceiptRead(observer.capture, expected).attempt).toBe(1);
    expect(observer.capture.events).toHaveLength(2);
    expect(
      observer.capture.events.find(
        (event: { event: string }) => event.event === "megapot.rewards.cycle",
      ),
    ).toMatchObject({ fundingConfirmed: 1 });
    const closed = await Promise.all([observer.close(), observer.close()]);
    expect(closed.every((capture) => capture.outcome === "capture-ended")).toBe(true);
    expect(calls).toEqual([
      "POST /workers/scripts/pirate-jobs-worker-megapot-e2e-staging/tails",
      "DELETE /workers/scripts/pirate-jobs-worker-megapot-e2e-staging/tails/shared-tail",
    ]);
    expect(readFileSync(join(directory, "jobs-observations.jsonl"), "utf8")).not.toContain(
      "must-not-copy",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
