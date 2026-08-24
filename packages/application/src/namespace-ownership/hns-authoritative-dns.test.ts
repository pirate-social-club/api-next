import { describe, expect, test } from "bun:test";
import type { Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import {
  buildHnsAuthoritativeDnsQueryV1,
  classifyHnsAuthoritativeDnsResponseV1,
  decodeHnsAuthoritativeDnsQueryV1,
  decodeHnsAuthoritativeDnsRdataNameV1,
  decodeHnsAuthoritativeDnsResponseV1,
  decodeHnsAuthoritativeDnsSemanticFactsV1,
  encodeHnsAuthoritativeDnsSemanticFactsV1,
  selectHnsAuthoritativeDnsAuthorityTupleV1,
  validateHnsAuthoritativeDnsValidationResultV1,
} from "./hns-authoritative-dns.ts";

const DNSKEY_QUERY_HEX =
  "000000000001000000000001086a617a6c65657577000030000100002904d0000080000000";
const CONTROL_QUERY_HEX =
  "000000000001000000000001075f706972617465086a617a6c65657577000010000100002904d0000080000000";
const DNSKEY_QUERY_SHA256 =
  "74a76e701ca44e5a1797a29f92af0b25a7a988e7114d7be4e9f446c34d965c64" as Sha256HexValue;
const CONTROL_QUERY_SHA256 =
  "f693b2b98f85c575d99f9dbb76eed2ec98d07391fb9e3d8a9c268b40ebfa30fe" as Sha256HexValue;
const CHAIN_AUTHORITY_DIGEST =
  "4c0edac62ed6d0c31eb92f873273846187b0c97ab2608e469cba4f8791619d72" as Sha256HexValue;
const SEMANTIC_FACTS_SHA256 = "26fc313e1e4046693391c1baf2a7cd0122c6b478b7557461cf003ae29507ca5f";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function uint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
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

function dnsRecord(
  type: number,
  rdata: Uint8Array,
  owner = new Uint8Array([0xc0, 0x0c]),
): Uint8Array {
  return concatBytes([
    owner,
    uint16(type),
    uint16(1),
    new Uint8Array([0, 0, 1, 44]),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function rrsig(type: number): Uint8Array {
  const rdata = new Uint8Array(18);
  rdata.set(uint16(type));
  return dnsRecord(46, rdata);
}

function dnsResponse(
  input: Readonly<{
    readonly request: Uint8Array;
    readonly flags: number;
    readonly answers?: ReadonlyArray<Uint8Array>;
    readonly authorities?: ReadonlyArray<Uint8Array>;
  }>,
): Uint8Array {
  const answers = input.answers ?? [];
  const authorities = input.authorities ?? [];
  const header = new Uint8Array(12);
  header[0] = input.request[0] ?? 0;
  header[1] = input.request[1] ?? 0;
  header.set(uint16(input.flags), 2);
  header.set(uint16(1), 4);
  header.set(uint16(answers.length), 6);
  header.set(uint16(authorities.length), 8);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    input.request.subarray(12, input.request.byteLength - 11),
    ...answers,
    ...authorities,
    input.request.subarray(input.request.byteLength - 11),
  ]);
}

describe("HNS authoritative DNS query wire", () => {
  test("reproduces the two literal zero-id vectors and their hashes", async () => {
    const dnskey = buildHnsAuthoritativeDnsQueryV1({
      message_id: 0,
      query_kind: "dnskey",
      root_label: "jazleeuw",
    });
    const control = buildHnsAuthoritativeDnsQueryV1({
      message_id: 0,
      query_kind: "control_txt",
      root_label: "jazleeuw",
    });
    expect(hex(dnskey)).toBe(DNSKEY_QUERY_HEX);
    expect(hex(control)).toBe(CONTROL_QUERY_HEX);
    expect(await sha256(dnskey)).toBe(DNSKEY_QUERY_SHA256);
    expect(await sha256(control)).toBe(CONTROL_QUERY_SHA256);
    expect(decodeHnsAuthoritativeDnsQueryV1(dnskey)).toEqual({
      message_id: 0,
      query_kind: "dnskey",
      root_label: "jazleeuw",
    });
    expect(decodeHnsAuthoritativeDnsQueryV1(control)).toEqual({
      message_id: 0,
      query_kind: "control_txt",
      root_label: "jazleeuw",
    });
  });

  test("round-trips the full message-id range without changing fixed wire authority", () => {
    for (const messageId of [1, 32_768, 65_535]) {
      const bytes = buildHnsAuthoritativeDnsQueryV1({
        message_id: messageId,
        query_kind: "dnskey",
        root_label: "jazleeuw",
      });
      expect(decodeHnsAuthoritativeDnsQueryV1(bytes).message_id).toBe(messageId);
      expect(hex(bytes).slice(4)).toBe(DNSKEY_QUERY_HEX.slice(4));
    }
  });

  test("rejects invalid entropy, query flags, names, OPT authority, and trailing bytes", () => {
    expect(() =>
      buildHnsAuthoritativeDnsQueryV1({
        message_id: 65_536,
        query_kind: "dnskey",
        root_label: "jazleeuw",
      }),
    ).toThrow();
    expect(() =>
      buildHnsAuthoritativeDnsQueryV1({
        message_id: 1,
        query_kind: "dnskey",
        root_label: "JAZLEEUW",
      }),
    ).toThrow();

    const valid = buildHnsAuthoritativeDnsQueryV1({
      message_id: 1,
      query_kind: "control_txt",
      root_label: "jazleeuw",
    });
    const mutations = [
      { offset: 2, value: 1 },
      { offset: 12, value: 0xc0 },
      { offset: valid.byteLength - 9, value: 0 },
      { offset: valid.byteLength - 4, value: 0 },
    ];
    for (const mutation of mutations) {
      const changed = new Uint8Array(valid);
      changed[mutation.offset] = mutation.value;
      expect(() => decodeHnsAuthoritativeDnsQueryV1(changed)).toThrow();
    }
    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(valid);
    expect(() => decodeHnsAuthoritativeDnsQueryV1(trailing)).toThrow();
  });
});

describe("HNS authoritative DNS decoded response seam", () => {
  test("rejects compression in the first echoed question name", () => {
    const request = buildHnsAuthoritativeDnsQueryV1({
      message_id: 8,
      query_kind: "control_txt",
      root_label: "jazleeuw",
    });
    const bytes = dnsResponse({ request, flags: 0x8400 });
    bytes[12] = 0xc0;
    bytes[13] = 0x0c;
    expect(() => decodeHnsAuthoritativeDnsResponseV1(bytes)).toThrow();
  });

  test("retains message-relative RDATA offsets and safely expands backward compression", () => {
    const request = buildHnsAuthoritativeDnsQueryV1({
      message_id: 9,
      query_kind: "control_txt",
      root_label: "jazleeuw",
    });
    const nsecRdata = new Uint8Array([0xc0, 0x14, 0, 1, 0x40]);
    const bytes = dnsResponse({
      request,
      flags: 0x8400,
      authorities: [dnsRecord(47, nsecRdata)],
    });
    const decoded = decodeHnsAuthoritativeDnsResponseV1(bytes);
    const record = decoded.authorities[0];
    expect(record?.section).toBe("authority");
    expect(record?.section_index).toBe(0);
    expect(record?.rdata_offset).toBeGreaterThan(12);
    if (record === undefined) throw new Error("fixture authority record is missing");
    const name = decodeHnsAuthoritativeDnsRdataNameV1({
      message_bytes: decoded.message_bytes,
      initial_offset: record.rdata_offset,
      encoded_end_offset: record.rdata_offset + record.rdata.byteLength,
      known_name_offsets: decoded.known_name_offsets,
    });
    expect(name.name).toBe("jazleeuw");
    expect(hex(name.canonical_wire)).toBe("086a617a6c6565757700");
    expect(name.next_offset).toBe(record.rdata_offset + 2);

    const nonNamePointer = new Uint8Array(decoded.message_bytes);
    nonNamePointer[record.rdata_offset] = 0xc0;
    nonNamePointer[record.rdata_offset + 1] = 0;
    expect(() =>
      decodeHnsAuthoritativeDnsRdataNameV1({
        message_bytes: nonNamePointer,
        initial_offset: record.rdata_offset,
        encoded_end_offset: record.rdata_offset + record.rdata.byteLength,
        known_name_offsets: decoded.known_name_offsets,
      }),
    ).toThrow();
  });

  test("allows a later owner to reuse a proven name boundary from earlier RDATA", () => {
    const request = buildHnsAuthoritativeDnsQueryV1({
      message_id: 10,
      query_kind: "control_txt",
      root_label: "jazleeuw",
    });
    const targetName = new Uint8Array([
      6, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 8, 0x6a, 0x61, 0x7a, 0x6c, 0x65, 0x65, 0x75, 0x77, 0,
    ]);
    const questionLength = request.byteLength - 12 - 11;
    const firstRdataOffset = 12 + questionLength + 2 + 10;
    const ownerPointer = new Uint8Array([0xc0 | (firstRdataOffset >>> 8), firstRdataOffset & 0xff]);
    const decoded = decodeHnsAuthoritativeDnsResponseV1(
      dnsResponse({
        request,
        flags: 0x8400,
        authorities: [
          dnsRecord(47, concatBytes([targetName, new Uint8Array([0, 1, 0x40])])),
          dnsRecord(1, new Uint8Array([192, 0, 2, 1]), ownerPointer),
        ],
      }),
    );
    expect(decoded.authorities[1]?.owner).toBe("target.jazleeuw");
  });
});

describe("HNS authoritative DNS authority and validation fences", () => {
  test("selects joined NS/glue tuples in canonical rotating order", () => {
    const records = [
      ["GLUE6", "ns2.jazleeuw", "2001:db8::2"],
      ["NS", "ns2.jazleeuw"],
      ["GLUE4", "unrelated.jazleeuw", "192.0.2.99"],
      ["GLUE4", "ns1.jazleeuw", "192.0.2.53"],
      ["NS", "ns1.jazleeuw"],
      ["GLUE6", "ns1.jazleeuw", "2001:db8::1"],
      ["DS", 12_345, 13, 2, "ab".repeat(32)],
    ] as const;
    expect(selectHnsAuthoritativeDnsAuthorityTupleV1(records, 0)).toEqual({
      authority_nameserver: "ns1.jazleeuw",
      authority_address_family: "GLUE4",
      authority_address: "192.0.2.53",
    });
    expect(selectHnsAuthoritativeDnsAuthorityTupleV1(records, 1)).toEqual({
      authority_nameserver: "ns1.jazleeuw",
      authority_address_family: "GLUE6",
      authority_address: "2001:db8::1",
    });
    expect(selectHnsAuthoritativeDnsAuthorityTupleV1(records, 2)).toEqual({
      authority_nameserver: "ns2.jazleeuw",
      authority_address_family: "GLUE6",
      authority_address: "2001:db8::2",
    });
    expect(selectHnsAuthoritativeDnsAuthorityTupleV1(records, 3)).toEqual(
      selectHnsAuthoritativeDnsAuthorityTupleV1(records, 0),
    );
  });

  test("recomputes exact validator hashes and rejects shape or authority substitution", async () => {
    const dnskeyResponse = new Uint8Array([1, 2, 3]);
    const controlResponse = new Uint8Array([4, 5, 6]);
    const result = {
      dnssec_validation: "secure" as const,
      validated_dnskey_response_sha256: (await sha256(dnskeyResponse)) as Sha256HexValue,
      validated_control_response_sha256: (await sha256(controlResponse)) as Sha256HexValue,
      validated_chain_authority_digest: CHAIN_AUTHORITY_DIGEST,
    };
    await expect(
      validateHnsAuthoritativeDnsValidationResultV1({
        value: result,
        dnskey_response_bytes: dnskeyResponse,
        control_response_bytes: controlResponse,
        chain_authority_digest: CHAIN_AUTHORITY_DIGEST,
      }),
    ).resolves.toEqual(result);
    await expect(
      validateHnsAuthoritativeDnsValidationResultV1({
        value: { ...result, unknown: true },
        dnskey_response_bytes: dnskeyResponse,
        control_response_bytes: controlResponse,
        chain_authority_digest: CHAIN_AUTHORITY_DIGEST,
      }),
    ).rejects.toThrow();
    for (const changed of [
      { ...result, validated_control_response_sha256: "0".repeat(64) },
      { ...result, validated_dnskey_response_sha256: "0".repeat(64) },
      { ...result, validated_chain_authority_digest: "0".repeat(64) },
      { ...result, dnssec_validation: "forged" },
      { ...result, validated_control_response_sha256: "A".repeat(64) },
    ]) {
      await expect(
        validateHnsAuthoritativeDnsValidationResultV1({
          value: changed,
          dnskey_response_bytes: dnskeyResponse,
          control_response_bytes: controlResponse,
          chain_authority_digest: CHAIN_AUTHORITY_DIGEST,
        }),
      ).rejects.toThrow();
    }
  });
});

describe("HNS authoritative DNS response grammar", () => {
  const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
    message_id: 41,
    query_kind: "dnskey",
    root_label: "jazleeuw",
  });
  const controlRequest = buildHnsAuthoritativeDnsQueryV1({
    message_id: 42,
    query_kind: "control_txt",
    root_label: "jazleeuw",
  });

  test("classifies structural DNSKEY and answer-only TXT responses", () => {
    const dnskeyResponse = dnsResponse({
      request: dnskeyRequest,
      flags: 0x8400,
      answers: [dnsRecord(48, new Uint8Array([1, 3, 13, 1])), rrsig(48)],
    });
    expect(
      classifyHnsAuthoritativeDnsResponseV1({
        request_bytes: dnskeyRequest,
        response_bytes: dnskeyResponse,
      }),
    ).toEqual({ kind: "dnskey" });

    const first = new TextEncoder().encode("pirate=alpha");
    const second = new TextEncoder().encode("pirate=beta");
    const controlResponse = dnsResponse({
      request: controlRequest,
      flags: 0x8400,
      answers: [
        dnsRecord(16, concatBytes([new Uint8Array([first.byteLength]), first])),
        dnsRecord(16, concatBytes([new Uint8Array([second.byteLength]), second])),
        rrsig(16),
      ],
    });
    expect(
      classifyHnsAuthoritativeDnsResponseV1({
        request_bytes: controlRequest,
        response_bytes: controlResponse,
      }),
    ).toEqual({
      kind: "txt_values",
      observed_txt_records: [{ chunks: ["pirate=alpha"] }, { chunks: ["pirate=beta"] }],
    });
  });

  test("accepts a backward multi-hop compression chain and rejects a forward pointer", () => {
    const value = new TextEncoder().encode("pirate=alpha");
    const questionLength = controlRequest.byteLength - 12 - 11;
    const firstOwnerOffset = 12 + questionLength;
    const first = dnsRecord(16, concatBytes([new Uint8Array([value.byteLength]), value]));
    const secondOwnerOffset = firstOwnerOffset + first.byteLength;
    const pointerToFirstOwner = new Uint8Array([
      0xc0 | ((firstOwnerOffset >>> 8) & 0x3f),
      firstOwnerOffset & 0xff,
    ]);
    const second = dnsRecord(
      16,
      concatBytes([new Uint8Array([value.byteLength]), value]),
      pointerToFirstOwner,
    );
    const compressed = dnsResponse({
      request: controlRequest,
      flags: 0x8400,
      answers: [first, second, rrsig(16)],
    });
    expect(
      classifyHnsAuthoritativeDnsResponseV1({
        request_bytes: controlRequest,
        response_bytes: compressed,
      }),
    ).toEqual({
      kind: "txt_values",
      observed_txt_records: [{ chunks: ["pirate=alpha"] }, { chunks: ["pirate=alpha"] }],
    });

    const forward = new Uint8Array(compressed);
    forward[firstOwnerOffset] = 0xc0 | ((secondOwnerOffset >>> 8) & 0x3f);
    forward[firstOwnerOffset + 1] = secondOwnerOffset & 0xff;
    expect(
      classifyHnsAuthoritativeDnsResponseV1({
        request_bytes: controlRequest,
        response_bytes: forward,
      }),
    ).toEqual({ kind: "inconclusive" });
  });

  test("keeps authenticated-negative structural classes distinct", () => {
    const proof = [dnsRecord(6, new Uint8Array([0])), dnsRecord(47, new Uint8Array([0]))];
    const signatures = [rrsig(6), rrsig(47)];
    for (const [flags, kind] of [
      [0x8400, "nodata"],
      [0x8403, "nxdomain"],
    ] as const) {
      expect(
        classifyHnsAuthoritativeDnsResponseV1({
          request_bytes: controlRequest,
          response_bytes: dnsResponse({
            request: controlRequest,
            flags,
            authorities: [...proof, ...signatures],
          }),
        }),
      ).toEqual({ kind });
    }
  });

  test("maps correlated SERVFAIL and malformed or unsigned authority without negatives", () => {
    expect(
      classifyHnsAuthoritativeDnsResponseV1({
        request_bytes: controlRequest,
        response_bytes: dnsResponse({ request: controlRequest, flags: 0x8002 }),
      }),
    ).toEqual({ kind: "servfail" });

    const unsignedTxt = dnsResponse({
      request: controlRequest,
      flags: 0x8400,
      answers: [dnsRecord(16, new Uint8Array([1, 0x61]))],
    });
    const wrongId = new Uint8Array(unsignedTxt);
    wrongId[1] = (wrongId[1] ?? 0) ^ 1;
    const truncated = unsignedTxt.subarray(0, unsignedTxt.byteLength - 1);
    for (const response of [unsignedTxt, wrongId, truncated]) {
      expect(
        classifyHnsAuthoritativeDnsResponseV1({
          request_bytes: controlRequest,
          response_bytes: response,
        }),
      ).toEqual({ kind: "inconclusive" });
    }
  });

  test("never promotes aliases, referrals, or out-of-answer TXT authority", () => {
    const txt = dnsRecord(16, new Uint8Array([1, 0x61]));
    const hostile = [
      dnsResponse({
        request: controlRequest,
        flags: 0x8400,
        answers: [dnsRecord(5, new Uint8Array([0])), txt, rrsig(16)],
      }),
      dnsResponse({
        request: controlRequest,
        flags: 0x8400,
        answers: [dnsRecord(39, new Uint8Array([0])), txt, rrsig(16)],
      }),
      dnsResponse({
        request: controlRequest,
        flags: 0x8400,
        authorities: [dnsRecord(2, new Uint8Array([0]))],
      }),
      dnsResponse({
        request: controlRequest,
        flags: 0x8400,
        authorities: [txt, rrsig(16)],
      }),
    ];
    for (const response of hostile) {
      expect(
        classifyHnsAuthoritativeDnsResponseV1({
          request_bytes: controlRequest,
          response_bytes: response,
        }),
      ).toEqual({ kind: "inconclusive" });
    }

    const misplacedDnskey = dnsResponse({
      request: dnskeyRequest,
      flags: 0x8400,
      answers: [dnsRecord(48, new Uint8Array([1, 3, 13, 1])), rrsig(48)],
      authorities: [dnsRecord(48, new Uint8Array([1, 3, 13, 2]))],
    });
    const misplacedOpt = dnsResponse({
      request: dnskeyRequest,
      flags: 0x8400,
      answers: [
        dnsRecord(48, new Uint8Array([1, 3, 13, 1])),
        rrsig(48),
        dnsRecord(41, new Uint8Array()),
      ],
    });
    for (const response of [misplacedDnskey, misplacedOpt]) {
      expect(
        classifyHnsAuthoritativeDnsResponseV1({
          request_bytes: dnskeyRequest,
          response_bytes: response,
        }),
      ).toEqual({ kind: "inconclusive" });
    }
  });
});

