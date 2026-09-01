import { X509Certificate } from "node:crypto";
import { createConnection, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import {
  buildHnsAuthoritativeDnsQueryV1,
  classifyHnsAuthoritativeDnsResponseV1,
  type HnsAuthoritativeDnsAddressFamilyV1,
  type HnsChainAuthorityRecord,
  hnsChainAuthorityDigest,
  hnsChainAuthorityRecords,
  makeHnsAuthoritativeDnsValidatorV1,
} from "@pirate/application/namespace-ownership";
import type { Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { deriveCanonicalHnsAuthorityZoneBytesV1 } from "@pirate/hns-dns-runtime/dns-axfr-zone";
import {
  exchangeDirectHnsDnsTcp,
  makeNodeHnsDnsTcpConnector,
} from "@pirate/hns-dns-runtime/dns-tcp";
import {
  exchangeDirectHnsDnsTsigAxfrV1,
  HNS_DNS_TSIG_AXFR_ALGORITHM,
  type HnsDnsTsigCredentialV1,
} from "@pirate/hns-dns-runtime/dns-tsig-axfr";

export type HnsRootReadinessAuthorityEndpointV1 = Readonly<{
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
  readonly local_address: string;
}>;

type HnsRootReadinessAuthorityViewV1 = Readonly<{
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
  readonly dnssec_validation: "secure";
  readonly challenge_present: true;
  readonly validated_dnskey_response_sha256: string;
  readonly validated_control_response_sha256: string;
  readonly validated_chain_authority_digest: string;
  readonly observed_zone_bytes: Uint8Array;
  readonly observed_zone_sha256: string;
}>;

export type HnsRootReadinessGatewayViewV1 = Readonly<{
  readonly normalized_host: string;
  readonly gateway_address: string;
  readonly certificate_spki_sha256: string;
  readonly http_status: 200 | 421;
}>;

export type HnsRootLiveReadinessResultV1 = Readonly<{
  readonly authority_views: readonly [
    HnsRootReadinessAuthorityViewV1,
    HnsRootReadinessAuthorityViewV1,
  ];
  readonly gateway: HnsRootReadinessGatewayViewV1;
}>;

export type HnsRootLiveReadinessConfigV1 = Readonly<{
  readonly chain_network: string;
  readonly chain_genesis_block_hash: string;
  readonly authorities: readonly [
    HnsRootReadinessAuthorityEndpointV1,
    HnsRootReadinessAuthorityEndpointV1,
  ];
  readonly axfr_credential: HnsDnsTsigCredentialV1;
  readonly gateway_address: string;
  readonly gateway_local_address: string;
  readonly expected_gateway_certificate_spki_sha256: string;
  readonly timeout_ms: number;
}>;

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", Uint8Array.from(bytes).buffer)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function validDnsName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    !value.endsWith(".") &&
    value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}

function assertConfiguration(config: HnsRootLiveReadinessConfigV1): void {
  if (
    config.chain_network.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(config.chain_genesis_block_hash) ||
    config.authorities[0].authority_nameserver >= config.authorities[1].authority_nameserver ||
    new Set(config.authorities.map((entry) => entry.authority_nameserver)).size !== 2 ||
    config.authorities.some(
      (entry) =>
        !validDnsName(entry.authority_nameserver) ||
        isIP(entry.authority_address) !== (entry.authority_address_family === "GLUE4" ? 4 : 6) ||
        isIP(entry.local_address) !== (entry.authority_address_family === "GLUE4" ? 4 : 6),
    ) ||
    config.axfr_credential.algorithm !== HNS_DNS_TSIG_AXFR_ALGORITHM ||
    config.axfr_credential.secret_bytes.byteLength < 16 ||
    config.axfr_credential.secret_bytes.byteLength > 512 ||
    isIP(config.gateway_address) !== 4 ||
    isIP(config.gateway_local_address) !== 4 ||
    !/^[0-9a-f]{64}$/u.test(config.expected_gateway_certificate_spki_sha256) ||
    !Number.isSafeInteger(config.timeout_ms) ||
    config.timeout_ms < 1_000 ||
    config.timeout_ms > 12_000
  ) {
    throw new Error("HNS live readiness configuration is invalid");
  }
}

function nextMessageId(): number {
  const bytes = new Uint16Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] ?? 0;
}

