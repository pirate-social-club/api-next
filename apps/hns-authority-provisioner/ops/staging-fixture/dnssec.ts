import {
  buildHnsAuthoritativeDnsQueryV1,
  type HnsChainAuthorityRecord,
  type HnsRootDelegationDsV1,
  hnsChainAuthorityDigest,
  makeHnsAuthoritativeDnsValidatorV1,
} from "@pirate/application/namespace-ownership";
import type { Sha256Hex } from "@pirate/domain/verification";
import {
  exchangeDirectHnsDnsTcp,
  makeNodeHnsDnsTcpConnector,
} from "@pirate/hns-dns-runtime/dns-tcp";

/** The DS trust anchor is fixture-provisioned here, not yet observed on a chain. */
export async function validateFixtureDnssec(
  root: string,
  ds: readonly HnsRootDelegationDsV1[],
): Promise<void> {
  const addresses = ["127.0.0.21", "127.0.0.22"] as const;
  const records: HnsChainAuthorityRecord[] = [
    ["GLUE4", "ns1.pirate", addresses[0]],
    ["GLUE4", "ns2.pirate", addresses[1]],
    ...ds.map(
      (record): HnsChainAuthorityRecord => [
        "DS",
        record.key_tag,
        record.algorithm,
        record.digest_type,
        record.digest,
      ],
    ),
  ];
  const digest = await hnsChainAuthorityDigest({
    chain_network: "regtest",
    chain_genesis_block_hash:
      "ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5" as Sha256Hex,
    root_label: root,
    ownership_source: "owner_authoritative_dns_txt",
    authority_records: records,
  });
  const validator = await makeHnsAuthoritativeDnsValidatorV1();
  for (const [index, address] of addresses.entries()) {
    const dnskey = buildHnsAuthoritativeDnsQueryV1({
      message_id: 100 + index,
      query_kind: "dnskey",
      root_label: root,
    });
    const control = buildHnsAuthoritativeDnsQueryV1({
      message_id: 200 + index,
      query_kind: "control_txt",
      root_label: root,
    });
    const exchange = (bytes: Uint8Array) =>
      exchangeDirectHnsDnsTcp({
        connector: makeNodeHnsDnsTcpConnector({ local_address: "127.0.0.1" }),
        host: address,
        family: 4,
        request_bytes: bytes,
        response_max_bytes: 65_535,
        timeout_ms: 3000,
        signal: AbortSignal.timeout(3000),
      });
    const input = {
      driver_reference: "isolated-staging-fixture",
      view_id: `fixture-${index}`,
      root_label: root,
      authority_records: records,
      chain_authority_digest: digest,
      authority_nameserver: `ns${index + 1}.pirate`,
      authority_address_family: "GLUE4" as const,
      authority_address: address,
      dnskey_request_bytes: dnskey,
      dnskey_response_bytes: await exchange(dnskey),
      control_request_bytes: control,
      control_response_bytes: await exchange(control),
      validation_database_time: new Date().toISOString(),
      signal: AbortSignal.timeout(3000),
    };
    const valid = await validator.validate(input);
    if (valid.dnssec_validation !== "secure") throw new Error("Fixture DNSSEC validation failed");
    const tampered = input.control_response_bytes.slice();
    const position = Buffer.from(tampered).indexOf("pirate-verification=");
    if (position < 0) throw new Error("Fixture control TXT missing");
    tampered[position] = (tampered[position] ?? 0) ^ 1;
    const invalid = await validator.validate({ ...input, control_response_bytes: tampered });
    if (invalid.dnssec_validation === "secure") throw new Error("Tampered fixture DNS accepted");
  }
}
