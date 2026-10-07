import { expect, test } from "bun:test";
import { cycleEvents, fundingConfirmationEvidence } from "./cycle-evidence.mjs";
import { isolatedEnvironment } from "./worker-plan.mjs";

const summary = (overrides = {}) => ({
  event: "megapot.rewards.cycle",
  schema_version: 5,
  funding_step_status: "ran",
  environment: isolatedEnvironment,
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
    fundingStep: "ran",
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
    summary({ environment: "test" }),
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
  fundingStep: "ran",
  failureTags: [],
  ...overrides,
});
const idle = (emittedAt: string) => cycle({ emittedAt, fundingObserved: 1, fundingConfirmed: 0 });
const facts = {
  httpObservations: { started: 1, answers: ["confirming"], unanswered: 0 },
  stateWhenSponsorLeft: "confirming",
  sponsorLeftAt: "2026-10-06T12:00:20.000Z",
  confirmedAt: "2026-10-06T12:01:02.000Z",
  jobsVersionId: "jobs-version",
  captureComplete: true,
  cycles: [idle("2026-10-06T12:00:03.000Z"), cycle()],
};

test("with the HTTP path closed first, a later confirmation is the jobs Worker's", () => {
  expect(fundingConfirmationEvidence(facts)).toEqual({
    jobsCausedConfirmation: { proven: true, reasons: [] },
    jobsObservedConfirmedFunding: { observed: true, reasons: [], cycle: cycle() },
  });
});

test("jobs listing a transfer the HTTP Worker then confirms is never credited to jobs", () => {
  // Jobs lists the pending funding, the HTTP observation confirms it, jobs then
  // reconciles the already-confirmed row and its count rises all the same.
  for (const httpObservations of [
    // The observation answered that it had confirmed the funding.
    { started: 1, answers: ["confirmed"], unanswered: 0 },
    // Or it was still on its way to the server when the sponsor left.
    { started: 1, answers: [], unanswered: 1 },
  ]) {
    const evidence = fundingConfirmationEvidence({ ...facts, httpObservations });
    expect(evidence.jobsCausedConfirmation.proven).toBe(false);
    // The count is still reported for what it is.
    expect(evidence.jobsObservedConfirmedFunding.observed).toBe(true);
  }
});

test("an HTTP observation that finishes after the sponsor left, with jobs idle, proves nothing", () => {
  const evidence = fundingConfirmationEvidence({
    ...facts,
    httpObservations: { started: 1, answers: [], unanswered: 1 },
    confirmedAt: "2026-10-06T12:00:24.000Z",
    cycles: [idle("2026-10-06T12:00:03.000Z"), idle("2026-10-06T12:01:03.000Z")],
  });
  expect(evidence.jobsCausedConfirmation).toEqual({
    proven: false,
    reasons: ["an HTTP observation had no answer when the sponsor left"],
  });
  expect(evidence.jobsObservedConfirmedFunding.observed).toBe(false);
});

test("the jobs count alone, or navigation alone, never proves jobs confirmed", () => {
  // Jobs reported a confirmation, but nothing shows the HTTP path was closed.
  for (const httpObservations of [undefined, { started: 0, answers: [], unanswered: 0 }]) {
    const evidence = fundingConfirmationEvidence({ ...facts, httpObservations });
    expect(evidence.jobsCausedConfirmation.proven).toBe(false);
    expect(evidence.jobsObservedConfirmedFunding.observed).toBe(true);
  }
});

test("each gap in the HTTP path leaves jobs confirmation unproven", () => {
  const cases: Array<[Partial<typeof facts>, string]> = [
    [{ httpObservations: { started: 2, answers: ["confirming"], unanswered: 1 } }, "no answer"],
    [
      { httpObservations: { started: 2, answers: ["confirming", "http-503"], unanswered: 0 } },
      "did not leave the funding waiting",
    ],
    [
      { httpObservations: { started: 1, answers: ["unreadable"], unanswered: 0 } },
      "did not leave the funding waiting",
    ],
    [{ httpObservations: { started: 2, answers: ["confirming"], unanswered: 0 } }, "do not add up"],
    [{ stateWhenSponsorLeft: "confirmed" }, "not waiting for confirmation when the sponsor left"],
    [{ confirmedAt: "2026-10-06T12:00:10.000Z" }, "not confirmed after the sponsor left"],
  ];
  for (const [change, reason] of cases) {
    const evidence = fundingConfirmationEvidence({ ...facts, ...change });
    expect(evidence.jobsCausedConfirmation.proven).toBe(false);
    expect(evidence.jobsCausedConfirmation.reasons.some((text) => text.includes(reason))).toBe(
      true,
    );
  }
});

test("the corroborating jobs observation is judged on its own and never required", () => {
  const cases: Array<[Partial<typeof facts>, string]> = [
    [{ captureComplete: false }, "capture has a gap"],
    [{ confirmedAt: "2026-10-06T12:02:30.000Z" }, "no single jobs cycle"],
    [{ jobsVersionId: "another-version" }, "no single jobs cycle"],
    [
      { cycles: [cycle(), cycle({ emittedAt: "2026-10-06T12:02:03.000Z" })] },
      "no single jobs cycle",
    ],
    [{ cycles: [cycle({ fundingConfirmed: 2 })] }, "no single jobs cycle"],
    [{ cycles: [] }, "no single jobs cycle"],
  ];
  for (const [change, reason] of cases) {
    const evidence = fundingConfirmationEvidence({ ...facts, ...change });
    expect(evidence.jobsObservedConfirmedFunding.observed).toBe(false);
    expect(evidence.jobsObservedConfirmedFunding.cycle).toBeNull();
    expect(
      evidence.jobsObservedConfirmedFunding.reasons.some((text) => text.includes(reason)),
    ).toBe(true);
    // A lost capture does not take away a proof that rests on the closed HTTP path.
    expect(evidence.jobsCausedConfirmation.proven).toBe(true);
  }
});
