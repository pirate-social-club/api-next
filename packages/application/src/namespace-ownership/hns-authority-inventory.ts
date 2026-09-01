import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Schema } from "effect";
import type { HnsChainAuthorityRecord } from "./hns-control-observer.ts";
import { decodeStrictHnsJsonBytes, HnsOwnerResponseDecodeError } from "./hns-evidence.ts";

export const HNS_AUTHORITY_INVENTORY_VERSION = "pirate-hns-authority-inventory-v1" as const;
export const HNS_AUTHORITY_CAPABILITY_SET_VERSION =
  "pirate-hns-authority-capability-set-v1" as const;
export const HNS_AUTHORITY_INVENTORY_MAX_BYTES = 65_536 as const;
export const HNS_AUTHORITY_INVENTORY_MAX_ENTRIES = 256 as const;
export const HNS_AUTHORITY_EVIDENCE_MAX_LIFETIME_SECONDS = 7 * 86_400;

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();
const registryReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function isSafeText(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) return false;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) return false;
  }
  return true;
}

function boundedString(maxBytes: number, label: string) {
  return Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value && isSafeText(value) && utf8Length(value) <= maxBytes
        ? undefined
        : `Expected ${label} to be bounded canonical UTF-8`,
    ),
  );
}

const Identity = boundedString(256, "inventory identity");
const RegistryReference = boundedString(256, "inventory registry reference").check(
  Schema.makeFilter((value) =>
    registryReferencePattern.test(value)
      ? undefined
      : "Expected inventory registry reference to match its canonical grammar",
  ),
);
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical UTC instant";
  }),
);
const CanonicalDnsName = boundedString(253, "authority nameserver").check(
  Schema.makeFilter((value) =>
    !value.endsWith(".") &&
    value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
      ? undefined
      : "Expected a lowercase canonical DNS name",
  ),
);
const RootLabel = boundedString(63, "root label").check(
  Schema.makeFilter((value) =>
    validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root label",
  ),
);

function canonicalIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255)
  );
}

function canonicalizeIpv6(value: string): string | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = (halves[0] ?? "") === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 2 && (halves[1] ?? "") !== "" ? (halves[1] ?? "").split(":") : [];
  if (
    left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) ||
    right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))
  ) {
    return null;
  }
  const words =
    halves.length === 2
      ? [
          ...left.map((part) => Number.parseInt(part, 16)),
          ...new Array(8 - left.length - right.length).fill(0),
          ...right.map((part) => Number.parseInt(part, 16)),
        ]
      : left.map((part) => Number.parseInt(part, 16));
  if (words.length !== 8) return null;
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < words.length; ) {
    if (words[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const encoded: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (index === bestStart) {
      encoded.push("");
      index += bestLength - 1;
    } else {
      encoded.push((words[index] ?? 0).toString(16));
    }
  }
  let result = encoded.join(":");
  if (bestStart === 0) result = `:${result}`;
  if (bestStart + bestLength === words.length) result = `${result}:`;
  return result;
}

function canonicalIpv6(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.toLowerCase() &&
    !value.includes(".") &&
    /^[0-9a-f:]+$/u.test(value) &&
    canonicalizeIpv6(value) === value
  );
}

const NameserverGlueSchema = Schema.Struct({
  authority_nameserver: CanonicalDnsName,
  authority_address_family: Schema.Literals(["GLUE4", "GLUE6"]),
  authority_address: boundedString(45, "authority address"),
  active: Schema.Boolean,
});

const DnsWriteCapabilitySchema = Schema.Struct({
  capability_reference: RegistryReference,
  scope_kind: Schema.Literal("exact_root"),
  root_label: RootLabel,
  active: Schema.Boolean,
});

const InventorySchema = Schema.Struct({
  version: Schema.Literal(HNS_AUTHORITY_INVENTORY_VERSION),
  authority_inventory_reference: RegistryReference,
  authority_inventory_version: Identity,
  environment: Identity,
  completeness: Schema.Literal("complete"),
  runtime_capability_set_digest: Sha256Hex,
  published_at: CanonicalInstant,
  expires_at: CanonicalInstant,
  authoritative_nameserver_glue: Schema.Array(NameserverGlueSchema),
  dns_write_capabilities: Schema.Array(DnsWriteCapabilitySchema),
});

