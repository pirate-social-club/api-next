import {
  decideHnsTeardownRetentionV1,
  type HnsChainObservationResultV1,
  type HnsChainObservationViewV1,
  type HnsRetainedAuthorityReferenceV1,
} from "@pirate/application/namespace-ownership";
import type {
  HnsRootObservationFinalizeInput,
  HnsRootObservationFinalizeResult,
  HnsRootObservationQueue,
} from "./observation-queue.ts";
import {
  decodeHnsAuthorityProvisionResultV1,
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
  type HnsZoneMutationLease,
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

/** Chain-evidence and retirement-evidence inputs the teardown gate consults. */
export type HnsTeardownRetentionPorts = Readonly<{
  readonly observe_chain: (
    rootLabel: string,
    view: HnsChainObservationViewV1,
  ) => Promise<HnsChainObservationResultV1>;
  /**
   * The persisted, explicit authorization to retire this authority: a
   * recorded retention review under `retention_review_v1`, or a recorded
   * supersession. Null means no such authorization exists.
   *
   * There is deliberately no wall-clock input here. Spec 012 states that no
   * wall-clock value alone authorizes deletion or release, and that an
   * exhausted publication deadline enters `recovery_required` with authority
   * retained. A gate that derives permission from elapsed time therefore
   * cannot be correct, however long the interval.
   */
  readonly retirement_authorization: (rootImportSessionId: string) => Promise<Readonly<{
    readonly kind: "retention_review" | "supersession";
    readonly recorded_at_epoch_ms: number;
    readonly evidence_ref: string;
  }> | null>;
}>;

/**
 * Both null is a valid absence of plan; exactly one null, or a digest that
 * does not match, is tampering or corruption.
 */
async function plannedBytesMatchDigest(
  bytes: Uint8Array | null,
  digest: string | null,
): Promise<boolean> {
  if (bytes === null && digest === null) return true;
  if (bytes === null || digest === null) return false;
  return (await sha256(bytes)) === digest;
}

/** Describe the authority an exposed plan asserts, for the reference test. */
function retainedAuthorityFromPlanBytes(bytes: Uint8Array): HnsRetainedAuthorityReferenceV1 {
  const plan = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const records = Array.isArray(plan.replacement_records) ? plan.replacement_records : [];
  const nsNames: string[] = [];
  const ds: { key_tag: number; algorithm: number; digest_type: number; digest: string }[] = [];
  let challenge: string | null = null;
  for (const entry of records) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.toUpperCase() : "";
    if (type === "NS" && typeof record.ns === "string") nsNames.push(record.ns);
    if (type === "DS") {
      const keyTag = record.keyTag ?? record.key_tag;
      const digestType = record.digestType ?? record.digest_type;
      if (
        typeof keyTag === "number" &&
        typeof record.algorithm === "number" &&
        typeof digestType === "number" &&
        typeof record.digest === "string"
      ) {
        ds.push({
          key_tag: keyTag,
          algorithm: record.algorithm,
          digest_type: digestType,
          digest: record.digest,
        });
      }
    }
    if (type === "TXT" && Array.isArray(record.txt)) {
      for (const value of record.txt) {
        if (typeof value === "string" && value.startsWith("pirate-verification="))
          challenge = value;
      }
    }
  }
  return {
    ns_names: nsNames,
    ds,
    challenge_txt_value: challenge,
  };
}

async function resolveTeardownRetention(
  input: Readonly<{
    readonly retention: HnsTeardownRetentionPorts;
    readonly teardown_kind: "teardown_provisional_root_v1" | "teardown_root_v1";
    readonly root_label: string;
    readonly root_import_session_id: string;
    readonly publish_plan_bytes: Uint8Array | null;
  }>,
): Promise<Readonly<{ readonly decision: "retain" | "retire_eligible"; readonly reason: string }>> {
  // Unknown plan provenance retains. A plan we cannot decode is a plan whose
  // authority we cannot describe, and an authority we cannot describe is one
  // we cannot prove is unreferenced.
  let authority: HnsRetainedAuthorityReferenceV1 | null = null;
  if (input.publish_plan_bytes === null) {
    // Partial provisioning: infrastructure may exist with no exposed plan.
    // Nothing was ever issued to the owner, so there is no plan reference to
    // find, but there is also no provenance — retirement still needs explicit
    // authorization below.
    authority = {
      ns_names: [],
      ds: [],
      challenge_txt_value: null,
    };
  } else {
    try {
      authority = retainedAuthorityFromPlanBytes(input.publish_plan_bytes);
    } catch {
      return { decision: "retain", reason: "unknown_plan_provenance_retained" };
    }
  }

  const observe = async (
    view: HnsChainObservationViewV1,
  ): Promise<HnsChainObservationResultV1 | null> => {
    try {
      return await input.retention.observe_chain(input.root_label, view);
    } catch {
      return null;
    }
  };
  const [current, safe, retirement] = await Promise.all([
    observe("current"),
    observe("safe"),
    input.retention.retirement_authorization(input.root_import_session_id).catch(() => null),
  ]);
  return decideHnsTeardownRetentionV1({
    teardown_kind: input.teardown_kind,
    authority,
    current,
    safe,
    // The only path to retirement is a recorded review or supersession. With
    // none, a fresh inspection showing no reference still retains: the owner
    // may broadcast the issued plan later.
    positive_absence_evidence: retirement !== null,
  });
}

