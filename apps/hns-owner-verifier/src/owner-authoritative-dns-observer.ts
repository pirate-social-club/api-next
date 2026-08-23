import {
  buildHnsAuthoritativeDnsQueryV1,
  classifyHnsAuthoritativeDnsResponseV1,
  encodeHnsAuthoritativeDnsSemanticFactsV1,
  type HnsAuthoritativeDnsMessageIdPortV1,
  type HnsAuthoritativeDnsSemanticViewV1,
  HnsAuthoritativeDnsTransportErrorV1,
  type HnsAuthoritativeDnsTransportPortV1,
  type HnsAuthoritativeDnsValidationResultV1,
  type HnsAuthoritativeDnsValidatorPortV1,
  type HnsChainAuthorityRecord,
  type HnsControlObservationRequestV1,
  type HnsControlObservationUnavailableReason,
  type HnsControlObserverConfigurationV1,
  type HnsControlObserverTranscriptEntryV1,
  hnsChainAuthorityDigest,
  hnsChainAuthorityRecords,
  hnsObservedTxtValuesDigest,
  hnsObservedTxtValuesPreimage,
  selectHnsAuthoritativeDnsAuthorityTupleV1,
  validateHnsAuthoritativeDnsValidationResultV1,
  validateHnsControlObserverTranscript,
} from "@pirate/application/namespace-ownership";

type Sha256HexValue = HnsAuthoritativeDnsValidationResultV1["validated_chain_authority_digest"];

export type HnsOwnerAuthoritativeDnsObservationResult = Readonly<{
  readonly status: "verified" | "rejected" | "unavailable";
  readonly reason_code:
    | "txt_absent"
    | "txt_value_mismatch"
    | HnsControlObservationUnavailableReason
    | null;
  readonly observed_txt_values_digest: Sha256HexValue | null;
  readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
  readonly semantic_facts_bytes: Uint8Array;
}>;

export class HnsOwnerAuthoritativeDnsObserverError extends Error {
  readonly name = "HnsOwnerAuthoritativeDnsObserverError";

  constructor(
    readonly reason: "invalid_request" | "invalid_response" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

type CompletedDnsExchange = Readonly<{
  readonly request_bytes: Uint8Array;
  readonly request_sha256: Sha256HexValue;
  readonly response_bytes: Uint8Array;
  readonly response_sha256: Sha256HexValue;
}>;

type DnsExchangeResult =
  | Readonly<{ readonly kind: "response"; readonly exchange: CompletedDnsExchange }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason_code: HnsControlObservationUnavailableReason;
    }>;

async function sha256(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const value = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return value as Sha256HexValue;
}

function abortIfSet(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "aborted",
      "HNS owner-authoritative DNS observation was aborted",
    );
  }
}

function nextMessageId(
  input: Readonly<{
    readonly message_ids: HnsAuthoritativeDnsMessageIdPortV1;
    readonly used_ids: Set<number>;
    readonly view_id: string;
    readonly query_kind: "dnskey" | "control_txt";
    readonly signal: AbortSignal;
  }>,
): number {
  abortIfSet(input.signal);
  let messageId: number;
  try {
    messageId = input.message_ids.next_id(input.view_id, input.query_kind);
  } catch (error) {
    abortIfSet(input.signal);
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "invalid_response",
      `HNS authoritative DNS message-id capability threw: ${String(error)}`,
    );
  }
  if (
    !Number.isSafeInteger(messageId) ||
    messageId < 0 ||
    messageId > 65_535 ||
    input.used_ids.has(messageId)
  ) {
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "invalid_response",
      "HNS authoritative DNS message-id capability returned invalid entropy",
    );
  }
  input.used_ids.add(messageId);
  return messageId;
}

