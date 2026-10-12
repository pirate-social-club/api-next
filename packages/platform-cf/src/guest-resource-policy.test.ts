import { expect, test } from "bun:test";
import {
  GuestParticipationStoreRejected,
  type GuestResourceAdmissionPolicy,
} from "@pirate/application";
import { readGuestResourceAdmissionPolicy } from "./guest-resource-policy.ts";

const fixture = {
  version: "test-policy-v1",
  costPolicyVersion: "test-cost-v1",
  maximumOwnerActiveSessions: 2,
  maximumOwnerReservedPaidCallsPerRollingDay: 60,
  maximumGlobalActiveSessions: 10,
  maximumGlobalPaidCallsPerRollingDay: 120,
  maximumGlobalCostMicrosPerRollingDay: "9007199254740993",
  maximumOwnerCostMicrosPerRollingDay: "123456789012345678",
  maximumTrustedEdgeSessionsPerWindow: 3,
  trustedEdgeWindowSeconds: 3600,
  maximumProviderCallCostMicros: "100000",
} satisfies GuestResourceAdmissionPolicy;

test("missing policy returns no paid composition, while explicit cost strings retain full precision", () => {
  expect(readGuestResourceAdmissionPolicy(undefined)).toBeNull();
  expect(readGuestResourceAdmissionPolicy(null)).toBeNull();
  expect(readGuestResourceAdmissionPolicy(fixture)).toEqual(fixture);
  expect(readGuestResourceAdmissionPolicy(fixture)?.maximumGlobalCostMicrosPerRollingDay).toBe(
    "9007199254740993",
  );
});

test("partial global, edge and cost inventories cannot silently acquire defaults", () => {
  for (const key of Object.keys(fixture)) {
    const incomplete: Record<string, unknown> = { ...fixture };
    delete incomplete[key];
    expect(() => readGuestResourceAdmissionPolicy(incomplete)).toThrow(
      GuestParticipationStoreRejected,
    );
  }
  expect(() =>
    readGuestResourceAdmissionPolicy({ ...fixture, providerToken: "private-config-value" }),
  ).toThrow(GuestParticipationStoreRejected);
  try {
    readGuestResourceAdmissionPolicy({ ...fixture, providerToken: "private-config-value" });
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain("private-config-value");
  }
});

test("fixed owner ceilings and integer cash semantics refuse widened or noncanonical values", () => {
  const invalid = [
    { maximumOwnerActiveSessions: 3 },
    { maximumOwnerReservedPaidCallsPerRollingDay: 61 },
    { maximumGlobalActiveSessions: 0 },
    { maximumGlobalPaidCallsPerRollingDay: 1.5 },
    { maximumTrustedEdgeSessionsPerWindow: Number.POSITIVE_INFINITY },
    { trustedEdgeWindowSeconds: -1 },
    ...["0", "01", "-1", "1.1", "1e9", "9".repeat(79), 100].map((value) => ({
      maximumProviderCallCostMicros: value,
    })),
  ];
  for (const patch of invalid)
    expect(() => readGuestResourceAdmissionPolicy({ ...fixture, ...patch })).toThrow(
      GuestParticipationStoreRejected,
    );
});
