import {
  encodeHnsAuthoritativeDnsSemanticFactsV1,
  HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID,
  type HnsAuthoritativeDnsMessageIdPortV1,
  type HnsAuthoritativeDnsTransportPortV1,
  type HnsAuthoritativeDnsValidatorPortV1,
  type HnsControlObservationRejectedReason,
  type HnsControlObservationResultV1,
  type HnsControlObserverConfigurationResolverPort,
  type HnsControlObserverHsdTransportPort,
  type HnsControlObserverRuntimeCapabilities,
  type HnsControlObserverSnapshotStorePort,
  type HnsControlObserverTranscriptEntryV1,
  HnsControlObserverTranscriptError,
  hnsControlIdentityDigest,
  validateHnsControlObserverTranscript,
} from "@pirate/application/namespace-ownership";
import {
  HnsParentChainObserverError,
  HnsStableHsdBracketError,
  type HnsStableHsdBracketResultV1,
  type HnsStableHsdBracketV1,
  type HnsTargetObserverLifecycleSourceInput,
  makeHnsTargetObserverSnapshotLifecycle,
  observeHnsStableHsdBracket,
} from "./hsd-parent-chain-observer.ts";
import {
  HnsOwnerAuthoritativeDnsObserverError,
  observeHnsOwnerAuthoritativeDns,
} from "./owner-authoritative-dns-observer.ts";
import { type HnsTargetObserverPort, HnsTargetObserverPortError } from "./target-observer.ts";
import {
  finalizeHnsControlObserverResult,
  type HnsTargetObserverExecutionResult,
  type HnsTargetObserverSha256,
  makeHnsRejectedControlResult,
  makeHnsUnavailableControlResult,
  makeHnsVerifiedControlResult,
} from "./target-observer-result.ts";

export class HnsOwnerAuthoritativeTargetObserverError extends HnsTargetObserverPortError {
  override readonly name = "HnsOwnerAuthoritativeTargetObserverError";

  constructor(
    readonly reason:
      | "invalid_request"
      | "misconfigured"
      | "transport_unavailable"
      | "invalid_response",
    message: string,
  ) {
    super(reason, message);
  }
}

function ownerAbortError(message: string): HnsOwnerAuthoritativeTargetObserverError {
  return new HnsOwnerAuthoritativeTargetObserverError("transport_unavailable", message);
}

function ownerAbortIfSet(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw ownerAbortError(message);
}

async function sha256(bytes: Uint8Array): Promise<HnsTargetObserverSha256> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  ) as HnsTargetObserverSha256;
}

function bracketMatchesExecution(
  bracket: HnsStableHsdBracketV1,
  input: HnsTargetObserverLifecycleSourceInput,
): boolean {
  const authority = bracket.request_authority;
  return (
    authority.provider_id === input.request.provider_id &&
    authority.provider_configuration_reference === input.request.provider_configuration_reference &&
    authority.provider_configuration_version === input.request.provider_configuration_version &&
    authority.provider_configuration_digest === input.configuration_digest &&
    authority.environment === input.request.environment &&
    authority.ownership_source === input.request.ownership_source &&
    authority.root_label === input.request.root_label &&
    authority.chain_network === input.configuration.chain.network &&
    authority.chain_genesis_block_hash === input.configuration.chain.genesis_block_hash &&
    authority.chain_driver_reference === input.configuration.chain.driver_reference
  );
}