function challengePresent(
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
  challenge: string,
): boolean {
  const classified = classifyHnsAuthoritativeDnsResponseV1({
    request_bytes: requestBytes,
    response_bytes: responseBytes,
  });
  return (
    classified.kind === "txt_values" &&
    classified.observed_txt_records.some(
      (record) => ("chunks" in record ? record.chunks : record).join("") === challenge,
    )
  );
}

export function hnsGatewayReadinessStatusV1(statusLine: string): 200 | 421 {
  const match = statusLine.match(/^HTTP\/1\.[01] ([0-9]{3})(?: |$)/u);
  const status = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (status !== 200 && status !== 421) {
    throw new Error("HNS gateway readiness response is unhealthy");
  }
  return status;
}

async function probeGateway(input: {
  readonly root_label: string;
  readonly gateway_address: string;
  readonly gateway_local_address: string;
  readonly timeout_ms: number;
}): Promise<HnsRootReadinessGatewayViewV1> {
  const host = `app.${input.root_label}`;
  return await new Promise((resolve, reject) => {
    let completed = false;
    let received = new Uint8Array();
    let socket: ReturnType<typeof connectTls> | undefined;
    const transport = createConnection({
      host: input.gateway_address,
      port: 443,
      family: 4,
      localAddress: input.gateway_local_address,
    });
    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      socket?.destroy();
      transport.destroy();
      action();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("HNS gateway readiness probe timed out"))),
      input.timeout_ms,
    );
    socket = connectTls({
      socket: transport,
      servername: host,
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => {
      const raw = socket?.getPeerCertificate(true).raw;
      if (raw === undefined) {
        finish(() => reject(new Error("HNS gateway did not present a certificate")));
        return;
      }
      let spki: Uint8Array;
      try {
        spki = new Uint8Array(
          new X509Certificate(raw).publicKey.export({ format: "der", type: "spki" }),
        );
      } catch {
        finish(() => reject(new Error("HNS gateway certificate is invalid")));
        return;
      }
      socket?.write(
        encoder.encode(
          `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: pirate-hns-readiness-v1\r\n\r\n`,
        ),
      );
      socket?.on("data", (chunk: Uint8Array) => {
        const next = new Uint8Array(received.byteLength + chunk.byteLength);
        next.set(received);
        next.set(chunk, received.byteLength);
        received = next;
        if (received.byteLength > 65_536) {
          finish(() => reject(new Error("HNS gateway response exceeded its byte limit")));
          return;
        }
        const headerEnd = new TextDecoder().decode(received).indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const statusLine = new TextDecoder()
          .decode(received.subarray(0, headerEnd))
          .split("\r\n")[0];
        let status: 200 | 421;
        try {
          status = hnsGatewayReadinessStatusV1(statusLine ?? "");
        } catch {
          finish(() => reject(new Error("HNS gateway readiness response is unhealthy")));
          return;
        }
        void sha256(spki).then(
          (certificateSpkiSha256) =>
            finish(() =>
              resolve({
                normalized_host: host,
                gateway_address: input.gateway_address,
                certificate_spki_sha256: certificateSpkiSha256,
                http_status: status,
              }),
            ),
          () => finish(() => reject(new Error("HNS gateway certificate digest failed"))),
        );
      });
    });
    socket.once("error", () =>
      finish(() => reject(new Error("HNS gateway readiness probe failed"))),
    );
  });
}

