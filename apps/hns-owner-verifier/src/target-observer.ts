import {
  encodeHnsControlObservationRequest,
  type HnsControlObservationRequestV1,
  type HnsEvidenceLeasePolicy,
  type HnsOwnershipSource,
  mapHnsControlObservationToTargetV2,
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
    }>,
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<Uint8Array>;
}>;

export type HnsTargetObserverRuntime = Readonly<{
  readonly configuration: HnsTargetObserverConfiguration;
  readonly observer: HnsTargetObserverPort;
  readonly ids?: Readonly<{ readonly observation: () => string }>;
}>;

export class HnsTargetObserverFacadeError extends Error {
  readonly name = "HnsTargetObserverFacadeError";

  constructor(readonly reason: "misconfigured" | "unavailable" | "invalid_response") {
    super(reason);
  }
}

type RecoveryConfigurationAuthority = Pick<
  HnsOwnerSameRootRecoveryProviderStartV1 | HnsOwnerRecoveryPersistedSessionV1,
  "provider_id" | "provider_configuration" | "environment"
>;

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
    Number.isSafeInteger(policy.expiry_safety_blocks) &&
    policy.expiry_safety_blocks >= 0 &&
    validPositiveInteger(policy.evidence_lease_seconds)
  );
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
        { request, request_bytes: new Uint8Array(requestBytes) },
        { deadline_ms: deadlineMs, signal: controller.signal },
      );
    } catch {
      settled = true;
      clearTimeout(timeout);
      reject(new HnsTargetObserverFacadeError("unavailable"));
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
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new HnsTargetObserverFacadeError("unavailable"));
      },
    );
  });
}

export async function observeHnsOwnerRecoverySession(
  session: HnsOwnerRecoveryPersistedSessionV1,
  runtime: HnsTargetObserverRuntime,
): Promise<Uint8Array> {
  if (!matchesHnsTargetObserverRecoveryConfiguration(session, runtime)) {
    throw new HnsTargetObserverFacadeError("misconfigured");
  }
  if (session.ownership_source !== runtime.configuration.ownership_source) {
    throw new HnsTargetObserverFacadeError("misconfigured");
  }
  const request: HnsControlObservationRequestV1 = {
    version: "pirate-hns-control-observation-request-v1",
    observation_id: runtime.ids?.observation() ?? crypto.randomUUID(),
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
