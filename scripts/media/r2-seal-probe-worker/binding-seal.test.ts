import { describe, expect, test } from "bun:test";

import {
  bytesToHex,
  cleanupExactObject,
  R2BindingSealFailure,
  type SealUploadInput,
  type StreamingDigest,
  sealR2Upload,
} from "./binding-seal";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SOURCE_KEY = "proof/source";
const DESTINATION_KEY = "proof/immutable";
const OWNER = "proof-owner";
const CONTENT_TYPE = "audio/mpeg";

interface StoredObject {
  key: string;
  version: string;
  etag: string;
  bytes: Uint8Array;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  checksums: R2Checksums;
}

function cloneBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function checksums(values: Partial<Record<"md5" | "sha256", ArrayBuffer>> = {}): R2Checksums {
  return {
    ...values,
    toJSON: () => ({
      ...(values.md5 === undefined ? {} : { md5: bytesToHex(values.md5) }),
      ...(values.sha256 === undefined ? {} : { sha256: bytesToHex(values.sha256) }),
    }),
  };
}

function objectMetadata(object: StoredObject): R2Object {
  return {
    key: object.key,
    version: object.version,
    size: object.bytes.byteLength,
    etag: object.etag,
    httpEtag: `"${object.etag}"`,
    checksums: object.checksums,
    uploaded: new Date("2026-08-25T00:00:00.000Z"),
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
    storageClass: "Standard",
    writeHttpMetadata: (headers) => {
      if (object.httpMetadata.contentType !== undefined) {
        headers.set("content-type", object.httpMetadata.contentType);
      }
    },
  };
}

function objectBody(object: StoredObject): R2ObjectBody {
  const bodyBytes = object.bytes.slice();
  const metadata = objectMetadata(object);
  return {
    ...metadata,
    writeHttpMetadata: (headers) => metadata.writeHttpMetadata(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    }),
    bodyUsed: false,
    arrayBuffer: async () => cloneBuffer(bodyBytes),
    bytes: async () => bodyBytes.slice(),
    text: async () => decoder.decode(bodyBytes),
    json: async <T>() => JSON.parse(decoder.decode(bodyBytes)) as T,
    blob: async () => new Blob([bodyBytes]),
  };
}

async function sha256(bytes: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", bytes);
}

function createTestDigest(fail = false): StreamingDigest {
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let resolveDigest: (value: ArrayBuffer) => void = () => undefined;
  const digest = new Promise<ArrayBuffer>((resolve) => {
    resolveDigest = resolve;
  });
  const writable = new WritableStream<ArrayBuffer | ArrayBufferView>({
    write(chunk) {
      if (fail) {
        throw new Error("fixture digest failure");
      }
      const view =
        chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const retained = view.slice();
      chunks.push(retained);
      byteCount += retained.byteLength;
    },
    async close() {
      const joined = new Uint8Array(byteCount);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolveDigest(await sha256(joined));
    },
  });
  return { writable, digest, bytesWritten: () => byteCount };
}

interface FakeOptions {
  overwriteSourceBeforeGet?: boolean;
  removeSourceBeforeGet?: boolean;
  throwOnPut?: boolean;
  mutateDestinationBeforeHead?: boolean;
  mutateDestinationBeforeCleanup?: boolean;
  throwOnDelete?: boolean;
  retainAfterDelete?: boolean;
  emptyDestinationVersion?: boolean;
  emptyDestinationEtag?: boolean;
}

class FakeBucket {
  readonly calls: string[] = [];
  source: StoredObject | null;
  destination: StoredObject | null;
  private destinationHeadCalls = 0;

  constructor(
    source: StoredObject | null,
    destination: StoredObject | null = null,
    private readonly options: FakeOptions = {},
  ) {
    this.source = source;
    this.destination = destination;
  }

