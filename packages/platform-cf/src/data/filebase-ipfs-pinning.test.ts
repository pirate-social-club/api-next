import { describe, expect, test } from "bun:test";
import type { IpfsPinningInput, IpfsPinningLimits } from "@pirate/application/data/ipfs-pinning";
import { Effect } from "effect";
import {
  FILEBASE_IPFS_ADD_PATH,
  FILEBASE_IPFS_CAT_PATH,
  FILEBASE_IPFS_MULTIPART_BOUNDARY,
  FILEBASE_IPFS_PIN_ADD_PATH,
  FILEBASE_IPFS_PIN_LS_PATH,
  type FilebaseIpfsTransport,
  type FilebaseIpfsTransportRequest,
  type FilebaseIpfsTransportResponse,
  isValidFilebaseCid,
  makeFilebaseIpfsPinningAdapter,
} from "./filebase-ipfs-pinning.ts";

const CID = "bafkreie7mstupynzp4jr7k5wwrdss3e3n4badz47wpctk3tmo7ujw2uani";
const BYTES = new Uint8Array([1, 2, 3, 4]);
const SHA256 = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const TOKEN = "filebase-test-token-must-not-leak";
const limits: IpfsPinningLimits = {
  max_source_bytes: 1024,
  max_response_bytes: 1024,
  timeout_ms: 100,
  pin_convergence_attempts: 3,
  pin_convergence_delay_ms: 0,
};

function body(bytes: Uint8Array, onCancel: () => void = () => undefined) {
  return {
    open: async function* () {
      yield bytes;
    },
    cancel: onCancel,
  };
}

function json(
  value: unknown,
  status = 200,
  contentType = "application/json",
): FilebaseIpfsTransportResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: body(new TextEncoder().encode(JSON.stringify(value))),
  };
}

function input(overrides: Partial<IpfsPinningInput> = {}): IpfsPinningInput {
  return {
    version: "ipfs-pinning-v1",
    request_id: "pin-attempt-1",
    filename: "sample.bin",
    content_type: "application/octet-stream",
    source: {
      byte_length: BYTES.byteLength,
      open: async function* (signal) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        yield BYTES;
      },
    },
    expected_byte_length: BYTES.byteLength,
    expected_sha256: SHA256,
    ...overrides,
  };
}

function transportFor(
  options: {
    readonly converge?: boolean;
    readonly contentType?: string;
    readonly catBytes?: Uint8Array;
  } = {},
) {
  const requests: FilebaseIpfsTransportRequest[] = [];
  let lsCalls = 0;
  const transport = async (
    request: FilebaseIpfsTransportRequest,
  ): Promise<FilebaseIpfsTransportResponse> => {
    requests.push(request);
    if (request.path === FILEBASE_IPFS_ADD_PATH) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.body.open(request.signal)) chunks.push(chunk);
      const multipart = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        multipart.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(multipart);
      expect(text).toContain(`--${FILEBASE_IPFS_MULTIPART_BOUNDARY}`);
      expect(text).toContain('filename="sample.bin"');
      expect(text.endsWith(`\r\n--${FILEBASE_IPFS_MULTIPART_BOUNDARY}--\r\n`)).toBe(true);
      return json(
        { Name: "sample.bin", Hash: CID, Size: "4" },
        200,
        options.contentType ?? "application/json",
      );
    }
    if (request.path === FILEBASE_IPFS_PIN_ADD_PATH) return json({ Pins: [CID] });
    if (request.path === FILEBASE_IPFS_PIN_LS_PATH) {
      lsCalls += 1;
      return json({
        Keys: options.converge === false && lsCalls < 3 ? {} : { [CID]: { Type: "recursive" } },
      });
    }
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: body(options.catBytes ?? BYTES),
    };
  };
  return { requests, transport };
}

function adapter(transport: FilebaseIpfsTransport) {
  return makeFilebaseIpfsPinningAdapter({ enabled: true, token: TOKEN, transport, limits });
}

describe("Filebase IPFS pinning adapter", () => {
  test("is disabled by default and never calls the transport", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      makeFilebaseIpfsPinningAdapter({
        transport: async () => {
          calls += 1;
          return json({});
        },
      }).pin(input()),
    );
    expect(result).toEqual({ status: "disabled", outcome: "disabled" });
    expect(calls).toBe(0);
  });

  test("streams one multipart source and verifies pin convergence plus raw cat digest", async () => {
    const fake = transportFor();
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result).toEqual({
      status: "pinned",
      outcome: "pinned",
      cid: CID,
      byte_length: 4,
      sha256: SHA256,
      recursive: true,
    });
    expect(fake.requests.map((request) => request.url)).toEqual([
      `https://rpc.filebase.io${FILEBASE_IPFS_ADD_PATH}`,
      `https://rpc.filebase.io${FILEBASE_IPFS_PIN_ADD_PATH}?arg=${encodeURIComponent(CID)}`,
      `https://rpc.filebase.io${FILEBASE_IPFS_PIN_LS_PATH}?arg=${encodeURIComponent(CID)}&type=recursive`,
      `https://rpc.filebase.io${FILEBASE_IPFS_CAT_PATH}?arg=${encodeURIComponent(CID)}`,
    ]);
    expect(fake.requests.every((request) => request.redirect === "error")).toBe(true);
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("requires recursive pin state after a duplicate or delayed pin", async () => {
    const fake = transportFor({ converge: false });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result.status).toBe("pinned");
    expect(
      fake.requests.filter((request) => request.path === FILEBASE_IPFS_PIN_LS_PATH),
    ).toHaveLength(3);
  });

  test("rejects invalid CID structures and wrong response content type", async () => {
    expect(isValidFilebaseCid(CID)).toBe(true);
    expect(isValidFilebaseCid("bafkrei-not-a-cid")).toBe(false);
    const fake = transportFor({ contentType: "text/html" });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result).toMatchObject({ status: "malformed" });
  });

  test("returns integrity mismatch without treating a CID as a raw SHA-256", async () => {
    const fake = transportFor({ catBytes: new Uint8Array([9, 9, 9, 9]) });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result).toEqual({
      status: "integrity_mismatch",
      outcome: "integrity_mismatch",
      reason: "sha256",
    });
  });

  test("maps cancellation and never exposes the token", async () => {
    const controller = new AbortController();
    const adapterInstance = adapter(
      async () => new Promise<FilebaseIpfsTransportResponse>(() => undefined),
    );
    const pending = Effect.runPromise(adapterInstance.pin(input({ signal: controller.signal })));
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ status: "cancelled", outcome: "cancelled" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
