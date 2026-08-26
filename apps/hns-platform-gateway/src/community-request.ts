import {
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_REQUEST_HEADERS,
} from "@pirate/application/hns-community-app-gateway";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
  type HnsStaticPlatformGatewayHeaderField,
  type HnsStaticPlatformGatewayRequest,
} from "./request.ts";

export type HnsCommunityAppGatewayAdmission = Readonly<{
  method: "GET" | "HEAD" | "POST" | "PATCH";
  external_target: string;
  mapped_target: string;
  normalized_host: string;
  canonical_root: string;
  upstream_headers: Headers;
  body_bytes: Uint8Array;
}>;

export type HnsCommunityAppGatewayRejection = Readonly<{
  status: 400 | 405 | 413 | 421;
  reason: "invalid_request" | "method_not_allowed" | "request_too_large" | "unavailable";
  allow?: "GET, HEAD, POST, PATCH";
}>;

const encoder = new TextEncoder();
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const percentTripletPattern = /^[0-9A-Fa-f]{2}$/u;
const allowedRequestHeaders = new Set<string>(
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_REQUEST_HEADERS,
);
const prohibitedRequestHeaders = new Set([
  "authorization",
  "csrf-token",
  "forwarded",
  "host",
  "proxy-authorization",
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
    byteLength(target) > HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[8]
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
  const pathname = target.split("?", 1)[0] ?? "";
  if (pathname.includes("//")) return false;
  return !pathname.split("/").some((segment) => /^(?:\.|%2e|%2E){1,2}$/u.test(segment));
}

function canonicalCommunityHost(value: string): { host: string; root: string } | null {
  if (value.length === 0 || value !== value.toLowerCase() || value.endsWith(".")) return null;
  const withoutPort = value.endsWith(":443") ? value.slice(0, -4) : value;
  if (withoutPort.includes(":") || withoutPort.includes("@")) return null;
  const labels = withoutPort.split(".");
  if (
    labels.length !== 2 ||
    labels[0] !== "app" ||
    labels[1] === "pirate" ||
    !labels.every((label) => dnsLabelPattern.test(label))
  ) {
    return null;
  }
  return { host: withoutPort, root: labels[1] ?? "" };
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
  status: HnsCommunityAppGatewayRejection["status"],
): HnsCommunityAppGatewayRejection {
  if (status === 405) {
    return { status, reason: "method_not_allowed", allow: "GET, HEAD, POST, PATCH" };
  }
  if (status === 413) return { status, reason: "request_too_large" };
  if (status === 421) return { status, reason: "unavailable" };
  return { status, reason: "invalid_request" };
}

function mappedTarget(target: string, root: string): string {
  const question = target.indexOf("?");
  const pathname = question === -1 ? target : target.slice(0, question);
  if (pathname !== "/") return target;
  return `/c/${root}${question === -1 ? "" : target.slice(question)}`;
}

function isApiTarget(target: string): boolean {
  const pathname = target.split("?", 1)[0] ?? "";
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function admitHnsCommunityAppGatewayRequest(
  request: HnsStaticPlatformGatewayRequest,
): HnsCommunityAppGatewayAdmission | HnsCommunityAppGatewayRejection {
  if (
    !HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[3].includes(
      request.method as "GET" | "HEAD" | "POST" | "PATCH",
    )
  ) {
    return rejection(405);
  }
  if (!targetIsValid(request.target)) return rejection(400);
  if (
    request.header_fields.length > HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[9] ||
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
  if (aggregateBytes > HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[10]) {
    return rejection(413);
  }

  const transferEncoding = headerValues(request.header_fields, "transfer-encoding");
  const contentLength = headerValues(request.header_fields, "content-length");
  if (
    transferEncoding.length !== 0 ||
    contentLength.length > 1 ||
    (contentLength.length === 1 && !/^(?:0|[1-9][0-9]*)$/u.test(contentLength[0] ?? ""))
  ) {
    return rejection(413);
  }
  const declaredLength = contentLength.length === 0 ? null : Number(contentLength[0]);
  if (
    request.body_bytes.byteLength > HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[11] ||
    (declaredLength !== null && declaredLength !== request.body_bytes.byteLength) ||
    ((request.method === "GET" || request.method === "HEAD") && request.body_bytes.byteLength !== 0)
  ) {
    return rejection(413);
  }

  const scheme = singleHeader(request.header_fields, HNS_GATEWAY_EXTERNAL_SCHEME_HEADER);
  const sni = singleHeader(request.header_fields, HNS_GATEWAY_TLS_SNI_HEADER);
  const authority = singleHeader(request.header_fields, "host");
  if (scheme !== "https" || sni === null || authority === null) return rejection(400);
  const parsedHost = canonicalCommunityHost(authority);
  const parsedSni = canonicalCommunityHost(sni);
  if (parsedHost === null || parsedSni === null || parsedHost.host !== parsedSni.host) {
    return rejection(421);
  }

  const unsafe = request.method === "POST" || request.method === "PATCH";
  if (unsafe && !isApiTarget(request.target)) return rejection(405);
  const origin = headerValues(request.header_fields, "origin");
  if (unsafe && (origin.length !== 1 || origin[0] !== `https://${parsedHost.host}`)) {
    return rejection(400);
  }
  const cookies = headerValues(request.header_fields, "cookie");
  if (
    cookies.length > 1 ||
    (cookies.length === 1 &&
      byteLength(cookies[0] ?? "") > HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[12])
  ) {
    return rejection(413);
  }

  const connectionFields = request.header_fields
    .filter(([name]) => name.toLowerCase() === "connection")
    .flatMap(([, value]) => value.split(",").map((item) => item.trim().toLowerCase()));
  const upstreamHeaders = new Headers();
  for (const [rawName, value] of request.header_fields) {
    const name = rawName.toLowerCase();
    if (
      prohibitedRequestHeaders.has(name) ||
      hopByHopHeaders.has(name) ||
      connectionFields.includes(name) ||
      removedByPrefix(name) ||
      !allowedRequestHeaders.has(name)
    ) {
      continue;
    }
    if (name === "cookie" || name === "origin") upstreamHeaders.set(name, value);
    else upstreamHeaders.append(name, value);
  }
  upstreamHeaders.delete("content-length");

  return {
    method: request.method as "GET" | "HEAD" | "POST" | "PATCH",
    external_target: request.target,
    mapped_target: mappedTarget(request.target, parsedHost.root),
    normalized_host: parsedHost.host,
    canonical_root: parsedHost.root,
    upstream_headers: upstreamHeaders,
    body_bytes: new Uint8Array(request.body_bytes),
  };
}
