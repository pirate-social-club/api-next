import { describe, expect, test } from "bun:test";
import {
  buildHnsAuthoritativeDnsQueryV1,
  type HnsAuthoritativeDnsValidatorInputV1,
  type HnsChainAuthorityRecord,
  makeHnsAuthoritativeDnsValidatorV1,
} from "@pirate/application/namespace-ownership";
import type { Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";

const ROOT = "jazleeuw";
const CONTROL = `_pirate.${ROOT}`;
const ORIGINAL_TTL = 300;
const INCEPTION = 1_769_990_400;
const EXPIRATION = 1_770_163_200;
const VALIDATION_TIME = "2026-02-02T12:00:00.000Z";
const encoder = new TextEncoder();

type AcceptedAlgorithm = 8 | 10 | 13 | 14 | 15;
type GeneratedKeyPair = Readonly<{ publicKey: CryptoKey; privateKey: CryptoKey }>;

function uint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function nameWire(name: string): Uint8Array {
  const labels = name.split(".").map((label) => encoder.encode(label.toLowerCase()));
  return concatBytes([
    ...labels.map((label) => concatBytes([new Uint8Array([label.byteLength]), label])),
    new Uint8Array([0]),
  ]);
}

function originalCaseNameWire(name: string): Uint8Array {
  const labels = name.split(".").map((label) => encoder.encode(label));
  return concatBytes([
    ...labels.map((label) => concatBytes([new Uint8Array([label.byteLength]), label])),
    new Uint8Array([0]),
  ]);
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dnskeyTag(rdata: Uint8Array): number {
  let accumulator = 0;
  for (let index = 0; index < rdata.byteLength; index += 1) {
    accumulator += index & 1 ? (rdata[index] ?? 0) : (rdata[index] ?? 0) << 8;
  }
  accumulator += (accumulator >>> 16) & 0xffff;
  return accumulator & 0xffff;
}

function rsaPublicKey(exponent: Uint8Array, modulus: Uint8Array): Uint8Array {
  const exponentLength =
    exponent.byteLength <= 255
      ? new Uint8Array([exponent.byteLength])
      : concatBytes([new Uint8Array([0]), uint16(exponent.byteLength)]);
  return concatBytes([exponentLength, exponent, modulus]);
}

async function generateKeyPair(algorithm: AcceptedAlgorithm): Promise<GeneratedKeyPair> {
  if (algorithm === 8 || algorithm === 10) {
    return (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2_048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: algorithm === 8 ? "SHA-256" : "SHA-512",
      },
      true,
      ["sign", "verify"],
    )) as GeneratedKeyPair;
  }
  if (algorithm === 13 || algorithm === 14) {
    return (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: algorithm === 13 ? "P-256" : "P-384" },
      true,
      ["sign", "verify"],
    )) as GeneratedKeyPair;
  }
  return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as GeneratedKeyPair;
}

async function dnskeyRdata(
  algorithm: AcceptedAlgorithm,
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as Readonly<
    Record<string, string | undefined>
  >;
  let publicBytes: Uint8Array;
  if (algorithm === 8 || algorithm === 10) {
    if (jwk.e === undefined || jwk.n === undefined) throw new TypeError("RSA fixture key");
    publicBytes = rsaPublicKey(fromBase64Url(jwk.e), fromBase64Url(jwk.n));
  } else if (algorithm === 13 || algorithm === 14) {
    if (jwk.x === undefined || jwk.y === undefined) throw new TypeError("ECDSA fixture key");
    publicBytes = concatBytes([fromBase64Url(jwk.x), fromBase64Url(jwk.y)]);
  } else {
    if (jwk.x === undefined) throw new TypeError("Ed25519 fixture key");
    publicBytes = fromBase64Url(jwk.x);
  }
  return concatBytes([uint16(257), new Uint8Array([3, algorithm]), publicBytes]);
}