  async head(key: string): Promise<R2Object | null> {
    this.calls.push(`head:${key}`);
    if (key === SOURCE_KEY) return this.source === null ? null : objectMetadata(this.source);
    if (key !== DESTINATION_KEY) return null;
    this.destinationHeadCalls += 1;
    if (
      this.destination !== null &&
      ((this.options.mutateDestinationBeforeHead === true && this.destinationHeadCalls === 1) ||
        (this.options.mutateDestinationBeforeCleanup === true && this.destinationHeadCalls === 1))
    ) {
      this.destination = replacementDestination(this.destination);
    }
    return this.destination === null ? null : objectMetadata(this.destination);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2Object | R2ObjectBody | null> {
    this.calls.push(`get:${key}`);
    if (key !== SOURCE_KEY || this.source === null) return null;
    if (this.options.removeSourceBeforeGet === true) {
      this.source = null;
      return null;
    }
    if (this.options.overwriteSourceBeforeGet === true) {
      this.source = {
        ...this.source,
        version: "source-version-2",
        etag: "source-etag-2",
        bytes: encoder.encode("replacement"),
      };
    }
    const condition = options?.onlyIf;
    const etagMatches =
      condition instanceof Headers ? condition.get("if-match") : condition?.etagMatches;
    if (etagMatches !== undefined && this.source.etag !== etagMatches) {
      return objectMetadata(this.source);
    }
    return objectBody(this.source);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    this.calls.push(`put:${key}`);
    if (key !== DESTINATION_KEY) throw new Error("unexpected destination key");
    if (this.options.throwOnPut === true) throw new Error("fixture put uncertainty");
    const condition = options?.onlyIf;
    const ifNoneMatch =
      condition instanceof Headers ? condition.get("if-none-match") : condition?.etagDoesNotMatch;
    if (ifNoneMatch === "*" && this.destination !== null) return null;
    const bytes =
      value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : typeof value === "string"
          ? encoder.encode(value)
          : value instanceof Blob
            ? new Uint8Array(await value.arrayBuffer())
            : value === null
              ? new Uint8Array()
              : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer);
    const headerContentType =
      options?.httpMetadata instanceof Headers
        ? options.httpMetadata.get("content-type")
        : undefined;
    const destination: StoredObject = {
      key,
      version: this.options.emptyDestinationVersion === true ? "" : "destination-version-1",
      etag: this.options.emptyDestinationEtag === true ? "" : "destination-etag-1",
      bytes,
      httpMetadata:
        options?.httpMetadata instanceof Headers
          ? headerContentType === null || headerContentType === undefined
            ? {}
            : { contentType: headerContentType }
          : (options?.httpMetadata ?? {}),
      customMetadata: options?.customMetadata ?? {},
      checksums: checksums(
        options?.sha256 === undefined ? {} : { sha256: toArrayBuffer(options.sha256) },
      ),
    };
    this.destination = destination;
    return objectMetadata(destination);
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    if (this.options.throwOnDelete === true) throw new Error("fixture delete failure");
    if (key === DESTINATION_KEY && this.options.retainAfterDelete !== true) this.destination = null;
  }
}

