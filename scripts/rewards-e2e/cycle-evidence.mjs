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
      if (event?.event !== "megapot.rewards.cycle") continue;
      if (
        event.schema_version !== 4 ||
        event.environment !== "test" ||
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
 * Decides whether the jobs Worker confirmed one funding. The sponsor's page
 * leaving proves only that no browser asked again: the HTTP Worker binds the hash
 * before it reconciles, so an observation already in flight can still confirm
 * after the page is gone. Jobs confirmation is therefore proven only by the jobs
 * Worker's own summary: exactly one cycle of the pinned jobs version reporting
 * one confirmation, with the database's confirmation time inside that cycle and
 * after the sponsor left, on an unbroken capture.
 */
export function jobsFundingProof({
  stateWhenSponsorLeft,
  sponsorLeftAt,
  confirmedAt,
  jobsVersionId,
  captureComplete,
  cycles,
}) {
  const reasons = [];
  const left = Date.parse(sponsorLeftAt);
  const confirmed = Date.parse(confirmedAt);
  if (stateWhenSponsorLeft !== "confirming")
    reasons.push("funding was not waiting for confirmation when the sponsor left");
  if (!Number.isFinite(left) || !Number.isFinite(confirmed) || confirmed <= left)
    reasons.push("funding was not confirmed after the sponsor left");
  if (captureComplete !== true) reasons.push("the jobs cycle capture has a gap");
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
    reasons.push("no single jobs cycle reported this confirmation at the time it was recorded");
  return {
    proven: reasons.length === 0,
    reasons,
    cycle: reasons.length === 0 ? matching[0] : null,
  };
}
