/**
 * The only differences an activated root's zone may show when its retained
 * zone is replaced outside an ordinary renewal.
 *
 * A retained zone is the canonical authority zone: every record except the
 * online signatures, as `[owner, type, class, ttl, rdata_hex]`. Renewal
 * requires the served zone to equal it byte for byte. Adoption replaces it,
 * and admits exactly three kinds of difference:
 *
 * - `wildcard_family_added`: the wildcard owner gains one AAAA holding the
 *   IPv4-mapped form of its A record's address and one HTTPS record in
 *   service mode whose target is the owner itself, advertising h2 and
 *   http/1.1. Two records change because of that and no others: the SOA,
 *   in its serial alone, and the wildcard owner's NSEC, whose type bitmap
 *   gains those two types.
 * - `wildcard_family_removed`: the exact reverse, record for record, which
 *   is how an adopted addition is withdrawn.
 * - `serial_only`: nothing but the SOA serial, which is what is left when a
 *   change to the zone has been undone before it was adopted.
 *
 * In all three the serial strictly increases and the rest of the SOA is equal.
 *
 * Anything else is refused, including a zone that uses NSEC3, whose denial
 * records this check does not model.
 */

const CANONICAL_ZONE_VERSION = "pirate-hns-canonical-authority-zone-v1";
const TYPE_A = 1;
const TYPE_SOA = 6;
const TYPE_AAAA = 28;
const TYPE_NSEC = 47;
const TYPE_NSEC3 = 50;
const TYPE_NSEC3PARAM = 51;
const TYPE_HTTPS = 65;
/** `1 . alpn=h2,http/1.1`: priority 1, the root target, one alpn parameter. */
const WILDCARD_HTTPS_RDATA_HEX = "0001000001000c02683208687474702f312e31";
const IPV4_MAPPED_PREFIX_HEX = "00000000000000000000ffff";

export const HNS_ZONE_ADOPTION_DELTA_KINDS = [
  "wildcard_family_added",
  "wildcard_family_removed",
  "serial_only",
] as const;
export type HnsZoneAdoptionDeltaKind = (typeof HNS_ZONE_ADOPTION_DELTA_KINDS)[number];

export class HnsZoneAdoptionDeltaRefusal extends Error {
  override readonly name = "HnsZoneAdoptionDeltaRefusal";
}

type CanonicalRecord = readonly [string, number, number, number, string];

function refuse(reason: string): never {
  throw new HnsZoneAdoptionDeltaRefusal(reason);
}

function decodeZone(
  bytes: Uint8Array,
  rootLabel: string,
  side: string,
): readonly CanonicalRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse(`${side} zone is not a canonical authority zone`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return refuse(`${side} zone is not a canonical authority zone`);
  const zone = value as Record<string, unknown>;
  if (
    zone.version !== CANONICAL_ZONE_VERSION ||
    zone.root_label !== rootLabel ||
    !Array.isArray(zone.records)
  )
    return refuse(`${side} zone is not a canonical authority zone for this root`);
  const records: CanonicalRecord[] = [];
  for (const entry of zone.records) {
    if (!Array.isArray(entry) || entry.length !== 5)
      return refuse(`${side} zone holds a malformed record`);
    const [owner, type, recordClass, ttl, rdata] = entry as readonly unknown[];
    if (
      typeof owner !== "string" ||
      !Number.isSafeInteger(type) ||
      recordClass !== 1 ||
      !Number.isSafeInteger(ttl) ||
      typeof rdata !== "string" ||
      !/^(?:[0-9a-f]{2})*$/u.test(rdata)
    )
      return refuse(`${side} zone holds a malformed record`);
    records.push([owner, type as number, 1, ttl as number, rdata]);
  }
  if (records.some(([, type]) => type === TYPE_NSEC3 || type === TYPE_NSEC3PARAM))
    return refuse(`${side} zone uses NSEC3, which adoption does not model`);
  return records;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Offset just past one uncompressed wire-format name. */
function skipName(bytes: Uint8Array, start: number, what: string): number {
  let offset = start;
  for (;;) {
    const length = bytes[offset];
    if (length === undefined || (length & 0xc0) !== 0)
      return refuse(`${what} holds a malformed name`);
    offset += 1;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.byteLength) return refuse(`${what} holds a malformed name`);
  }
}

