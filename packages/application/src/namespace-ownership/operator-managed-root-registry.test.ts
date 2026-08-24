import { expect, test } from "bun:test";
import type { Sha256Hex } from "@pirate/domain/verification";
import {
  decodeOperatorManagedRootRegistryV1,
  encodeOperatorManagedRootRegistryV1,
  OperatorManagedRootRegistryError,
  operatorManagedRootRegistryContains,
  validateOperatorManagedRootRegistryIdentity,
} from "./operator-managed-root-registry.ts";

const vector =
  '["pirate-operator-managed-root-registry-v1","operator-managed-roots-2026-08",1,[["hns","pirate","active"]]]';
const digest = "f60b4c58bdf17672aae9014e6fed2f522fc77ef0190ed80b822249b8826b1292" as Sha256Hex;

test("reproduces the immutable operator-managed root registry vector", async () => {
  const decoded = await decodeOperatorManagedRootRegistryV1(new TextEncoder().encode(vector));
  expect(decoded.registry_bytes.byteLength).toBe(107);
  expect(decoded.registry_digest).toBe(digest);
  expect(decoded.registry).toEqual({
    version: "pirate-operator-managed-root-registry-v1",
    registry_reference: "operator-managed-roots-2026-08",
    registry_version: 1,
    entries: [["hns", "pirate", "active"]],
  });
  expect(operatorManagedRootRegistryContains(decoded.registry, "pirate")).toBe(true);
  expect(operatorManagedRootRegistryContains(decoded.registry, "other")).toBe(false);
});

test("encodes only sorted unique canonical HNS roots", async () => {
  await expect(
    encodeOperatorManagedRootRegistryV1({
      registry_reference: "operator-managed-roots-2026-08",
      registry_version: 1,
      entries: [
        ["hns", "alpha", "active"],
        ["hns", "pirate", "active"],
      ],
    }),
  ).resolves.toMatchObject({ registry_digest: expect.any(String) });
  await expect(
    encodeOperatorManagedRootRegistryV1({
      registry_reference: "operator-managed-roots-2026-08",
      registry_version: 1,
      entries: [
        ["hns", "pirate", "active"],
        ["hns", "alpha", "active"],
      ],
    }),
  ).rejects.toThrow("duplicated or reordered");
});

test("rejects noncanonical JSON and identity or digest substitution", async () => {
  await expect(
    decodeOperatorManagedRootRegistryV1(new TextEncoder().encode(`${vector}\n`)),
  ).rejects.toBeInstanceOf(OperatorManagedRootRegistryError);
  const decoded = await decodeOperatorManagedRootRegistryV1(new TextEncoder().encode(vector));
  expect(() =>
    validateOperatorManagedRootRegistryIdentity({
      decoded,
      expected_reference: decoded.registry.registry_reference,
      expected_version: decoded.registry.registry_version,
      expected_digest: digest,
    }),
  ).not.toThrow();
  expect(() =>
    validateOperatorManagedRootRegistryIdentity({
      decoded,
      expected_reference: "other-registry",
      expected_version: decoded.registry.registry_version,
      expected_digest: digest,
    }),
  ).toThrow("identity does not match");
  expect(() =>
    validateOperatorManagedRootRegistryIdentity({
      decoded,
      expected_reference: decoded.registry.registry_reference,
      expected_version: decoded.registry.registry_version,
      expected_digest: "0".repeat(64) as Sha256Hex,
    }),
  ).toThrow("digest does not match");
});
