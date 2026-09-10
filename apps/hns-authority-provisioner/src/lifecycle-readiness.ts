import { canonicalJson } from "@pirate/domain";
import type { HnsLifecycleClaimV1, HnsLifecycleReadinessResultV1 } from "./lifecycle-executor.ts";
import {
  decodeHnsRootReadinessObservationRequestV1,
  HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
  type HnsRootReadinessObservationConfig,
  HnsRootReadinessObservationError,
  type HnsRootReadinessObservationPorts,
  observeHnsRootReadinessV1,
} from "./observe-root.ts";

/**
 * One leased lifecycle readiness observation.
 *
 * The shape follows the retention reviewer for the same reason: the provider
 * probes run outside any transaction, so a slow DNS authority or gateway
 * cannot pin the operation's row lock, and the write is one statement that
 * persists the readiness result on the session, commits the lifecycle
 * `readiness_observed` transition and completes the job together.
 *
 * The performer cannot accept anything on its own. The atomic writer checks
 * the enabled ownership marker, the claimed job's kind, holder, fence and
 * expiry, the generation and expected revision, the phase and the session's
 * readiness preconditions, so a lease gathered before handover or adoption is
 * refused at acceptance rather than trusted here.
 */

export type HnsLifecycleReadinessContextV1 = Readonly<{
  /** The lifecycle revision the probes are taken against. */
  readonly lifecycle_revision: number;
  readonly phase: string;
  readonly namespace_session_id: string;
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly ownership_result_sha256: string;
  readonly publish_plan_sha256: string;
  readonly publish_plan_bytes: Uint8Array;
  readonly provision_result_sha256: string;
  readonly provision_result_bytes: Uint8Array;
  readonly expires_at: string;
}>;

export type HnsLifecycleReadinessPortsV1 = Readonly<{
  readonly context: (rootImportSessionId: string) => Promise<HnsLifecycleReadinessContextV1 | null>;
  readonly observe: HnsRootReadinessObservationPorts;
  readonly config: HnsRootReadinessObservationConfig;
  /**
   * The probe runner. Defaults to the real readiness observation; the seam
   * exists so the performer's outcome handling is testable without a live
   * DNS authority or gateway.
   */
  readonly observe_readiness?: (
    input: Parameters<typeof observeHnsRootReadinessV1>[0],
  ) => ReturnType<typeof observeHnsRootReadinessV1>;
  /** The atomic acceptance. Nothing is written on any other outcome. */
  readonly record: (
    input: Readonly<{
      readonly root_import_session_id: string;
      readonly lifecycle_job_id: string;
      readonly executor_id: string;
      readonly lease_fence: number;
      readonly expected_revision: number;
      readonly result_bytes: Uint8Array;
      readonly result_sha256: string;
    }>,
  ) => Promise<Readonly<{ readonly outcome: string; readonly revision: number | null }>>;
  /** Used only when the atomic writer refused and the job is still leased. */
  readonly finalize: (
    job: HnsLifecycleClaimV1,
    executorId: string,
    outcome: "completed" | "failed" | "retry",
    failureCode: string | null,
  ) => Promise<Readonly<{ readonly outcome: string }>>;
  readonly now_epoch_ms: () => number;
}>;

/**
 * Acceptance refusals that describe superseded or impossible evidence. They
 * fail the job with a named reason rather than retrying forever; the others
 * are operational and retry under the frozen backoff.
 */
const TERMINAL_REFUSALS = new Set([
  "lease_conflict",
  "phase_conflict",
  "session_conflict",
  "plan_absent",
  "invalid_result",
  "lifecycle_absent",
  "conflict",
]);
// The readiness writer must not return `deadline_expired` or
// `session_expired` for a lifecycle-managed operation: the finality window is
// active only in waiting_safe_commitment, and the retired session expiry is
// not a readiness gate. They are deliberately absent from this set; a future
// writer that reintroduced one would not be treating it as a terminal
// refusal without a matching policy change.

const encoder = new TextEncoder();

export async function runHnsRootImportReadinessOnce(
  job: HnsLifecycleClaimV1,
  executorId: string,
  ports: HnsLifecycleReadinessPortsV1,
): Promise<HnsLifecycleReadinessResultV1> {
  if (job.job_kind !== "observe_readiness") {
    await ports.finalize(job, executorId, "failed", "not_a_readiness_job");
    return { outcome: "failed", reason: "not_a_readiness_job" };
  }

  const context = await ports.context(job.root_import_session_id);
  if (context === null) {
    // No operation behind the job. Reported, never inferred.
    await ports.finalize(job, executorId, "failed", "lifecycle_absent");
    return { outcome: "failed", reason: "lifecycle_absent" };
  }

  const requestBytes = encoder.encode(
    canonicalJson({
      version: HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION,
      root_import_session_id: job.root_import_session_id,
      namespace_session_id: context.namespace_session_id,
      root_label: context.root_label,
      challenge_txt_value: context.challenge_txt_value,
      ownership_result_sha256: context.ownership_result_sha256,
      publish_plan_sha256: context.publish_plan_sha256,
      provision_result_sha256: context.provision_result_sha256,
      expires_at: context.expires_at,
    }),
  );
  let request: ReturnType<typeof decodeHnsRootReadinessObservationRequestV1>;
  try {
    request = decodeHnsRootReadinessObservationRequestV1(requestBytes);
  } catch {
    await ports.finalize(job, executorId, "failed", "readiness_request_invalid");
    return { outcome: "failed", reason: "readiness_request_invalid" };
  }

  let artifact: Awaited<ReturnType<typeof observeHnsRootReadinessV1>>;
  try {
    const probe = ports.observe_readiness ?? observeHnsRootReadinessV1;
    artifact = await probe({
      operation_kind: "observe_root_v1",
      observation_attempt: {
        job_id: job.lifecycle_job_id,
        executor_id: executorId,
        lease_fence: job.lease_fence,
      },
      request,
      publish_plan_bytes: context.publish_plan_bytes,
      provision_result_bytes: context.provision_result_bytes,
      ports: ports.observe,
      config: ports.config,
    });
  } catch (error) {
    const code =
      error instanceof HnsRootReadinessObservationError ? error.code : "authority_unavailable";
    if (code === "invalid_request" || code === "authority_mismatch") {
      await ports.finalize(job, executorId, "failed", `readiness_${code}`);
      return { outcome: "failed", reason: `readiness_${code}` };
    }
    // An owner update still pending means the current/safe observation has not
    // caught up; the current-view observers must run before readiness. A
    // provider outage is operational. Both retry; neither invents success.
    const reason =
      code === "owner_update_pending"
        ? "readiness_owner_update_pending"
        : "readiness_authority_unavailable";
    await ports.finalize(job, executorId, "retry", reason);
    return { outcome: "retry", reason };
  }

  const recorded = await ports.record({
    root_import_session_id: job.root_import_session_id,
    lifecycle_job_id: job.lifecycle_job_id,
    executor_id: executorId,
    lease_fence: job.lease_fence,
    expected_revision: context.lifecycle_revision,
    result_bytes: artifact.result_bytes,
    result_sha256: artifact.result_sha256,
  });
  if (recorded.outcome === "ready" || recorded.outcome === "replayed") {
    // The atomic writer completed the job in the same statement.
    return { outcome: "completed", reason: `readiness_${recorded.outcome}` };
  }
  const outcome = TERMINAL_REFUSALS.has(recorded.outcome) ? "failed" : "retry";
  const reason = `readiness_${recorded.outcome}`;
  await ports.finalize(job, executorId, outcome, reason);
  return { outcome, reason };
}
