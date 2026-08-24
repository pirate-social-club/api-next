import {
  decodeHnsAuthorityInventoryBytes,
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  decodeHnsControlObservationResultV2Bytes,
  encodeHnsAuthoritativeDnsSemanticFactsV1,
  encodeHnsControlObservationResultV2,
  HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION,
  HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION,
  HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES,
  type HnsAuthoritativeDnsMessageIdPortV1,
  type HnsAuthoritativeDnsTransportPortV1,
  type HnsAuthoritativeDnsValidatorPortV1,
  type HnsAuthorityInventoryDecodedV1,
  type HnsAuthorityInventoryResolvedV1,
  type HnsAuthorityInventoryResolverPortV1,
  type HnsControlObservationIneligibleV2,
  type HnsControlObservationResultV2,
  HnsControlObserverConfigurationError,
  type HnsControlObserverConfigurationResolverPort,
  type HnsControlObserverConfigurationV1,
  type HnsControlObserverHsdTransportPort,
  type HnsControlObserverRuntimeCapabilitiesV2,
  type HnsControlObserverSnapshotStorePortV2,
  hnsControlObservationRequestHash,
  hnsControlObserverSnapshotDigestV2,
  hnsControlObserverSnapshotLogicalByteLengthV2,
  hnsControlObserverTranscriptManifestDigestV2,
  hnsControlObserverTranscriptManifestV2,
  hnsRootIsPirateWritable,
  isHnsControlObserverSnapshotReference,
  promoteHnsControlObservationResultV1ToV2,
  resolveHnsControlObserverConfigurationV2,
  validateHnsAuthorityInventoryAtDatabaseTime,
} from "@pirate/application/namespace-ownership";
import {
  HnsStableHsdBracketError,
  observeHnsStableHsdBracket,
} from "./hsd-parent-chain-observer.ts";
import {
  HnsOwnerAuthoritativeTargetObserverError,
  observeHnsOwnerAuthoritativeDnsSource,
} from "./owner-authoritative-source-observer.ts";
import type { HnsTargetObserverPort } from "./target-observer.ts";
import type {
  HnsTargetObserverExecutionResult,
  HnsTargetObserverSha256,
} from "./target-observer-result.ts";

const encoder = new TextEncoder();

type InventoryRetention = Readonly<{
  readonly authority_inventory_bytes: Uint8Array | null;
  readonly authority_inventory_reference_or_null: string | null;
  readonly authority_inventory_version_or_null: string | null;
  readonly authority_inventory_digest_or_null: HnsTargetObserverSha256 | null;
}>;

type V2Execution = InventoryRetention &
  Readonly<{
    readonly transcript: HnsTargetObserverExecutionResult["transcript"];
    readonly semantic_facts_bytes: Uint8Array;
    readonly semantic_facts_sha256: HnsTargetObserverSha256;
    readonly transcript_manifest_sha256: HnsTargetObserverSha256;
    readonly observer_snapshot_sha256: HnsTargetObserverSha256;
    readonly result_bytes: Uint8Array;
    readonly result_sha256: HnsTargetObserverSha256;
    readonly result_status: HnsControlObservationResultV2["status"];
    readonly result_reference_kind: "provider_evidence_ref" | "diagnostic_ref";
  }>;

function fail(
  reason: "invalid_request" | "misconfigured" | "transport_unavailable" | "invalid_response",
  message: string,
): HnsOwnerAuthoritativeTargetObserverError {
  return new HnsOwnerAuthoritativeTargetObserverError(reason, message);
}

function abortIfSet(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw fail("transport_unavailable", message);
}

async function sha256(bytes: Uint8Array): Promise<HnsTargetObserverSha256> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  ) as HnsTargetObserverSha256;
}

function canonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function configurationV1Projection(
  configuration: Awaited<
    ReturnType<typeof resolveHnsControlObserverConfigurationV2>
  >["configuration"],
): HnsControlObserverConfigurationV1 {
  const { authority_inventory: _authorityInventory, ...shared } = configuration;
  return { ...shared, version: HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION };
}