async function runObservation(input: {
  readonly executor_id: string;
  readonly queue: HnsRootObservationQueue;
  readonly observe: HnsRootReadinessObservationPorts;
  readonly teardown_zone: (input: {
    readonly root_label: string;
    readonly challenge_txt_value?: string;
    readonly mutation_lease?: HnsZoneMutationLease;
  }) => Promise<void>;
  readonly retention: HnsTeardownRetentionPorts;
  readonly observation_config: HnsRootReadinessObservationConfig;
}): Promise<HnsAuthorityProvisionExecutorResult> {
  const claim = await input.queue.claim(input.executor_id, 60);
  if (claim === null) return { outcome: "idle" };
  const base = {
    observation_job_id: claim.observation_job_id,
    operation_kind: claim.operation_kind,
    executor_id: input.executor_id,
    lease_fence: claim.lease_fence,
    request_sha256: claim.request_sha256,
  } as const;
  let completion: HnsRootObservationFinalizeInput;
  try {
    if ((await sha256(claim.request_bytes)) !== claim.request_sha256)
      throw new HnsRootReadinessObservationError("invalid_request");
    if (claim.operation_kind === "teardown_provisional_root_v1") {
      const request = decodeHnsAuthorityProvisionRequestV1(claim.request_bytes);
      if (request.root_import_session_id !== claim.root_import_session_id)
        throw new HnsRootReadinessObservationError("authority_mismatch");
      // Partial provisioning legitimately carries no plan. Both fields null is
      // valid; hashing empty bytes and comparing that digest with an empty
      // string made that case indistinguishable from tampering.
      if (!plannedBytesMatchDigest(claim.publish_plan_bytes, claim.publish_plan_sha256)) {
        throw new HnsRootReadinessObservationError("invalid_request");
      }
      const retention = await resolveTeardownRetention({
        retention: input.retention,
        teardown_kind: "teardown_provisional_root_v1",
        root_label: request.root_label,
        root_import_session_id: claim.root_import_session_id,
        publish_plan_bytes: claim.publish_plan_bytes,
      });
      if (retention.decision === "retain") {
        // The authority is retained: no provider deletion runs. Unknown
        // evidence and a not-yet-passed exposure horizon retry later; a
        // chain reference completes the job without deleting.
        completion = {
          ...base,
          outcome: retention.reason === "chain_reference_retained" ? "failed" : "retry",
          failure_code: `retention_${retention.reason}`,
        };
      } else {
        await input.teardown_zone({
          root_label: request.root_label,
          challenge_txt_value: request.challenge_txt_value,
          mutation_lease: {
            job_id: claim.observation_job_id,
            executor_id: input.executor_id,
            lease_fence: claim.lease_fence,
          },
        });
        completion = { ...base, outcome: "failed", failure_code: "session_expired" };
      }
    } else {
      if (
        (await sha256(claim.publish_plan_bytes)) !== claim.publish_plan_sha256 ||
        (await sha256(claim.provision_result_bytes)) !== claim.provision_result_sha256
      ) {
        throw new HnsRootReadinessObservationError("invalid_request");
      }
      if (claim.operation_kind === "teardown_root_v1") {
        const provision = decodeHnsAuthorityProvisionResultV1(claim.provision_result_bytes);
        if (provision.root_import_session_id !== claim.root_import_session_id) {
          throw new HnsRootReadinessObservationError("authority_mismatch");
        }
        const retention = await resolveTeardownRetention({
          retention: input.retention,
          teardown_kind: "teardown_root_v1",
          root_label: provision.root_label,
          root_import_session_id: claim.root_import_session_id,
          publish_plan_bytes: claim.publish_plan_bytes,
        });
        if (retention.decision === "retain") {
          completion = {
            ...base,
            outcome: retention.reason === "chain_reference_retained" ? "failed" : "retry",
            failure_code: `retention_${retention.reason}`,
          };
        } else {
          if (provision.zone_created) {
            await input.teardown_zone({
              root_label: provision.root_label,
              // The same mutation fence as the provisional variant: an
              // unfenced delete can land after another executor has taken the
              // job over.
              mutation_lease: {
                job_id: claim.observation_job_id,
                executor_id: input.executor_id,
                lease_fence: claim.lease_fence,
              },
            });
          }
          completion = { ...base, outcome: "failed", failure_code: "session_expired" };
        }
      } else {
        const request = decodeHnsRootReadinessObservationRequestV1(claim.request_bytes);
        if (
          request.root_import_session_id !== claim.root_import_session_id ||
          request.publish_plan_sha256 !== claim.publish_plan_sha256 ||
          request.provision_result_sha256 !== claim.provision_result_sha256
        ) {
          throw new HnsRootReadinessObservationError("invalid_request");
        }
        const result = await observeHnsRootReadinessV1({
          operation_kind: claim.operation_kind,
          observation_attempt: {
            job_id: claim.observation_job_id,
            executor_id: input.executor_id,
            lease_fence: claim.lease_fence,
          },
          request,
          publish_plan_bytes: claim.publish_plan_bytes,
          provision_result_bytes: claim.provision_result_bytes,
          ports: input.observe,
          config: input.observation_config,
        });
        completion = {
          ...base,
          outcome: "ready",
          result_bytes: result.result_bytes,
          result_sha256: result.result_sha256,
        };
      }
    }
  } catch (error) {
    const code =
      error instanceof HnsRootReadinessObservationError
        ? error.code
        : claim.operation_kind.startsWith("teardown_")
          ? "zone_teardown_unavailable"
          : "observation_failed";
    // Only proven invalid evidence is terminal. Unknown transport and runtime
    // failures must not permanently disable a live renewal generation.
    const retry = code !== "invalid_request" && code !== "authority_mismatch";
    completion = { ...base, outcome: retry ? "retry" : "failed", failure_code: code };
  }
  const finalized = await input.queue.finalize(completion);
  return {
    outcome: finalized.outcome,
    observation_job_id: claim.observation_job_id,
    root_import_session_id: claim.root_import_session_id,
  };
}