async function exchangeDns(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly configuration: HnsControlObserverConfigurationV1;
    readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
    readonly chain_authority_digest: Sha256HexValue;
    readonly view_id: string;
    readonly query_kind: "dnskey" | "control_txt";
    readonly tuple: Readonly<{
      readonly authority_nameserver: string;
      readonly authority_address_family: "GLUE4" | "GLUE6";
      readonly authority_address: string;
    }>;
    readonly message_ids: HnsAuthoritativeDnsMessageIdPortV1;
    readonly used_ids: Set<number>;
    readonly transport: HnsAuthoritativeDnsTransportPortV1;
    readonly transcript: HnsControlObserverTranscriptEntryV1[];
    readonly signal: AbortSignal;
  }>,
): Promise<DnsExchangeResult> {
  const dns = input.configuration.authoritative_dns;
  if (dns === null) {
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "invalid_request",
      "HNS owner-authoritative DNS configuration is absent",
    );
  }
  const messageId = nextMessageId({
    message_ids: input.message_ids,
    used_ids: input.used_ids,
    view_id: input.view_id,
    query_kind: input.query_kind,
    signal: input.signal,
  });
  const requestBytes = buildHnsAuthoritativeDnsQueryV1({
    message_id: messageId,
    query_kind: input.query_kind,
    root_label: input.request.root_label,
  });
  const requestHash = await sha256(requestBytes);
  abortIfSet(input.signal);

  let rawResponse: Uint8Array;
  try {
    rawResponse = await input.transport.exchange({
      driver_reference: dns.driver_reference,
      view_id: input.view_id,
      query_kind: input.query_kind,
      root_label: input.request.root_label,
      authority_records: input.authority_records,
      chain_authority_digest: input.chain_authority_digest,
      authority_nameserver: input.tuple.authority_nameserver,
      authority_address_family: input.tuple.authority_address_family,
      authority_address: input.tuple.authority_address,
      request_bytes: new Uint8Array(requestBytes),
      response_max_bytes: dns.response_max_bytes,
      signal: input.signal,
    });
  } catch (error) {
    abortIfSet(input.signal);
    const outcome =
      error instanceof HnsAuthoritativeDnsTransportErrorV1 &&
      (error.outcome === "timeout" ||
        error.outcome === "transport_error" ||
        error.outcome === "aborted")
        ? error.outcome
        : ("transport_error" as const);
    if (outcome === "aborted") {
      throw new HnsOwnerAuthoritativeDnsObserverError(
        "aborted",
        "HNS authoritative DNS transport aborted",
      );
    }
    input.transcript.push({
      driver_reference: dns.driver_reference,
      ownership_source: "owner_authoritative_dns_txt",
      method_or_view_id: input.view_id,
      request_bytes: requestBytes,
      request_sha256: requestHash,
      transport_outcome: outcome,
      transport_status: null,
      response_bytes: null,
      response_sha256: null,
    });
    return {
      kind: "unavailable",
      reason_code:
        outcome === "timeout" ? "authoritative_dns_timeout" : "authoritative_dns_inconclusive",
    };
  }
  abortIfSet(input.signal);
  if (!(rawResponse instanceof Uint8Array) || rawResponse.byteLength === 0) {
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "invalid_response",
      "HNS authoritative DNS transport returned invalid bytes",
    );
  }
  if (rawResponse.byteLength > dns.response_max_bytes + 1) {
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "invalid_response",
      "HNS authoritative DNS transport exceeded the capacity-marker contract",
    );
  }
  const capacity = rawResponse.byteLength === dns.response_max_bytes + 1;
  const responseBytes = new Uint8Array(
    capacity ? rawResponse.subarray(0, dns.response_max_bytes) : rawResponse,
  );
  const responseHash = await sha256(responseBytes);
  abortIfSet(input.signal);
  input.transcript.push({
    driver_reference: dns.driver_reference,
    ownership_source: "owner_authoritative_dns_txt",
    method_or_view_id: input.view_id,
    request_bytes: requestBytes,
    request_sha256: requestHash,
    transport_outcome: "response",
    transport_status: null,
    response_bytes: responseBytes,
    response_sha256: responseHash,
  });
  if (capacity) return { kind: "unavailable", reason_code: "observer_capacity" };
  return {
    kind: "response",
    exchange: {
      request_bytes: requestBytes,
      request_sha256: requestHash,
      response_bytes: responseBytes,
      response_sha256: responseHash,
    },
  };
}