async function makeV2Execution(
  input: Readonly<{
    readonly request: Awaited<
      ReturnType<typeof decodeHnsControlObservationRequestBytes>
    >["request"];
    readonly request_sha256: HnsTargetObserverSha256;
    readonly provider_configuration_digest: HnsTargetObserverSha256;
    readonly reservation_database_time: string;
    readonly snapshot_reference: string;
    readonly inventory: InventoryRetention;
    readonly transcript: HnsTargetObserverExecutionResult["transcript"];
    readonly semantic_facts_bytes: Uint8Array;
    readonly make_result: (
      observerSnapshotSha256: HnsTargetObserverSha256,
    ) => HnsControlObservationResultV2;
  }>,
): Promise<V2Execution> {
  const transcriptManifestSha256 = (await hnsControlObserverTranscriptManifestDigestV2(
    hnsControlObserverTranscriptManifestV2(input.transcript),
  )) as HnsTargetObserverSha256;
  const semanticFactsBytes = new Uint8Array(input.semantic_facts_bytes);
  const semanticFactsSha256 = await sha256(semanticFactsBytes);
  const observerSnapshotSha256 = (await hnsControlObserverSnapshotDigestV2({
    observation_id: input.request.observation_id,
    request_sha256: input.request_sha256,
    provider_configuration_digest: input.provider_configuration_digest,
    authority_inventory_reference_or_null: input.inventory.authority_inventory_reference_or_null,
    authority_inventory_version_or_null: input.inventory.authority_inventory_version_or_null,
    authority_inventory_digest_or_null: input.inventory.authority_inventory_digest_or_null,
    reservation_database_time: input.reservation_database_time,
    snapshot_reference: input.snapshot_reference,
    transcript_manifest_sha256: transcriptManifestSha256,
    semantic_facts_sha256: semanticFactsSha256,
  })) as HnsTargetObserverSha256;
  const encoded = await encodeHnsControlObservationResultV2(
    input.make_result(observerSnapshotSha256),
  );
  const decoded = await decodeHnsControlObservationResultV2Bytes(encoded, input.request);
  return Object.freeze({
    ...input.inventory,
    transcript: input.transcript,
    semantic_facts_bytes: semanticFactsBytes,
    semantic_facts_sha256: semanticFactsSha256,
    transcript_manifest_sha256: transcriptManifestSha256,
    observer_snapshot_sha256: observerSnapshotSha256,
    result_bytes: new Uint8Array(decoded.result_bytes),
    result_sha256: decoded.result_sha256 as HnsTargetObserverSha256,
    result_status: decoded.result.status,
    result_reference_kind:
      decoded.result.status === "verified" || decoded.result.status === "rejected"
        ? "provider_evidence_ref"
        : "diagnostic_ref",
  });
}

async function retainResolvedInventory(
  resolved: HnsAuthorityInventoryResolvedV1,
  maximumBytes: number,
): Promise<InventoryRetention> {
  const bytes = new Uint8Array(resolved.inventory_bytes.slice(0, maximumBytes + 1));
  const recomputedDigest = await sha256(bytes);
  if (resolved.authority_inventory_digest !== recomputedDigest) {
    throw new TypeError("HNS custody resolver inventory digest differs from exact bytes");
  }
  return Object.freeze({
    authority_inventory_bytes: bytes,
    authority_inventory_reference_or_null: resolved.authority_inventory_reference,
    authority_inventory_version_or_null: resolved.authority_inventory_version,
    authority_inventory_digest_or_null: resolved.authority_inventory_digest,
  });
}

async function inventoryUnavailableExecution(
  input: Readonly<{
    readonly request: Parameters<typeof makeV2Execution>[0]["request"];
    readonly request_sha256: HnsTargetObserverSha256;
    readonly provider_configuration_digest: HnsTargetObserverSha256;
    readonly reservation_database_time: string;
    readonly snapshot_reference: string;
    readonly inventory: InventoryRetention;
  }>,
): Promise<V2Execution> {
  const emptyFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([]);
  return makeV2Execution({
    ...input,
    transcript: [],
    semantic_facts_bytes: emptyFacts,
    make_result: (observerSnapshotSha256) => ({
      version: HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION,
      observation_id: input.request.observation_id,
      request_sha256: input.request_sha256,
      status: "unavailable",
      reason_code: "authority_inventory_unavailable",
      retry_after_seconds: null,
      observer_snapshot_sha256: observerSnapshotSha256,
      diagnostic_ref: input.snapshot_reference,
    }),
  });
}

