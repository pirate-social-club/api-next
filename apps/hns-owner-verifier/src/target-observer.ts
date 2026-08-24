import {
  encodeHnsActiveLeaseRenewalResponse,
  encodeHnsControlObservationRequest,
  type HnsControlObservationRequestV1,
  HnsControlObserverSnapshotReadError,
  type HnsControlObserverSnapshotReaderPort,
  type HnsEvidenceLeasePolicy,
  type HnsOwnerActiveLeaseRenewalRequestV1,
  type HnsOwnershipSource,
  hnsActiveLeaseRenewalPriorSnapshotReference,
  mapHnsActiveLeaseRenewalObservationForRequest,
  mapHnsControlObservationToTargetV2,
  resolveHnsActiveLeaseRenewalControlIdentity,
} from "@pirate/application/namespace-ownership";
import {
  decodeHnsOwnerRecoveryTargetResponseBytes,
  type HnsOwnerRecoveryPersistedSessionV1,
  type HnsOwnerSameRootRecoveryProviderStartV1,
} from "@pirate/application/route-revalidation";

export const HNS_TARGET_OBSERVER_DEADLINE_MAX_MS = 12_000 as const;

export type HnsTargetObserverConfiguration = Readonly<{
  readonly provider_id: "hns.owner.v1";
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly provider_configuration_digest: string;
  readonly environment: string;
  readonly ownership_source: HnsOwnershipSource;
  readonly observer_deadline_ms: number;
  readonly lease_policy: HnsEvidenceLeasePolicy;
}>;