async function sign(
  algorithm: AcceptedAlgorithm,
  privateKey: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (algorithm === 13) {
    return new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data),
    );
  }
  if (algorithm === 14) {
    return new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-384" }, privateKey, data),
    );
  }
  return new Uint8Array(
    await crypto.subtle.sign(algorithm === 15 ? "Ed25519" : "RSASSA-PKCS1-v1_5", privateKey, data),
  );
}

function canonicalRecord(owner: string, type: number, rdata: Uint8Array): Uint8Array {
  return concatBytes([
    nameWire(owner),
    uint16(type),
    uint16(1),
    uint32(ORIGINAL_TTL),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

async function signedRrsigRdata(
  input: Readonly<{
    readonly owner: string;
    readonly type: number;
    readonly rdata: Uint8Array;
    readonly algorithm: AcceptedAlgorithm;
    readonly key_tag: number;
    readonly private_key: CryptoKey;
    readonly labels?: number;
    readonly rrset_rdatas?: ReadonlyArray<Uint8Array>;
  }>,
): Promise<Uint8Array> {
  const header = concatBytes([
    uint16(input.type),
    new Uint8Array([input.algorithm, input.labels ?? input.owner.split(".").length]),
    uint32(ORIGINAL_TTL),
    uint32(EXPIRATION),
    uint32(INCEPTION),
    uint16(input.key_tag),
    nameWire(ROOT),
  ]);
  const signature = await sign(
    input.algorithm,
    input.private_key,
    concatBytes([
      header,
      ...(input.rrset_rdatas ?? [input.rdata])
        .slice()
        .sort((left, right) => {
          const length = Math.min(left.byteLength, right.byteLength);
          for (let index = 0; index < length; index += 1) {
            const difference = (left[index] ?? 0) - (right[index] ?? 0);
            if (difference !== 0) return difference;
          }
          return left.byteLength - right.byteLength;
        })
        .map((rdata) => canonicalRecord(input.owner, input.type, rdata)),
    ]),
  );
  return concatBytes([header, signature]);
}

function record(type: number, rdata: Uint8Array, ttl = ORIGINAL_TTL): Uint8Array {
  return namedRecord(new Uint8Array([0xc0, 0x0c]), type, rdata, ttl);
}

function namedRecord(
  owner: Uint8Array,
  type: number,
  rdata: Uint8Array,
  ttl = ORIGINAL_TTL,
): Uint8Array {
  return concatBytes([
    owner,
    uint16(type),
    uint16(1),
    uint32(ttl),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function response(
  request: Uint8Array,
  answers: ReadonlyArray<Uint8Array>,
  flags = 0x8400,
  authorities: ReadonlyArray<Uint8Array> = [],
): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = request[0] ?? 0;
  header[1] = request[1] ?? 0;
  header.set(uint16(flags), 2);
  header.set(uint16(1), 4);
  header.set(uint16(answers.length), 6);
  header.set(uint16(authorities.length), 8);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    request.subarray(12, request.byteLength - 11),
    ...answers,
    ...authorities,
    request.subarray(request.byteLength - 11),
  ]);
}

function nsecBitmap(types: ReadonlyArray<number>): Uint8Array {
  const length = Math.max(...types.map((type) => Math.floor(type / 8))) + 1;
  const bitmap = new Uint8Array(length);
  for (const type of types) {
    const index = Math.floor(type / 8);
    bitmap[index] = (bitmap[index] ?? 0) | (0x80 >>> (type % 8));
  }
  return concatBytes([new Uint8Array([0, bitmap.byteLength]), bitmap]);
}

async function negativeFixture(
  kind: "nodata" | "nxdomain",
  includeNsec3 = false,
  mixedCaseNext = false,
  deprecatedNsecSignatures = false,
  omitNsecSelfBits = false,
): Promise<HnsAuthoritativeDnsValidatorInputV1> {
  const algorithm = 13 as const;
  const pair = await generateKeyPair(algorithm);
  const dnskey = await dnskeyRdata(algorithm, pair.publicKey);
  const keyTag = dnskeyTag(dnskey);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", concatBytes([nameWire(ROOT), dnskey])),
  );
  const authorityRecords: ReadonlyArray<HnsChainAuthorityRecord> = [
    ["NS", `ns1.${ROOT}`],
    ["GLUE4", `ns1.${ROOT}`, "192.0.2.53"],
    ["DS", keyTag, algorithm, 2, toHex(digest)],
  ];
  const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
    message_id: 3,
    query_kind: "dnskey",
    root_label: ROOT,
  });
  const controlRequest = buildHnsAuthoritativeDnsQueryV1({
    message_id: 4,
    query_kind: "control_txt",
    root_label: ROOT,
  });
  const dnskeySignature = await signedRrsigRdata({
    owner: ROOT,
    type: 48,
    rdata: dnskey,
    algorithm,
    key_tag: keyTag,
    private_key: pair.privateKey,
  });
  const soa = concatBytes([
    nameWire(`ns1.${ROOT}`),
    nameWire(`hostmaster.${ROOT}`),
    uint32(1),
    uint32(3_600),
    uint32(600),
    uint32(86_400),
    uint32(300),
  ]);
  const soaSignature = await signedRrsigRdata({
    owner: ROOT,
    type: 6,
    rdata: soa,
    algorithm,
    key_tag: keyTag,
    private_key: pair.privateKey,
  });
  const authorities: Uint8Array[] = [
    namedRecord(nameWire(ROOT), 6, soa),
    namedRecord(nameWire(ROOT), 46, soaSignature),
  ];
  const denialOwners = kind === "nodata" ? [CONTROL] : [ROOT, `a.${ROOT}`];
  const denialNextNames = kind === "nodata" ? [`z.${ROOT}`] : [`a.${ROOT}`, ROOT];
  for (let index = 0; index < denialOwners.length; index += 1) {
    const owner = denialOwners[index] as string;
    const nextName = denialNextNames[index] as string;
    const nsec = concatBytes([
      mixedCaseNext ? originalCaseNameWire(nextName.toUpperCase()) : nameWire(nextName),
      nsecBitmap(omitNsecSelfBits ? [1] : [46, 47]),
    ]);
    const signed = await signedRrsigRdata({
      owner,
      type: 47,
      rdata: nsec,
      algorithm,
      key_tag: keyTag,
      private_key: pair.privateKey,
    });
    const signature = new Uint8Array(signed);
    if (deprecatedNsecSignatures) signature[2] = 5;
    const ownerWire = owner === CONTROL ? new Uint8Array([0xc0, 0x0c]) : nameWire(owner);
    authorities.push(namedRecord(ownerWire, 47, nsec), namedRecord(ownerWire, 46, signature));
  }
  if (includeNsec3) {
    authorities.push(
      namedRecord(nameWire(`unused.${ROOT}`), 50, new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0])),
    );
  }
  return {
    driver_reference: "authoritative-dns:fixture",
    view_id: "dns-view-a",
    root_label: ROOT,
    authority_records: authorityRecords,
    chain_authority_digest: "2".repeat(64) as Sha256HexValue,
    authority_nameserver: `ns1.${ROOT}`,
    authority_address_family: "GLUE4",
    authority_address: "192.0.2.53",
    dnskey_request_bytes: dnskeyRequest,
    dnskey_response_bytes: response(dnskeyRequest, [
      record(48, dnskey),
      record(46, dnskeySignature),
    ]),
    control_request_bytes: controlRequest,
    control_response_bytes: response(
      controlRequest,
      [],
      kind === "nxdomain" ? 0x8403 : 0x8400,
      authorities,
    ),
    validation_database_time: VALIDATION_TIME,
    signal: new AbortController().signal,
  };
}

