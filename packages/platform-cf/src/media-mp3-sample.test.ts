import { describe, expect, test } from "bun:test";
import type {
  MediaTransformAudioSampleInput,
  MediaTransformProbeInput,
  MediaTransformService,
} from "@pirate/application/media/transform";
import { Effect } from "effect";
import {
  makeR2Mp3SampleMediaTransform,
  readMp3FrameWindow,
  readMp3Probe,
} from "./media-mp3-sample.ts";

const BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const FRAME_DURATION_MS = (1_152 * 1_000) / 44_100;

function frame(
  input: Readonly<{ bitrateIndex: number; mono: boolean; marker?: string }>,
): Uint8Array {
  const bitrate = BITRATES[input.bitrateIndex - 1];
  if (bitrate === undefined) throw new TypeError("invalid test bitrate");
  const byteLength = Math.floor((144 * bitrate * 1_000) / 44_100);
  const bytes = new Uint8Array(byteLength);
  bytes.set([0xff, 0xfb, input.bitrateIndex << 4, input.mono ? 0xc0 : 0x00]);
  bytes.fill(input.bitrateIndex, 4);
  if (input.marker !== undefined) bytes.set(new TextEncoder().encode(input.marker), 20);
  return bytes;
}

function id3(payloadBytes: number): Uint8Array {
  return Uint8Array.from([
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    (payloadBytes >>> 21) & 0x7f,
    (payloadBytes >>> 14) & 0x7f,
    (payloadBytes >>> 7) & 0x7f,
    payloadBytes & 0x7f,
    ...new Uint8Array(payloadBytes),
  ]);
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function mp3(input: Readonly<{ frames: number; mono: boolean; vbr?: boolean }>): Uint8Array {
  return join([
    id3(17),
    ...Array.from({ length: input.frames }, (_, index) =>
      frame({
        bitrateIndex: input.vbr === true ? 9 + (index % 3) : 11,
        mono: input.mono,
        ...(input.vbr === true && index === 0 ? { marker: "Xing" } : {}),
      }),
    ),
  ]);
}

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + size);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function r2Object(
  key: string,
  bytes: Uint8Array,
  sha256: ArrayBuffer,
  customMetadata: Readonly<Record<string, string>> = {},
): R2Object {
  return {
    key,
    version: `${key}-version`,
    size: bytes.byteLength,
    etag: `${key}-etag`,
    httpEtag: `"${key}-etag"`,
    checksums: { sha256, toJSON: () => ({}) },
    uploaded: new Date("2026-08-27T00:00:00.000Z"),
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: { ...customMetadata },
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
  };
}

function r2Body(object: R2Object, bytes: Uint8Array): R2ObjectBody {
  return {
    ...object,
    body: chunked(bytes, 997),
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
    bytes: () => Promise.resolve(bytes.slice()),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    json: () => Promise.reject(new Error("not json")),
    blob: () => Promise.resolve(new Blob([bytes])),
    writeHttpMetadata: () => undefined,
  };
}

async function sampleBuckets(sourceBytes: Uint8Array): Promise<{
  readonly originals: R2Bucket;
  readonly derived: R2Bucket;
  readonly writes: Array<Readonly<{ key: string; options: R2PutOptions }>>;
}> {
  const sourceKey = "immutable/operation/audio/1";
  const sourceDigest = await crypto.subtle.digest("SHA-256", sourceBytes);
  const source = r2Object(sourceKey, sourceBytes, sourceDigest);
  const writes: Array<Readonly<{ key: string; options: R2PutOptions }>> = [];
  let retained: R2Object | null = null;
  const originals = {
    head: async (key: string) => (key === sourceKey ? source : null),
    get: async (key: string) => (key === sourceKey ? r2Body(source, sourceBytes) : null),
  } as unknown as R2Bucket;
  const derived = {
    head: async (key: string) => (retained?.key === key ? retained : null),
    put: async (key: string, value: Uint8Array, options: R2PutOptions) => {
      writes.push({ key, options });
      if (retained !== null) return null;
      const digest = await crypto.subtle.digest("SHA-256", value);
      retained = r2Object(key, value, digest, options.customMetadata);
      return retained;
    },
  } as unknown as R2Bucket;
  return { originals, derived, writes };
}

function providerTransform(): MediaTransformService {
  return {
    probe: () => Effect.die(new Error("probe is delegated but unused by this test")),
    extractAudioSample: () => Effect.die(new Error("provider sample must not run")),
    extractCanonicalAudioSegment: () =>
      Effect.die(new Error("Dance segment extraction must not run")),
    alignVideoSoundtrackToSong: () =>
      Effect.die(new Error("Dance soundtrack alignment must not run")),
    extractVideoAudio: () => Effect.die(new Error("video audio extraction must not run")),
    extractVideoFrames: () => Effect.die(new Error("video frame extraction must not run")),
    cancelAssembly: () => Effect.succeed({ status: "unavailable", reason: "disabled" }),
  };
}