async function retainOwnerResult(
  input: Readonly<{
    readonly execution: HnsTargetObserverLifecycleSourceInput;
    readonly result: HnsControlObservationResultV1;
    readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
    readonly semantic_facts_bytes: Uint8Array;
  }>,
): Promise<HnsTargetObserverExecutionResult> {
  const dns = input.execution.configuration.authoritative_dns;
  if (dns === null) {
    throw new HnsOwnerAuthoritativeTargetObserverError(
      "misconfigured",
      "HNS owner-authoritative source lacks DNS configuration",
    );
  }
  ownerAbortIfSet(input.execution.signal, "HNS owner result retention started after abort");
  let transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
  try {
    transcript = await validateHnsControlObserverTranscript({
      transcript: input.transcript,
      context: {
        ownership_source: "owner_authoritative_dns_txt",
        root_label: input.execution.request.root_label,
        hsd_driver_reference: input.execution.configuration.chain.driver_reference,
        hsd_response_max_bytes: input.execution.configuration.chain.response_max_bytes,
        authoritative_dns_driver_reference: dns.driver_reference,
        authoritative_dns_response_max_bytes: dns.response_max_bytes,
        required_view_ids: dns.required_view_ids,
        terminal_status: input.result.status,
        terminal_reason_code: input.result.status === "verified" ? null : input.result.reason_code,
      },
    });
  } catch (error) {
    ownerAbortIfSet(
      input.execution.signal,
      "HNS owner transcript validation completed after abort",
    );
    if (error instanceof HnsControlObserverTranscriptError) {
      throw new HnsOwnerAuthoritativeTargetObserverError(
        "invalid_response",
        "HNS owner-authoritative transcript is invalid",
      );
    }
    throw error;
  }
  ownerAbortIfSet(input.execution.signal, "HNS owner transcript validated after abort");
  return finalizeHnsControlObserverResult({
    request: input.execution.request,
    result: input.result,
    transcript,
    semantic_facts_bytes: input.semantic_facts_bytes,
    signal: input.execution.signal,
    abort_error: ownerAbortError,
  });
}

function mapStableError(error: HnsStableHsdBracketError): HnsOwnerAuthoritativeTargetObserverError {
  return new HnsOwnerAuthoritativeTargetObserverError(error.reason, error.message);
}

function mapDnsError(
  error: HnsOwnerAuthoritativeDnsObserverError,
): HnsOwnerAuthoritativeTargetObserverError {
  return new HnsOwnerAuthoritativeTargetObserverError(
    error.reason === "aborted" ? "transport_unavailable" : error.reason,
    error.message,
  );
}

