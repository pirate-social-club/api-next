import { describe, expect, test } from "bun:test";
import type { IpfsPinningInput, IpfsPinningLimits } from "@pirate/application/data/ipfs-pinning";
import { Effect } from "effect";
import {
  FILEBASE_IPFS_ADD_PATH,
  FILEBASE_IPFS_ADD_QUERY,
  FILEBASE_IPFS_CAT_PATH,
  FILEBASE_IPFS_MULTIPART_BOUNDARY_PREFIX,
  FILEBASE_IPFS_PIN_ADD_PATH,
  FILEBASE_IPFS_PIN_LS_PATH,
  type FilebaseIpfsTransport,
  type FilebaseIpfsTransportRequest,
  type FilebaseIpfsTransportResponse,
  isValidFilebaseCid,
  makeFilebaseIpfsPinningAdapter,
} from "./filebase-ipfs-pinning.ts";

const hostileFixtures = (await Bun.file(
  new URL("../../../../tests/fixtures/data-ipfs/filebase/hostile-fixtures.json", import.meta.url),
).json()) as {
  readonly content: Readonly<{
    readonly bytes_hex: string;
    readonly length: number;
    readonly sha256: string;
    readonly cid_v1: string;
  }>;
  readonly multipart: Readonly<{
    readonly boundary_prefix: string;
    readonly random_bytes_hex: string;
    readonly injection_filename: string;
    readonly boundary_collision_payload: string;
  }>;
  readonly responses: Readonly<{
    readonly wrong_content_type: string;
    readonly ndjson: string;
    readonly oversized: Readonly<{ readonly character: string; readonly length: number }>;
    readonly pin_ls_empty: unknown;
    readonly pin_ls_recursive: unknown;
    readonly pin_ls_direct: unknown;
  }>;
  readonly secret: string;
};

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu)?.map((part) => Number.parseInt(part, 16)) ?? []);
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const CID = hostileFixtures.content.cid_v1;
const BYTES = hexBytes(hostileFixtures.content.bytes_hex);
const SHA256 = hostileFixtures.content.sha256;
const TOKEN = hostileFixtures.secret;
const RANDOM_BYTES = hexBytes(hostileFixtures.multipart.random_bytes_hex);
const limits: IpfsPinningLimits = {
  max_source_bytes: 1024,
  max_response_bytes: 1024,
  timeout_ms: 100,
  pin_convergence_attempts: 3,
  pin_convergence_delay_ms: 0,
};

function body(bytes: Uint8Array, onCancel: () => void | PromiseLike<void> = () => undefined) {
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

function raw(
  value: string,
  status = 200,
  contentType = "application/json",
): FilebaseIpfsTransportResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: body(new TextEncoder().encode(value)),
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
    readonly catOnCancel?: () => void;
    readonly duplicate?: boolean;
    readonly addSize?: string;
    readonly statuses?: Partial<Record<FilebaseIpfsTransportRequest["path"], number>>;
    readonly onRequest?: (request: FilebaseIpfsTransportRequest) => void;
  } = {},
) {
  const requests: FilebaseIpfsTransportRequest[] = [];
  let lsCalls = 0;
  const transport = async (
    request: FilebaseIpfsTransportRequest,
  ): Promise<FilebaseIpfsTransportResponse> => {
    requests.push(request);
    options.onRequest?.(request);
    const forcedStatus = options.statuses?.[request.path];
    if (forcedStatus !== undefined) return json({}, forcedStatus);
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
      const boundary = request.body.content_type.split("boundary=", 2)[1] ?? "";
      expect(boundary.startsWith(hostileFixtures.multipart.boundary_prefix)).toBe(true);
      expect(hostileFixtures.multipart.boundary_prefix).toBe(
        FILEBASE_IPFS_MULTIPART_BOUNDARY_PREFIX,
      );
      expect(text).toContain(`--${boundary}`);
      expect(text).toContain('filename="sample.bin"');
      expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
      return json(
        {
          Bytes: "4",
          Hash: CID,
          Mode: "0644",
          Mtime: "0",
          MtimeNsecs: "0",
          Name: "sample.bin",
          Size: options.addSize ?? "4",
        },
        200,
        options.contentType ?? "application/json",
      );
    }
    if (request.path === FILEBASE_IPFS_PIN_ADD_PATH) {
      return options.duplicate ? json({}, 409) : json({ Pins: [CID] });
    }
    if (request.path === FILEBASE_IPFS_PIN_LS_PATH) {
      lsCalls += 1;
      return json(
        options.converge === false && lsCalls < 3
          ? hostileFixtures.responses.pin_ls_empty
          : hostileFixtures.responses.pin_ls_recursive,
      );
    }
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: body(options.catBytes ?? BYTES, options.catOnCancel),
    };
  };
  return { requests, transport };
}

