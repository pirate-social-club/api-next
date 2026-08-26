import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MediaProcessingProviders } from "@pirate/application/media/processing-contracts";
import type { MediaTransformSampleArtifact } from "@pirate/application/media/transform";
import {
  MediaProcessingArtifactFailure,
  MediaProcessingTransportFailure,
  makeAcrCloudFetchTransport,
  makeElevenLabsAlignmentFetchTransport,
  makeElevenLabsProcessingAlignmentPort,
  makeMediaProcessingRuntime,
  makeR2EmbeddedMetadataPort,
  makeR2MediaProcessingArtifactReader,
  makeTransloaditFetchTransport,
} from "./media-processing-runtime.ts";
import type { ElevenLabsAlignmentInput } from "./media-providers/elevenlabs-alignment-types.ts";

const originalDigestStream = Object.getOwnPropertyDescriptor(globalThis, "DigestStream");

class TestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  readonly #chunks: Uint8Array[] = [];
  #resolve!: (value: ArrayBuffer) => void;
  #bytesWritten = 0;

  constructor(_algorithm: string | SubtleCryptoHashAlgorithm) {
    let writeChunk: (chunk: ArrayBuffer | ArrayBufferView) => void = () => undefined;
    let closeStream: () => Promise<void> = async () => undefined;
    super({ write: (chunk) => writeChunk(chunk), close: () => closeStream() });
    this.digest = new Promise<ArrayBuffer>((resolve) => {
      this.#resolve = resolve;
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
      const bytes = new Uint8Array(this.#bytesWritten);
      let offset = 0;
      for (const chunk of this.#chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.#resolve(await crypto.subtle.digest("SHA-256", bytes));
    };
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, "DigestStream", {
    configurable: true,
    value: TestDigestStream,
  });
});

afterAll(() => {
  if (originalDigestStream === undefined) Reflect.deleteProperty(globalThis, "DigestStream");
  else Object.defineProperty(globalThis, "DigestStream", originalDigestStream);
});

function r2Object(key: string, bytes: Uint8Array, contentType: string): R2Object {
  return {
    key,
    version: "object-version",
    size: bytes.byteLength,
    etag: "object-etag",
    httpEtag: '"object-etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-08-26T00:00:00.000Z"),
    httpMetadata: { contentType },
    customMetadata: {},
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
  };
}

function r2Body(object: R2Object, bytes: Uint8Array): R2ObjectBody {
  return {
    ...object,
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

function r2Bucket(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  calls: string[] = [],
): R2Bucket {
  const object = r2Object(key, bytes, contentType);
  return {
    head: async (requested: string) => {
      calls.push(`head:${requested}`);
      return requested === key ? object : null;
    },
    get: async (requested: string, options?: R2GetOptions) => {
      calls.push(`get:${requested}`);
      if (requested !== key) return null;
      const range = options?.range;
      const selected =
        range !== undefined && !(range instanceof Headers) && "offset" in range
          ? bytes.subarray(range.offset, range.offset + (range.length ?? bytes.byteLength))
          : bytes;
      return r2Body(object, selected);
    },
  } as unknown as R2Bucket;
}

function uint32(value: number): readonly number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function synchsafe(value: number): readonly number[] {
  return [(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f];
}

function id3(frames: readonly Readonly<{ id: string; body: Uint8Array }>[]): Uint8Array {
  const encodedFrames = frames.map(({ id, body }) =>
    Uint8Array.from([...new TextEncoder().encode(id), ...uint32(body.byteLength), 0, 0, ...body]),
  );
  const tagLength = encodedFrames.reduce((total, frame) => total + frame.byteLength, 0);
  const output = new Uint8Array(10 + tagLength + 3);
  output.set([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(tagLength)], 0);
  let offset = 10;
  for (const frame of encodedFrames) {
    output.set(frame, offset);
    offset += frame.byteLength;
  }
  output.set([0xff, 0xfb, 0x90], offset);
  return output;
}

const authority = (sizeBytes: number) => ({
  communityId: "community",
  actorAccountId: "account",
  authorPersonaId: "persona",
  submissionId: "submission",
  operationId: "operation",
  songType: "original" as const,
  creationRevision: 2,
  audioRevision: 1,
  analysisRevision: 1,
  decisionRevision: 0,
  workflowRevision: 1,
  retryCount: 0,
  status: "processing" as const,
  phase: "analysis" as const,
  audio: {
    immutableRef: "media://immutable/operation/audio/1",
    canonicalSha256: "0".repeat(64),
    contentType: "audio/mpeg",
    sizeBytes,
  },
  termsRevision: null,
  lyrics: null,
  analysis: null,
  decision: null,
  boundReferenceAssetId: null,
  postId: null,
  publishedLyricsRevision: null,
});

describe("media processor runtime boundary", () => {
  test("keeps disabled composition inert without reading providers", () => {
    let providerReads = 0;
    const options = { enabled: false } as { enabled: false; providers?: MediaProcessingProviders };
    Object.defineProperty(options, "providers", {
      get() {
        providerReads += 1;
        throw new Error("provider configuration must remain unread");
      },
    });
    expect(makeMediaProcessingRuntime(options)).toEqual({ enabled: false, providers: null });
    expect(providerReads).toBe(0);
  });

  test("uses exact no-redirect fetch transports and redacts rejected request bodies", async () => {
    const requests: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
    const fetcher = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const signal = new AbortController().signal;
    await makeTransloaditFetchTransport(fetcher).request({
      requestId: "request",
      method: "POST",
      url: "https://api2.transloadit.com/assemblies",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("signed-secret-body"),
      signal,
      redirect: "error",
    });
    await makeAcrCloudFetchTransport("identify-ap-southeast-1.acrcloud.com", fetcher).request({
      requestId: "request",
      method: "POST",
      url: "https://identify-ap-southeast-1.acrcloud.com/v1/identify",
      headers: {},
      body: new Uint8Array([1]),
      signal,
      redirect: "error",
    });
    await makeElevenLabsAlignmentFetchTransport(fetcher)({
      method: "POST",
      url: "https://api.elevenlabs.io/v1/forced-alignment",
      headers: { "xi-api-key": "secret" },
      body: {
        byteLength: 1,
        contentType: "application/octet-stream",
        open: async function* () {
          yield new Uint8Array([1]);
        },
      },
      signal,
    });
    expect(requests).toHaveLength(3);
    expect(requests.every(({ init }) => init?.redirect === "error")).toBe(true);

    const invalid = makeTransloaditFetchTransport(fetcher).request({
      requestId: "request",
      method: "POST",
      url: "https://attacker.invalid/assemblies",
      headers: {},
      body: new TextEncoder().encode("must-not-appear"),
      signal,
      redirect: "error",
    });
    await expect(invalid).rejects.toBeInstanceOf(MediaProcessingTransportFailure);
    await expect(invalid).rejects.not.toThrow("must-not-appear");
  });

  test("binds a retained sample with HEAD plus conditional GET before returning bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const calls: string[] = [];
    const artifact: MediaTransformSampleArtifact = {
      version: "media-transform-sample-artifact-v1",
      objectKey: "media-transform/operation/primary.wav",
      contentType: "audio/wav",
      byteLength: bytes.byteLength,
      offsetMs: 0,
      durationMs: 12_000,
      variant: "primary",
      retainedObjectVerification: "required",
    };
    const reader = makeR2MediaProcessingArtifactReader(
      r2Bucket(artifact.objectKey, bytes, "audio/wav", calls),
    );
    await expect(
      reader.readAudioSample(artifact, 4, new AbortController().signal),
    ).resolves.toEqual(bytes);
    expect(calls).toEqual([`head:${artifact.objectKey}`, `get:${artifact.objectKey}`]);

    await expect(
      reader.readAudioSample({ ...artifact, byteLength: 3 }, 4, new AbortController().signal),
    ).rejects.toBeInstanceOf(MediaProcessingArtifactFailure);
  });

  test("extracts a bounded ID3 title and proves absent artwork without inventing safety", async () => {
    const bytes = id3([
      { id: "TIT2", body: Uint8Array.from([3, ...new TextEncoder().encode("Golden song")]) },
    ]);
    const metadata = makeR2EmbeddedMetadataPort(
      r2Bucket("immutable/operation/audio/1", bytes, "audio/mpeg"),
    );
    await expect(
      metadata.extract(authority(bytes.byteLength), new AbortController().signal),
    ).resolves.toMatchObject({
      trackTitle: "Golden song",
      cover: { status: "absent", reasonCode: "not_embedded" },
    });

    const withArtwork = id3([{ id: "APIC", body: new Uint8Array([3, 1, 2, 3]) }]);
    const artworkMetadata = makeR2EmbeddedMetadataPort(
      r2Bucket("immutable/operation/audio/1", withArtwork, "audio/mpeg"),
    );
    await expect(
      artworkMetadata.extract(authority(withArtwork.byteLength), new AbortController().signal),
    ).resolves.toMatchObject({ cover: { status: "rejected", reasonCode: "invalid" } });
  });

  test("maps forced alignment to an exact lyrics-fenced artifact after audio hash verification", async () => {
    const audio = new Uint8Array([9, 8, 7, 6]);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", audio)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const providerArtifactRefs: string[] = [];
    const adapter = {
      align: async (input: ElevenLabsAlignmentInput) => {
        providerArtifactRefs.push(input.transcript.artifact_ref);
        const consumed: number[] = [];
        for await (const chunk of input.audio.source.open(input.signal)) consumed.push(...chunk);
        expect(consumed).toEqual([...audio]);
        return {
          status: "ready" as const,
          alignment: "ready" as const,
          outcome: "ready" as const,
          context: {
            operation_id: input.operation_id,
            post_id: input.post_id,
            audio_revision: input.audio.audio_revision,
            analysis_revision: input.transcript.analysis_revision,
            canonical_audio_sha256: input.audio.canonical_audio_sha256,
            transcript_artifact_ref: input.transcript.artifact_ref,
            adapter_revision: "elevenlabs-alignment-adapter-v1" as const,
          },
          mode: "word" as const,
          timings: [{ token_index: 0, start_ms: 0, end_ms: 500, kind: "word" as const }],
        };
      },
    };
    const port = makeElevenLabsProcessingAlignmentPort(
      r2Bucket("immutable/operation/audio/1", audio, "audio/mpeg"),
      adapter,
      64,
    );
    const result = await port.align({
      operationId: "operation",
      postId: "post",
      audioRevision: 1,
      analysisRevision: 1,
      lyricsRevision: 2,
      canonicalAudioSha256: hash,
      audioArtifactRef: "media://immutable/operation/audio/1",
      lyrics: "project lyrics",
      signal: new AbortController().signal,
    });
    expect(providerArtifactRefs).toEqual(["media://lyrics/operation/2"]);
    expect(result).toMatchObject({
      status: "ready",
      artifactRef: "media://timed-lyrics/operation/audio/1/analysis/1/lyrics/2",
      artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      artifact: {
        operation_id: "operation",
        post_id: "post",
        lyrics_revision: 2,
        canonical_audio_sha256: hash,
      },
    });
  });

  test("fails closed when the canonical alignment object cannot be inspected", async () => {
    let providerCalls = 0;
    const port = makeElevenLabsProcessingAlignmentPort(
      {
        head: async () => Promise.reject(new Error("r2 unavailable")),
      } as unknown as R2Bucket,
      {
        align: async () => {
          providerCalls += 1;
          throw new Error("provider must remain untouched");
        },
      },
      64,
    );

    await expect(
      port.align({
        operationId: "operation",
        postId: "post",
        audioRevision: 1,
        analysisRevision: 1,
        lyricsRevision: 2,
        canonicalAudioSha256: "0".repeat(64),
        audioArtifactRef: "media://immutable/operation/audio/1",
        lyrics: "project lyrics",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "unavailable", failureCode: "provider_unavailable" });
    expect(providerCalls).toBe(0);
  });
});
