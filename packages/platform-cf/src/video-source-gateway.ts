const SOURCE_PATH_PREFIX = "/.well-known/pirate/video-source/v1/";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

type VideoSourceObject = Readonly<{
  key: string;
  version: string;
  etag: string;
  size: number;
  checksums?: Readonly<{ sha256?: ArrayBuffer }>;
  httpMetadata?: Readonly<{ contentType?: string }>;
}>;

type VideoSourceObjectBody = VideoSourceObject & Readonly<{ body: ReadableStream<Uint8Array> }>;

export type VideoSourceBucket = Readonly<{
  head: (key: string) => Promise<VideoSourceObject | null>;
  get: (
    key: string,
    options: Readonly<{
      onlyIf: Readonly<{ etagMatches: string }>;
      range?: Readonly<{ offset: number; length: number }>;
    }>,
  ) => Promise<VideoSourceObject | VideoSourceObjectBody | null>;
}>;

export type VideoSourceGrant = Readonly<{
  capability: string;
  expiresAtMs: number;
  object: Readonly<{
    key: string;
    version: string;
    etag: string;
    size: number;
    contentType: "video/mp4" | "video/quicktime";
    canonicalSha256: string;
  }>;
}>;

export type VideoSourceGrantResolver = Readonly<{
  resolve: (capability: string) => Promise<VideoSourceGrant | null>;
}>;

export type VideoSourceGatewayLogEvent = Readonly<{
  event: "source_request";
  outcome: "invalid_grant" | "not_found" | "range_rejected" | "served" | "source_changed";
  method: "GET" | "HEAD";
  status: 200 | 206 | 404 | 409 | 416;
}>;

export type VideoSourceGatewayLogger = (event: VideoSourceGatewayLogEvent) => void;

type ParsedRange = Readonly<{ offset: number; length: number; end: number }>;

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function hasBody(
  object: VideoSourceObject | VideoSourceObjectBody,
): object is VideoSourceObjectBody {
  return "body" in object && object.body instanceof ReadableStream;
}

function objectMatches(grant: VideoSourceGrant, object: VideoSourceObject): boolean {
  const sha256 = object.checksums?.sha256;
  return (
    object.key === grant.object.key &&
    object.version === grant.object.version &&
    object.etag === grant.object.etag &&
    object.size === grant.object.size &&
    object.httpMetadata?.contentType === grant.object.contentType &&
    (sha256 === undefined || bytesToHex(sha256) === grant.object.canonicalSha256)
  );
}

function parseUnsignedInteger(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseRange(header: string, size: number): ParsedRange | null {
  if (!header.startsWith("bytes=") || header.includes(",")) return null;
  const value = header.slice("bytes=".length);
  const separator = value.indexOf("-");
  if (separator < 0 || value.indexOf("-", separator + 1) >= 0) return null;

  const startText = value.slice(0, separator);
  const endText = value.slice(separator + 1);
  if (startText.length === 0) {
    const suffix = parseUnsignedInteger(endText);
    if (suffix === null || suffix === 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length, end: size - 1 };
  }

  const start = parseUnsignedInteger(startText);
  if (start === null || start >= size) return null;
  const requestedEnd = endText.length === 0 ? size - 1 : parseUnsignedInteger(endText);
  if (requestedEnd === null || requestedEnd < start) return null;
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1, end };
}

function sourceHeaders(grant: VideoSourceGrant, contentLength: number): Headers {
  return new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-length": String(contentLength),
    "content-type": grant.object.contentType,
    etag: `"${grant.object.etag}"`,
    "x-content-type-options": "nosniff",
  });
}

/**
 * Serves one sealed R2 object through an opaque, expiring capability. The R2
 * key, capability, and canonical digest never enter the typed diagnostic event.
 */
export function makeVideoSourceGateway(
  input: Readonly<{
    bucket: VideoSourceBucket;
    grants: VideoSourceGrantResolver;
    now: () => number;
    logger?: VideoSourceGatewayLogger;
  }>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const url = new URL(request.url);
    const capability = url.pathname.startsWith(SOURCE_PATH_PREFIX)
      ? url.pathname.slice(SOURCE_PATH_PREFIX.length)
      : "";
    if (url.search.length > 0 || !CAPABILITY_PATTERN.test(capability)) {
      input.logger?.({ event: "source_request", method, outcome: "not_found", status: 404 });
      return new Response(null, { status: 404 });
    }

    const grant = await input.grants.resolve(capability);
    if (grant === null || grant.capability !== capability || grant.expiresAtMs <= input.now()) {
      input.logger?.({ event: "source_request", method, outcome: "not_found", status: 404 });
      return new Response(null, { status: 404 });
    }
    if (
      grant.object.size <= 0 ||
      !Number.isSafeInteger(grant.object.size) ||
      grant.object.version.length === 0 ||
      grant.object.etag.length === 0 ||
      !SHA256_PATTERN.test(grant.object.canonicalSha256)
    ) {
      input.logger?.({ event: "source_request", method, outcome: "invalid_grant", status: 409 });
      return new Response(null, { status: 409 });
    }

    const observed = await input.bucket.head(grant.object.key);
    if (observed === null || !objectMatches(grant, observed)) {
      input.logger?.({ event: "source_request", method, outcome: "source_changed", status: 409 });
      return new Response(null, { status: 409 });
    }

    if (method === "HEAD") {
      const headers = sourceHeaders(grant, grant.object.size);
      headers.set("content-range", `bytes 0-${grant.object.size - 1}/${grant.object.size}`);
      input.logger?.({ event: "source_request", method, outcome: "served", status: 200 });
      return new Response(null, { status: 200, headers });
    }

    const rangeHeader = request.headers.get("range");
    const range = rangeHeader === null ? null : parseRange(rangeHeader, grant.object.size);
    if (rangeHeader !== null && range === null) {
      input.logger?.({ event: "source_request", method, outcome: "range_rejected", status: 416 });
      return new Response(null, {
        status: 416,
        headers: { "accept-ranges": "bytes", "content-range": `bytes */${grant.object.size}` },
      });
    }

    const selected = await input.bucket.get(grant.object.key, {
      onlyIf: { etagMatches: grant.object.etag },
      ...(range === null ? {} : { range: { offset: range.offset, length: range.length } }),
    });
    if (selected === null || !hasBody(selected) || !objectMatches(grant, selected)) {
      input.logger?.({ event: "source_request", method, outcome: "source_changed", status: 409 });
      return new Response(null, { status: 409 });
    }

    const contentLength = range?.length ?? grant.object.size;
    const headers = sourceHeaders(grant, contentLength);
    if (range !== null) {
      headers.set("content-range", `bytes ${range.offset}-${range.end}/${grant.object.size}`);
    }
    const status = range === null ? 200 : 206;
    input.logger?.({ event: "source_request", method, outcome: "served", status });
    return new Response(selected.body, { status, headers });
  };
}

export function makeVideoSourceUrl(origin: string, capability: string): string {
  if (!CAPABILITY_PATTERN.test(capability)) throw new Error("invalid video source capability");
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0
  ) {
    throw new Error("video source origin must be credential-free HTTPS");
  }
  url.pathname = `${SOURCE_PATH_PREFIX}${capability}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
