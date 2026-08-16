/**
 * Dependency-free case manifest for the post-barrier adapter-abort tests.
 * These are test inputs and event names only; they do not implement an
 * adapter, driver, RPC, queue, or lease.
 */

export type AdapterKind = "postgres" | "queue-send";

export type SafetyProof = "aborted" | "fenced";

export type AdapterAbortCase = {
  readonly id: string;
  readonly adapter: AdapterKind;
  readonly proof: SafetyProof;
  readonly operation: string;
  readonly mustStartBeforeTimeout: true;
  readonly lateResolutionMustBe: "ignored";
};

export const ADAPTER_ABORT_CASES: readonly AdapterAbortCase[] = [
  {
    id: "postgres-statement-terminates-client",
    adapter: "postgres",
    proof: "aborted",
    operation: "statement",
    mustStartBeforeTimeout: true,
    lateResolutionMustBe: "ignored",
  },
  {
    id: "queue-send-consumer-rejects-stale-token",
    adapter: "queue-send",
    proof: "fenced",
    operation: "send",
    mustStartBeforeTimeout: true,
    lateResolutionMustBe: "ignored",
  },
];

export type AdapterTraceEvent =
  | "started"
  | "timeout"
  | "abort_requested"
  | "aborted"
  | "connection_terminated"
  | "fence_committed"
  | "lease_released"
  | "late_resolution"
  | "late_publish";

/**
 * A future adapter test calls this with its observable trace. It deliberately
 * checks ordering, not elapsed time, so a timeout race cannot pass the gate.
 */
export function assertLeaseReleaseSafety(
  events: readonly AdapterTraceEvent[],
  proof: SafetyProof,
): void {
  const releaseIndex = events.indexOf("lease_released");
  if (releaseIndex < 0) throw new Error("adapter test did not release the lease");

  const terminalEvents =
    proof === "aborted" ? ["aborted", "connection_terminated"] : ["fence_committed"];
  const terminalIndex = events.findIndex((event) =>
    terminalEvents.includes(event as (typeof terminalEvents)[number]),
  );
  if (terminalIndex < 0 || terminalIndex > releaseIndex) {
    throw new Error("lease released before adapter abort/fence evidence");
  }

  if (events.slice(releaseIndex + 1).includes("late_publish")) {
    throw new Error("late adapter resolution published after lease release");
  }
}