async function secureFixture(
  algorithm: AcceptedAlgorithm,
  digestType: 2 | 4 = 2,
  labels?: number,
  controlSignatureCopies = 1,
  includeMalformedSignature = false,
  receivedControlTtl = ORIGINAL_TTL,
  includeNonZoneKey = false,
): Promise<HnsAuthoritativeDnsValidatorInputV1> {
  const pair = await generateKeyPair(algorithm);
  const dnskey = await dnskeyRdata(algorithm, pair.publicKey);
  const keyTag = dnskeyTag(dnskey);
  const digestName = digestType === 2 ? "SHA-256" : "SHA-384";
  const digest = new Uint8Array(
    await crypto.subtle.digest(digestName, concatBytes([nameWire(ROOT), dnskey])),
  );
  const authorityRecords: ReadonlyArray<HnsChainAuthorityRecord> = [
    ["NS", `ns1.${ROOT}`],
    ["GLUE4", `ns1.${ROOT}`, "192.0.2.53"],
    ["DS", keyTag, algorithm, digestType, toHex(digest)],
  ];
  const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
    message_id: 1,
    query_kind: "dnskey",
    root_label: ROOT,
  });
  const controlRequest = buildHnsAuthoritativeDnsQueryV1({
    message_id: 2,
    query_kind: "control_txt",
    root_label: ROOT,
  });
  const txt = concatBytes([new Uint8Array([15]), encoder.encode("pirate=expected")]);
  const nonZoneKey = includeNonZoneKey
    ? await dnskeyRdata(algorithm, (await generateKeyPair(algorithm)).publicKey).then((rdata) => {
        const changed = new Uint8Array(rdata);
        changed[0] = 0;
        changed[1] = 0;
        return changed;
      })
    : null;
  const dnskeyRdatas = nonZoneKey === null ? [dnskey] : [dnskey, nonZoneKey];
  const dnskeySignature = await signedRrsigRdata({
    owner: ROOT,
    type: 48,
    rdata: dnskey,
    algorithm,
    key_tag: keyTag,
    private_key: pair.privateKey,
    rrset_rdatas: dnskeyRdatas,
  });
  const txtSignature = await signedRrsigRdata({
    owner: CONTROL,
    type: 16,
    rdata: txt,
    algorithm,
    key_tag: keyTag,
    private_key: pair.privateKey,
    ...(labels === undefined ? {} : { labels }),
  });
  return {
    driver_reference: "authoritative-dns:fixture",
    view_id: "dns-view-a",
    root_label: ROOT,
    authority_records: authorityRecords,
    chain_authority_digest: "1".repeat(64) as Sha256HexValue,
    authority_nameserver: `ns1.${ROOT}`,
    authority_address_family: "GLUE4",
    authority_address: "192.0.2.53",
    dnskey_request_bytes: dnskeyRequest,
    dnskey_response_bytes: response(dnskeyRequest, [
      ...dnskeyRdatas.map((rdata) => record(48, rdata)),
      record(46, dnskeySignature),
    ]),
    control_request_bytes: controlRequest,
    control_response_bytes: response(controlRequest, [
      record(16, txt, receivedControlTtl),
      ...Array.from({ length: controlSignatureCopies }, () => record(46, txtSignature)),
      ...(includeMalformedSignature
        ? [record(46, txtSignature.subarray(0, txtSignature.byteLength - 1))]
        : []),
    ]),
    validation_database_time: VALIDATION_TIME,
    signal: new AbortController().signal,
  };
}