const inventoryKeys = [
  "version",
  "authority_inventory_reference",
  "authority_inventory_version",
  "environment",
  "completeness",
  "runtime_capability_set_digest",
  "published_at",
  "expires_at",
  "authoritative_nameserver_glue",
  "dns_write_capabilities",
] as const;
const nameserverGlueKeys = [
  "authority_nameserver",
  "authority_address_family",
  "authority_address",
  "active",
] as const;
const dnsWriteCapabilityKeys = [
  "capability_reference",
  "scope_kind",
  "root_label",
  "active",
] as const;

export type HnsAuthorityInventoryV1 = Schema.Schema.Type<typeof InventorySchema>;
export type HnsAuthorityInventoryNameserverGlueV1 = Schema.Schema.Type<typeof NameserverGlueSchema>;
export type HnsAuthorityInventoryDnsWriteCapabilityV1 = Schema.Schema.Type<
  typeof DnsWriteCapabilitySchema
>;
export type HnsAuthorityInventoryDecodedV1 = Readonly<{
  readonly inventory_bytes: Uint8Array;
  readonly inventory: HnsAuthorityInventoryV1;
  readonly inventory_digest: Sha256HexValue;
}>;

export type HnsAuthorityInventoryResolvedV1 = Readonly<{
  readonly authority_inventory_reference: string;
  readonly authority_inventory_version: string;
  readonly authority_inventory_digest: Sha256HexValue;
  readonly inventory_bytes: Uint8Array;
}>;