async function semanticExecutionV2(
  input: Readonly<{
    readonly request: Parameters<typeof makeV2Execution>[0]["request"];
    readonly request_sha256: HnsTargetObserverSha256;
    readonly configuration: Awaited<
      ReturnType<typeof resolveHnsControlObserverConfigurationV2>
    >["configuration"];
    readonly provider_configuration_digest: HnsTargetObserverSha256;
    readonly reservation_database_time: string;
    readonly snapshot_reference: string;
    readonly inventory: InventoryRetention;
    readonly decoded_inventory: HnsAuthorityInventoryDecodedV1;
    readonly hsd_transport: HnsControlObserverHsdTransportPort;
    readonly authoritative_dns_transport: HnsAuthoritativeDnsTransportPortV1;
    readonly message_ids: HnsAuthoritativeDnsMessageIdPortV1;
    readonly validator: HnsAuthoritativeDnsValidatorPortV1;
    readonly signal: AbortSignal;
  }>,
): Promise<V2Execution> {
  const configuration = configurationV1Projection(input.configuration);
  let bracketResult: Awaited<ReturnType<typeof observeHnsStableHsdBracket>>;
  try {
    bracketResult = await observeHnsStableHsdBracket({
      request: input.request,
      configuration,
      reservation_database_time: input.reservation_database_time,
      transport: input.hsd_transport,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof HnsStableHsdBracketError) {
      throw fail(error.reason, error.message);
    }
    throw error;
  }
  abortIfSet(input.signal, "HNS custody bracket completed after abort");
  if (
    bracketResult.kind === "stable" &&
    bracketResult.bracket.root.kind === "active" &&
    hnsRootIsPirateWritable({
      root_label: input.request.root_label,
      chain_authority_records: bracketResult.bracket.authority_records,
      inventory: input.decoded_inventory.inventory,
    })
  ) {
    const expectedTxtValueSha256 = await sha256(encoder.encode(input.request.expected_txt_value));
    const bracket = bracketResult.bracket;
    if (bracket.root.expiry_height === null) {
      throw fail("invalid_response", "HNS custody active root lacks expiry authority");
    }
    const expiryHeight = bracket.root.expiry_height;
    return makeV2Execution({
      ...input,
      transcript: bracket.transcript,
      semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
      make_result: (observerSnapshotSha256) =>
        ({
          version: HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION,
          observation_id: input.request.observation_id,
          request_sha256: input.request_sha256,
          status: "ineligible",
          reason_code: "owner_authoritative_source_ineligible",
          provider_id: input.request.provider_id,
          provider_configuration_reference: input.request.provider_configuration_reference,
          provider_configuration_version: input.request.provider_configuration_version,
          provider_configuration_digest: input.provider_configuration_digest,
          environment: input.request.environment,
          ownership_source: "owner_authoritative_dns_txt",
          root_label: input.request.root_label,
          txt_name: input.request.txt_name,
          expected_txt_value_sha256: expectedTxtValueSha256,
          chain_authority_digest: bracket.chain_authority_digest,
          chain_network: bracket.anchor_a.network,
          chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
          chain_anchor_height: bracket.anchor_a.height,
          chain_anchor_block_hash: bracket.anchor_a.best_block_hash,
          chain_anchor_median_time: bracket.anchor_a.median_time,
          expiry_height: expiryHeight,
          authority_inventory_reference:
            input.decoded_inventory.inventory.authority_inventory_reference,
          authority_inventory_version:
            input.decoded_inventory.inventory.authority_inventory_version,
          authority_inventory_digest: input.decoded_inventory.inventory_digest,
          observer_snapshot_sha256: observerSnapshotSha256,
          diagnostic_ref: input.snapshot_reference,
        }) satisfies HnsControlObservationIneligibleV2,
    });
  }
  const semantic = await observeHnsOwnerAuthoritativeDnsSource({
    request: input.request,
    request_sha256: input.request_sha256,
    configuration,
    configuration_digest: input.provider_configuration_digest,
    reservation_database_time: input.reservation_database_time,
    snapshot_reference: input.snapshot_reference,
    signal: input.signal,
    hsd_transport: input.hsd_transport,
    authoritative_dns_transport: input.authoritative_dns_transport,
    message_ids: input.message_ids,
    validator: input.validator,
    preobserved_bracket_result: bracketResult,
  });
  const decodedV1 = await decodeHnsControlObservationResultBytes(
    semantic.result_bytes,
    input.request,
  );
  return makeV2Execution({
    ...input,
    transcript: semantic.transcript,
    semantic_facts_bytes: semantic.semantic_facts_bytes,
    make_result: (observerSnapshotSha256) =>
      promoteHnsControlObservationResultV1ToV2(decodedV1.result, observerSnapshotSha256),
  });
}

function sameLeasePolicy(
  policy: Readonly<{
    readonly expected_block_interval_seconds: number;
    readonly minimum_safe_remaining_blocks: number;
    readonly expiry_safety_blocks: number;
    readonly evidence_lease_seconds: number;
  }>,
  configuration: Awaited<
    ReturnType<typeof resolveHnsControlObserverConfigurationV2>
  >["configuration"],
): boolean {
  return (
    policy.expected_block_interval_seconds ===
      configuration.chain.expected_block_interval_seconds &&
    policy.minimum_safe_remaining_blocks === configuration.chain.minimum_safe_remaining_blocks &&
    policy.expiry_safety_blocks === configuration.chain.expiry_safety_blocks &&
    policy.evidence_lease_seconds === configuration.evidence_lease_seconds
  );
}

export function makeHnsOwnerAuthoritativeDnsTargetObserverV2(
  input: Readonly<{
    readonly configuration_resolver: HnsControlObserverConfigurationResolverPort;
    readonly capabilities: HnsControlObserverRuntimeCapabilitiesV2;
    readonly authority_inventory_resolver: HnsAuthorityInventoryResolverPortV1;
    readonly snapshot_store: HnsControlObserverSnapshotStorePortV2;
    readonly hsd_transport: HnsControlObserverHsdTransportPort;
    readonly authoritative_dns_transport: HnsAuthoritativeDnsTransportPortV1;
    readonly message_ids: HnsAuthoritativeDnsMessageIdPortV1;
    readonly validator: HnsAuthoritativeDnsValidatorPortV1;
  }>,
): HnsTargetObserverPort {
  return {
    observe: async (observation, options) => {
      abortIfSet(options.signal, "HNS custody observation was already aborted");
      const decodedRequest = await decodeHnsControlObservationRequestBytes(
        observation.request_bytes,
      );
      if (
        decodedRequest.request_sha256 !==
          (await hnsControlObservationRequestHash(observation.request)) ||
        JSON.stringify(decodedRequest.request) !== JSON.stringify(observation.request) ||
        decodedRequest.request.provider_id !== "hns.owner.v1" ||
        decodedRequest.request.ownership_source !== "owner_authoritative_dns_txt"
      ) {
        throw fail("invalid_request", "HNS custody request projection and bytes differ");
      }
      let resolvedConfiguration: Awaited<
        ReturnType<typeof resolveHnsControlObserverConfigurationV2>
      >;
      try {
        resolvedConfiguration = await resolveHnsControlObserverConfigurationV2({
          authority: {
            provider_id: "hns.owner.v1",
            provider_configuration_reference:
              decodedRequest.request.provider_configuration_reference,
            provider_configuration_version: decodedRequest.request.provider_configuration_version,
            provider_configuration_digest: decodedRequest.request.provider_configuration_digest,
            environment: decodedRequest.request.environment,
            ownership_source: decodedRequest.request.ownership_source,
          },
          capabilities: input.capabilities,
          resolver: input.configuration_resolver,
          deadline_ms: options.deadline_ms,
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof HnsControlObserverConfigurationError) {
          throw fail("misconfigured", "HNS custody configuration authority is invalid");
        }
        throw fail("transport_unavailable", "HNS custody configuration registry is unavailable");
      }
      const configuration = resolvedConfiguration.configuration;
      if (
        options.deadline_ms !== configuration.observer_deadline_ms ||
        configuration.authority_inventory === null ||
        !sameLeasePolicy(observation.lease_policy, configuration)
      ) {
        throw fail("misconfigured", "HNS custody immutable configuration is incomplete");
      }
      let reservation: Awaited<ReturnType<HnsControlObserverSnapshotStorePortV2["reserve"]>>;
      try {
        reservation = await input.snapshot_store.reserve(
          {
            observation_id: decodedRequest.request.observation_id,
            request_bytes: decodedRequest.request_bytes,
            request_sha256: decodedRequest.request_sha256,
            configuration_bytes: resolvedConfiguration.configuration_bytes,
            provider_configuration_digest: resolvedConfiguration.configuration_digest,
            reservation_lease_seconds: configuration.observer_reservation_lease_seconds,
          },
          options,
        );
      } catch {
        throw fail("transport_unavailable", "HNS custody snapshot reservation is unavailable");
      }
      abortIfSet(options.signal, "HNS custody reservation completed after abort");
      if (reservation.kind === "mismatch") {
        throw fail("invalid_request", "HNS custody observation id reused different authority");
      }
      if (reservation.kind === "busy") {
        throw fail("transport_unavailable", "HNS custody observation has another live fence");
      }
      if (reservation.kind === "replay") {
        const replay = await decodeHnsControlObservationResultV2Bytes(
          reservation.result_bytes,
          decodedRequest.request,
        );
        if (
          replay.result_sha256 !== reservation.result_sha256 ||
          (replay.result.status === "unavailable" || replay.result.status === "ineligible"
            ? replay.result.diagnostic_ref !== reservation.snapshot_reference
            : replay.result.provider_evidence_ref !== reservation.snapshot_reference)
        ) {
          throw fail("invalid_response", "HNS custody replay is not cross-pinned");
        }
        return new Uint8Array(replay.result_bytes);
      }
      if (
        !Number.isSafeInteger(reservation.observer_fence) ||
        reservation.observer_fence < 1 ||
        !isHnsControlObserverSnapshotReference(reservation.snapshot_reference) ||
        !canonicalInstant(reservation.reservation_database_time) ||
        !canonicalInstant(reservation.lease_expires_at) ||
        Date.parse(reservation.lease_expires_at) -
          Date.parse(reservation.reservation_database_time) !==
          configuration.observer_reservation_lease_seconds * 1_000
      ) {
        throw fail("invalid_response", "HNS custody reservation authority is malformed");
      }
      let resolvedInventory: HnsAuthorityInventoryResolvedV1 | null = null;
      let inventoryRetention: InventoryRetention = Object.freeze({
        authority_inventory_bytes: null,
        authority_inventory_reference_or_null: null,
        authority_inventory_version_or_null: null,
        authority_inventory_digest_or_null: null,
      });
      let decodedInventory: HnsAuthorityInventoryDecodedV1 | null = null;
      try {
        resolvedInventory = await input.authority_inventory_resolver.resolve(options);
        if (resolvedInventory !== null) {
          inventoryRetention = await retainResolvedInventory(
            resolvedInventory,
            configuration.authority_inventory.response_max_bytes,
          );
          decodedInventory = await decodeHnsAuthorityInventoryBytes(
            inventoryRetention.authority_inventory_bytes,
          );
          const retainedInventoryDigest = inventoryRetention.authority_inventory_digest_or_null;
          if (retainedInventoryDigest === null) {
            throw new TypeError("HNS custody retained inventory lacks its digest");
          }
          validateHnsAuthorityInventoryAtDatabaseTime({
            decoded: decodedInventory,
            expected_reference: resolvedInventory.authority_inventory_reference,
            expected_version: resolvedInventory.authority_inventory_version,
            expected_digest: retainedInventoryDigest,
            expected_environment: configuration.environment,
            expected_runtime_capability_set_digest:
              input.capabilities.authority_inventory_runtime_capability_set_digest,
            database_now: reservation.reservation_database_time,
            maximum_inventory_lifetime_seconds:
              configuration.authority_inventory.maximum_inventory_lifetime_seconds,
          });
        }
      } catch {
        decodedInventory = null;
      }
      abortIfSet(options.signal, "HNS custody inventory resolution completed after abort");
      let execution =
        decodedInventory === null
          ? await inventoryUnavailableExecution({
              request: decodedRequest.request,
              request_sha256: decodedRequest.request_sha256,
              provider_configuration_digest: resolvedConfiguration.configuration_digest,
              reservation_database_time: reservation.reservation_database_time,
              snapshot_reference: reservation.snapshot_reference,
              inventory: inventoryRetention,
            })
          : await semanticExecutionV2({
              request: decodedRequest.request,
              request_sha256: decodedRequest.request_sha256,
              configuration,
              provider_configuration_digest: resolvedConfiguration.configuration_digest,
              reservation_database_time: reservation.reservation_database_time,
              snapshot_reference: reservation.snapshot_reference,
              inventory: inventoryRetention,
              decoded_inventory: decodedInventory,
              hsd_transport: input.hsd_transport,
              authoritative_dns_transport: input.authoritative_dns_transport,
              message_ids: input.message_ids,
              validator: input.validator,
              signal: options.signal,
            });
      const logicalInput = () => ({
        observation_id: decodedRequest.request.observation_id,
        observer_fence: reservation.observer_fence,
        reservation_database_time: reservation.reservation_database_time,
        lease_expires_at: reservation.lease_expires_at,
        request_bytes: decodedRequest.request_bytes,
        request_sha256: decodedRequest.request_sha256,
        configuration_bytes: resolvedConfiguration.configuration_bytes,
        provider_configuration_digest: resolvedConfiguration.configuration_digest,
        ...execution,
        snapshot_reference: reservation.snapshot_reference,
      });
      if (
        hnsControlObserverSnapshotLogicalByteLengthV2(logicalInput()) >
        HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES
      ) {
        execution = await makeV2Execution({
          request: decodedRequest.request,
          request_sha256: decodedRequest.request_sha256,
          provider_configuration_digest: resolvedConfiguration.configuration_digest,
          reservation_database_time: reservation.reservation_database_time,
          snapshot_reference: reservation.snapshot_reference,
          inventory: inventoryRetention,
          transcript: execution.transcript,
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
          make_result: (observerSnapshotSha256) => ({
            version: HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION,
            observation_id: decodedRequest.request.observation_id,
            request_sha256: decodedRequest.request_sha256,
            status: "unavailable",
            reason_code: "observer_capacity",
            retry_after_seconds: null,
            observer_snapshot_sha256: observerSnapshotSha256,
            diagnostic_ref: reservation.snapshot_reference,
          }),
        });
      }
      if (
        hnsControlObserverSnapshotLogicalByteLengthV2(logicalInput()) >
        HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES
      ) {
        throw fail("invalid_response", "HNS custody capacity result exceeds snapshot bound");
      }
      abortIfSet(options.signal, "HNS custody semantic observation completed after abort");
      let finalized: Awaited<ReturnType<HnsControlObserverSnapshotStorePortV2["finalize"]>>;
      try {
        finalized = await input.snapshot_store.finalize(
          {
            observation_id: decodedRequest.request.observation_id,
            observer_fence: reservation.observer_fence,
            request_sha256: decodedRequest.request_sha256,
            provider_configuration_digest: resolvedConfiguration.configuration_digest,
            snapshot_reference: reservation.snapshot_reference,
            authority_inventory_bytes: execution.authority_inventory_bytes,
            authority_inventory_reference_or_null: execution.authority_inventory_reference_or_null,
            authority_inventory_version_or_null: execution.authority_inventory_version_or_null,
            authority_inventory_digest_or_null: execution.authority_inventory_digest_or_null,
            transcript: execution.transcript,
            transcript_manifest_sha256: execution.transcript_manifest_sha256,
            semantic_facts_bytes: execution.semantic_facts_bytes,
            semantic_facts_sha256: execution.semantic_facts_sha256,
            observer_snapshot_sha256: execution.observer_snapshot_sha256,
            result_bytes: execution.result_bytes,
            result_sha256: execution.result_sha256,
          },
          options,
        );
      } catch {
        throw fail("transport_unavailable", "HNS custody snapshot finalization is unavailable");
      }
      abortIfSet(options.signal, "HNS custody finalization completed after abort");
      if (finalized.kind === "lost") {
        throw fail("transport_unavailable", "HNS custody finalization lost its fence");
      }
      if (
        finalized.kind === "mismatch" ||
        finalized.snapshot_reference !== reservation.snapshot_reference ||
        finalized.result_sha256 !== execution.result_sha256 ||
        finalized.result_bytes.byteLength !== execution.result_bytes.byteLength ||
        !finalized.result_bytes.every((byte, index) => byte === execution.result_bytes[index])
      ) {
        throw fail("invalid_response", "HNS custody finalization authority mismatched");
      }
      return new Uint8Array(finalized.result_bytes);
    },
  };
}