function toArrayBuffer(value: ArrayBuffer | ArrayBufferView | string): ArrayBuffer {
  if (typeof value === "string") return cloneBuffer(encoder.encode(value));
  if (value instanceof ArrayBuffer) return value.slice(0);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function replacementDestination(original: StoredObject): StoredObject {
  return {
    ...original,
    version: "foreign-version",
    etag: "foreign-etag",
    bytes: encoder.encode("foreign bytes"),
  };
}

async function sourceObject(checksumOverride?: ArrayBuffer): Promise<StoredObject> {
  const bytes = encoder.encode("trusted proof audio");
  return {
    key: SOURCE_KEY,
    version: "source-version-1",
    etag: "source-etag-1",
    bytes,
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { "media-seal-owner": OWNER },
    checksums: checksums({ sha256: checksumOverride ?? (await sha256(bytes)) }),
  };
}

async function input(overrides: Partial<SealUploadInput> = {}): Promise<SealUploadInput> {
  const source = await sourceObject();
  return {
    sourceKey: SOURCE_KEY,
    destinationKey: DESTINATION_KEY,
    immutableRef: "proof:immutable-audio",
    expectedSizeBytes: source.bytes.byteLength,
    expectedContentType: CONTENT_TYPE,
    ownershipMarker: OWNER,
    ...overrides,
  };
}

const dependencies = { createDigest: () => createTestDigest() };

describe("Workers-binding R2 seal", () => {
  test("streams one selected body into an absent destination and returns the trusted digest", async () => {
    const source = await sourceObject();
    const bucket = new FakeBucket(source);
    const attempt = await sealR2Upload(bucket, await input(), dependencies);

    expect(attempt.result).toEqual({
      outcome: "sealed",
      immutable_ref: "proof:immutable-audio",
      etag: "destination-etag-1",
      version: "destination-version-1",
      size_bytes: source.bytes.byteLength,
      canonical_sha256: bytesToHex(await sha256(source.bytes)),
    });
    expect(attempt.destinationIdentity?.checksums.sha256).toEqual(source.checksums.sha256);
    expect(bucket.calls).toEqual([
      `head:${SOURCE_KEY}`,
      `get:${SOURCE_KEY}`,
      `put:${DESTINATION_KEY}`,
      `head:${DESTINATION_KEY}`,
    ]);
  });

  test("keeps a missing source retryable without writing a destination", async () => {
    const bucket = new FakeBucket(null);
    const attempt = await sealR2Upload(bucket, await input(), dependencies);
    expect(attempt.result).toEqual({ outcome: "source_missing" });
    expect(bucket.calls).toEqual([`head:${SOURCE_KEY}`]);
  });

  test("rejects declared size, media type, or ownership mismatch before reading", async () => {
    const source = await sourceObject();
    for (const changed of [
      { expectedSizeBytes: source.bytes.byteLength + 1 },
      { expectedContentType: "audio/wav" },
      { ownershipMarker: "foreign-owner" },
    ]) {
      const bucket = new FakeBucket(source);
      const attempt = await sealR2Upload(bucket, await input(changed), dependencies);
      expect(attempt.result).toEqual({ outcome: "expectation_mismatch" });
      expect(bucket.calls).toEqual([`head:${SOURCE_KEY}`]);
    }
  });

  test("distinguishes a failed source condition from a destination conflict", async () => {
    const source = await sourceObject();
    const changed = new FakeBucket(source, null, { overwriteSourceBeforeGet: true });
    const precondition = await sealR2Upload(changed, await input(), dependencies);
    expect(precondition.result).toEqual({ outcome: "source_precondition_failed" });
    expect(changed.calls).not.toContain(`put:${DESTINATION_KEY}`);

    const existing = replacementDestination({
      ...(await sourceObject()),
      key: DESTINATION_KEY,
    });
    const conflicted = new FakeBucket(source, existing);
    const conflict = await sealR2Upload(conflicted, await input(), dependencies);
    expect(conflict.result).toEqual({ outcome: "destination_conflict" });
    expect(conflicted.destination).toEqual(existing);
  });

  test("maps deletion between head and conditional get to source missing", async () => {
    const bucket = new FakeBucket(await sourceObject(), null, { removeSourceBeforeGet: true });
    const attempt = await sealR2Upload(bucket, await input(), dependencies);
    expect(attempt.result).toEqual({ outcome: "source_missing" });
    expect(bucket.calls).not.toContain(`put:${DESTINATION_KEY}`);
  });

  test("compares the author expectation only after trusted streaming and removes the exact write", async () => {
    const bucket = new FakeBucket(await sourceObject());
    const attempt = await sealR2Upload(
      bucket,
      await input({ expectedSha256: "f".repeat(64) }),
      dependencies,
    );
    expect(attempt.result).toEqual({ outcome: "expectation_mismatch" });
    expect(attempt.cleanup).toEqual({
      outcome: "deleted",
      identity_verified_before_delete: true,
      delete_condition: "unavailable",
    });
    expect(bucket.destination).toBeNull();
    expect(bucket.calls).toContain(`put:${DESTINATION_KEY}`);
  });

  test("retains cleanup uncertainty when the just-written identity no longer matches", async () => {
    const bucket = new FakeBucket(await sourceObject(), null, {
      mutateDestinationBeforeCleanup: true,
    });
    const attempt = await sealR2Upload(
      bucket,
      await input({ expectedSha256: "f".repeat(64) }),
      dependencies,
    );
    expect(attempt.result).toEqual({ outcome: "expectation_mismatch" });
    expect(attempt.cleanup).toEqual({ outcome: "retained_identity_mismatch" });
    expect(bucket.calls).not.toContain(`delete:${DESTINATION_KEY}`);
  });

  test("closes digest failure and cleans only the exact returned object", async () => {
    const bucket = new FakeBucket(await sourceObject());
    const run = sealR2Upload(bucket, await input(), {
      createDigest: () => createTestDigest(true),
    });
    await expect(run).rejects.toMatchObject({
      code: "source_stream_failed",
      cleanup: {
        outcome: "deleted",
        identity_verified_before_delete: true,
        delete_condition: "unavailable",
      },
    });
    expect(bucket.destination).toBeNull();
  });

  test("closes verification mismatch and never projects sealed", async () => {
    const bucket = new FakeBucket(await sourceObject(), null, {
      mutateDestinationBeforeHead: true,
    });
    await expect(sealR2Upload(bucket, await input(), dependencies)).rejects.toMatchObject({
      code: "destination_verification_failed",
      cleanup: { outcome: "retained_identity_mismatch" },
    });
  });

  test("requires non-empty destination version and ETag before projecting sealed", async () => {
    for (const options of [{ emptyDestinationVersion: true }, { emptyDestinationEtag: true }]) {
      const bucket = new FakeBucket(await sourceObject(), null, options);
      await expect(sealR2Upload(bucket, await input(), dependencies)).rejects.toMatchObject({
        code: "destination_verification_failed",
        cleanup: {
          outcome: "deleted",
          identity_verified_before_delete: true,
          delete_condition: "unavailable",
        },
      });
    }
  });

  test("treats a thrown put as uncertain and does not guess an object identity", async () => {
    const bucket = new FakeBucket(await sourceObject(), null, { throwOnPut: true });
    await expect(sealR2Upload(bucket, await input(), dependencies)).rejects.toMatchObject({
      name: R2BindingSealFailure.name,
      code: "destination_put_uncertain",
      cleanup: { outcome: "not_required" },
    });
    expect(bucket.calls).not.toContain(`delete:${DESTINATION_KEY}`);
  });

  test("refuses cleanup when the retained object differs from the exact returned identity", async () => {
    const source = await sourceObject();
    const bucket = new FakeBucket(source);
    const attempt = await sealR2Upload(bucket, await input(), dependencies);
    if (attempt.destinationIdentity === undefined) throw new Error("destination identity missing");
    if (bucket.destination === null) throw new Error("destination object missing");
    bucket.destination = replacementDestination(bucket.destination);
    expect(await cleanupExactObject(bucket, attempt.destinationIdentity)).toEqual({
      outcome: "retained_identity_mismatch",
    });
    expect(bucket.calls).not.toContain(`delete:${DESTINATION_KEY}`);
  });

  test("treats a stored source checksum disagreement as closed verification evidence", async () => {
    const wrongChecksum = new Uint8Array(32).fill(0xff).buffer;
    const bucket = new FakeBucket(await sourceObject(wrongChecksum));
    await expect(sealR2Upload(bucket, await input(), dependencies)).rejects.toMatchObject({
      code: "destination_verification_failed",
      cleanup: {
        outcome: "deleted",
        identity_verified_before_delete: true,
        delete_condition: "unavailable",
      },
    });
  });
});