export type HnsAuthorityInventoryResolverPortV1 = Readonly<{
  /**
   * The capability closes over registry identity, current-version selection,
   * endpoint, authentication, environment, and response byte bound.
   */
  readonly resolve: (
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<HnsAuthorityInventoryResolvedV1 | null>;
}>;

export class HnsAuthorityInventoryError extends Error {
  readonly name = "HnsAuthorityInventoryError";

  constructor(
    readonly reason:
      | "invalid_document"
      | "identity_mismatch"
      | "digest_mismatch"
      | "capability_mismatch"
      | "stale",
    message: string,
  ) {
    super(message);
  }
}

function decodeSchema<T>(schema: Schema.ConstraintDecoder<T>, value: unknown, message: string): T {
  const decoded = Schema.decodeUnknownOption(schema, exactParseOptions)(value);
  if (Option.isNone(decoded)) throw new HnsAuthorityInventoryError("invalid_document", message);
  return decoded.value;
}

function assertObjectOrder(value: unknown, keys: ReadonlyArray<string>, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HnsAuthorityInventoryError("invalid_document", `${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new HnsAuthorityInventoryError("invalid_document", `${label} members are reordered`);
  }
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

function compareNameserverGlue(
  left: HnsAuthorityInventoryNameserverGlueV1,
  right: HnsAuthorityInventoryNameserverGlueV1,
): number {
  const nameserver = compareUtf8(left.authority_nameserver, right.authority_nameserver);
  if (nameserver !== 0) return nameserver;
  if (left.authority_address_family !== right.authority_address_family) {
    return left.authority_address_family === "GLUE4" ? -1 : 1;
  }
  return compareUtf8(left.authority_address, right.authority_address);
}

function compareDnsWriteCapability(
  left: HnsAuthorityInventoryDnsWriteCapabilityV1,
  right: HnsAuthorityInventoryDnsWriteCapabilityV1,
): number {
  const root = compareUtf8(left.root_label, right.root_label);
  return root === 0 ? compareUtf8(left.capability_reference, right.capability_reference) : root;
}

function assertOrderedUnique<T>(
  values: ReadonlyArray<T>,
  compare: (left: T, right: T) => number,
  label: string,
): void {
  if (values.length > HNS_AUTHORITY_INVENTORY_MAX_ENTRIES) {
    throw new HnsAuthorityInventoryError("invalid_document", `${label} exceeds its entry bound`);
  }
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1] as T, values[index] as T) >= 0) {
      throw new HnsAuthorityInventoryError(
        "invalid_document",
        `${label} entries are duplicated or reordered`,
      );
    }
  }
}

async function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Schema.decodeUnknownSync(Sha256Hex)(
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

export function hnsAuthorityCapabilitySetPreimage(
  input: Readonly<{
    readonly environment: string;
    readonly authoritative_nameserver_glue: ReadonlyArray<HnsAuthorityInventoryNameserverGlueV1>;
    readonly dns_write_capabilities: ReadonlyArray<HnsAuthorityInventoryDnsWriteCapabilityV1>;
  }>,
): string {
  const environment = Schema.decodeUnknownSync(Identity)(input.environment);
  const nameserverGlue = input.authoritative_nameserver_glue.map((entry) =>
    Schema.decodeUnknownSync(NameserverGlueSchema)(entry),
  );
  const dnsWriteCapabilities = input.dns_write_capabilities.map((entry) =>
    Schema.decodeUnknownSync(DnsWriteCapabilitySchema)(entry),
  );
  assertOrderedUnique(nameserverGlue, compareNameserverGlue, "Authority nameserver/glue");
  assertOrderedUnique(
    dnsWriteCapabilities,
    compareDnsWriteCapability,
    "Authority DNS-write capability",
  );
  return JSON.stringify([
    HNS_AUTHORITY_CAPABILITY_SET_VERSION,
    environment,
    nameserverGlue,
    dnsWriteCapabilities,
  ]);
}

export function hnsAuthorityCapabilitySetDigest(
  input: Parameters<typeof hnsAuthorityCapabilitySetPreimage>[0],
): Promise<Sha256HexValue> {
  return sha256Bytes(encoder.encode(hnsAuthorityCapabilitySetPreimage(input)));
}

function assertInventoryInvariants(inventory: HnsAuthorityInventoryV1): void {
  if (Date.parse(inventory.expires_at) <= Date.parse(inventory.published_at)) {
    throw new HnsAuthorityInventoryError(
      "invalid_document",
      "Authority inventory expiry must follow publication",
    );
  }
  for (const entry of inventory.authoritative_nameserver_glue) {
    const validAddress =
      entry.authority_address_family === "GLUE4"
        ? canonicalIpv4(entry.authority_address)
        : canonicalIpv6(entry.authority_address);
    if (!validAddress) {
      throw new HnsAuthorityInventoryError(
        "invalid_document",
        "Authority inventory address is not canonical for its family",
      );
    }
  }
  assertOrderedUnique(
    inventory.authoritative_nameserver_glue,
    compareNameserverGlue,
    "Authority nameserver/glue",
  );
  assertOrderedUnique(
    inventory.dns_write_capabilities,
    compareDnsWriteCapability,
    "Authority DNS-write capability",
  );
}

export async function decodeHnsAuthorityInventoryBytes(
  value: unknown,
): Promise<HnsAuthorityInventoryDecodedV1> {
  if (!(value instanceof Uint8Array)) {
    throw new HnsAuthorityInventoryError(
      "invalid_document",
      "Authority inventory must be exact bytes",
    );
  }
  const inventoryBytes = new Uint8Array(value);
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(inventoryBytes, HNS_AUTHORITY_INVENTORY_MAX_BYTES);
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsAuthorityInventoryError("invalid_document", error.message);
    }
    throw error;
  }
  assertObjectOrder(json, inventoryKeys, "Authority inventory");
  const raw = json as Record<string, unknown>;
  if (!Array.isArray(raw.authoritative_nameserver_glue)) {
    throw new HnsAuthorityInventoryError(
      "invalid_document",
      "Authority inventory nameserver/glue must be an array",
    );
  }
  if (!Array.isArray(raw.dns_write_capabilities)) {
    throw new HnsAuthorityInventoryError(
      "invalid_document",
      "Authority inventory DNS-write capabilities must be an array",
    );
  }
  for (const entry of raw.authoritative_nameserver_glue) {
    assertObjectOrder(entry, nameserverGlueKeys, "Authority nameserver/glue entry");
  }
  for (const entry of raw.dns_write_capabilities) {
    assertObjectOrder(entry, dnsWriteCapabilityKeys, "Authority DNS-write capability entry");
  }
  const inventory = decodeSchema(
    InventorySchema,
    json,
    "Authority inventory failed its strict schema",
  );
  assertInventoryInvariants(inventory);
  const capabilitySetDigest = await hnsAuthorityCapabilitySetDigest({
    environment: inventory.environment,
    authoritative_nameserver_glue: inventory.authoritative_nameserver_glue,
    dns_write_capabilities: inventory.dns_write_capabilities,
  });
  if (capabilitySetDigest !== inventory.runtime_capability_set_digest) {
    throw new HnsAuthorityInventoryError(
      "capability_mismatch",
      "Authority inventory capability-set digest is not self-consistent",
    );
  }
  return {
    inventory_bytes: inventoryBytes,
    inventory,
    inventory_digest: await sha256Bytes(inventoryBytes),
  };
}

export async function encodeHnsAuthorityInventory(
  input: HnsAuthorityInventoryV1,
): Promise<Uint8Array> {
  return (await decodeHnsAuthorityInventoryBytes(encoder.encode(JSON.stringify(input))))
    .inventory_bytes;
}

export function validateHnsAuthorityInventoryAtDatabaseTime(
  input: Readonly<{
    readonly decoded: HnsAuthorityInventoryDecodedV1;
    readonly expected_reference: string;
    readonly expected_version: string;
    readonly expected_digest: Sha256HexValue;
    readonly expected_environment: string;
    readonly expected_runtime_capability_set_digest: Sha256HexValue;
    readonly database_now: string;
    readonly maximum_inventory_lifetime_seconds: number;
  }>,
): HnsAuthorityInventoryV1 {
  const inventory = input.decoded.inventory;
  if (
    inventory.authority_inventory_reference !== input.expected_reference ||
    inventory.authority_inventory_version !== input.expected_version ||
    inventory.environment !== input.expected_environment
  ) {
    throw new HnsAuthorityInventoryError(
      "identity_mismatch",
      "Authority inventory identity does not match resolved authority",
    );
  }
  if (input.decoded.inventory_digest !== input.expected_digest) {
    throw new HnsAuthorityInventoryError(
      "digest_mismatch",
      "Authority inventory digest does not match exact bytes",
    );
  }
  if (inventory.runtime_capability_set_digest !== input.expected_runtime_capability_set_digest) {
    throw new HnsAuthorityInventoryError(
      "capability_mismatch",
      "Authority inventory does not match runtime capability authority",
    );
  }
  const now = Date.parse(input.database_now);
  const publishedAt = Date.parse(inventory.published_at);
  const expiresAt = Date.parse(inventory.expires_at);
  if (
    !Number.isSafeInteger(input.maximum_inventory_lifetime_seconds) ||
    input.maximum_inventory_lifetime_seconds <= 0 ||
    input.maximum_inventory_lifetime_seconds > HNS_AUTHORITY_EVIDENCE_MAX_LIFETIME_SECONDS ||
    !Number.isFinite(now) ||
    new Date(now).toISOString() !== input.database_now ||
    publishedAt > now ||
    now >= expiresAt ||
    expiresAt - publishedAt > input.maximum_inventory_lifetime_seconds * 1_000
  ) {
    throw new HnsAuthorityInventoryError(
      "stale",
      "Authority inventory is not fresh at the database clock",
    );
  }
  return inventory;
}

export function hnsRootIsPirateWritable(
  input: Readonly<{
    readonly root_label: string;
    readonly chain_authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
    readonly inventory: HnsAuthorityInventoryV1;
  }>,
): boolean {
  const chainNameservers = new Set<string>();
  const chainGlue = new Set<string>();
  for (const record of input.chain_authority_records) {
    if (record[0] === "NS") {
      chainNameservers.add(record[1]);
      continue;
    }
    if (record[0] === "GLUE4" || record[0] === "GLUE6") {
      chainGlue.add(JSON.stringify([record[1], record[0], record[2]]));
    }
  }
  const authorityIntersection = input.inventory.authoritative_nameserver_glue.some(
    (entry) =>
      entry.active &&
      chainNameservers.has(entry.authority_nameserver) &&
      chainGlue.has(
        JSON.stringify([
          entry.authority_nameserver,
          entry.authority_address_family,
          entry.authority_address,
        ]),
      ),
  );
  if (authorityIntersection) return true;
  return input.inventory.dns_write_capabilities.some(
    (entry) =>
      entry.active && entry.scope_kind === "exact_root" && entry.root_label === input.root_label,
  );
}
