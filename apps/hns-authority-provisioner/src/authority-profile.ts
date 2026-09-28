import { isIP } from "node:net";
import {
  type HnsRootImportGlueRecordV1,
  type HnsRootImportNameserversV1,
  validHnsRootImportNameserversV1,
} from "@pirate/application/namespace-ownership";
import type { HnsRootReadinessAuthorityEndpointV1 } from "./live-readiness.ts";
import { HNS_AUTHORITY_NAMESERVERS } from "./provision-root.ts";

// Read back from the two production authority hosts on 2026-09-27. Staging
// mainnet cannot delegate to either host's production DNS listener.
const productionAuthorityAddresses = new Set(["94.103.168.161", "81.15.150.159"]);

export type HnsAuthorityRuntimeProfileV1 = Readonly<{
  nameservers: HnsRootImportNameserversV1;
  glue_records: readonly [HnsRootImportGlueRecordV1, HnsRootImportGlueRecordV1];
  endpoints: readonly [HnsRootReadinessAuthorityEndpointV1, HnsRootReadinessAuthorityEndpointV1];
}>;

export function parseHnsAuthorityRuntimeProfileV1(
  input: Readonly<{
    environment: string;
    chain_network: string;
    required: (name: string) => string;
  }>,
): HnsAuthorityRuntimeProfileV1 {
  const endpoint = (ordinal: 1 | 2): HnsRootReadinessAuthorityEndpointV1 => {
    const authorityNameserver = input.required(`HNS_AUTHORITY_NS${ordinal}_NAME`);
    const authorityAddress = input.required(`HNS_AUTHORITY_NS${ordinal}_ADDRESS`);
    const family = isIP(authorityAddress);
    if (family !== 4 && family !== 6) {
      throw new Error("HNS authority delegation profile is invalid");
    }
    const localAddress = input.required(
      family === 4 ? "HNS_AUTHORITY_DNS_LOCAL_IPV4" : "HNS_AUTHORITY_DNS_LOCAL_IPV6",
    );
    if (isIP(localAddress) !== family) {
      throw new Error("HNS authority delegation profile is invalid");
    }
    return {
      authority_nameserver: authorityNameserver,
      authority_address_family: family === 4 ? "GLUE4" : "GLUE6",
      authority_address: authorityAddress,
      local_address: localAddress,
    };
  };
  const endpoints = [endpoint(1), endpoint(2)] as const;
  const nameservers: HnsRootImportNameserversV1 = [
    `${endpoints[0].authority_nameserver}.`,
    `${endpoints[1].authority_nameserver}.`,
  ];
  if (
    !["production", "staging", "regtest", "test"].includes(input.environment) ||
    !["main", "regtest"].includes(input.chain_network) ||
    !validHnsRootImportNameserversV1(nameservers) ||
    nameservers[0] >= nameservers[1] ||
    (input.environment === "production" &&
      JSON.stringify(nameservers) !== JSON.stringify(HNS_AUTHORITY_NAMESERVERS)) ||
    (input.environment === "staging" &&
      input.chain_network === "main" &&
      (JSON.stringify(nameservers) === JSON.stringify(HNS_AUTHORITY_NAMESERVERS) ||
        endpoints[0].authority_address === endpoints[1].authority_address ||
        endpoints.some((entry) => productionAuthorityAddresses.has(entry.authority_address))))
  ) {
    throw new Error("HNS authority delegation profile is invalid");
  }
  const glue_records = endpoints.map((entry, index) => ({
    type: entry.authority_address_family,
    ns: nameservers[index as 0 | 1],
    address: entry.authority_address,
  })) as [HnsRootImportGlueRecordV1, HnsRootImportGlueRecordV1];
  return { nameservers, glue_records, endpoints };
}
