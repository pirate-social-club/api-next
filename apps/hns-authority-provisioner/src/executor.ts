import type {
  HnsRootObservationFinalizeResult,
  HnsRootObservationQueue,
} from "./observation-queue.ts";
import {
  decodeHnsRootReadinessObservationRequestV1,
  type HnsRootReadinessObservationConfig,
  HnsRootReadinessObservationError,
  type HnsRootReadinessObservationPorts,
  observeHnsRootReadinessV1,
} from "./observe-root.ts";
import {
  decodeHnsAuthorityProvisionRequestV1,
  HnsAuthorityProvisionError,
  type HnsAuthorityProvisionPorts,
  provisionHnsAuthorityRootV1,
} from "./provision-root.ts";
import type { HnsAuthorityProvisionFinalizeResult, HnsAuthorityProvisionQueue } from "./queue.ts";

export type HnsAuthorityProvisionExecutorResult =
  | Readonly<{ readonly outcome: "idle" }>
  | Readonly<{
      readonly outcome: HnsAuthorityProvisionFinalizeResult["outcome"];
      readonly provision_job_id: string;
      readonly root_import_session_id: string;
    }>
  | Readonly<{
      readonly outcome: HnsRootObservationFinalizeResult["outcome"];
      readonly observation_job_id: string;
      readonly root_import_session_id: string;
    }>;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failureCode(error: unknown): string {
  return error instanceof HnsAuthorityProvisionError ? error.code : "provision_failed";
}

async function runObservation(input: {
  readonly executor_id: string;
  readonly queue: HnsRootObservationQueue;
  readonly observe: HnsRootReadinessObservationPorts;
  readonly observation_config: HnsRootReadinessObservationConfig;
}): Promise<HnsAuthorityProvisionExecutorResult> {
  const claim = await input.queue.claim(input.executor_id, 60);
  if (claim === null) return { outcome: "idle" };
  const base = {
    observation_job_id: claim.observation_job_id,
    executor_id: input.executor_id,
    lease_fence: claim.lease_fence,
    request_sha256: claim.request_sha256,
  } as const;
  try {
    if (
      (await sha256(claim.request_bytes)) !== claim.request_sha256 ||
      (await sha256(claim.publish_plan_bytes)) !== claim.publish_plan_sha256 ||
      (await sha256(claim.provision_result_bytes)) !== claim.provision_result_sha256
    ) {
      throw new HnsRootReadinessObservationError("invalid_request");
    }
    const request = decodeHnsRootReadinessObservationRequestV1(claim.request_bytes);
    if (
      request.root_import_session_id !== claim.root_import_session_id ||
      request.publish_plan_sha256 !== claim.publish_plan_sha256 ||
      request.provision_result_sha256 !== claim.provision_result_sha256
    ) {
      throw new HnsRootReadinessObservationError("invalid_request");
    }
    const result = await observeHnsRootReadinessV1({
      request,
      publish_plan_bytes: claim.publish_plan_bytes,
      provision_result_bytes: claim.provision_result_bytes,
      ports: input.observe,
      config: input.observation_config,
    });
    const finalized = await input.queue.finalize({
      ...base,
      outcome: "ready",
      result_bytes: result.result_bytes,
      result_sha256: result.result_sha256,
    });
    return {
      outcome: finalized.outcome,
      observation_job_id: claim.observation_job_id,
      root_import_session_id: claim.root_import_session_id,
    };
  } catch (error) {
    const code =
      error instanceof HnsRootReadinessObservationError ? error.code : "observation_failed";
    const retry = code === "owner_update_pending" || code === "authority_unavailable";
    const finalized = await input.queue.finalize({
      ...base,
      outcome: retry ? "retry" : "failed",
      failure_code: code,
    });
    return {
      outcome: finalized.outcome,
      observation_job_id: claim.observation_job_id,
      root_import_session_id: claim.root_import_session_id,
    };
  }
}

export async function runHnsAuthorityProvisionExecutorOnce(input: {
  readonly executor_id: string;
  readonly queue: HnsAuthorityProvisionQueue;
  readonly provision: HnsAuthorityProvisionPorts;
  readonly observation?: Readonly<{
    readonly queue: HnsRootObservationQueue;
    readonly observe: HnsRootReadinessObservationPorts;
    readonly config: HnsRootReadinessObservationConfig;
  }>;
}): Promise<HnsAuthorityProvisionExecutorResult> {
  const claim = await input.queue.claim(input.executor_id, 60);
  if (claim === null) {
    return input.observation === undefined
      ? { outcome: "idle" }
      : runObservation({
          executor_id: input.executor_id,
          queue: input.observation.queue,
          observe: input.observation.observe,
          observation_config: input.observation.config,
        });
  }
  const base = {
    provision_job_id: claim.provision_job_id,
    executor_id: input.executor_id,
    lease_fence: claim.lease_fence,
    request_sha256: claim.request_sha256,
  } as const;
  try {
    if ((await sha256(claim.request_bytes)) !== claim.request_sha256) {
      throw new HnsAuthorityProvisionError("invalid_request");
    }
    const request = decodeHnsAuthorityProvisionRequestV1(claim.request_bytes);
    if (request.root_import_session_id !== claim.root_import_session_id) {
      throw new HnsAuthorityProvisionError("invalid_request");
    }
    const output = await provisionHnsAuthorityRootV1(request, input.provision);
    const finalized = await input.queue.finalize({ ...base, outcome: "completed", ...output });
    return {
      outcome: finalized.outcome,
      provision_job_id: claim.provision_job_id,
      root_import_session_id: claim.root_import_session_id,
    };
  } catch (error) {
    const code = failureCode(error);
    const retry =
      code === "root_unavailable" ||
      code === "authority_unavailable" ||
      code === "provision_failed";
    const finalized = await input.queue.finalize({
      ...base,
      outcome: retry ? "retry" : "failed",
      failure_code: code,
    });
    return {
      outcome: finalized.outcome,
      provision_job_id: claim.provision_job_id,
      root_import_session_id: claim.root_import_session_id,
    };
  }
}
