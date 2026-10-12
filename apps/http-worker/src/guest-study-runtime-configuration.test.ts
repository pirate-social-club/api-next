import { expect, test } from "bun:test";
import {
  makeGuestStudyTrustedEdge,
  readGuestStudyRuntimeConfiguration,
} from "./guest-study-runtime-configuration.ts";

const configuration = {
  policy: {
    version: "fixture-resource-v1",
    costPolicyVersion: "fixture-cost-v1",
    maximumOwnerActiveSessions: 2,
    maximumOwnerReservedPaidCallsPerRollingDay: 60,
    maximumGlobalActiveSessions: 100,
    maximumGlobalPaidCallsPerRollingDay: 1000,
    maximumGlobalCostMicrosPerRollingDay: "1000000",
    maximumOwnerCostMicrosPerRollingDay: "10000",
    maximumTrustedEdgeSessionsPerWindow: 100,
    trustedEdgeWindowSeconds: 3600,
    maximumProviderCallCostMicros: "1000",
  },
  disclosure: {
    version: "fixture-disclosure-v1",
    text: "Explicit fixture disclosure, not production policy.",
  },
};
test("incomplete or malformed release configuration supplies no paid capability", () => {
  for (const binding of [
    undefined,
    "",
    "null",
    "{}",
    "{",
    " ".repeat(16385),
    JSON.stringify({ ...configuration, policy: null }),
    JSON.stringify({
      ...configuration,
      policy: { ...configuration.policy, maximumOwnerActiveSessions: 3 },
    }),
    JSON.stringify({
      ...configuration,
      policy: { ...configuration.policy, maximumProviderCallCostMicros: 0.1 },
    }),
    JSON.stringify({
      ...configuration,
      policy: { ...configuration.policy, maximumGlobalCostMicrosPerRollingDay: "01" },
    }),
    JSON.stringify({
      ...configuration,
      policy: { ...configuration.policy, unreviewedDefault: true },
    }),
    JSON.stringify({ ...configuration, disclosure: { version: "fixture-disclosure-v1" } }),
    JSON.stringify({ ...configuration, unrelated: true }),
  ])
    expect(readGuestStudyRuntimeConfiguration(binding)).toBeNull();
  const { maximumGlobalPaidCallsPerRollingDay: _, ...missing } = configuration.policy;
  expect(
    readGuestStudyRuntimeConfiguration(JSON.stringify({ ...configuration, policy: missing })),
  ).toBeNull();
});
test("complete explicit configuration retains exact atomic-unit strings and disclosure", () => {
  const result = readGuestStudyRuntimeConfiguration(JSON.stringify(configuration));
  expect(result).toEqual(configuration);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result?.policy)).toBe(true);
});
test("edge metadata is required, origin scoped and hashed without supplying ownership proof", async () => {
  for (const ip of [undefined, "", "127.0.0.1, 127.0.0.2", " 127.0.0.1", "x".repeat(129)])
    expect(await makeGuestStudyTrustedEdge("https://community.example", ip)).toBeNull();
  for (const origin of [
    "http://community.example",
    "https://community.example/path",
    "https://*.example",
  ])
    expect(await makeGuestStudyTrustedEdge(origin, "198.51.100.1")).toBeNull();
  const first = await makeGuestStudyTrustedEdge("https://community.example", "198.51.100.1");
  expect(first?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  expect(JSON.stringify(first)).not.toContain("198.51.100.1");
  expect(await makeGuestStudyTrustedEdge("https://community.example", "198.51.100.1")).toEqual(
    first,
  );
  expect(await makeGuestStudyTrustedEdge("https://another.example", "198.51.100.1")).not.toEqual(
    first,
  );
});