describe("HNS authoritative DNS validator policy v1", () => {
  test("authenticates literal DNSKEY and TXT packets for every accepted algorithm", async () => {
    const validator = await makeHnsAuthoritativeDnsValidatorV1();
    expect(validator.policy_id).toBe("pirate-hns-authoritative-dns-validator-policy-v1");
    for (const [algorithm, digest] of [
      [8, 2],
      [10, 4],
      [13, 2],
      [14, 4],
      [15, 2],
    ] as const) {
      const result = await validator.validate(await secureFixture(algorithm, digest));
      expect(result.dnssec_validation).toBe("secure");
    }
  });

  test("classifies a tampered accepted signature as bogus", async () => {
    const input = await secureFixture(13);
    const changed = new Uint8Array(input.control_response_bytes);
    changed[changed.byteLength - 12] = (changed[changed.byteLength - 12] ?? 0) ^ 1;
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate({
      ...input,
      control_response_bytes: changed,
    });
    expect(result.dnssec_validation).toBe("bogus");
  });

  test("returns indeterminate for wildcard-expanded control evidence", async () => {
    const input = await secureFixture(13, 2, 1);
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(input);
    expect(result.dnssec_validation).toBe("indeterminate");
  });

  test("returns insecure before observation when the chain publishes only SHA-1 DNSSEC", async () => {
    const input = await secureFixture(13);
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate({
      ...input,
      authority_records: [
        ["NS", `ns1.${ROOT}`],
        ["GLUE4", `ns1.${ROOT}`, "192.0.2.53"],
        ["DS", 1, 5, 1, "ab".repeat(20)],
      ],
    });
    expect(result.dnssec_validation).toBe("insecure");
  });

  test("authenticates exact NSEC NODATA and NSEC NXDOMAIN denial", async () => {
    const validator = await makeHnsAuthoritativeDnsValidatorV1();
    expect((await validator.validate(await negativeFixture("nodata"))).dnssec_validation).toBe(
      "secure",
    );
    expect((await validator.validate(await negativeFixture("nxdomain"))).dnssec_validation).toBe(
      "secure",
    );
  });

  test("ignores an NSEC3 record when complete authenticated NSEC denial is also present", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await negativeFixture("nodata", true),
    );
    expect(result.dnssec_validation).toBe("secure");
  });

  test("preserves received NSEC Next Domain Name case in the signed input", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await negativeFixture("nodata", false, true),
    );
    expect(result.dnssec_validation).toBe("secure");
  });

  test("propagates deprecated-only NSEC signing as insecure", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await negativeFixture("nodata", false, false, true),
    );
    expect(result.dnssec_validation).toBe("insecure");
  });

  test("ignores the NSEC and RRSIG self-bits when authenticating denial", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await negativeFixture("nodata", false, false, false, true),
    );
    expect(result.dnssec_validation).toBe("secure");
  });

  test("returns indeterminate for an over-budget RRSIG set before verification", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await secureFixture(13, 2, undefined, 9),
    );
    expect(result.dnssec_validation).toBe("indeterminate");
  });

  test("does not let a valid rollover path hide malformed accepted signature encoding", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await secureFixture(13, 2, undefined, 1, true),
    );
    expect(result.dnssec_validation).toBe("bogus");
  });

  test("replaces a greater received TTL with the signed Original TTL", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await secureFixture(13, 2, undefined, 1, false, 600),
    );
    expect(result.dnssec_validation).toBe("secure");
  });

  test("keeps a non-Zone DNSKEY in the signed RRset but excludes it from verification", async () => {
    const result = await (await makeHnsAuthoritativeDnsValidatorV1()).validate(
      await secureFixture(13, 2, undefined, 1, false, ORIGINAL_TTL, true),
    );
    expect(result.dnssec_validation).toBe("secure");
  });

  test("keeps serial-time ambiguity distinct from an unambiguously expired signature", async () => {
    const validator = await makeHnsAuthoritativeDnsValidatorV1();
    const input = await secureFixture(13);
    expect(
      (
        await validator.validate({
          ...input,
          validation_database_time: "2107-01-01T00:00:00.000Z",
        })
      ).dnssec_validation,
    ).toBe("indeterminate");
    expect(
      (
        await validator.validate({
          ...input,
          validation_database_time: new Date((EXPIRATION + 1) * 1_000).toISOString(),
        })
      ).dnssec_validation,
    ).toBe("bogus");
  });
});
