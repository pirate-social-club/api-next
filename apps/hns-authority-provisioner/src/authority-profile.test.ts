import { describe, expect, test } from "bun:test";
import { parseHnsAuthorityRuntimeProfileV1 } from "./authority-profile.ts";

const addresses = {
  HNS_AUTHORITY_NS1_ADDRESS: "192.0.2.53",
  HNS_AUTHORITY_NS2_ADDRESS: "192.0.2.54",
  HNS_AUTHORITY_DNS_LOCAL_IPV4: "127.0.0.21",
};

function profile(
  environment: string,
  chainNetwork: string,
  names: readonly [string, string],
  overrides: Readonly<Record<string, string>> = {},
) {
  const values: Readonly<Record<string, string>> = {
    ...addresses,
    HNS_AUTHORITY_NS1_NAME: names[0],
    HNS_AUTHORITY_NS2_NAME: names[1],
    ...overrides,
  };
  return parseHnsAuthorityRuntimeProfileV1({
    environment,
    chain_network: chainNetwork,
    required: (name) => {
      const value = values[name];
      if (value === undefined) throw new Error("configuration missing");
      return value;
    },
  });
}

describe("HNS authority runtime profile", () => {
  test("keeps the production names and admits isolated staging mainnet names", () => {
    expect(profile("production", "main", ["ns1.pirate", "ns2.pirate"]).nameservers).toEqual([
      "ns1.pirate.",
      "ns2.pirate.",
    ]);
    const staging = profile("staging", "main", ["ns1.staging-hns", "ns2.staging-hns"]);
    expect(staging.nameservers).toEqual(["ns1.staging-hns.", "ns2.staging-hns."]);
    expect(staging.endpoints.map((endpoint) => endpoint.authority_address)).toEqual([
      "192.0.2.53",
      "192.0.2.54",
    ]);
    expect(staging.glue_records).toEqual([
      { type: "GLUE4", ns: "ns1.staging-hns.", address: "192.0.2.53" },
      { type: "GLUE4", ns: "ns2.staging-hns.", address: "192.0.2.54" },
    ]);
  });

  test("refuses a staging mainnet profile that delegates to production", () => {
    expect(() => profile("staging", "main", ["ns1.pirate", "ns2.pirate"])).toThrow(
      "delegation profile is invalid",
    );
    expect(profile("staging", "regtest", ["ns1.pirate", "ns2.pirate"]).nameservers).toEqual([
      "ns1.pirate.",
      "ns2.pirate.",
    ]);
    expect(() =>
      profile("staging", "main", ["ns1.staging-hns", "ns2.staging-hns"], {
        HNS_AUTHORITY_NS1_ADDRESS: "94.103.168.161",
      }),
    ).toThrow("delegation profile is invalid");
    expect(() =>
      profile("staging", "main", ["ns1.staging-hns", "ns2.staging-hns"], {
        HNS_AUTHORITY_NS2_ADDRESS: "192.0.2.53",
      }),
    ).toThrow("delegation profile is invalid");
  });

  test("refuses production drift and malformed or duplicate names", () => {
    expect(() => profile("production", "main", ["ns1.staging-hns", "ns2.staging-hns"])).toThrow();
    expect(() => profile("staging", "main", ["ns1.staging-hns", "ns1.staging-hns"])).toThrow();
    expect(() => profile("staging", "main", ["NS1.staging-hns", "ns2.staging-hns"])).toThrow();
    expect(() =>
      profile("staging", "main", ["ns1.staging-hns", "ns2.staging-hns"], {
        HNS_AUTHORITY_NS2_ADDRESS: "not-an-address",
      }),
    ).toThrow();
  });
});