export async function runHnsAuthorityProvisionExecutorOnce(input: {
  readonly executor_id: string;
  readonly queue: HnsAuthorityProvisionQueue;
  readonly provision: HnsAuthorityProvisionPorts;
  readonly observation?: Readonly<{
    readonly queue: HnsRootObservationQueue;
    readonly observe: HnsRootReadinessObservationPorts;
    readonly teardown_zone: (input: {
      readonly root_label: string;
      readonly challenge_txt_value?: string;
      readonly mutation_lease?: HnsZoneMutationLease;
    }) => Promise<void>;
    readonly retention?: HnsTeardownRetentionPorts;
    readonly config: HnsRootReadinessObservationConfig;
  }>;
  /**
   * Restrict this call to one job class, so the service loop can give each
   * class its own turn. Omitted keeps the original behaviour — provisioning
   * first, observation only when provisioning is idle — which is what the
   * one-shot invocation and the existing callers expect.
   */
  readonly only?: "provisioning" | "observation";
}): Promise<HnsAuthorityProvisionExecutorResult> {
  const observation = input.observation;
  const runObservationTurn = (): Promise<HnsAuthorityProvisionExecutorResult> =>
    observation === undefined
      ? Promise.resolve({ outcome: "idle" } as const)
      : runObservation({
          executor_id: input.executor_id,
          queue: observation.queue,
          observe: observation.observe,
          teardown_zone: observation.teardown_zone,
          retention:
            observation.retention ??
            ({
              observe_chain: () => Promise.reject(new Error("retention evidence unavailable")),
              // No ports supplied means no recorded authorization exists.
              retirement_authorization: () => Promise.resolve(null),
            } as const satisfies HnsTeardownRetentionPorts),
          observation_config: observation.config,
        });
  if (input.only === "observation") return runObservationTurn();
  const claim = await input.queue.claim(input.executor_id, 60);
  if (claim === null) {
    return input.only === "provisioning" ? { outcome: "idle" } : runObservationTurn();
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
    const output = await provisionHnsAuthorityRootV1(request, {
      ...input.provision,
      ensure_zone: (zone) =>
        input.provision.ensure_zone({
          ...zone,
          mutation_lease: {
            job_id: claim.provision_job_id,
            executor_id: input.executor_id,
            lease_fence: claim.lease_fence,
          },
        }),
    });
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
