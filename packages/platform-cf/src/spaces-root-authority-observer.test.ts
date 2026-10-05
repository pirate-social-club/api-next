import { describe, expect, test } from "bun:test";
import { SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES } from "./spaces-root-authority-evidence.ts";
import { makeSpacesRootAuthorityObserver } from "./spaces-root-authority-observer.ts";
import { binary, bytes, fixture } from "./spaces-root-authority-test-fixture.ts";

const credentials = {
  accessClientId: "test-id",
  accessClientSecret: "test-secret",
  bearerToken: "test-bearer",
};

const streamFetch = (stream: ReadableStream<Uint8Array>): typeof fetch =>
  Object.assign(async () => new Response(stream), {
    preconnect: () => {
      throw new Error("Unexpected test preconnection");
    },
  });

describe("Spaces root authority observer", () => {
  test("reads a production-sized receipt over multiple chunks", async () => {
    const cert = binary("r".repeat(224_079));
    const payload = bytes({
      ...fixture(),
      root_certificate_base64: cert.base64,
      root_certificate_sha256_hex: cert.sha256,
    });
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === payload.length) {
          controller.close();
          return;
        }
        const next = Math.min(offset + 16_384, payload.length);
        controller.enqueue(payload.slice(offset, next));
        offset = next;
      },
    });
    const observer = makeSpacesRootAuthorityObserver(credentials, streamFetch(stream));
    const result = await observer.observe({ canonicalRoot: "yahoo" });
    expect(result.kind).toBe("verified");
    if (result.kind === "verified") expect(result.bytes).toEqual(payload);
  });

  test("cancels an overflowing response instead of continuing to read", async () => {
    let cancelled = false;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(65_536));
      },
      cancel() {
        cancelled = true;
      },
    });
    const observer = makeSpacesRootAuthorityObserver(credentials, streamFetch(stream));
    await expect(observer.observe({ canonicalRoot: "yahoo" })).rejects.toThrow("bound");
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(18);
  });

  test("treats verifier 409 as pending without deriving a changed root", async () => {
    const mockFetch = (async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "CF-Access-Client-Id": "test-id",
        "CF-Access-Client-Secret": "test-secret",
        authorization: "Bearer test-bearer",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ root: "@yahoo" });
      return new Response(null, { status: 409 });
    }) as typeof fetch;
    const observer = makeSpacesRootAuthorityObserver(credentials, mockFetch);
    expect(await observer.observe({ canonicalRoot: "yahoo" })).toEqual({ kind: "pending" });
  });

  test("refuses incomplete credentials and an oversized verifier response", async () => {
    expect(() => makeSpacesRootAuthorityObserver({ ...credentials, bearerToken: "" })).toThrow();
    const observer = makeSpacesRootAuthorityObserver(
      credentials,
      (async () =>
        new Response("a".repeat(SPACES_ROOT_AUTHORITY_MAX_RESPONSE_BYTES + 1), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    await expect(observer.observe({ canonicalRoot: "yahoo" })).rejects.toThrow("bound");
  });

  test("does not follow an Access login redirect", async () => {
    const observer = makeSpacesRootAuthorityObserver(credentials, (async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://login.example.test" },
      });
    }) as typeof fetch);
    await expect(observer.observe({ canonicalRoot: "yahoo" })).rejects.toThrow("unavailable");
  });
  test("interrupts a stalled body and never waits for a hung cancellation", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const observer = makeSpacesRootAuthorityObserver(credentials, streamFetch(stream), 20);
    const began = performance.now();
    await expect(observer.observe({ canonicalRoot: "yahoo" })).rejects.toThrow();
    expect(performance.now() - began).toBeLessThan(500);
    expect(cancelled).toBe(true);
  });

  test("interrupts a stalled fetch through its AbortSignal", async () => {
    let aborted = false;
    const waiting = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      })) as typeof fetch;
    const observer = makeSpacesRootAuthorityObserver(credentials, waiting, 20);
    await expect(observer.observe({ canonicalRoot: "yahoo" })).rejects.toThrow();
    expect(aborted).toBe(true);
  });
  test("caller cancellation interrupts collection before the observer deadline", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel() {
        cancelled = true;
      },
    });
    const observer = makeSpacesRootAuthorityObserver(credentials, streamFetch(stream), 3000);
    const caller = new AbortController();
    const pending = observer.observe({ canonicalRoot: "yahoo" }, caller.signal);
    const began = performance.now();
    const timer = setTimeout(() => caller.abort(), 10);
    try {
      await expect(pending).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    expect(performance.now() - began).toBeLessThan(500);
    expect(cancelled).toBe(true);
  });
});