/** The SOA's two names and four timers, and its serial apart. */
function splitSoa(rdataHex: string, side: string): Readonly<{ rest: string; serial: number }> {
  const bytes = hexBytes(rdataHex);
  const names = skipName(bytes, skipName(bytes, 0, `${side} SOA`), `${side} SOA`);
  if (bytes.byteLength !== names + 20) return refuse(`${side} SOA is malformed`);
  const serial = new DataView(bytes.buffer, bytes.byteOffset + names, 4).getUint32(0);
  return {
    rest: `${rdataHex.slice(0, names * 2)}|${rdataHex.slice((names + 4) * 2)}`,
    serial,
  };
}

/** The NSEC's next owner name and the set of types its bitmap lists. */
function splitNsec(
  rdataHex: string,
  side: string,
): Readonly<{ next: string; types: ReadonlySet<number> }> {
  const bytes = hexBytes(rdataHex);
  const end = skipName(bytes, 0, `${side} wildcard NSEC`);
  const types = new Set<number>();
  let offset = end;
  let previousWindow = -1;
  while (offset < bytes.byteLength) {
    const window = bytes[offset];
    const length = bytes[offset + 1];
    if (
      window === undefined ||
      length === undefined ||
      length < 1 ||
      length > 32 ||
      window <= previousWindow ||
      offset + 2 + length > bytes.byteLength
    )
      return refuse(`${side} wildcard NSEC is malformed`);
    for (let index = 0; index < length; index += 1) {
      const octet = bytes[offset + 2 + index] ?? 0;
      for (let bit = 0; bit < 8; bit += 1)
        if ((octet & (0x80 >> bit)) !== 0) types.add(window * 256 + index * 8 + bit);
    }
    previousWindow = window;
    offset += 2 + length;
  }
  return { next: rdataHex.slice(0, end * 2), types };
}

function only<A>(items: readonly A[], what: string): A {
  const [first] = items;
  if (items.length !== 1 || first === undefined) return refuse(`expected exactly one ${what}`);
  return first;
}

const key = (record: CanonicalRecord) => JSON.stringify(record);

/** The serial encoded in the canonical zone, never a separate provider field. */
export function hnsZoneAdoptionSerialV1(rootLabel: string, bytes: Uint8Array): number {
  const soa = only(
    decodeZone(bytes, rootLabel, "observed").filter(
      (record) => record[0] === rootLabel && record[1] === TYPE_SOA,
    ),
    "observed SOA",
  );
  return splitSoa(soa[4], "observed").serial;
}

/** Whether a canonical zone holds a wildcard AAAA or HTTPS record for the root. */
export function hnsZoneHoldsWildcardAddressFamilyV1(input: {
  readonly root_label: string;
  readonly zone_bytes: Uint8Array;
}): boolean {
  const wildcard = `*.${input.root_label}`;
  return decodeZone(input.zone_bytes, input.root_label, "retained").some(
    (record) => record[0] === wildcard && (record[1] === TYPE_AAAA || record[1] === TYPE_HTTPS),
  );
}

/**
 * Returns the kind of difference between the retained zone and the observed
 * one, or throws when the difference is not one adoption admits. Equal zones
 * are refused: there is nothing to adopt and renewal is the right operation.
 */
