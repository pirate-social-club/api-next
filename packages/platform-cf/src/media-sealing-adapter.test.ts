import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  inspectMediaUpload,
  type MediaSealBuckets,
  sealMediaUpload,
} from "./media-sealing-adapter.ts";

const originalDigestStream = Object.getOwnPropertyDescriptor(crypto, "DigestStream");
let failDigest = false;

class TestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  readonly #chunks: Uint8Array[] = [];
  #resolve!: (value: ArrayBuffer) => void;
  #reject!: (reason: unknown) => void;
  #bytesWritten = 0;

  constructor(_algorithm: string | SubtleCryptoHashAlgorithm) {
    let writeChunk: (chunk: ArrayBuffer | ArrayBufferView) => void = () => undefined;
    let closeStream: () => Promise<void> = async () => undefined;
    let abortStream: (reason: unknown) => void = () => undefined;
    super({
      write: (chunk) => writeChunk(chunk),
      close: () => closeStream(),
      abort: (reason) => abortStream(reason),
    });
    this.digest = new Promise<ArrayBuffer>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    writeChunk = (chunk) => {
      const bytes =
        chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.#bytesWritten += bytes.byteLength;
      this.#chunks.push(new Uint8Array(bytes));
    };
    closeStream = async () => {
      if (failDigest) {
        this.#reject(new Error("digest failed"));
        return;
      }
      const joined = new Uint8Array(this.#bytesWritten);
      let offset = 0;
      for (const chunk of this.#chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.#resolve(await crypto.subtle.digest("SHA-256", joined));
    };
    abortStream = (reason) => this.#reject(reason);
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }
}

beforeAll(() => {
  Object.defineProperty(crypto, "DigestStream", {
    configurable: true,
    value: TestDigestStream,
  });
});

afterAll(() => {
  if (originalDigestStream === undefined) {
    Reflect.deleteProperty(crypto, "DigestStream");
  } else {
    Object.defineProperty(crypto, "DigestStream", originalDigestStream);
  }
});

function checksum(bytes: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", bytes);
}

function object(input: {
  readonly key: string;
  readonly version: string;
  readonly etag: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly owner?: string;
  readonly sourceVersion?: string;
  readonly sha256?: ArrayBuffer;
}): R2Object {
  return {
    key: input.key,
    version: input.version,
    size: input.bytes.byteLength,
    etag: input.etag,
    httpEtag: `"${input.etag}"`,
    checksums: {
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      toJSON: () => ({}),
    },
    uploaded: new Date("2026-08-26T00:00:00.000Z"),
    httpMetadata: { contentType: input.contentType },
    customMetadata: {
      ...(input.owner === undefined ? {} : { "media-seal-owner": input.owner }),
      ...(input.sourceVersion === undefined
        ? {}
        : { "media-seal-source-version": input.sourceVersion }),
    },
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
  };
}

function body(base: R2Object, bytes: Uint8Array): R2ObjectBody {
  return {
    ...base,
    body: new Blob([bytes]).stream(),
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer),
    bytes: () => Promise.resolve(Uint8Array.from(bytes)),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    json: () => Promise.reject(new Error("not json")),
    blob: () => Promise.resolve(new Blob([bytes])),
    writeHttpMetadata: () => undefined,
  };
}

function sameTestBucket(
  bucket: MediaSealBuckets["ingress"] & MediaSealBuckets["immutableOriginals"],
): MediaSealBuckets {
  return { ingress: bucket, immutableOriginals: bucket };
}

