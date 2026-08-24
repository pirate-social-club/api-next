import {
  HNS_PLATFORM_APP_HOST,
  HNS_PLATFORM_ROOT,
  HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE,
} from "@pirate/application/hns-static-platform-app-gateway";

export const HNS_GATEWAY_EXTERNAL_SCHEME_HEADER = "x-pirate-gateway-external-scheme" as const;
export const HNS_GATEWAY_TLS_SNI_HEADER = "x-pirate-gateway-tls-sni" as const;

export type HnsStaticPlatformGatewayHeaderField = readonly [name: string, value: string];

export type HnsStaticPlatformGatewayRequest = Readonly<{
  method: string;
  target: string;
  header_fields: readonly HnsStaticPlatformGatewayHeaderField[];
  body_bytes: Uint8Array;
  signal: AbortSignal;
}>;

export type HnsStaticPlatformGatewayAdmission = Readonly<{
  method: "GET" | "HEAD";
  target: string;
  host: typeof HNS_PLATFORM_ROOT | typeof HNS_PLATFORM_APP_HOST;
  upstream_headers: Headers;
}>;

export type HnsStaticPlatformGatewayRejection = Readonly<{
  status: 400 | 405 | 413 | 421;
  reason: "invalid_request" | "method_not_allowed" | "request_too_large" | "unavailable";
}>;

const encoder = new TextEncoder();
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const canonicalHostPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const percentTripletPattern = /^[0-9A-Fa-f]{2}$/u;

const removedRequestHeaders = new Set([
  "authorization",
  "cookie",
  "csrf-token",
  "forwarded",
  "host",
  "origin",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function invalidHeaderValue(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 0x20 && point !== 0x09) || point === 0x7f) return true;
  }
  return false;
}

function removedByPrefix(name: string): boolean {
  return (
    name.startsWith("cf-access-") ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("x-pirate-gateway-") ||
    name.startsWith("x-pirate-hns-forwarder-")
  );
}

function targetIsValid(target: string): boolean {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    target.includes("\\") ||
    byteLength(target) > HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE[6]
  ) {
    return false;
  }
  for (let index = 0; index < target.length; index += 1) {
    const point = target.codePointAt(index) ?? 0;
    if (point < 0x20 || point === 0x7f || point > 0x7e) return false;
    if (target[index] !== "%") continue;
    const triplet = target.slice(index + 1, index + 3);
    if (!percentTripletPattern.test(triplet)) return false;
    const decoded = Number.parseInt(triplet, 16);
    if (decoded === 0x2f || decoded === 0x5c) return false;
    index += 2;
  }
  const path = target.split("?", 1)[0] ?? "";
  if (path.includes("//")) return false;
  return !path.split("/").some((segment) => /^(?:\.|%2e|%2E){1,2}$/u.test(segment));
}

function canonicalAuthority(value: string): string | null {
  if (value.length === 0 || value !== value.toLowerCase() || value.endsWith(".")) return null;
  const withoutPort = value.endsWith(":443") ? value.slice(0, -4) : value;
  if (
    withoutPort.length === 0 ||
    withoutPort.includes(":") ||
    withoutPort.includes("@") ||
    !canonicalHostPattern.test(withoutPort)
  ) {
    return null;
  }
  return withoutPort;
}

function singleHeader(
  fields: readonly HnsStaticPlatformGatewayHeaderField[],
  name: string,
): string | null {
  const values = fields
    .filter(([candidate]) => candidate.toLowerCase() === name)
    .map(([, value]) => value);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function headerValues(
  fields: readonly HnsStaticPlatformGatewayHeaderField[],
  name: string,
): readonly string[] {
  return fields.filter(([candidate]) => candidate.toLowerCase() === name).map(([, value]) => value);
}

function rejection(
  status: HnsStaticPlatformGatewayRejection["status"],
): HnsStaticPlatformGatewayRejection {
  if (status === 405) return { status, reason: "method_not_allowed" };
  if (status === 413) return { status, reason: "request_too_large" };
  if (status === 421) return { status, reason: "unavailable" };
  return { status, reason: "invalid_request" };
}

export function admitHnsStaticPlatformGatewayRequest(
  request: HnsStaticPlatformGatewayRequest,
): HnsStaticPlatformGatewayAdmission | HnsStaticPlatformGatewayRejection {
  if (!HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE[5].includes(request.method as "GET" | "HEAD")) {
    return rejection(405);
  }
  if (!targetIsValid(request.target)) return rejection(400);
  if (
    request.header_fields.length > HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE[7] ||
    request.header_fields.some(
      ([name, value]) => !headerNamePattern.test(name) || invalidHeaderValue(value),
    )
  ) {
    return rejection(400);
  }
  const aggregateBytes = request.header_fields.reduce(
    (sum, [name, value]) => sum + byteLength(name) + byteLength(value),
    0,
  );
  if (aggregateBytes > HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE[8]) return rejection(413);

  const transferEncoding = headerValues(request.header_fields, "transfer-encoding");
  const contentLength = headerValues(request.header_fields, "content-length");
  if (
    transferEncoding.length !== 0 ||
    request.body_bytes.byteLength !== 0 ||
    contentLength.length > 1 ||
    (contentLength.length === 1 && contentLength[0] !== "0")
  ) {
    return rejection(413);
  }

  const scheme = singleHeader(request.header_fields, HNS_GATEWAY_EXTERNAL_SCHEME_HEADER);
  const sni = singleHeader(request.header_fields, HNS_GATEWAY_TLS_SNI_HEADER);
  const authority = singleHeader(request.header_fields, "host");
  if (scheme !== "https" || sni === null || authority === null) return rejection(400);
  const host = canonicalAuthority(authority);
  if (host === null || canonicalAuthority(sni) !== sni || host !== sni) return rejection(421);
  if (host !== HNS_PLATFORM_ROOT && host !== HNS_PLATFORM_APP_HOST) return rejection(421);

  const connectionFields = request.header_fields
    .filter(([name]) => name.toLowerCase() === "connection")
    .flatMap(([, value]) => value.split(",").map((item) => item.trim().toLowerCase()));
  const upstreamHeaders = new Headers();
  for (const [rawName, value] of request.header_fields) {
    const name = rawName.toLowerCase();
    if (
      removedRequestHeaders.has(name) ||
      hopByHopHeaders.has(name) ||
      connectionFields.includes(name) ||
      removedByPrefix(name)
    ) {
      continue;
    }
    upstreamHeaders.append(name, value);
  }
  upstreamHeaders.delete("content-length");

  return {
    method: request.method as "GET" | "HEAD",
    target: request.target,
    host,
    upstream_headers: upstreamHeaders,
  };
}