export type HnsTargetObserverPort = Readonly<{
  /**
   * Persists the exact request before driver work and returns exact retained
   * inner-result bytes. It cannot inject a target-v2 outer response.
   */
  readonly observe: (
    input: Readonly<{
      readonly request: HnsControlObservationRequestV1;
      readonly request_bytes: Uint8Array;
      readonly lease_policy: HnsEvidenceLeasePolicy;
    }>,
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<Uint8Array>;
}>;

export type HnsTargetObserverRuntime = Readonly<{
  readonly configuration: HnsTargetObserverConfiguration;
  readonly observer: HnsTargetObserverPort;
  readonly snapshot_reader?: HnsControlObserverSnapshotReaderPort;
}>;

export type HnsTargetObserverPortErrorReason =
  | "invalid_request"
  | "misconfigured"
  | "transport_unavailable"
  | "invalid_response";

export class HnsTargetObserverPortError extends Error {
  override readonly name: string = "HnsTargetObserverPortError";

  constructor(
    readonly reason: HnsTargetObserverPortErrorReason,
    message: string,
  ) {
    super(message);
  }
}

export class HnsTargetObserverFacadeError extends Error {
  readonly name = "HnsTargetObserverFacadeError";

  constructor(
    readonly reason: "misconfigured" | "unavailable" | "invalid_response" | "ineligible",
  ) {
    super(reason);
  }
}

type RecoveryConfigurationAuthority = Pick<
  HnsOwnerSameRootRecoveryProviderStartV1 | HnsOwnerRecoveryPersistedSessionV1,
  "provider_id" | "provider_configuration" | "environment"
>;

export type HnsOwnerCreationTargetSession = Readonly<{
  readonly provider_id: "hns.owner.v1";
  readonly provider_configuration: Readonly<{
    readonly kind: "managed" | "dynamic";
    readonly reference: string;
    readonly version: string;
  }>;
  readonly environment: string;
  readonly route: Readonly<{ readonly root_label: string }>;
  readonly upstream_session_ref: string;
}>;

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function matchesHnsTargetObserverRecoveryConfiguration(
  authority: RecoveryConfigurationAuthority,
  runtime: HnsTargetObserverRuntime,
): boolean {
  const configuration = runtime.configuration;
  const policy = configuration.lease_policy;
  return (
    authority.provider_id === configuration.provider_id &&
    authority.provider_configuration.kind === "managed" &&
    authority.provider_configuration.reference === configuration.provider_configuration_reference &&
    authority.provider_configuration.version === configuration.provider_configuration_version &&
    authority.provider_configuration.digest === configuration.provider_configuration_digest &&
    authority.environment === configuration.environment &&
    validPositiveInteger(configuration.observer_deadline_ms) &&
    configuration.observer_deadline_ms <= HNS_TARGET_OBSERVER_DEADLINE_MAX_MS &&
    validPositiveInteger(policy.expected_block_interval_seconds) &&
    validPositiveInteger(policy.minimum_safe_remaining_blocks) &&
    Number.isSafeInteger(policy.expiry_safety_blocks) &&
    policy.expiry_safety_blocks >= 0 &&
    validPositiveInteger(policy.evidence_lease_seconds)
  );
}

export function matchesHnsTargetObserverCreationConfiguration(
  authority: HnsOwnerCreationTargetSession,
  runtime: HnsTargetObserverRuntime,
): boolean {
  const configuration = runtime.configuration;
  const policy = configuration.lease_policy;
  return (
    authority.provider_id === configuration.provider_id &&
    authority.provider_configuration.kind === "managed" &&
    authority.provider_configuration.reference === configuration.provider_configuration_reference &&
    authority.provider_configuration.version === configuration.provider_configuration_version &&
    authority.environment === configuration.environment &&
    validPositiveInteger(configuration.observer_deadline_ms) &&
    configuration.observer_deadline_ms <= HNS_TARGET_OBSERVER_DEADLINE_MAX_MS &&
    validPositiveInteger(policy.expected_block_interval_seconds) &&
    validPositiveInteger(policy.minimum_safe_remaining_blocks) &&
    Number.isSafeInteger(policy.expiry_safety_blocks) &&
    policy.expiry_safety_blocks >= 0 &&
    validPositiveInteger(policy.evidence_lease_seconds)
  );
}

export function matchesHnsTargetObserverRenewalConfiguration(
  request: HnsOwnerActiveLeaseRenewalRequestV1,
  runtime: HnsTargetObserverRuntime,
): boolean {
  const configuration = runtime.configuration;
  return (
    request.provider_id === configuration.provider_id &&
    request.provider_configuration.kind === "managed" &&
    request.provider_configuration.reference === configuration.provider_configuration_reference &&
    request.provider_configuration.version === configuration.provider_configuration_version &&
    request.provider_configuration.digest === configuration.provider_configuration_digest &&
    request.environment === configuration.environment &&
    validPositiveInteger(configuration.observer_deadline_ms) &&
    configuration.observer_deadline_ms <= HNS_TARGET_OBSERVER_DEADLINE_MAX_MS
  );
}

export async function observeHnsActiveLeaseRenewal(
  request: HnsOwnerActiveLeaseRenewalRequestV1,
  runtime: HnsTargetObserverRuntime,
  observationId: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    !matchesHnsTargetObserverRenewalConfiguration(request, runtime) ||
    runtime.snapshot_reader === undefined
  ) {
    throw new HnsTargetObserverFacadeError("misconfigured");
  }
  if (signal.aborted) throw new HnsTargetObserverFacadeError("unavailable");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), runtime.configuration.observer_deadline_ms);
  try {
    let reference: ReturnType<typeof hnsActiveLeaseRenewalPriorSnapshotReference>;
    try {
      reference = hnsActiveLeaseRenewalPriorSnapshotReference(request.prior_provider_evidence_ref);
    } catch {
      throw new HnsTargetObserverFacadeError("ineligible");
    }
    let snapshot: Awaited<ReturnType<typeof runtime.snapshot_reader.read>>;
    try {
      snapshot = await runtime.snapshot_reader.read(reference.snapshot_reference, {
        deadline_ms: runtime.configuration.observer_deadline_ms,
        signal: controller.signal,
      });
    } catch (error) {
      if (
        error instanceof HnsControlObserverSnapshotReadError &&
        error.reason === "invalid_snapshot"
      ) {
        throw new HnsTargetObserverFacadeError("ineligible");
      }
      throw new HnsTargetObserverFacadeError("unavailable");
    }
    if (snapshot === null) throw new HnsTargetObserverFacadeError("ineligible");
    let controlIdentity: Awaited<ReturnType<typeof resolveHnsActiveLeaseRenewalControlIdentity>>;
    try {
      controlIdentity = await resolveHnsActiveLeaseRenewalControlIdentity({ request, snapshot });
    } catch {
      throw new HnsTargetObserverFacadeError("ineligible");
    }
    if (controlIdentity.ownership_source !== runtime.configuration.ownership_source) {
      throw new HnsTargetObserverFacadeError("misconfigured");
    }
    const upstreamSessionRef = controlIdentity.expected_txt_value.slice(
      "pirate-verification=".length,
    );
    const observerRequest: HnsControlObservationRequestV1 = {
      version: "pirate-hns-control-observation-request-v1",
      observation_id: observationId,
      provider_id: request.provider_id,
      provider_configuration_reference: request.provider_configuration.reference,
      provider_configuration_version: request.provider_configuration.version,
      provider_configuration_digest: request.provider_configuration.digest,
      environment: request.environment,
      ownership_source: controlIdentity.ownership_source,
      root_label: request.route.root_label,
      txt_name: controlIdentity.txt_name,
      expected_txt_value: controlIdentity.expected_txt_value,
    };
    const observerRequestBytes = await encodeHnsControlObservationRequest(observerRequest);
    let observerResultBytes: Uint8Array;
    try {
      observerResultBytes = await runtime.observer.observe(
        {
          request: observerRequest,
          request_bytes: observerRequestBytes,
          lease_policy: runtime.configuration.lease_policy,
        },
        {
          deadline_ms: runtime.configuration.observer_deadline_ms,
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw mapPortError(error);
    }
    if (controller.signal.aborted) throw new HnsTargetObserverFacadeError("unavailable");
    const response = await mapHnsActiveLeaseRenewalObservationForRequest({
      request,
      control_identity: controlIdentity,
      observer_request: observerRequest,
      observer_result_bytes: observerResultBytes,
      upstream_session_ref: upstreamSessionRef,
      policy: runtime.configuration.lease_policy,
    });
    return encodeHnsActiveLeaseRenewalResponse(response);
  } catch (error) {
    if (error instanceof HnsTargetObserverFacadeError) throw error;
    if (controller.signal.aborted) throw new HnsTargetObserverFacadeError("unavailable");
    throw new HnsTargetObserverFacadeError("invalid_response");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function observeWithDeadline(
  runtime: HnsTargetObserverRuntime,
  request: HnsControlObservationRequestV1,
  requestBytes: Uint8Array,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const deadlineMs = runtime.configuration.observer_deadline_ms;
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new HnsTargetObserverFacadeError("unavailable"));
    }, deadlineMs);
    let operation: Promise<Uint8Array>;
    try {
      operation = runtime.observer.observe(
        {
          request,
          request_bytes: new Uint8Array(requestBytes),
          lease_policy: runtime.configuration.lease_policy,
        },
        { deadline_ms: deadlineMs, signal: controller.signal },
      );
    } catch (error) {
      settled = true;
      clearTimeout(timeout);
      reject(mapPortError(error));
      return;
    }
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!(value instanceof Uint8Array)) {
          reject(new HnsTargetObserverFacadeError("invalid_response"));
          return;
        }
        resolve(new Uint8Array(value));
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(mapPortError(error));
      },
    );
  });
}