export function requireHnsZoneAdoptionDeltaV1(input: {
  readonly root_label: string;
  readonly retained_zone_bytes: Uint8Array;
  readonly observed_zone_bytes: Uint8Array;
}): HnsZoneAdoptionDeltaKind {
  const retained = decodeZone(input.retained_zone_bytes, input.root_label, "retained");
  const observed = decodeZone(input.observed_zone_bytes, input.root_label, "observed");
  const wildcard = `*.${input.root_label}`;
  const at = (records: readonly CanonicalRecord[], owner: string, type: number) =>
    records.filter((record) => record[0] === owner && record[1] === type);

  const retainedSoa = splitSoa(
    only(at(retained, input.root_label, TYPE_SOA), "retained SOA")[4],
    "retained",
  );
  const observedSoa = splitSoa(
    only(at(observed, input.root_label, TYPE_SOA), "observed SOA")[4],
    "observed",
  );
  if (retainedSoa.rest !== observedSoa.rest)
    return refuse("the SOA changed in more than its serial");
  if (observedSoa.serial <= retainedSoa.serial) return refuse("the SOA serial did not increase");
  const soaTtlEqual =
    only(at(retained, input.root_label, TYPE_SOA), "retained SOA")[3] ===
    only(at(observed, input.root_label, TYPE_SOA), "observed SOA")[3];
  if (!soaTtlEqual) return refuse("the SOA changed in more than its serial");

  const isSoa = (record: CanonicalRecord) =>
    record[0] === input.root_label && record[1] === TYPE_SOA;
  const isWildcardNsec = (record: CanonicalRecord) =>
    record[0] === wildcard && record[1] === TYPE_NSEC;
  const isFamily = (record: CanonicalRecord) =>
    record[0] === wildcard && (record[1] === TYPE_AAAA || record[1] === TYPE_HTTPS);

  const sorted = (records: readonly CanonicalRecord[]) => records.map(key).sort();
  const sameExceptSoa =
    JSON.stringify(sorted(retained.filter((record) => !isSoa(record)))) ===
    JSON.stringify(sorted(observed.filter((record) => !isSoa(record))));
  if (sameExceptSoa) return "serial_only";

  // An addition is checked as written; a removal is the same check with the
  // two zones exchanged, so the pair of zones a removal admits is exactly the
  // pair an addition admits.
  const removal = retained.some(isFamily);
  if (removal && observed.some(isFamily))
    return refuse("the wildcard address records changed rather than being added or removed");
  const [without, withFamily] = removal ? [observed, retained] : [retained, observed];
  const stable = (records: readonly CanonicalRecord[]) =>
    sorted(
      records.filter((record) => !isSoa(record) && !isWildcardNsec(record) && !isFamily(record)),
    );
  if (JSON.stringify(stable(without)) !== JSON.stringify(stable(withFamily)))
    return refuse("the zone changed outside the wildcard address records");

  const address = only(at(withFamily, wildcard, TYPE_A), "wildcard A record");
  const mapped = only(at(withFamily, wildcard, TYPE_AAAA), "wildcard AAAA record");
  const service = only(at(withFamily, wildcard, TYPE_HTTPS), "wildcard HTTPS record");
  if (address[4].length !== 8) return refuse("the wildcard A record is malformed");
  if (mapped[4] !== `${IPV4_MAPPED_PREFIX_HEX}${address[4]}`)
    return refuse("the wildcard AAAA record is not the IPv4-mapped form of the wildcard A record");
  if (service[4] !== WILDCARD_HTTPS_RDATA_HEX)
    return refuse("the wildcard HTTPS record is not the expected service binding");
  if (mapped[3] !== address[3] || service[3] !== address[3])
    return refuse("the wildcard address records do not share the wildcard A record's TTL");

  const bareNsecRecord = only(
    at(without, wildcard, TYPE_NSEC),
    "wildcard NSEC without the records",
  );
  const fullNsecRecord = only(
    at(withFamily, wildcard, TYPE_NSEC),
    "wildcard NSEC with the records",
  );
  const bareNsec = splitNsec(bareNsecRecord[4], removal ? "observed" : "retained");
  const fullNsec = splitNsec(fullNsecRecord[4], removal ? "retained" : "observed");
  const expectedTypes = new Set([...bareNsec.types, TYPE_AAAA, TYPE_HTTPS]);
  if (
    bareNsecRecord[3] !== fullNsecRecord[3] ||
    bareNsec.next !== fullNsec.next ||
    bareNsec.types.has(TYPE_AAAA) ||
    bareNsec.types.has(TYPE_HTTPS) ||
    fullNsec.types.size !== expectedTypes.size ||
    [...expectedTypes].some((type) => !fullNsec.types.has(type))
  )
    return refuse("the wildcard owner's NSEC changed in more than the two added types");
  return removal ? "wildcard_family_removed" : "wildcard_family_added";
}
