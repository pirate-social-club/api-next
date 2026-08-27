import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeIpfsIoGatewayVerifier } from "./ipfs-live-gateway";

const CID = "bafkreie7mstupynzp4jr7k5wwrdss3e3n4badz47wpctk3tmo7ujw2uani";
const BYTES = new TextEncoder().encode("test");
const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const originalDigestStream = Object.getOwnPropertyDescriptor(crypto, "DigestStream");

class TestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
  readonly #chunks: Uint8Array[] = [];
  #resolve!: (value: ArrayBuffer) => void;
  #reject!: (reason: unknown) => void;

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
      this.#chunks.push(new Uint8Array(bytes));
    };
    closeStream = async () => {
      const length = this.#chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of this.#chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.#resolve(await crypto.subtle.digest("SHA-256", bytes));
    };
    abortStream = (reason) => this.#reject(reason);
  }
}

beforeAll(() => {
  Object.defineProperty(crypto, "DigestStream", {
    configurable: true,
    value: TestDigestStream,
  });
});

afterAll(() => {
  if (originalDigestStream === undefined) Reflect.deleteProperty(crypto, "DigestStream");
  else Object.defineProperty(crypto, "DigestStream", originalDigestStream);
});

const input = (overrides: Record<string, unknown> = {}) => ({
  version: "ipfs-gateway-verification-v1" as const,
  request_id: "artifact-1",
  cid: CID,
  expected_byte_length: BYTES.byteLength,
  expected_sha256: SHA256,
  ...overrides,
});

describe("ipfs.io gateway verification", () => {
  test("streams and verifies the retained CID without credentials", async () => {
    let requested = "";
    const verifier = makeIpfsIoGatewayVerifier({
      fetch: async (request, init) => {
        requested = String(request);
        expect(init).toMatchObject({ method: "GET", redirect: "manual" });
        expect(init?.headers).toBeUndefined();
        return new Response(BYTES);
      },
    });
    await expect(Effect.runPromise(verifier.verify(input()))).resolves.toEqual({
      status: "verified",
      cid: CID,
      byte_length: 4,
      sha256: SHA256,
      provider_id: "ipfs.io",
    });
    expect(requested).toBe(`https://ipfs.io/ipfs/${CID}`);
  });

  test("rejects wrong bytes, oversized bodies, and redirects", async () => {
    const wrong = makeIpfsIoGatewayVerifier({ fetch: async () => new Response("nope") });
    expect(await Effect.runPromise(wrong.verify(input()))).toEqual({
      status: "rejected",
      reason: "sha256",
    });
    const oversized = makeIpfsIoGatewayVerifier({ fetch: async () => new Response("tests") });
    expect(await Effect.runPromise(oversized.verify(input()))).toEqual({
      status: "rejected",
      reason: "oversized",
    });
    const redirect = makeIpfsIoGatewayVerifier({
      fetch: async () => new Response(null, { status: 302 }),
    });
    expect(await Effect.runPromise(redirect.verify(input()))).toEqual({
      status: "rejected",
      reason: "redirect",
    });
  });

  test("maps cancellation and timeout without exposing transport errors", async () => {
    const cancelled = new AbortController();
    const pendingFetch = async (_request: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret transport")), {
          once: true,
        });
      });
    const verifier = makeIpfsIoGatewayVerifier({ fetch: pendingFetch, timeout_ms: 10 });
    const cancellation = Effect.runPromise(verifier.verify(input({ signal: cancelled.signal })));
    cancelled.abort();
    expect(await cancellation).toEqual({ status: "retryable", reason: "cancelled" });
    expect(await Effect.runPromise(verifier.verify(input()))).toEqual({
      status: "retryable",
      reason: "timeout",
    });
  });
});