export function makeHnsOwnerObserverCapacityResult(
  input: Readonly<{
    readonly request: HnsTargetObserverLifecycleSourceInput["request"];
    readonly request_sha256: HnsTargetObserverLifecycleSourceInput["request_sha256"];
    readonly snapshot_reference: string;
    readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsTargetObserverExecutionResult> {
  return finalizeHnsControlObserverResult({
    request: input.request,
    result: makeHnsUnavailableControlResult({
      request: input.request,
      request_sha256: input.request_sha256,
      reason: "observer_capacity",
      snapshot_reference: input.snapshot_reference,
    }),
    transcript: input.transcript,
    semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
    signal: input.signal,
    abort_error: ownerAbortError,
  });
}

export async function observeHnsOwnerAuthoritativeDnsSource(
  input: HnsTargetObserverLifecycleSourceInput &
    Readonly<{
      readonly hsd_transport: HnsControlObserverHsdTransportPort;
      readonly authoritative_dns_transport: HnsAuthoritativeDnsTransportPortV1;
      readonly message_ids: HnsAuthoritativeDnsMessageIdPortV1;
      readonly validator: HnsAuthoritativeDnsValidatorPortV1;
      readonly preobserved_bracket_result?: HnsStableHsdBracketResultV1;
    }>,
): Promise<HnsTargetObserverExecutionResult> {
  if (input.validator.policy_id !== HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID) {
    throw new HnsOwnerAuthoritativeTargetObserverError(
      "misconfigured",
      "HNS authoritative DNS validator policy is not the configured immutable policy",
    );
  }
  if (
    input.request.ownership_source !== "owner_authoritative_dns_txt" ||
    input.request.txt_name !== `_pirate.${input.request.root_label}`
  ) {
    throw new HnsOwnerAuthoritativeTargetObserverError(
      "invalid_request",
      "HNS owner-authoritative source received invalid request authority",
    );
  }
  const emptySemanticFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([]);
  let bracketResult: Awaited<ReturnType<typeof observeHnsStableHsdBracket>>;
  if (input.preobserved_bracket_result !== undefined) {
    bracketResult = input.preobserved_bracket_result;
  } else {
    try {
      bracketResult = await observeHnsStableHsdBracket({
        request: input.request,
        configuration: input.configuration,
        reservation_database_time: input.reservation_database_time,
        transport: input.hsd_transport,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof HnsStableHsdBracketError) throw mapStableError(error);
      throw error;
    }
  }
  ownerAbortIfSet(input.signal, "HNS stable owner bracket completed after abort");
  if (bracketResult.kind === "unavailable") {
    return retainOwnerResult({
      execution: input,
      result: makeHnsUnavailableControlResult({
        request: input.request,
        request_sha256: input.request_sha256,
        reason: bracketResult.reason,
        snapshot_reference: input.snapshot_reference,
      }),
      transcript: bracketResult.transcript,
      semantic_facts_bytes: emptySemanticFacts,
    });
  }
  const { bracket } = bracketResult;
  if (!bracketMatchesExecution(bracket, input)) {
    throw new HnsOwnerAuthoritativeTargetObserverError(
      "invalid_response",
      "HNS stable owner bracket authority differs from its execution",
    );
  }
  const expectedTxtValueSha256 = await sha256(
    new TextEncoder().encode(input.request.expected_txt_value),
  );
  ownerAbortIfSet(input.signal, "HNS owner expected TXT digest completed after abort");
  if (bracket.root.kind !== "active") {
    return retainOwnerResult({
      execution: input,
      result: makeHnsRejectedControlResult({
        request: input.request,
        request_sha256: input.request_sha256,
        reason: bracket.root.kind,
        expected_txt_value_sha256: expectedTxtValueSha256,
        observed_txt_values_digest: null,
        chain_authority_digest: bracket.chain_authority_digest,
        chain_anchor: bracket.anchor_a,
        chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
        expiry_height: bracket.root.expiry_height,
        snapshot_reference: input.snapshot_reference,
      }),
      transcript: bracket.transcript,
      semantic_facts_bytes: emptySemanticFacts,
    });
  }

  let dnsResult: Awaited<ReturnType<typeof observeHnsOwnerAuthoritativeDns>>;
  try {
    dnsResult = await observeHnsOwnerAuthoritativeDns({
      request: input.request,
      configuration: input.configuration,
      authority_records: bracket.authority_records,
      expected_chain_authority_digest: bracket.chain_authority_digest,
      reservation_database_time: input.reservation_database_time,
      initial_transcript: bracket.transcript,
      message_ids: input.message_ids,
      transport: input.authoritative_dns_transport,
      validator: input.validator,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof HnsOwnerAuthoritativeDnsObserverError) throw mapDnsError(error);
    throw error;
  }
  ownerAbortIfSet(input.signal, "HNS owner DNS kernel completed after abort");

  if (dnsResult.status === "unavailable") {
    if (
      dnsResult.reason_code === null ||
      dnsResult.reason_code === "txt_absent" ||
      dnsResult.reason_code === "txt_value_mismatch"
    ) {
      throw new HnsOwnerAuthoritativeTargetObserverError(
        "invalid_response",
        "HNS unavailable owner DNS result has an invalid reason",
      );
    }
    return retainOwnerResult({
      execution: input,
      result: makeHnsUnavailableControlResult({
        request: input.request,
        request_sha256: input.request_sha256,
        reason: dnsResult.reason_code,
        snapshot_reference: input.snapshot_reference,
      }),
      transcript: dnsResult.transcript,
      semantic_facts_bytes: dnsResult.semantic_facts_bytes,
    });
  }
  const safeRemainingBlocks =
    bracket.root.expiry_height -
    bracket.anchor_a.height -
    input.configuration.chain.expiry_safety_blocks;
  let rejection: HnsControlObservationRejectedReason | null = null;
  if (dnsResult.status === "rejected") {
    if (dnsResult.reason_code !== "txt_absent" && dnsResult.reason_code !== "txt_value_mismatch") {
      throw new HnsOwnerAuthoritativeTargetObserverError(
        "invalid_response",
        "HNS rejected owner DNS result has an invalid reason",
      );
    }
    rejection = dnsResult.reason_code;
  }
  if (
    dnsResult.status === "verified" &&
    safeRemainingBlocks < input.configuration.chain.minimum_safe_remaining_blocks
  ) {
    rejection = "expiry_horizon_insufficient";
  }
  if (rejection !== null) {
    return retainOwnerResult({
      execution: input,
      result: makeHnsRejectedControlResult({
        request: input.request,
        request_sha256: input.request_sha256,
        reason: rejection,
        expected_txt_value_sha256: expectedTxtValueSha256,
        observed_txt_values_digest: dnsResult.observed_txt_values_digest,
        chain_authority_digest: bracket.chain_authority_digest,
        chain_anchor: bracket.anchor_a,
        chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
        expiry_height: bracket.root.expiry_height,
        snapshot_reference: input.snapshot_reference,
      }),
      transcript: dnsResult.transcript,
      semantic_facts_bytes: dnsResult.semantic_facts_bytes,
    });
  }
  if (dnsResult.observed_txt_values_digest === null) {
    throw new HnsOwnerAuthoritativeTargetObserverError(
      "invalid_response",
      "HNS verified owner DNS result lacks observed TXT authority",
    );
  }
  const controlIdentityDigest = await hnsControlIdentityDigest({
    ownership_source: input.request.ownership_source,
    txt_name: input.request.txt_name,
    expected_txt_value: input.request.expected_txt_value,
    root_label: input.request.root_label,
    chain_authority_digest: bracket.chain_authority_digest,
  });
  ownerAbortIfSet(input.signal, "HNS owner control digest completed after abort");
  return retainOwnerResult({
    execution: input,
    result: makeHnsVerifiedControlResult({
      request: input.request,
      request_sha256: input.request_sha256,
      expected_txt_value_sha256: expectedTxtValueSha256,
      control_identity_digest: controlIdentityDigest,
      chain_authority_digest: bracket.chain_authority_digest,
      chain_anchor: bracket.anchor_a,
      chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
      expiry_height: bracket.root.expiry_height,
      snapshot_reference: input.snapshot_reference,
    }),
    transcript: dnsResult.transcript,
    semantic_facts_bytes: dnsResult.semantic_facts_bytes,
  });
}

export function makeHnsOwnerAuthoritativeDnsTargetObserver(
  input: Readonly<{
    readonly configuration_resolver: HnsControlObserverConfigurationResolverPort;
    readonly capabilities: HnsControlObserverRuntimeCapabilities;
    readonly snapshot_store: HnsControlObserverSnapshotStorePort;
    readonly hsd_transport: HnsControlObserverHsdTransportPort;
    readonly authoritative_dns_transport: HnsAuthoritativeDnsTransportPortV1;
    readonly message_ids: HnsAuthoritativeDnsMessageIdPortV1;
    readonly validator: HnsAuthoritativeDnsValidatorPortV1;
  }>,
): HnsTargetObserverPort {
  if (input.validator.policy_id !== HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID) {
    throw new HnsOwnerAuthoritativeTargetObserverError(
      "misconfigured",
      "HNS authoritative DNS validator policy is not the configured immutable policy",
    );
  }
  const validate = input.validator.validate.bind(input.validator);
  const validator = Object.freeze({
    policy_id: HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID,
    validate,
  });
  const lifecycle = makeHnsTargetObserverSnapshotLifecycle({
    ownership_source: "owner_authoritative_dns_txt",
    configuration_resolver: input.configuration_resolver,
    capabilities: input.capabilities,
    snapshot_store: input.snapshot_store,
    observe_source: (sourceInput) =>
      observeHnsOwnerAuthoritativeDnsSource({
        ...sourceInput,
        hsd_transport: input.hsd_transport,
        authoritative_dns_transport: input.authoritative_dns_transport,
        message_ids: input.message_ids,
        validator,
      }),
    make_capacity_result: makeHnsOwnerObserverCapacityResult,
  });
  return {
    observe: async (observation, options) => {
      try {
        return await lifecycle.observe(observation, options);
      } catch (error) {
        if (error instanceof HnsOwnerAuthoritativeTargetObserverError) throw error;
        if (error instanceof HnsParentChainObserverError) {
          throw new HnsOwnerAuthoritativeTargetObserverError(error.reason, error.message);
        }
        throw error;
      }
    },
  };
}