describe("Workers R2 media sealing adapter", () => {
  test("inspects once, conditionally selects, hashes, writes absent-only, and verifies", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await checksum(bytes);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
      sha256,
    });
    const destinationObject = object({
      key: "immutable/media_operation/audio/1",
      version: "destination-version",
      etag: "destination-etag",
      bytes,
      contentType: "audio/mpeg",
      owner: "media_operation",
      sourceVersion: sourceObject.version,
      sha256,
    });
    const ingressCalls: string[] = [];
    const immutableCalls: string[] = [];
    const ingress = {
      head: async (key: string) => {
        ingressCalls.push(`head:${key}`);
        return key === sourceObject.key ? sourceObject : null;
      },
      get: async (
        _key: string,
        options: R2GetOptions & { readonly onlyIf: R2Conditional | Headers },
      ) => {
        ingressCalls.push(`get:${JSON.stringify(options.onlyIf)}`);
        return body(sourceObject, bytes);
      },
      put: async () => {
        throw new Error("ingress bucket must never receive immutable writes");
      },
    };
    const immutableOriginals = {
      head: async (key: string) => {
        immutableCalls.push(`head:${key}`);
        return key === destinationObject.key ? destinationObject : null;
      },
      get: async () => {
        throw new Error("immutable bucket must never supply ingress bytes");
      },
      put: async (
        _key: string,
        stream: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
        options: R2PutOptions & { readonly onlyIf: R2Conditional | Headers },
      ) => {
        immutableCalls.push(
          `put:${options.onlyIf instanceof Headers ? options.onlyIf.get("if-none-match") : ""}`,
        );
        if (!(stream instanceof ReadableStream)) throw new Error("expected a stream body");
        expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
        return destinationObject;
      },
    };

    const inspection = await inspectMediaUpload(ingress, {
      sourceKey: sourceObject.key,
      expectedSizeBytes: bytes.byteLength,
      expectedContentType: "audio/mpeg",
    });
    expect(inspection.outcome).toBe("ready");
    if (inspection.outcome !== "ready") throw new Error("inspection was not ready");
    const attempt = await sealMediaUpload(
      { ingress, immutableOriginals },
      {
        source: inspection.source,
        destinationKey: destinationObject.key,
        immutableRef: "media://immutable/media_operation/audio/1",
        expectedSizeBytes: bytes.byteLength,
        expectedContentType: "audio/mpeg",
        expectedSha256: Array.from(new Uint8Array(sha256), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join(""),
        ownershipMarker: "media_operation",
      },
    );

    expect(attempt.result).toMatchObject({
      outcome: "sealed",
      version: "destination-version",
      etag: "destination-etag",
      size_bytes: 4,
    });
    expect(ingressCalls).toEqual([`head:${sourceObject.key}`, 'get:{"etagMatches":"source-etag"}']);
    expect(immutableCalls).toEqual(["put:*", `head:${destinationObject.key}`]);
  });

  test("does not write after a source precondition failure", async () => {
    const bytes = new Uint8Array([1]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    let puts = 0;
    const attempt = await sealMediaUpload(
      sameTestBucket({
        head: async () => null,
        get: async () => sourceObject,
        put: async () => {
          puts += 1;
          return null;
        },
      }),
      {
        source: {
          key: sourceObject.key,
          version: sourceObject.version,
          etag: sourceObject.etag,
          size: sourceObject.size,
          contentType: "audio/mpeg",
          ownerMarker: null,
          sourceVersion: null,
          checksums: {},
        },
        destinationKey: "immutable/media_operation/audio/1",
        immutableRef: "media://immutable/media_operation/audio/1",
        expectedSizeBytes: 1,
        expectedContentType: "audio/mpeg",
        ownershipMarker: "media_operation",
      },
    );
    expect(attempt.result).toEqual({ outcome: "source_precondition_failed" });
    expect(puts).toBe(0);
  });

  test("converges an occupied destination owned by the same operation to sealed", async () => {
    const bytes = new Uint8Array([2, 3, 4]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    const siblingObject = object({
      key: "immutable/media_operation/audio/1",
      version: "sibling-version",
      etag: "sibling-etag",
      bytes,
      contentType: "audio/mpeg",
      owner: "media_operation",
      sourceVersion: sourceObject.version,
    });
    let putCalls = 0;
    const attempt = await sealMediaUpload(
      sameTestBucket({
        head: async () => siblingObject,
        get: async () => body(sourceObject, bytes),
        put: async () => {
          // A conditional miss need not consume this branch. The independent
          // digest branch must still establish the canonical hash.
          putCalls += 1;
          return null;
        },
      }),
      {
        source: {
          key: sourceObject.key,
          version: sourceObject.version,
          etag: sourceObject.etag,
          size: sourceObject.size,
          contentType: "audio/mpeg",
          ownerMarker: null,
          sourceVersion: null,
          checksums: {},
        },
        destinationKey: siblingObject.key,
        immutableRef: "media://immutable/media_operation/audio/1",
        expectedSizeBytes: bytes.byteLength,
        expectedContentType: "audio/mpeg",
        ownershipMarker: "media_operation",
      },
    );

    expect(putCalls).toBe(1);
    expect(attempt).toMatchObject({
      result: {
        outcome: "sealed",
        version: siblingObject.version,
        etag: siblingObject.etag,
        size_bytes: bytes.byteLength,
      },
    });
    expect(attempt.result).toHaveProperty(
      "canonical_sha256",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
  });

  test("keeps a genuinely foreign destination as a terminal conflict with exact evidence", async () => {
    const bytes = new Uint8Array([4]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    const foreignObject = object({
      key: "immutable/media_operation/audio/1",
      version: "foreign-version",
      etag: "foreign-etag",
      bytes,
      contentType: "audio/mpeg",
      owner: "different_operation",
      sourceVersion: sourceObject.version,
    });

    const attempt = await sealMediaUpload(
      sameTestBucket({
        head: async () => foreignObject,
        get: async () => body(sourceObject, bytes),
        put: async () => null,
      }),
      {
        source: {
          key: sourceObject.key,
          version: sourceObject.version,
          etag: sourceObject.etag,
          size: sourceObject.size,
          contentType: "audio/mpeg",
          ownerMarker: null,
          sourceVersion: null,
          checksums: {},
        },
        destinationKey: foreignObject.key,
        immutableRef: "media://immutable/media_operation/audio/1",
        expectedSizeBytes: 1,
        expectedContentType: "audio/mpeg",
        ownershipMarker: "media_operation",
      },
    );

    expect(attempt.result).toEqual({ outcome: "destination_conflict" });
    expect(attempt.retainedDestination).toMatchObject({
      key: foreignObject.key,
      version: foreignObject.version,
      etag: foreignObject.etag,
      ownerMarker: "different_operation",
    });
  });

  test("does not mutate product state when an own sibling cannot be verified", async () => {
    const bytes = new Uint8Array([5]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    failDigest = true;
    try {
      await expect(
        sealMediaUpload(
          sameTestBucket({
            head: async () =>
              object({
                key: "immutable/media_operation/audio/1",
                version: "sibling-version",
                etag: "sibling-etag",
                bytes,
                contentType: "audio/mpeg",
                owner: "media_operation",
                sourceVersion: sourceObject.version,
              }),
            get: async () => body(sourceObject, bytes),
            put: async () => null,
          }),
          {
            source: {
              key: sourceObject.key,
              version: sourceObject.version,
              etag: sourceObject.etag,
              size: sourceObject.size,
              contentType: "audio/mpeg",
              ownerMarker: null,
              sourceVersion: null,
              checksums: {},
            },
            destinationKey: "immutable/media_operation/audio/1",
            immutableRef: "media://immutable/media_operation/audio/1",
            expectedSizeBytes: 1,
            expectedContentType: "audio/mpeg",
            ownershipMarker: "media_operation",
          },
        ),
      ).rejects.toMatchObject({ code: "sibling_convergence_unavailable" });
    } finally {
      failDigest = false;
    }
  });

  test("retains the exact destination identity on author digest mismatch", async () => {
    const bytes = new Uint8Array([5, 6]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    const destinationObject = object({
      key: "immutable/media_operation/audio/1",
      version: "destination-version",
      etag: "destination-etag",
      bytes,
      contentType: "audio/mpeg",
      owner: "media_operation",
      sourceVersion: sourceObject.version,
    });
    const attempt = await sealMediaUpload(
      sameTestBucket({
        head: async () => destinationObject,
        get: async () => body(sourceObject, bytes),
        put: async () => destinationObject,
      }),
      {
        source: {
          key: sourceObject.key,
          version: sourceObject.version,
          etag: sourceObject.etag,
          size: sourceObject.size,
          contentType: "audio/mpeg",
          ownerMarker: null,
          sourceVersion: null,
          checksums: {},
        },
        destinationKey: destinationObject.key,
        immutableRef: "media://immutable/media_operation/audio/1",
        expectedSizeBytes: bytes.byteLength,
        expectedContentType: "audio/mpeg",
        expectedSha256: "0".repeat(64),
        ownershipMarker: "media_operation",
      },
    );
    expect(attempt.result).toEqual({ outcome: "expectation_mismatch" });
    expect(attempt.retainedDestination).toMatchObject({
      key: destinationObject.key,
      version: destinationObject.version,
      etag: destinationObject.etag,
      size: destinationObject.size,
    });
  });

  test("fails closed when destination PUT outcome is uncertain", async () => {
    const bytes = new Uint8Array([7]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    await expect(
      sealMediaUpload(
        sameTestBucket({
          head: async () => null,
          get: async () => body(sourceObject, bytes),
          put: async () => {
            throw new Error("uncertain");
          },
        }),
        {
          source: {
            key: sourceObject.key,
            version: sourceObject.version,
            etag: sourceObject.etag,
            size: sourceObject.size,
            contentType: "audio/mpeg",
            ownerMarker: null,
            sourceVersion: null,
            checksums: {},
          },
          destinationKey: "immutable/media_operation/audio/1",
          immutableRef: "media://immutable/media_operation/audio/1",
          expectedSizeBytes: 1,
          expectedContentType: "audio/mpeg",
          ownershipMarker: "media_operation",
        },
      ),
    ).rejects.toMatchObject({ code: "destination_put_uncertain" });
  });

  test("retains the written identity when the trusted digest fails", async () => {
    const bytes = new Uint8Array([8]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    const destinationObject = object({
      key: "immutable/media_operation/audio/1",
      version: "destination-version",
      etag: "destination-etag",
      bytes,
      contentType: "audio/mpeg",
      owner: "media_operation",
      sourceVersion: sourceObject.version,
    });
    failDigest = true;
    try {
      await expect(
        sealMediaUpload(
          sameTestBucket({
            head: async () => destinationObject,
            get: async () => body(sourceObject, bytes),
            put: async (_key, value) => {
              if (value instanceof ReadableStream) await new Response(value).arrayBuffer();
              return destinationObject;
            },
          }),
          {
            source: {
              key: sourceObject.key,
              version: sourceObject.version,
              etag: sourceObject.etag,
              size: sourceObject.size,
              contentType: "audio/mpeg",
              ownerMarker: null,
              sourceVersion: null,
              checksums: {},
            },
            destinationKey: destinationObject.key,
            immutableRef: "media://immutable/media_operation/audio/1",
            expectedSizeBytes: 1,
            expectedContentType: "audio/mpeg",
            ownershipMarker: "media_operation",
          },
        ),
      ).rejects.toMatchObject({
        code: "source_stream_failed",
        retainedDestination: {
          key: destinationObject.key,
          version: destinationObject.version,
          etag: destinationObject.etag,
        },
      });
    } finally {
      failDigest = false;
    }
  });

  test("fails closed when the verification HEAD does not match the written version", async () => {
    const bytes = new Uint8Array([9]);
    const sourceObject = object({
      key: "reservations/media_reservation/source",
      version: "source-version",
      etag: "source-etag",
      bytes,
      contentType: "audio/mpeg",
    });
    const written = object({
      key: "immutable/media_operation/audio/1",
      version: "destination-version",
      etag: "destination-etag",
      bytes,
      contentType: "audio/mpeg",
      owner: "media_operation",
      sourceVersion: sourceObject.version,
    });
    const replaced = object({
      key: written.key,
      version: "replacement-version",
      etag: "replacement-etag",
      bytes,
      contentType: "audio/mpeg",
      owner: "media_operation",
      sourceVersion: sourceObject.version,
    });

    await expect(
      sealMediaUpload(
        sameTestBucket({
          head: async () => replaced,
          get: async () => body(sourceObject, bytes),
          put: async () => written,
        }),
        {
          source: {
            key: sourceObject.key,
            version: sourceObject.version,
            etag: sourceObject.etag,
            size: sourceObject.size,
            contentType: "audio/mpeg",
            ownerMarker: null,
            sourceVersion: null,
            checksums: {},
          },
          destinationKey: written.key,
          immutableRef: "media://immutable/media_operation/audio/1",
          expectedSizeBytes: 1,
          expectedContentType: "audio/mpeg",
          ownershipMarker: "media_operation",
        },
      ),
    ).rejects.toMatchObject({
      code: "destination_verification_failed",
      retainedDestination: {
        key: written.key,
        version: written.version,
        etag: written.etag,
      },
    });
  });
});