function adapter(
  transport: FilebaseIpfsTransport,
  limitOverrides: Partial<IpfsPinningLimits> = {},
) {
  return makeFilebaseIpfsPinningAdapter({
    enabled: true,
    token: TOKEN,
    transport,
    limits: { ...limits, ...limitOverrides },
    random_bytes: () => new Uint8Array(RANDOM_BYTES),
  });
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
      `https://rpc.filebase.io${FILEBASE_IPFS_ADD_PATH}${FILEBASE_IPFS_ADD_QUERY}`,
      `https://rpc.filebase.io${FILEBASE_IPFS_PIN_ADD_PATH}?arg=${encodeURIComponent(CID)}`,
      `https://rpc.filebase.io${FILEBASE_IPFS_PIN_LS_PATH}?arg=${encodeURIComponent(CID)}&stream=false&names=false`,
      `https://rpc.filebase.io${FILEBASE_IPFS_CAT_PATH}?arg=${encodeURIComponent(CID)}`,
    ]);
    expect(fake.requests[1]?.body.byte_length).toBe(0);
    expect(fake.requests[1]?.body.content_type).not.toBe("application/json");
    expect(fake.requests[3]?.body.byte_length).toBe(0);
    expect(fake.requests[3]?.body.content_type).toBe("application/octet-stream");
    expect(fake.requests.every((request) => request.redirect === "error")).toBe(true);
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("rejects a true multipart boundary collision before pinning", async () => {
    const collisionBytes = new TextEncoder().encode(
      hostileFixtures.multipart.boundary_collision_payload,
    );
    const collisionInput = input({
      source: {
        byte_length: collisionBytes.byteLength,
        open: async function* () {
          const splitAt = hostileFixtures.multipart.boundary_collision_payload.indexOf("--") + 3;
          yield collisionBytes.slice(0, splitAt);
          yield collisionBytes.slice(splitAt);
        },
      },
      expected_byte_length: collisionBytes.byteLength,
      expected_sha256: await digestHex(collisionBytes),
    });
    const result = await Effect.runPromise(adapter(transportFor().transport).pin(collisionInput));
    expect(result).toEqual({
      status: "integrity_mismatch",
      outcome: "integrity_mismatch",
      reason: "length",
    });
  });

  test("rejects filename header injection before opening the transport", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      adapter(async () => {
        calls += 1;
        return json({});
      }).pin(input({ filename: hostileFixtures.multipart.injection_filename })),
    ).catch((error) => error);
    expect(result).toMatchObject({ reason: "invalid_filename" });
    expect(calls).toBe(0);
  });

  test("requires recursive pin state after a duplicate or delayed pin", async () => {
    const fake = transportFor({ converge: false });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result.status).toBe("pinned");
    expect(
      fake.requests.filter((request) => request.path === FILEBASE_IPFS_PIN_LS_PATH),
    ).toHaveLength(3);
  });

  test("waits between non-converged pin-list attempts", async () => {
    const lsTimes: number[] = [];
    const fake = transportFor({
      converge: false,
      onRequest: (request) => {
        if (request.path === FILEBASE_IPFS_PIN_LS_PATH) lsTimes.push(performance.now());
      },
    });
    const result = await Effect.runPromise(
      adapter(fake.transport, { pin_convergence_delay_ms: 10 }).pin(input()),
    );
    expect(result.status).toBe("pinned");
    expect(lsTimes).toHaveLength(3);
    const first = lsTimes[0] ?? 0;
    const second = lsTimes[1] ?? 0;
    const third = lsTimes[2] ?? 0;
    expect(second - first).toBeGreaterThanOrEqual(8);
    expect(third - second).toBeGreaterThanOrEqual(8);
  });

  test("does not converge a direct pin as recursive", async () => {
    const base = transportFor();
    const result = await Effect.runPromise(
      adapter(async (request) => {
        const response = await base.transport(request);
        return request.path === FILEBASE_IPFS_PIN_LS_PATH
          ? json(hostileFixtures.responses.pin_ls_direct)
          : response;
      }).pin(input()),
    );
    expect(result).toEqual({
      status: "retryable",
      outcome: "retryable",
      reason: "pin_not_converged",
    });
  });

  test("treats a duplicate pin as success only after canonical recursive pin/ls", async () => {
    const fake = transportFor({ duplicate: true });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result.status).toBe("pinned");
    expect(fake.requests.some((request) => request.path === FILEBASE_IPFS_PIN_LS_PATH)).toBe(true);
  });

  test("accepts bounded documented /pin/add evidence and rejects unbounded evidence", async () => {
    const base = transportFor();
    const accepted = await Effect.runPromise(
      adapter(async (request) => {
        const response = await base.transport(request);
        return request.path === FILEBASE_IPFS_PIN_ADD_PATH
          ? json({ Bytes: "4", Pins: [CID], Progress: "1" })
          : response;
      }).pin(input()),
    );
    expect(accepted.status).toBe("pinned");

    const rejectedBase = transportFor();
    const rejected = await Effect.runPromise(
      adapter(async (request) => {
        const response = await rejectedBase.transport(request);
        return request.path === FILEBASE_IPFS_PIN_ADD_PATH
          ? json({ Bytes: "999999999999999999999999999", Pins: [CID] })
          : response;
      }).pin(input()),
    );
    expect(rejected).toMatchObject({ status: "malformed", reason: "malformed_response" });
  });

  test("rejects invalid CID structures and wrong response content type", async () => {
    expect(isValidFilebaseCid(CID)).toBe(true);
    expect(isValidFilebaseCid("QmNLfbof5rLekrACjeuLk9JmGZD2HDBHCU4z16iYKmx5SE")).toBe(true);
    expect(isValidFilebaseCid("bafkrei-not-a-cid")).toBe(false);
    expect(isValidFilebaseCid(CID.toUpperCase())).toBe(false);
    expect(isValidFilebaseCid(`${CID.slice(0, -1)}z`)).toBe(false);
    const fake = transportFor({ contentType: hostileFixtures.responses.wrong_content_type });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result).toMatchObject({ status: "malformed" });
  });

  test("maps throttled, unauthorized, unavailable, and not-found statuses", async () => {
    const throttled = await Effect.runPromise(
      adapter(transportFor({ statuses: { [FILEBASE_IPFS_ADD_PATH]: 429 } }).transport).pin(input()),
    );
    expect(throttled).toMatchObject({ status: "retryable", reason: "throttled" });

    const unauthorized = await Effect.runPromise(
      adapter(transportFor({ statuses: { [FILEBASE_IPFS_ADD_PATH]: 401 } }).transport).pin(input()),
    );
    expect(unauthorized).toMatchObject({ status: "permanent", reason: "unauthorized" });

    const unavailable = await Effect.runPromise(
      adapter(transportFor({ statuses: { [FILEBASE_IPFS_PIN_LS_PATH]: 503 } }).transport).pin(
        input(),
      ),
    );
    expect(unavailable).toMatchObject({ status: "retryable", reason: "provider_unavailable" });

    const notFound = await Effect.runPromise(
      adapter(transportFor({ statuses: { [FILEBASE_IPFS_CAT_PATH]: 404 } }).transport).pin(input()),
    );
    expect(notFound).toEqual({ status: "not_found", outcome: "not_found" });

    const rejected = await Effect.runPromise(
      adapter(transportFor({ statuses: { [FILEBASE_IPFS_ADD_PATH]: 400 } }).transport).pin(input()),
    );
    expect(rejected).toMatchObject({ status: "permanent", reason: "provider_rejected" });

    const transportFailure = await Effect.runPromise(
      adapter(async () => {
        throw new Error(`provider leaked ${TOKEN}`);
      }).pin(input()),
    );
    expect(transportFailure).toEqual({
      status: "retryable",
      outcome: "retryable",
      reason: "transport",
    });
    expect(JSON.stringify(transportFailure)).not.toContain(TOKEN);
  });

  test("returns integrity mismatch without treating a CID as a raw SHA-256", async () => {
    let cancelled = false;
    const fake = transportFor({
      catBytes: new Uint8Array([9, 9, 9, 9]),
      catOnCancel: () => {
        cancelled = true;
      },
    });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result).toEqual({
      status: "integrity_mismatch",
      outcome: "integrity_mismatch",
      reason: "sha256",
    });
    expect(cancelled).toBe(true);
  });

  test("disposes /cat on a short read and an invalid streamed chunk", async () => {
    let shortCancelled = false;
    const short = transportFor({
      catBytes: new Uint8Array([1, 2]),
      catOnCancel: () => {
        shortCancelled = true;
      },
    });
    const shortResult = await Effect.runPromise(adapter(short.transport).pin(input()));
    expect(shortResult).toMatchObject({ status: "integrity_mismatch", reason: "length" });
    expect(shortCancelled).toBe(true);

    let invalidCancelled = false;
    const invalid = transportFor();
    const invalidResult = await Effect.runPromise(
      adapter(async (request) => {
        const response = await invalid.transport(request);
        if (request.path !== FILEBASE_IPFS_CAT_PATH) return response;
        return {
          status: response.status,
          headers: response.headers,
          body: {
            open: async function* () {
              yield "not-bytes" as unknown as Uint8Array;
            },
            cancel: () => {
              invalidCancelled = true;
            },
          },
        };
      }).pin(input()),
    );
    expect(invalidResult).toMatchObject({ status: "malformed" });
    expect(invalidCancelled).toBe(true);
  });

  test("disposes /cat on overflow and does not await a hostile cancel", async () => {
    let overflowCancelled = false;
    const overflow = transportFor({
      catBytes: new Uint8Array([1, 2, 3, 4, 5]),
      catOnCancel: () => {
        overflowCancelled = true;
      },
    });
    const overflowResult = await Effect.runPromise(adapter(overflow.transport).pin(input()));
    expect(overflowResult).toMatchObject({ status: "integrity_mismatch", reason: "length" });
    expect(overflowCancelled).toBe(true);

    let neverSettlingCancelled = false;
    const hostile = transportFor({
      catBytes: new Uint8Array([9, 9, 9, 9]),
      catOnCancel: () => {
        neverSettlingCancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const bounded = await Promise.race([
      Effect.runPromise(adapter(hostile.transport).pin(input())),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("cancel cleanup blocked operation")), 250);
      }),
    ]);
    expect(bounded).toMatchObject({ status: "integrity_mismatch", reason: "sha256" });
    expect(neverSettlingCancelled).toBe(true);
  });

  test("disposes a one-pass source iterator when multipart streaming fails", async () => {
    let disposed = false;
    const source = {
      byte_length: BYTES.byteLength,
      open: async function* () {
        try {
          yield "not-bytes" as unknown as Uint8Array;
        } finally {
          disposed = true;
        }
      },
    };
    const result = await Effect.runPromise(
      adapter(transportFor().transport).pin(input({ source })),
    );
    expect(result).toMatchObject({ status: "integrity_mismatch", reason: "length" });
    expect(disposed).toBe(true);
  });

  test("uses streamed /cat length and digest as authority, not /add Size", async () => {
    const fake = transportFor({ addSize: "999999" });
    const result = await Effect.runPromise(adapter(fake.transport).pin(input()));
    expect(result.status).toBe("pinned");
  });

  test("rejects non-canonical PinLsList shapes and malformed NDJSON", async () => {
    const malformedPinLs = transportFor();
    const result = await Effect.runPromise(
      adapter(async (request) => {
        const response = await malformedPinLs.transport(request);
        if (request.path === FILEBASE_IPFS_PIN_LS_PATH) {
          const recursive = hostileFixtures.responses.pin_ls_recursive as {
            readonly Keys: Readonly<Record<string, unknown>>;
          };
          return json({ PinLsList: { Keys: recursive.Keys } });
        }
        return response;
      }).pin(input()),
    );
    expect(result).toMatchObject({ status: "malformed" });

    const ndjsonResult = await Effect.runPromise(
      adapter(async (request) => {
        const response = await transportFor().transport(request);
        if (request.path === FILEBASE_IPFS_ADD_PATH) {
          return raw(hostileFixtures.responses.ndjson);
        }
        return response;
      }).pin(input()),
    );
    expect(ndjsonResult).toMatchObject({ status: "malformed" });
  });

  test("bounds oversized JSON and disposes a late response after timeout", async () => {
    const oversized = await Effect.runPromise(
      adapter(async (request) => {
        if (request.path === FILEBASE_IPFS_ADD_PATH) {
          return raw(
            hostileFixtures.responses.oversized.character.repeat(
              hostileFixtures.responses.oversized.length,
            ),
          );
        }
        return transportFor().transport(request);
      }).pin(input()),
    );
    expect(oversized).toMatchObject({ status: "malformed", reason: "oversized_response" });

    let lateCancelled = false;
    const timeoutAdapter = makeFilebaseIpfsPinningAdapter({
      enabled: true,
      token: TOKEN,
      limits: { ...limits, timeout_ms: 5 },
      random_bytes: () => new Uint8Array(RANDOM_BYTES),
      transport: async () =>
        new Promise<FilebaseIpfsTransportResponse>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ...json({ Hash: CID, Name: "sample.bin", Size: "4" }, 200),
                body: body(
                  new TextEncoder().encode(
                    JSON.stringify({ Hash: CID, Name: "sample.bin", Size: "4" }),
                  ),
                  () => {
                    lateCancelled = true;
                  },
                ),
              }),
            30,
          );
        }),
    });
    const timeoutResult = await Effect.runPromise(timeoutAdapter.pin(input()));
    expect(timeoutResult).toEqual({ status: "timeout", outcome: "retryable", reason: "timeout" });
    // The transport response arrives after the operation has already closed.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lateCancelled).toBe(true);
  });

  test("snapshots input and limits, and uses a fresh random boundary per operation", async () => {
    const fake = transportFor();
    const mutable = input() as unknown as { expected_sha256: string };
    const operation = adapter(fake.transport).pin(mutable as IpfsPinningInput);
    mutable.expected_sha256 = "0".repeat(64);
    const result = await Effect.runPromise(operation);
    expect(result.status).toBe("pinned");

    const boundaries: string[] = [];
    const boundaryAdapter = makeFilebaseIpfsPinningAdapter({
      enabled: true,
      token: TOKEN,
      transport: async (request) => {
        boundaries.push(request.body.content_type);
        return transportFor().transport(request);
      },
      limits: { ...limits },
      random_bytes: (() => {
        let value = 0;
        return (length: number) => new Uint8Array(length).fill(++value);
      })(),
    });
    await Effect.runPromise(boundaryAdapter.pin(input()));
    await Effect.runPromise(boundaryAdapter.pin(input()));
    expect(boundaries[0]).not.toBe(boundaries[4]);
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