function mapPortError(error: unknown): HnsTargetObserverFacadeError {
  if (!(error instanceof HnsTargetObserverPortError)) {
    return new HnsTargetObserverFacadeError("invalid_response");
  }
  if (error.reason === "misconfigured") {
    return new HnsTargetObserverFacadeError("misconfigured");
  }
  if (error.reason === "transport_unavailable") {
    return new HnsTargetObserverFacadeError("unavailable");
  }
  return new HnsTargetObserverFacadeError("invalid_response");
}

export async function observeHnsOwnerRecoverySession(
  session: HnsOwnerRecoveryPersistedSessionV1,
  runtime: HnsTargetObserverRuntime,
  observationId: string,
): Promise<Uint8Array> {
  if (!matchesHnsTargetObserverRecoveryConfiguration(session, runtime)) {
    throw new HnsTargetObserverFacadeError("misconfigured");
  }
  if (session.ownership_source !== runtime.configuration.ownership_source) {
    throw new HnsTargetObserverFacadeError("misconfigured");
  }
  const request: HnsControlObservationRequestV1 = {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: observationId,
    provider_id: session.provider_id,
    provider_configuration_reference: session.provider_configuration.reference,
    provider_configuration_version: session.provider_configuration.version,
    provider_configuration_digest: session.provider_configuration.digest,
    environment: session.environment,
    ownership_source: session.ownership_source,
    root_label: session.route.root_label,
    txt_name: session.challenge_name,
    expected_txt_value: session.challenge_value,
  };
  let requestBytes: Uint8Array;
  try {
    requestBytes = await encodeHnsControlObservationRequest(request);
  } catch {
    throw new HnsTargetObserverFacadeError("invalid_response");
  }
  const resultBytes = await observeWithDeadline(runtime, request, requestBytes);
  try {
    const response = await mapHnsControlObservationToTargetV2({
      request,
      result_bytes: resultBytes,
      upstream_session_ref: session.upstream_session_ref,
      policy: runtime.configuration.lease_policy,
    });
    const outerBytes = new TextEncoder().encode(JSON.stringify(response));
    return (await decodeHnsOwnerRecoveryTargetResponseBytes(outerBytes)).response_bytes;
  } catch {
    throw new HnsTargetObserverFacadeError("invalid_response");
  }
}