function unavailableResult(
  input: Readonly<{
    readonly reason_code: HnsControlObservationUnavailableReason;
    readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
    readonly semantic_views: ReadonlyArray<HnsAuthoritativeDnsSemanticViewV1>;
  }>,
): HnsOwnerAuthoritativeDnsObservationResult {
  return {
    status: "unavailable",
    reason_code: input.reason_code,
    observed_txt_values_digest: null,
    transcript: input.transcript,
    semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1(input.semantic_views),
  };
}

/**
 * Disabled owner-source kernel. The complete source adapter supplies
 * `authority_records` and their expected digest from one stable HSD A/B
 * bracket. This function remains independently testable and is not composed by
 * the Worker runtime.
 */
export async function observeHnsOwnerAuthoritativeDns(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly configuration: HnsControlObserverConfigurationV1;
    readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
    readonly expected_chain_authority_digest?: Sha256HexValue;
    readonly reservation_database_time: string;
    readonly initial_transcript?: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
    readonly message_ids: HnsAuthoritativeDnsMessageIdPortV1;
    readonly transport: HnsAuthoritativeDnsTransportPortV1;
    readonly validator: HnsAuthoritativeDnsValidatorPortV1;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsOwnerAuthoritativeDnsObservationResult> {
  abortIfSet(input.signal);
  const dns = input.configuration.authoritative_dns;
  if (
    input.request.ownership_source !== "owner_authoritative_dns_txt" ||
    input.request.txt_name !== `_pirate.${input.request.root_label}` ||
    dns === null ||
    !input.configuration.ownership_sources.includes("owner_authoritative_dns_txt")
  ) {
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "invalid_request",
      "HNS owner-authoritative DNS observation authority is invalid",
    );
  }
  const canonicalAuthorityRecords = Object.freeze(
    hnsChainAuthorityRecords("owner_authoritative_dns_txt", input.authority_records).map(
      (record) => Object.freeze([...record]) as HnsChainAuthorityRecord,
    ),
  );
  const chainAuthorityDigest = await hnsChainAuthorityDigest({
    chain_network: input.configuration.chain.network,
    chain_genesis_block_hash: input.configuration.chain.genesis_block_hash,
    root_label: input.request.root_label,
    ownership_source: "owner_authoritative_dns_txt",
    authority_records: canonicalAuthorityRecords,
  });
  abortIfSet(input.signal);
  if (
    input.expected_chain_authority_digest !== undefined &&
    chainAuthorityDigest !== input.expected_chain_authority_digest
  ) {
    throw new HnsOwnerAuthoritativeDnsObserverError(
      "invalid_response",
      "HNS owner-authoritative DNS authority differs from its stable HSD bracket",
    );
  }
  const transcript = (input.initial_transcript ?? []).map((entry) => ({
    ...entry,
    request_bytes: new Uint8Array(entry.request_bytes),
    response_bytes: entry.response_bytes === null ? null : new Uint8Array(entry.response_bytes),
  }));
  const semanticViews: HnsAuthoritativeDnsSemanticViewV1[] = [];
  const usedIds = new Set<number>();
  const semanticKeys: string[] = [];
  const txtValueSets: ReadonlyArray<string>[] = [];
  let finalTxtDigest: Sha256HexValue | null = null;

  if (!canonicalAuthorityRecords.some((record) => record[0] === "DS")) {
    return unavailableResult({
      reason_code: "authoritative_dns_insecure",
      transcript,
      semantic_views: semanticViews,
    });
  }

  for (let viewOrdinal = 0; viewOrdinal < dns.required_view_ids.length; viewOrdinal += 1) {
    abortIfSet(input.signal);
    const viewId = dns.required_view_ids[viewOrdinal];
    const tuple = selectHnsAuthoritativeDnsAuthorityTupleV1(canonicalAuthorityRecords, viewOrdinal);
    if (viewId === undefined || tuple === null) {
      return unavailableResult({
        reason_code: "authoritative_dns_inconclusive",
        transcript,
        semantic_views: semanticViews,
      });
    }
    const dnskey = await exchangeDns({
      request: input.request,
      configuration: input.configuration,
      authority_records: canonicalAuthorityRecords,
      chain_authority_digest: chainAuthorityDigest,
      view_id: viewId,
      query_kind: "dnskey",
      tuple,
      message_ids: input.message_ids,
      used_ids: usedIds,
      transport: input.transport,
      transcript,
      signal: input.signal,
    });
    if (dnskey.kind === "unavailable") {
      return unavailableResult({
        reason_code: dnskey.reason_code,
        transcript,
        semantic_views: semanticViews,
      });
    }
    const dnskeyClassification = classifyHnsAuthoritativeDnsResponseV1({
      request_bytes: dnskey.exchange.request_bytes,
      response_bytes: dnskey.exchange.response_bytes,
    });
    if (dnskeyClassification.kind !== "dnskey") {
      return unavailableResult({
        reason_code:
          dnskeyClassification.kind === "servfail"
            ? "authoritative_dns_servfail"
            : "authoritative_dns_inconclusive",
        transcript,
        semantic_views: semanticViews,
      });
    }

    const control = await exchangeDns({
      request: input.request,
      configuration: input.configuration,
      authority_records: canonicalAuthorityRecords,
      chain_authority_digest: chainAuthorityDigest,
      view_id: viewId,
      query_kind: "control_txt",
      tuple,
      message_ids: input.message_ids,
      used_ids: usedIds,
      transport: input.transport,
      transcript,
      signal: input.signal,
    });
    if (control.kind === "unavailable") {
      return unavailableResult({
        reason_code: control.reason_code,
        transcript,
        semantic_views: semanticViews,
      });
    }
    const controlClassification = classifyHnsAuthoritativeDnsResponseV1({
      request_bytes: control.exchange.request_bytes,
      response_bytes: control.exchange.response_bytes,
    });
    if (
      controlClassification.kind !== "txt_values" &&
      controlClassification.kind !== "nxdomain" &&
      controlClassification.kind !== "nodata"
    ) {
      return unavailableResult({
        reason_code:
          controlClassification.kind === "servfail"
            ? "authoritative_dns_servfail"
            : "authoritative_dns_inconclusive",
        transcript,
        semantic_views: semanticViews,
      });
    }

    let rawValidation: unknown;
    try {
      abortIfSet(input.signal);
      rawValidation = await input.validator.validate({
        driver_reference: dns.driver_reference,
        view_id: viewId,
        root_label: input.request.root_label,
        authority_records: canonicalAuthorityRecords,
        chain_authority_digest: chainAuthorityDigest,
        authority_nameserver: tuple.authority_nameserver,
        authority_address_family: tuple.authority_address_family,
        authority_address: tuple.authority_address,
        dnskey_request_bytes: dnskey.exchange.request_bytes,
        dnskey_response_bytes: dnskey.exchange.response_bytes,
        control_request_bytes: control.exchange.request_bytes,
        control_response_bytes: control.exchange.response_bytes,
        validation_database_time: input.reservation_database_time,
        signal: input.signal,
      });
      abortIfSet(input.signal);
    } catch (error) {
      abortIfSet(input.signal);
      throw new HnsOwnerAuthoritativeDnsObserverError(
        "invalid_response",
        `HNS authoritative DNS validator threw: ${String(error)}`,
      );
    }
    let validation: HnsAuthoritativeDnsValidationResultV1;
    try {
      validation = await validateHnsAuthoritativeDnsValidationResultV1({
        value: rawValidation,
        dnskey_response_bytes: dnskey.exchange.response_bytes,
        control_response_bytes: control.exchange.response_bytes,
        chain_authority_digest: chainAuthorityDigest,
      });
    } catch (error) {
      abortIfSet(input.signal);
      throw new HnsOwnerAuthoritativeDnsObserverError(
        "invalid_response",
        `HNS authoritative DNS validator result is invalid: ${String(error)}`,
      );
    }
    abortIfSet(input.signal);

    const txtRecords =
      controlClassification.kind === "txt_values" ? controlClassification.observed_txt_records : [];
    const txtDigest = await hnsObservedTxtValuesDigest(txtRecords);
    const semanticClass =
      validation.dnssec_validation === "secure" ? controlClassification.kind : null;
    semanticViews.push({
      view_id: viewId,
      ...tuple,
      dnskey_request_sha256: dnskey.exchange.request_sha256,
      dnskey_response_sha256: dnskey.exchange.response_sha256,
      control_request_sha256: control.exchange.request_sha256,
      control_response_sha256: control.exchange.response_sha256,
      chain_authority_digest: chainAuthorityDigest,
      validation_database_time: input.reservation_database_time,
      dnssec_validation: validation.dnssec_validation,
      semantic_class: semanticClass,
      observed_txt_values_digest:
        semanticClass === "txt_values" ? (txtDigest as Sha256HexValue) : null,
    });
    if (validation.dnssec_validation === "insecure" || validation.dnssec_validation === "bogus") {
      return unavailableResult({
        reason_code: "authoritative_dns_insecure",
        transcript,
        semantic_views: semanticViews,
      });
    }
    if (validation.dnssec_validation === "indeterminate") {
      return unavailableResult({
        reason_code: "authoritative_dns_inconclusive",
        transcript,
        semantic_views: semanticViews,
      });
    }
    const semanticKey =
      controlClassification.kind === "txt_values"
        ? `txt:${hnsObservedTxtValuesPreimage(controlClassification.observed_txt_records)}`
        : controlClassification.kind;
    semanticKeys.push(semanticKey);
    if (controlClassification.kind === "txt_values") {
      txtValueSets.push(
        controlClassification.observed_txt_records.map((record) =>
          (Array.isArray(record) ? record : "chunks" in record ? record.chunks : []).join(""),
        ),
      );
      finalTxtDigest = txtDigest;
    }
  }

  abortIfSet(input.signal);
  if (new Set(semanticKeys).size !== 1) {
    return unavailableResult({
      reason_code: "authoritative_dns_inconclusive",
      transcript,
      semantic_views: semanticViews,
    });
  }
  const semanticKey = semanticKeys[0] ?? "";
  let result: HnsOwnerAuthoritativeDnsObservationResult;
  if (semanticKey === "nodata" || semanticKey === "nxdomain") {
    result = {
      status: "rejected",
      reason_code: "txt_absent",
      observed_txt_values_digest: null,
      transcript,
      semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1(semanticViews),
    };
  } else {
    const expected = input.request.expected_txt_value;
    const matchingValue =
      semanticKey.startsWith("txt:") &&
      txtValueSets.length === semanticKeys.length &&
      (txtValueSets[0]?.includes(expected) ?? false);
    result = {
      status: matchingValue ? "verified" : "rejected",
      reason_code: matchingValue ? null : "txt_value_mismatch",
      observed_txt_values_digest: finalTxtDigest,
      transcript,
      semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1(semanticViews),
    };
  }
  const retainedTranscript = await validateHnsControlObserverTranscript({
    transcript: result.transcript,
    context: {
      ownership_source: "owner_authoritative_dns_txt",
      root_label: input.request.root_label,
      hsd_driver_reference: input.configuration.chain.driver_reference,
      hsd_response_max_bytes: input.configuration.chain.response_max_bytes,
      authoritative_dns_driver_reference: dns.driver_reference,
      authoritative_dns_response_max_bytes: dns.response_max_bytes,
      required_view_ids: dns.required_view_ids,
      terminal_status: result.status,
    },
  });
  abortIfSet(input.signal);
  return { ...result, transcript: retainedTranscript };
}