describe("raw MP3 sample extraction", () => {
  test("probes CBR MP3 duration and track facts without a provider", async () => {
    const source = mp3({ frames: 1_000, mono: true });
    const result = await readMp3Probe(
      chunked(source, 211),
      60 * 60 * 1_000,
      new AbortController().signal,
    );
    expect(result).toEqual({
      version: "media-transform-probe-v1",
      durationMs: Math.round(1_000 * FRAME_DURATION_MS),
      container: "mp3",
      mimeType: "audio/mpeg",
      tracks: [
        {
          kind: "audio",
          codec: "mp3",
          channels: 1,
          sampleRateHz: 44_100,
          bitrateBps: 192_000,
          bitrateMode: "constant",
        },
      ],
    });
  });

  test("probes the sealed R2 object and rejects a truncated MP3", async () => {
    const source = mp3({ frames: 120, mono: false, vbr: true });
    const buckets = await sampleBuckets(source);
    const canonicalAudioSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const transform = makeR2Mp3SampleMediaTransform({
      providerTransform: providerTransform(),
      immutableOriginals: buckets.originals,
      derivedArtifacts: buckets.derived,
      maximumSampleBytes: 1_000_000,
    });
    const request: MediaTransformProbeInput = {
      version: "media-transform-probe-input-v1",
      binding: {
        operationId: "operation",
        audioRevision: 1,
        analysisRevision: 1,
        canonicalAudioSha256,
        requestId: "probe",
      },
      source: { objectKey: "immutable/operation/audio/1" },
      attempt: {
        version: "media-transform-attempt-v1",
        runtimeFence: { submittedAtMs: 1_000, runtimeDeadlineMs: 61_000 },
      },
    };
    await expect(Effect.runPromise(transform.probe(request))).resolves.toMatchObject({
      status: "completed",
      probe: {
        container: "mp3",
        tracks: [{ codec: "mp3", channels: 2, bitrateMode: "variable" }],
      },
    });

    const truncated = source.subarray(0, source.byteLength - 100);
    await expect(
      readMp3Probe(chunked(truncated, 173), 60 * 60 * 1_000, new AbortController().signal),
    ).rejects.toThrow("inconsistent_media_facts");
  });

  test("selects a bounded primary CBR mono window across stream boundaries", async () => {
    const source = mp3({ frames: 1_000, mono: true });
    const sourceDurationMs = Math.round(1_000 * FRAME_DURATION_MS);
    const result = await readMp3FrameWindow(
      chunked(source, 113),
      sourceDurationMs,
      "primary",
      1_000_000,
      new AbortController().signal,
    );
    const cbrFrameBytes = frame({ bitrateIndex: 11, mono: true }).byteLength;
    expect(result.bytes[0]).toBe(0xff);
    expect(result.bytes[1]).toBe(0xfb);
    expect(result.bytes.byteLength % cbrFrameBytes).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(12_000);
    expect(result.durationMs).toBeLessThan(12_000 + FRAME_DURATION_MS);
    const expectedOffsetMs = Math.floor((sourceDurationMs - 12_000) * 0.25);
    expect(Math.abs(result.offsetMs - expectedOffsetMs)).toBeLessThan(FRAME_DURATION_MS + 1);
  });

  test("selects an alternate VBR Xing stereo window without assuming fixed frame bytes", async () => {
    const source = mp3({ frames: 1_000, mono: false, vbr: true });
    const sourceDurationMs = Math.round(1_000 * FRAME_DURATION_MS);
    const result = await readMp3FrameWindow(
      chunked(source, 509),
      sourceDurationMs,
      "alternate",
      1_000_000,
      new AbortController().signal,
    );
    expect(result.bytes[0]).toBe(0xff);
    expect(result.bytes[3] ?? 0).toBeLessThan(0xc0);
    expect(result.durationMs).toBeGreaterThanOrEqual(12_000);
    expect(result.durationMs).toBeLessThan(12_000 + FRAME_DURATION_MS);
    const expectedOffsetMs = Math.floor((sourceDurationMs - 12_000) * 0.75);
    expect(Math.abs(result.offsetMs - expectedOffsetMs)).toBeLessThan(FRAME_DURATION_MS + 1);
  });

  test("fails closed on a truncated frame after a valid boundary", async () => {
    const source = mp3({ frames: 100, mono: true });
    await expect(
      readMp3FrameWindow(
        chunked(source.subarray(0, source.byteLength - 100), 127),
        12_000,
        "primary",
        1_000_000,
        new AbortController().signal,
      ),
    ).rejects.toThrow("inconsistent_media_facts");
  });

  test("writes one immutable MP3 artifact and converges on a sibling result", async () => {
    const source = mp3({ frames: 1_000, mono: true });
    const buckets = await sampleBuckets(source);
    const canonicalAudioSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const transform = makeR2Mp3SampleMediaTransform({
      providerTransform: providerTransform(),
      immutableOriginals: buckets.originals,
      derivedArtifacts: buckets.derived,
      maximumSampleBytes: 1_000_000,
    });
    const request: MediaTransformAudioSampleInput = {
      version: "media-transform-audio-sample-input-v1",
      binding: {
        operationId: "operation",
        audioRevision: 1,
        analysisRevision: 1,
        canonicalAudioSha256,
        requestId: "sample-primary",
      },
      source: { objectKey: "immutable/operation/audio/1" },
      sourceDurationMs: Math.round(1_000 * FRAME_DURATION_MS),
      variant: "primary",
      attempt: {
        version: "media-transform-attempt-v1",
        runtimeFence: { submittedAtMs: 1_000, runtimeDeadlineMs: 61_000 },
      },
    };
    const first = await Effect.runPromise(transform.extractAudioSample(request));
    const sibling = await Effect.runPromise(transform.extractAudioSample(request));
    expect(first).toMatchObject({
      status: "completed",
      artifact: { contentType: "audio/mpeg", variant: "primary" },
    });
    expect(sibling).toEqual(first);
    expect(buckets.writes).toHaveLength(2);
    expect(buckets.writes[0]?.options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
    expect(buckets.writes[0]?.options.httpMetadata).toEqual({ contentType: "audio/mpeg" });
  });
});