export async function observeHnsOwnerCreationSession(
  session: HnsOwnerCreationTargetSession,
  runtime: HnsTargetObserverRuntime,
  observationId: string,
): Promise<Uint8Array> {
  if (!matchesHnsTargetObserverCreationConfiguration(session, runtime)) {
    throw new HnsTargetObserverFacadeError("misconfigured");
  }
  const request: HnsControlObservationRequestV1 = {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: observationId,
    provider_id: session.provider_id,
    provider_configuration_reference: session.provider_configuration.reference,
    provider_configuration_version: session.provider_configuration.version,
    provider_configuration_digest: runtime.configuration.provider_configuration_digest,
    environment: session.environment,
    ownership_source: runtime.configuration.ownership_source,
    root_label: session.route.root_label,
    txt_name:
      runtime.configuration.ownership_source === "hns_parent_chain_txt"
        ? session.route.root_label
        : `_pirate.${session.route.root_label}`,
    expected_txt_value: `pirate-verification=${session.upstream_session_ref}`,
  };
  let requestBytes: Uint8Array;
  try {
    requestBytes = await encodeHnsControlObservationRequest(request);
  } catch {
    throw new HnsTargetObserverFacadeError("invalid_response");
  }
  const resultBytes = await observeWithDeadline(runtime, request, requestBytes);
  try {
    const response = await mapHnsControlObservationToTargetV2({
      request,
      result_bytes: resultBytes,
      upstream_session_ref: session.upstream_session_ref,
      policy: runtime.configuration.lease_policy,
    });
    const outerBytes = new TextEncoder().encode(JSON.stringify(response));
    return (await decodeHnsOwnerRecoveryTargetResponseBytes(outerBytes)).response_bytes;
  } catch {
    throw new HnsTargetObserverFacadeError("invalid_response");
  }
}
