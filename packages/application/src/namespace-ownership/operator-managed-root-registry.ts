import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Schema } from "effect";
import { decodeStrictHnsJsonBytes, HnsOwnerResponseDecodeError } from "./hns-evidence.ts";

export const OPERATOR_MANAGED_ROOT_REGISTRY_VERSION =
  "pirate-operator-managed-root-registry-v1" as const;
export const OPERATOR_MANAGED_ROOT_REGISTRY_MAX_BYTES = 65_536 as const;
export const OPERATOR_MANAGED_ROOT_REGISTRY_MAX_ENTRIES = 256 as const;

const encoder = new TextEncoder();

export type OperatorManagedRootRegistryEntryV1 = readonly [
  family: "hns",
  canonical_root: string,
  status: "active",
];

export type OperatorManagedRootRegistryV1 = Readonly<{
  readonly version: typeof OPERATOR_MANAGED_ROOT_REGISTRY_VERSION;
  readonly registry_reference: string;
  readonly registry_version: number;
  readonly entries: readonly OperatorManagedRootRegistryEntryV1[];
}>;

export type OperatorManagedRootRegistryDecodedV1 = Readonly<{
  readonly registry: OperatorManagedRootRegistryV1;
  readonly registry_bytes: Uint8Array;
  readonly registry_digest: Sha256HexValue;
}>;

export class OperatorManagedRootRegistryError extends Error {
  readonly name = "OperatorManagedRootRegistryError";

  constructor(
    readonly reason: "invalid_document" | "digest_mismatch" | "identity_mismatch",
    message: string,
  ) {
    super(message);
  }
}

function validIdentity(value: unknown, maximumBytes = 256): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    encoder.encode(value).byteLength > maximumBytes
  ) {
    return false;
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0xfffd) return false;
  }
  return true;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

async function sha256Hex(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Schema.decodeUnknownSync(Sha256Hex)(
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function decodeRegistry(value: unknown): OperatorManagedRootRegistryV1 {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new OperatorManagedRootRegistryError(
      "invalid_document",
      "Operator-managed root registry must be the exact four-member array",
    );
  }
  const [version, registryReference, registryVersion, rawEntries] = value;
  if (version !== OPERATOR_MANAGED_ROOT_REGISTRY_VERSION) {
    throw new OperatorManagedRootRegistryError(
      "invalid_document",
      "Operator-managed root registry version is not supported",
    );
  }
  if (!validIdentity(registryReference)) {
    throw new OperatorManagedRootRegistryError(
      "invalid_document",
      "Operator-managed root registry reference is not canonical",
    );
  }
  if (!Number.isSafeInteger(registryVersion) || registryVersion <= 0) {
    throw new OperatorManagedRootRegistryError(
      "invalid_document",
      "Operator-managed root registry version must be a positive JSON integer",
    );
  }
  if (
    !Array.isArray(rawEntries) ||
    rawEntries.length > OPERATOR_MANAGED_ROOT_REGISTRY_MAX_ENTRIES
  ) {
    throw new OperatorManagedRootRegistryError(
      "invalid_document",
      "Operator-managed root registry entries exceed their closed bound",
    );
  }

  const entries: OperatorManagedRootRegistryEntryV1[] = [];
  for (const rawEntry of rawEntries) {
    if (
      !Array.isArray(rawEntry) ||
      rawEntry.length !== 3 ||
      rawEntry[0] !== "hns" ||
      typeof rawEntry[1] !== "string" ||
      !validCommunityRouteRoot("hns", rawEntry[1]) ||
      rawEntry[2] !== "active"
    ) {
      throw new OperatorManagedRootRegistryError(
        "invalid_document",
        "Operator-managed root registry entry is not canonical",
      );
    }
    const entry = ["hns", rawEntry[1], "active"] as const;
    const previous = entries.at(-1);
    if (previous !== undefined && compareUtf8(previous[1], entry[1]) >= 0) {
      throw new OperatorManagedRootRegistryError(
        "invalid_document",
        "Operator-managed root registry entries are duplicated or reordered",
      );
    }
    entries.push(entry);
  }

  return {
    version,
    registry_reference: registryReference,
    registry_version: registryVersion,
    entries,
  };
}

export async function decodeOperatorManagedRootRegistryV1(
  value: unknown,
): Promise<OperatorManagedRootRegistryDecodedV1> {
  if (!(value instanceof Uint8Array)) {
    throw new OperatorManagedRootRegistryError(
      "invalid_document",
      "Operator-managed root registry must be exact bytes",
    );
  }
  const registryBytes = new Uint8Array(value);
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(registryBytes, OPERATOR_MANAGED_ROOT_REGISTRY_MAX_BYTES);
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new OperatorManagedRootRegistryError("invalid_document", error.message);
    }
    throw error;
  }
  const registry = decodeRegistry(json);
  if (
    JSON.stringify([
      registry.version,
      registry.registry_reference,
      registry.registry_version,
      registry.entries,
    ]) !== new TextDecoder("utf-8", { fatal: true }).decode(registryBytes)
  ) {
    throw new OperatorManagedRootRegistryError(
      "invalid_document",
      "Operator-managed root registry bytes are not canonical JSON.stringify output",
    );
  }
  return {
    registry,
    registry_bytes: registryBytes,
    registry_digest: await sha256Hex(registryBytes),
  };
}

export function encodeOperatorManagedRootRegistryV1(
  input: Readonly<{
    readonly registry_reference: string;
    readonly registry_version: number;
    readonly entries: readonly OperatorManagedRootRegistryEntryV1[];
  }>,
): Promise<OperatorManagedRootRegistryDecodedV1> {
  return decodeOperatorManagedRootRegistryV1(
    encoder.encode(
      JSON.stringify([
        OPERATOR_MANAGED_ROOT_REGISTRY_VERSION,
        input.registry_reference,
        input.registry_version,
        input.entries,
      ]),
    ),
  );
}

export function validateOperatorManagedRootRegistryIdentity(
  input: Readonly<{
    readonly decoded: OperatorManagedRootRegistryDecodedV1;
    readonly expected_reference: string;
    readonly expected_version: number;
    readonly expected_digest: Sha256HexValue;
  }>,
): OperatorManagedRootRegistryV1 {
  if (
    input.decoded.registry.registry_reference !== input.expected_reference ||
    input.decoded.registry.registry_version !== input.expected_version
  ) {
    throw new OperatorManagedRootRegistryError(
      "identity_mismatch",
      "Operator-managed root registry identity does not match retained authority",
    );
  }
  if (input.decoded.registry_digest !== input.expected_digest) {
    throw new OperatorManagedRootRegistryError(
      "digest_mismatch",
      "Operator-managed root registry digest does not match exact bytes",
    );
  }
  return input.decoded.registry;
}

export function operatorManagedRootRegistryContains(
  registry: OperatorManagedRootRegistryV1,
  canonicalRoot: string,
): boolean {
  return registry.entries.some(
    ([family, root, status]) => family === "hns" && root === canonicalRoot && status === "active",
  );
}
