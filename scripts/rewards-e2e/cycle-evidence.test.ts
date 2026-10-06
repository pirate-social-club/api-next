import { expect, test } from "bun:test";
import { cycleEvents, jobsFundingProof } from "./cycle-evidence.mjs";

const summary = (overrides = {}) => ({
  event: "megapot.rewards.cycle",
  schema_version: 4,
  environment: "test",
  worker_version_id: "jobs-version",
  emitted_at: "2026-10-06T12:01:03.000Z",
  duration_ms: 2_500,
  funding_observed_count: 1,
  funding_confirmed_count: 1,
  funding_deferred_count: 0,
  failure_tags: [],
  reconciled_count: 0,
  ...overrides,
});
const envelope = (...messages: unknown[]) => ({ logs: [{ message: messages }] });

test("a cycle summary is reduced to its public counts however it was logged", () => {
  const expected = {
    event: "megapot.rewards.cycle",
    versionId: "jobs-version",
    emittedAt: "2026-10-06T12:01:03.000Z",
    durationMs: 2_500,
    fundingObserved: 1,
    fundingConfirmed: 1,
    fundingDeferred: 0,
    failureTags: [],
  };
  // The sink logs the event name as a label followed by the fields object.
  expect(cycleEvents(envelope("megapot.rewards.cycle", summary()))).toEqual([expected]);
  expect(cycleEvents(envelope(JSON.stringify(summary())))).toEqual([expected]);
  expect(cycleEvents(envelope("unrelated", { event: "megapot_receipt_read" }))).toEqual([]);
});

test("a malformed summary, an older schema or an overloaded tail is refused", () => {
  for (const broken of [
    summary({ schema_version: 3 }),
    summary({ environment: "staging" }),
    summary({ funding_confirmed_count: "1" }),
    summary({ funding_confirmed_count: -1 }),
    summary({ worker_version_id: "" }),
    summary({ emitted_at: "soon" }),
    summary({ failure_tags: [1] }),
  ])
    expect(() => cycleEvents(envelope(broken))).toThrow("Invalid isolated cycle summary");
  expect(() => cycleEvents({ logs: [], event: { type: "overload" } })).toThrow("overload");
  expect(() => cycleEvents({})).toThrow("Invalid cycle tail envelope");
});

const cycle = (overrides = {}) => ({
  versionId: "jobs-version",
  emittedAt: "2026-10-06T12:01:03.000Z",
  durationMs: 2_500,
  fundingObserved: 1,
  fundingConfirmed: 1,
  fundingDeferred: 0,
  failureTags: [],
  ...overrides,
});
const idle = (emittedAt: string) => cycle({ emittedAt, fundingObserved: 1, fundingConfirmed: 0 });
const facts = {
  stateWhenSponsorLeft: "confirming",
  sponsorLeftAt: "2026-10-06T12:00:20.000Z",
  confirmedAt: "2026-10-06T12:01:02.000Z",
  jobsVersionId: "jobs-version",
  captureComplete: true,
  cycles: [idle("2026-10-06T12:00:03.000Z"), cycle()],
};

test("one jobs cycle reporting the confirmation when it was recorded proves it", () => {
  expect(jobsFundingProof(facts)).toEqual({ proven: true, reasons: [], cycle: cycle() });
});

test("an HTTP observation that finishes after the sponsor left, with jobs idle, proves nothing", () => {
  // The page is gone and the state was still confirming, but every jobs cycle
  // reports zero confirmations: the in-flight HTTP observation did it.
  const proof = jobsFundingProof({
    ...facts,
    confirmedAt: "2026-10-06T12:00:24.000Z",
    cycles: [idle("2026-10-06T12:00:03.000Z"), idle("2026-10-06T12:01:03.000Z")],
  });
  expect(proof.proven).toBe(false);
  expect(proof.reasons).toEqual([
    "no single jobs cycle reported this confirmation at the time it was recorded",
  ]);
});

test("navigation alone is never taken as proof", () => {
  expect(jobsFundingProof({ ...facts, cycles: [] }).proven).toBe(false);
  expect(jobsFundingProof({ ...facts, cycles: undefined }).proven).toBe(false);
});

test("each missing piece of evidence leaves confirmation unproven", () => {
  const cases: Array<[Partial<typeof facts>, string]> = [
    [{ stateWhenSponsorLeft: "confirmed" }, "not waiting for confirmation"],
    [{ confirmedAt: "2026-10-06T12:00:10.000Z" }, "not confirmed after the sponsor left"],
    [{ captureComplete: false }, "capture has a gap"],
    // A confirmation recorded well outside the reporting cycle.
    [{ confirmedAt: "2026-10-06T12:02:30.000Z" }, "no single jobs cycle"],
    // A cycle of some other jobs version.
    [{ jobsVersionId: "another-version" }, "no single jobs cycle"],
    // Two cycles claim a confirmation, or one claims two.
    [
      { cycles: [cycle(), cycle({ emittedAt: "2026-10-06T12:02:03.000Z" })] },
      "no single jobs cycle",
    ],
    [{ cycles: [cycle({ fundingConfirmed: 2 })] }, "no single jobs cycle"],
  ];
  for (const [change, reason] of cases) {
    const proof = jobsFundingProof({ ...facts, ...change });
    expect(proof.proven).toBe(false);
    expect(proof.cycle).toBeNull();
    expect(proof.reasons.some((text) => text.includes(reason))).toBe(true);
  }
});