export function makeLiveHnsRootReadinessObserverV1(config: HnsRootLiveReadinessConfigV1) {
  assertConfiguration(config);
  const validator = makeHnsAuthoritativeDnsValidatorV1();
  return async (input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
    readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  }): Promise<HnsRootLiveReadinessResultV1> => {
    const records = hnsChainAuthorityRecords(
      "owner_authoritative_dns_txt",
      input.authority_records,
    );
    const chainDigest = await hnsChainAuthorityDigest({
      chain_network: config.chain_network,
      chain_genesis_block_hash: config.chain_genesis_block_hash as Sha256HexValue,
      root_label: input.root_label,
      ownership_source: "owner_authoritative_dns_txt",
      authority_records: records,
    });
    const validationTime = new Date().toISOString();
    const views: HnsRootReadinessAuthorityViewV1[] = [];
    for (const endpoint of config.authorities) {
      const family = endpoint.authority_address_family === "GLUE4" ? 4 : 6;
      const connector = makeNodeHnsDnsTcpConnector({ local_address: endpoint.local_address });
      const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
        message_id: nextMessageId(),
        query_kind: "dnskey",
        root_label: input.root_label,
      });
      const controlRequest = buildHnsAuthoritativeDnsQueryV1({
        message_id: nextMessageId(),
        query_kind: "control_txt",
        root_label: input.root_label,
      });
      const dnskeyResponse = await exchangeDirectHnsDnsTcp({
        connector,
        host: endpoint.authority_address,
        family,
        request_bytes: dnskeyRequest,
        response_max_bytes: 65_535,
        timeout_ms: config.timeout_ms,
        signal: AbortSignal.timeout(config.timeout_ms),
      });
      const controlResponse = await exchangeDirectHnsDnsTcp({
        connector,
        host: endpoint.authority_address,
        family,
        request_bytes: controlRequest,
        response_max_bytes: 65_535,
        timeout_ms: config.timeout_ms,
        signal: AbortSignal.timeout(config.timeout_ms),
      });
      const validated = await (await validator).validate({
        driver_reference: "hns-root-readiness-direct-v1",
        view_id: endpoint.authority_nameserver,
        root_label: input.root_label,
        authority_records: records,
        chain_authority_digest: chainDigest,
        authority_nameserver: endpoint.authority_nameserver,
        authority_address_family: endpoint.authority_address_family,
        authority_address: endpoint.authority_address,
        dnskey_request_bytes: dnskeyRequest,
        dnskey_response_bytes: dnskeyResponse,
        control_request_bytes: controlRequest,
        control_response_bytes: controlResponse,
        validation_database_time: validationTime,
        signal: AbortSignal.timeout(config.timeout_ms),
      });
      if (
        validated.dnssec_validation !== "secure" ||
        !challengePresent(controlRequest, controlResponse, input.challenge_txt_value)
      ) {
        throw new Error("HNS authority readiness validation failed");
      }
      const axfr = await exchangeDirectHnsDnsTsigAxfrV1({
        connector,
        host: endpoint.authority_address,
        family,
        zone_name: input.root_label,
        credential: config.axfr_credential,
        fudge_seconds: 300,
        response_message_max_bytes: 65_535,
        response_total_max_bytes: 1_048_576,
        response_max_messages: 1_024,
        timeout_ms: config.timeout_ms,
        signal: AbortSignal.timeout(config.timeout_ms),
      });
      const zoneBytes = deriveCanonicalHnsAuthorityZoneBytesV1({
        zone_name: input.root_label,
        response_sequence_bytes: axfr.response_sequence_bytes,
      });
      views.push({
        ...endpoint,
        dnssec_validation: "secure",
        challenge_present: true,
        validated_dnskey_response_sha256: validated.validated_dnskey_response_sha256,
        validated_control_response_sha256: validated.validated_control_response_sha256,
        validated_chain_authority_digest: validated.validated_chain_authority_digest,
        observed_zone_bytes: zoneBytes,
        observed_zone_sha256: await sha256(zoneBytes),
      });
    }
    const primary = views[0];
    const secondary = views[1];
    if (
      primary === undefined ||
      secondary === undefined ||
      primary.observed_zone_sha256 !== secondary.observed_zone_sha256
    ) {
      throw new Error("HNS authorities do not serve the same retained zone");
    }
    const gateway = await probeGateway({
      root_label: input.root_label,
      gateway_address: config.gateway_address,
      gateway_local_address: config.gateway_local_address,
      timeout_ms: config.timeout_ms,
    });
    if (gateway.certificate_spki_sha256 !== config.expected_gateway_certificate_spki_sha256) {
      throw new Error("HNS gateway certificate does not match the retained TLSA association");
    }
    return { authority_views: [primary, secondary], gateway };
  };
}