describe("HNS authoritative DNS semantic facts", () => {
  test("reproduces the literal secure-TXT semantic-facts vector", async () => {
    const bytes = encodeHnsAuthoritativeDnsSemanticFactsV1([
      {
        view_id: "dns-view-a",
        authority_nameserver: "ns1.jazleeuw",
        authority_address_family: "GLUE4",
        authority_address: "192.0.2.53",
        dnskey_request_sha256: DNSKEY_QUERY_SHA256,
        dnskey_response_sha256: "a".repeat(64) as Sha256HexValue,
        control_request_sha256: CONTROL_QUERY_SHA256,
        control_response_sha256: "b".repeat(64) as Sha256HexValue,
        chain_authority_digest: CHAIN_AUTHORITY_DIGEST,
        validation_database_time: "2026-02-02T00:00:00.000Z",
        dnssec_validation: "secure",
        semantic_class: "txt_values",
        observed_txt_values_digest:
          "c95f975f2d990aae7433c40288c95f5fae2115990a57b2497f3fa8b9550f26bc" as Sha256HexValue,
      },
    ]);
    expect(bytes.byteLength).toBe(870);
    expect(await sha256(bytes)).toBe(SEMANTIC_FACTS_SHA256);
  });

  test("rejects duplicate views and secure/non-secure semantic authority mismatches", () => {
    const base = {
      view_id: "dns-view-a",
      authority_nameserver: "ns1.jazleeuw",
      authority_address_family: "GLUE4" as const,
      authority_address: "192.0.2.53",
      dnskey_request_sha256: DNSKEY_QUERY_SHA256,
      dnskey_response_sha256: "a".repeat(64) as Sha256HexValue,
      control_request_sha256: CONTROL_QUERY_SHA256,
      control_response_sha256: "b".repeat(64) as Sha256HexValue,
      chain_authority_digest: CHAIN_AUTHORITY_DIGEST,
      validation_database_time: "2026-02-02T00:00:00.000Z",
      dnssec_validation: "secure" as const,
      semantic_class: "nodata" as const,
      observed_txt_values_digest: null,
    };
    expect(() => encodeHnsAuthoritativeDnsSemanticFactsV1([base, base])).toThrow();
    expect(() =>
      encodeHnsAuthoritativeDnsSemanticFactsV1([
        { ...base, dnssec_validation: "insecure", semantic_class: "nodata" },
      ]),
    ).toThrow();
    expect(() =>
      encodeHnsAuthoritativeDnsSemanticFactsV1([
        { ...base, semantic_class: "txt_values", observed_txt_values_digest: null },
      ]),
    ).toThrow();
    expect(() =>
      encodeHnsAuthoritativeDnsSemanticFactsV1([{ ...base, semantic_class: "forged" as "nodata" }]),
    ).toThrow();
  });

  test("strict-decodes only the canonical semantic-facts bytes", () => {
    const empty = encodeHnsAuthoritativeDnsSemanticFactsV1([]);
    expect(decodeHnsAuthoritativeDnsSemanticFactsV1(empty)).toEqual({
      semantic_facts_bytes: empty,
      views: [],
    });
    for (const changed of [
      new TextEncoder().encode(
        '{"views":[],"version":"pirate-hns-authoritative-dns-semantic-facts-v1"}',
      ),
      new TextEncoder().encode(
        '{"version":"pirate-hns-authoritative-dns-semantic-facts-v1","views":[],"extra":true}',
      ),
      new TextEncoder().encode(
        ' {"version":"pirate-hns-authoritative-dns-semantic-facts-v1","views":[]}',
      ),
    ]) {
      expect(() => decodeHnsAuthoritativeDnsSemanticFactsV1(changed)).toThrow();
    }
  });
});
