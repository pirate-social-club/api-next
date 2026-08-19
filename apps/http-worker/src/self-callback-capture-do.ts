// This module is bundled by Workers, while the root typecheck also traverses
// its export. Keep the runtime-only import isolated from Node/Bun's ambient
// declarations.
// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";

const CAPTURE_KEY = "physical-ceremony-callback";
const MAX_BODY_BYTES = 1_048_576;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_PROVIDER_ID_LENGTH = 128;

export type SelfCallbackCaptureStatus = {
  readonly state: "empty" | "captured";
  readonly provider_id: string | null;
  readonly digest: string | null;
  readonly length: number | null;
  readonly captured_at: string | null;
  readonly replayed: boolean;
};

export type SelfCallbackCaptureReplay = {
  readonly provider_id: string;
  readonly raw_body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly length: number;
};

type CaptureRecord = {
  readonly provider_id: string;
  readonly body: ArrayBuffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly length: number;
  readonly captured_at: string;
  readonly replayed: boolean;
};

type StorageLike = {
  readonly get: <T>(key: string) => Promise<T | undefined>;
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<boolean>;
};

type DurableObjectStateLike = {
  readonly storage: StorageLike;
};

const emptyStatus = (): SelfCallbackCaptureStatus => ({
  state: "empty",
  provider_id: null,
  digest: null,
  length: null,
  captured_at: null,
  replayed: false,
});

const statusOf = (record: CaptureRecord | undefined): SelfCallbackCaptureStatus =>
  record === undefined
    ? emptyStatus()
    : {
        state: "captured",
        provider_id: record.provider_id,
        digest: record.digest,
        length: record.length,
        captured_at: record.captured_at,
        replayed: record.replayed,
      };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
    },
  });

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const validProviderId = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_PROVIDER_ID_LENGTH &&
  value === value.trim() &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const hasHeaderControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 0x0a || code === 0x0d;
  });

const parseHeaders = (value: string | null): Readonly<Record<string, string>> | undefined => {
  if (value === null || value.length > MAX_HEADER_BYTES) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
  const result: Record<string, string> = {};
  let total = 0;
  for (const [name, headerValue] of Object.entries(decoded)) {
    if (
      name.length === 0 ||
      name.length > 256 ||
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) ||
      typeof headerValue !== "string" ||
      headerValue.length > 4096 ||
      hasHeaderControlCharacter(headerValue)
    ) {
      return undefined;
    }
    total += name.length + headerValue.length;
    if (total > MAX_HEADER_BYTES) return undefined;
    result[name] = headerValue;
  }
  return result;
};

export class SelfCallbackCaptureDO extends CloudflareDurableObject {
  private readonly state: DurableObjectStateLike;

  constructor(ctx: DurableObjectStateLike, env: unknown) {
    super(ctx as never, env as never);
    this.state = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(statusOf(await this.state.storage.get<CaptureRecord>(CAPTURE_KEY)));
    }

    if (request.method === "DELETE" && url.pathname === "/capture") {
      const cleared = await this.state.storage.delete(CAPTURE_KEY);
      return json({ cleared });
    }

    if (request.method === "POST" && url.pathname === "/capture") {
      const providerId = request.headers.get("x-callback-provider");
      const headers = parseHeaders(request.headers.get("x-callback-headers"));
      if (providerId === null || !validProviderId(providerId) || headers === undefined) {
        return json({ error: "invalid capture" }, 400);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "invalid capture" }, 413);
      const current = await this.state.storage.get<CaptureRecord>(CAPTURE_KEY);
      if (current !== undefined) return json(statusOf(current), 200);
      const record: CaptureRecord = {
        provider_id: providerId,
        body: bytes.slice().buffer,
        headers,
        digest: await sha256Hex(bytes),
        length: bytes.byteLength,
        captured_at: new Date().toISOString(),
        replayed: false,
      };
      await this.state.storage.put(CAPTURE_KEY, record);
      return json(statusOf(record), 201);
    }

    if (request.method === "POST" && url.pathname === "/replay") {
      const current = await this.state.storage.get<CaptureRecord>(CAPTURE_KEY);
      if (current === undefined) return json({ error: "capture unavailable" }, 404);
      if (current.replayed) return json({ error: "capture already replayed" }, 409);
      await this.state.storage.put(CAPTURE_KEY, { ...current, replayed: true });
      return new Response(current.body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-callback-provider": current.provider_id,
          "x-callback-headers": JSON.stringify(current.headers),
          "x-callback-digest": current.digest,
          "x-callback-length": String(current.length),
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
