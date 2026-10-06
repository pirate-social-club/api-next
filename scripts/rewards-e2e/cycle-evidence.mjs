import { isolatedEnvironment } from "./worker-plan.mjs";

const count = (value) => Number.isSafeInteger(value) && value >= 0;

/** Keep the public counts only; never persist an entire tail envelope or log object. */
export function cycleEvents(envelope) {
  if (!envelope || !Array.isArray(envelope.logs)) throw new Error("Invalid cycle tail envelope");
  if (["overload", "overload-stop"].includes(envelope.event?.type))
    throw new Error("Cycle tail reported provider overload; capture incomplete");
  const events = [];
  for (const log of envelope.logs) {
    if (!Array.isArray(log.message)) throw new Error("Invalid cycle tail log");
    for (const message of log.message) {
      let event;
      try {
        event = typeof message === "string" ? JSON.parse(message) : message;
      } catch {
        // The event name is also logged on its own as a plain label.
        continue;
      }
      if (event?.event === "megapot.rewards.cycle.timing") {
        // Where a cycle's time went, in milliseconds since its job began.
        const elapsed = event.elapsed_ms;
        if (
          typeof event.worker_version_id !== "string" ||
          !elapsed ||
          typeof elapsed !== "object" ||
          Object.values(elapsed).some((value) => !Number.isFinite(value))
        )
          throw new Error("Invalid isolated cycle timing");
        events.push({
          event: event.event,
          versionId: event.worker_version_id,
          elapsedMs: { ...elapsed },
        });
        continue;
      }
      if (event?.event !== "megapot.rewards.cycle") continue;
      if (
        event.schema_version !== 5 ||
        !["ran", "skipped_deadline_passed"].includes(event.funding_step_status) ||
        event.environment !== isolatedEnvironment ||
        typeof event.worker_version_id !== "string" ||
        !event.worker_version_id ||
        !Number.isFinite(Date.parse(event.emitted_at)) ||
        !count(event.duration_ms) ||
        !count(event.funding_observed_count) ||
        !count(event.funding_confirmed_count) ||
        !count(event.funding_deferred_count) ||
        !Array.isArray(event.failure_tags) ||
        event.failure_tags.some((tag) => typeof tag !== "string")
      )
        throw new Error("Invalid isolated cycle summary");
      events.push({
        event: event.event,
        versionId: event.worker_version_id,
        emittedAt: event.emitted_at,
        durationMs: event.duration_ms,
        fundingObserved: event.funding_observed_count,
        fundingConfirmed: event.funding_confirmed_count,
        fundingDeferred: event.funding_deferred_count,
        // A skipped step looked at nothing; its zero counts say nothing about what was pending.
        fundingStep: event.funding_step_status,
        failureTags: [...event.failure_tags],
      });
    }
  }
  return events;
}

// A cycle's summary is written just after its work; its clock and the database's
// may differ slightly.
const clockSlackMs = 5_000;

/**
 * What the run can and cannot say about who confirmed one funding.
 *
 * `jobsCausedConfirmation` is the claim that matters, and the jobs Worker's own
 * count cannot make it: jobs counts a confirmation whenever reconciliation
 * returns confirmed, including for a transfer the HTTP Worker confirmed between
 * jobs listing it and reconciling it. It is proven a different way, by closing
 * every other path first. The app observes a transfer through HTTP, and each of
 * those observations is watched until its answer arrives. If at least one was
 * made, all of them answered that the funding was still waiting, none was left
 * in flight or failed without an answer, and the sponsor's page was then
 * unloaded with the funding still waiting, then nothing but the jobs Worker
 * remained that could confirm it, and a confirmation recorded afterwards is its.
 *
 * `jobsObservedConfirmedFunding` is weaker corroboration and is labelled as
 * that: one jobs cycle of the pinned version reported a confirmed funding at the
 * time the database recorded it. It is reported, and never required.
 */
export function fundingConfirmationEvidence({
  httpObservations,
  stateWhenSponsorLeft,
  sponsorLeftAt,
  confirmedAt,
  jobsVersionId,
  captureComplete,
  cycles,
}) {
  const left = Date.parse(sponsorLeftAt);
  const confirmed = Date.parse(confirmedAt);
  const reasons = [];
  const observations = httpObservations ?? { started: 0, answers: [], unanswered: 1 };
  if (observations.started < 1) reasons.push("no HTTP observation of the transfer was seen");
  if (observations.unanswered > 0)
    reasons.push("an HTTP observation had no answer when the sponsor left");
  if (observations.answers.length !== observations.started - observations.unanswered)
    reasons.push("HTTP observations and their answers do not add up");
  if (observations.answers.some((answer) => answer !== "confirming"))
    reasons.push("an HTTP observation did not leave the funding waiting for confirmation");
  if (stateWhenSponsorLeft !== "confirming")
    reasons.push("funding was not waiting for confirmation when the sponsor left");
  if (!Number.isFinite(left) || !Number.isFinite(confirmed) || confirmed <= left)
    reasons.push("funding was not confirmed after the sponsor left");

  const observedReasons = [];
  if (captureComplete !== true) observedReasons.push("the jobs cycle capture has a gap");
  const confirming = (cycles ?? []).filter(
    (cycle) => cycle.versionId === jobsVersionId && cycle.fundingConfirmed > 0,
  );
  const matching = confirming.filter((cycle) => {
    const ended = Date.parse(cycle.emittedAt);
    return (
      cycle.fundingConfirmed === 1 &&
      confirmed >= ended - cycle.durationMs - clockSlackMs &&
      confirmed <= ended + clockSlackMs
    );
  });
  if (confirming.length !== 1 || matching.length !== 1)
    observedReasons.push("no single jobs cycle reported a confirmed funding when it was recorded");
  return {
    jobsCausedConfirmation: { proven: reasons.length === 0, reasons },
    jobsObservedConfirmedFunding: {
      observed: observedReasons.length === 0,
      reasons: observedReasons,
      cycle: observedReasons.length === 0 ? matching[0] : null,
    },
  };
}
