import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { HnsDnsTsigAxfrError, makeHnsDnsTsigAxfrSessionV1 } from "./dns-tsig-axfr.ts";

const messageId = 0x1234;
const zoneName = "jazleeuw";
const keyName = "pirate-axfr";
const secret = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const signedAt = 1_777_689_600;

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

function uint48(value: number): Uint8Array {
  return new Uint8Array([
    Math.floor(value / 0x10000000000) & 0xff,
    Math.floor(value / 0x100000000) & 0xff,
    ...uint32(value >>> 0),
  ]);
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function name(value: string): Uint8Array {
  return concat([
    ...value.split(".").map((label) => {
      const bytes = new TextEncoder().encode(label);
      return new Uint8Array([bytes.byteLength, ...bytes]);
    }),
    new Uint8Array([0]),
  ]);
}

function question(): Uint8Array {
  return concat([name(zoneName), uint16(252), uint16(1)]);
}

function record(owner: string, type: number, ttl: number, rdata: Uint8Array): Uint8Array {
  return concat([
    name(owner),
    uint16(type),
    uint16(1),
    uint32(ttl),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function soa(serial = 2_026_080_805, owner = zoneName): Uint8Array {
  return record(
    owner,
    6,
    300,
    concat([
      name("ns1.pirate"),
      name("hostmaster.jazleeuw"),
      uint32(serial),
      uint32(3_600),
      uint32(900),
      uint32(1_209_600),
      uint32(300),
    ]),
  );
}

const apexNs = record(zoneName, 2, 300, name("ns1.pirate"));
const appA = record("app.jazleeuw", 1, 300, new Uint8Array([94, 103, 168, 161]));

function unsignedResponse(
  answers: ReadonlyArray<Uint8Array>,
  includeQuestion: boolean,
): Uint8Array {
  return concat([
    uint16(messageId),
    uint16(0x8400),
    uint16(includeQuestion ? 1 : 0),
    uint16(answers.length),
    uint16(0),
    uint16(0),
    ...(includeQuestion ? [question()] : []),
    ...answers,
  ]);
}

function hmac(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const digest = createHmac("sha256", secret);
  for (const part of parts) digest.update(part);
  return new Uint8Array(digest.digest());
}

function fullVariables(time: number, fudge: number): Uint8Array {
  return concat([
    name(keyName),
    uint16(255),
    uint32(0),
    name("hmac-sha256"),
    uint48(time),
    uint16(fudge),
    uint16(0),
    uint16(0),
  ]);
}

function requestMac(request: Uint8Array): Uint8Array {
  const questionEnd = 12 + question().byteLength;
  const rdata = questionEnd + name(keyName).byteLength + 10;
  const macSizeOffset = rdata + name("hmac-sha256").byteLength + 8;
  const macSize = (request[macSizeOffset] ?? 0) * 256 + (request[macSizeOffset + 1] ?? 0);
  return request.slice(macSizeOffset + 2, macSizeOffset + 2 + macSize);
}

function appendTsig(
  message: Uint8Array,
  priorMac: Uint8Array,
  messageIndex: number,
  time = signedAt,
  fudge = 300,
  macByteLength = 32,
): Readonly<{ message: Uint8Array; mac: Uint8Array }> {
  const fullMac =
    messageIndex === 0
      ? hmac([uint16(priorMac.byteLength), priorMac, message, fullVariables(time, fudge)])
      : hmac([uint16(priorMac.byteLength), priorMac, message, uint48(time), uint16(fudge)]);
  const mac = fullMac.slice(0, macByteLength);
  const rdata = concat([
    name("hmac-sha256"),
    uint48(time),
    uint16(fudge),
    uint16(mac.byteLength),
    mac,
    uint16(messageId),
    uint16(0),
    uint16(0),
  ]);
  const tsig = concat([
    name(keyName),
    uint16(250),
    uint16(255),
    uint32(0),
    uint16(rdata.byteLength),
    rdata,
  ]);
  const result = concat([message, tsig]);
  result[10] = 0;
  result[11] = 1;
  return { message: result, mac };
}

function session() {
  return makeHnsDnsTsigAxfrSessionV1({
    message_id: messageId,
    zone_name: zoneName,
    credential: { key_name: keyName, algorithm: "hmac-sha256", secret_bytes: secret },
    signed_at_seconds: signedAt,
    fudge_seconds: 300,
    now_seconds: () => signedAt,
  });
}

function signedTransfer(
  current: ReturnType<typeof session>,
  closingSoa = soa(),
): readonly [Uint8Array, Uint8Array] {
  const first = appendTsig(
    unsignedResponse([soa(), apexNs, appA], true),
    requestMac(current.request_bytes),
    0,
  );
  const second = appendTsig(unsignedResponse([closingSoa], false), first.mac, 1);
  return [first.message, second.message];
}

function compressionPointer(offset: number): Uint8Array {
  return new Uint8Array([0xc0 | ((offset >>> 8) & 0x3f), offset & 0xff]);
}

function unsignedResponseWithCompressionPointerLadder(): Uint8Array {
  const header = concat([
    uint16(messageId),
    uint16(0x8400),
    uint16(1),
    uint16(5),
    uint16(0),
    uint16(0),
  ]);
  const prefix = concat([header, question(), soa(), apexNs]);
  const fillerRdataOffset = prefix.byteLength + name(zoneName).byteLength + 10;
  const pointers: Uint8Array[] = [];
  for (let index = 0; index < 17; index += 1) {
    pointers.push(compressionPointer(index === 0 ? 12 : fillerRdataOffset + (index - 1) * 2));
  }
  const filler = record(zoneName, 16, 300, concat(pointers));
  const maliciousOwner = compressionPointer(fillerRdataOffset + 16 * 2);
  const maliciousRecord = concat([
    maliciousOwner,
    uint16(1),
    uint16(1),
    uint32(300),
    uint16(4),
    new Uint8Array([94, 103, 168, 161]),
  ]);
  return concat([prefix, filler, maliciousRecord, soa()]);
}

describe("TSIG-authenticated AXFR session", () => {
  test("builds a signed AXFR request and accepts an exact two-message MAC chain", () => {
    const current = session();
    expect([...current.request_bytes.slice(0, 2)]).toEqual([...uint16(messageId)]);
    expect(current.request_bytes.includes(252)).toBe(true);
    expect(requestMac(current.request_bytes)).toHaveLength(32);

    const [first, second] = signedTransfer(current);
    expect(current.accept_response(first, 0)).toBe(false);
    expect(current.accept_response(second, 1)).toBe(true);
  });

  test("accepts a one-message transfer only when identical SOAs bracket the records", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponse([soa(), apexNs, appA, soa()], true),
      requestMac(current.request_bytes),
      0,
    );
    expect(current.accept_response(response.message, 0)).toBe(true);
  });

  test("accepts a first response within the clock window and enforces exact sequence indexes", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponse([soa(), apexNs, appA, soa()], true),
      requestMac(current.request_bytes),
      0,
      signedAt - 1,
    );
    expect(() => current.accept_response(response.message, 1)).toThrow(
      "invalid AXFR response sequence",
    );

    const retry = session();
    expect(retry.accept_response(response.message, 0)).toBe(true);
  });

  test("refuses a byte changed after the TSIG was computed", () => {
    const current = session();
    const [first] = signedTransfer(current);
    const tampered = Uint8Array.from(first);
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    expect(() => current.accept_response(tampered, 0)).toThrow("verification failed");
  });

  test("refuses a correctly signed transfer whose terminal SOA differs", () => {
    const current = session();
    const [first, second] = signedTransfer(current, soa(2_026_080_806));
    expect(current.accept_response(first, 0)).toBe(false);
    expect(() => current.accept_response(second, 1)).toThrow("terminal SOA mismatch");
  });

  test("refuses a first message without an opening SOA", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponse([appA], true),
      requestMac(current.request_bytes),
      0,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow("does not begin with SOA");
  });

  test("refuses authenticated SOAs whose owner is not the requested zone", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponse(
        [soa(2_026_080_805, "attacker.example"), apexNs, soa(2_026_080_805, "attacker.example")],
        true,
      ),
      requestMac(current.request_bytes),
      0,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow(
      "answer owner is outside the requested zone",
    );
  });

  test("refuses an authenticated SOA owned by a subdomain of the requested zone", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponse(
        [soa(2_026_080_805, "child.jazleeuw"), apexNs, soa(2_026_080_805, "child.jazleeuw")],
        true,
      ),
      requestMac(current.request_bytes),
      0,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow("AXFR SOA owner mismatch");
  });

  test("refuses authenticated records outside the requested zone", () => {
    const current = session();
    const outOfZone = record("attacker.example", 1, 300, new Uint8Array([192, 0, 2, 1]));
    const response = appendTsig(
      unsignedResponse([soa(), apexNs, outOfZone, soa()], true),
      requestMac(current.request_bytes),
      0,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow(
      "answer owner is outside the requested zone",
    );
  });

  test("refuses an authenticated SOA-only transfer without the apex NS RRset", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponse([soa(), soa()], true),
      requestMac(current.request_bytes),
      0,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow("lacks the apex NS RRset");
  });

  test("refuses a correctly truncated TSIG MAC rather than accepting a server downgrade", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponse([soa(), apexNs, appA, soa()], true),
      requestMac(current.request_bytes),
      0,
      signedAt,
      300,
      16,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow("invalid TSIG MAC length");
  });

  test("refuses a signed response whose owner uses an excessive compression-pointer ladder", () => {
    const current = session();
    const response = appendTsig(
      unsignedResponseWithCompressionPointerLadder(),
      requestMac(current.request_bytes),
      0,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow(
      "invalid DNS compression pointer",
    );
  });

  test("refuses a malformed record masquerading as the apex NS RRset", () => {
    const current = session();
    const malformedApexNs = record(
      zoneName,
      2,
      300,
      concat([name("ns1.pirate"), new Uint8Array([0])]),
    );
    const response = appendTsig(
      unsignedResponse([soa(), malformedApexNs, soa()], true),
      requestMac(current.request_bytes),
      0,
    );
    expect(() => current.accept_response(response.message, 0)).toThrow("invalid AXFR apex NS data");
  });

  test("refuses stale signatures and invalid credentials before acquisition", () => {
    const stale = makeHnsDnsTsigAxfrSessionV1({
      message_id: messageId,
      zone_name: zoneName,
      credential: { key_name: keyName, algorithm: "hmac-sha256", secret_bytes: secret },
      signed_at_seconds: signedAt,
      fudge_seconds: 300,
      now_seconds: () => signedAt + 301,
    });
    const response = appendTsig(
      unsignedResponse([soa(), soa()], true),
      requestMac(stale.request_bytes),
      0,
    );
    expect(() => stale.accept_response(response.message, 0)).toThrow("invalid AXFR TSIG metadata");

    const excessiveFudge = session();
    const excessiveFudgeResponse = appendTsig(
      unsignedResponse([soa(), soa()], true),
      requestMac(excessiveFudge.request_bytes),
      0,
      signedAt,
      301,
    );
    expect(() => excessiveFudge.accept_response(excessiveFudgeResponse.message, 0)).toThrow(
      "invalid AXFR TSIG metadata",
    );
    expect(() =>
      makeHnsDnsTsigAxfrSessionV1({
        message_id: messageId,
        zone_name: zoneName,
        credential: {
          key_name: keyName,
          algorithm: "hmac-sha256",
          secret_bytes: new Uint8Array(15),
        },
        signed_at_seconds: signedAt,
        fudge_seconds: 300,
        now_seconds: () => signedAt,
      }),
    ).toThrow(HnsDnsTsigAxfrError);
  });
});
