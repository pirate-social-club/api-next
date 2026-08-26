import { HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE } from "@pirate/application/hns-community-handle-gateway";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
  type HnsStaticPlatformGatewayHeaderField,
  type HnsStaticPlatformGatewayRequest,
} from "./request.ts";

export type HnsCommunityHandleGatewayAdmission = Readonly<{
  method: "GET" | "HEAD";
  normalized_host: string;
  canonical_root: string;
  canonical_handle_label: string;
}>;

export type HnsCommunityHandleGatewayRejection = Readonly<{
  status: 400 | 405 | 413 | 421;
  reason: "invalid_request" | "method_not_allowed" | "request_too_large" | "unavailable";
  allow?: "GET, HEAD";
}>;

const encoder = new TextEncoder();
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const byteLength = (value: string): number => encoder.encode(value).byteLength;

function invalidHeaderValue(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 0x20 && point !== 0x09) || point === 0x7f) return true;
  }
  return false;
}

function canonicalHandleHost(
  value: string,
): { host: string; root: string; handleLabel: string } | null {
  if (value.length === 0 || value !== value.toLowerCase() || value.endsWith(".")) return null;
  const withoutPort = value.endsWith(":443") ? value.slice(0, -4) : value;
  if (withoutPort.includes(":") || withoutPort.includes("@")) return null;
  const labels = withoutPort.split(".");
  const handleLabel = labels[0];
  const root = labels[1];
  if (
    labels.length !== 2 ||
    handleLabel === undefined ||
    root === undefined ||
    root === "pirate" ||
    !dnsLabelPattern.test(handleLabel) ||
    !dnsLabelPattern.test(root)
  ) {
    return null;
  }
  return { host: withoutPort, root, handleLabel };
}

function headerValues(
  fields: readonly HnsStaticPlatformGatewayHeaderField[],
  name: string,
): readonly string[] {
  return fields.filter(([candidate]) => candidate.toLowerCase() === name).map(([, value]) => value);
}

function singleHeader(
  fields: readonly HnsStaticPlatformGatewayHeaderField[],
  name: string,
): string | null {
  const values = headerValues(fields, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function rejection(
  status: HnsCommunityHandleGatewayRejection["status"],
): HnsCommunityHandleGatewayRejection {
  if (status === 405) return { status, reason: "method_not_allowed", allow: "GET, HEAD" };
  if (status === 413) return { status, reason: "request_too_large" };
  if (status === 421) return { status, reason: "unavailable" };
  return { status, reason: "invalid_request" };
}

export function admitHnsCommunityHandleGatewayRequest(
  request: HnsStaticPlatformGatewayRequest,
): HnsCommunityHandleGatewayAdmission | HnsCommunityHandleGatewayRejection {
  if (!HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[3].includes(request.method as "GET" | "HEAD")) {
    return rejection(405);
  }
  if (
    request.target !== "/" ||
    byteLength(request.target) > HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[9]
  ) {
    return rejection(400);
  }
  if (
    request.header_fields.length > HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[10] ||
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
  if (aggregateBytes > HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[11]) {
    return rejection(413);
  }
  const transferEncoding = headerValues(request.header_fields, "transfer-encoding");
  const contentLength = headerValues(request.header_fields, "content-length");
  if (
    transferEncoding.length !== 0 ||
    contentLength.length > 1 ||
    (contentLength.length === 1 && contentLength[0] !== "0") ||
    request.body_bytes.byteLength !== HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[12]
  ) {
    return rejection(413);
  }
  const scheme = singleHeader(request.header_fields, HNS_GATEWAY_EXTERNAL_SCHEME_HEADER);
  const sni = singleHeader(request.header_fields, HNS_GATEWAY_TLS_SNI_HEADER);
  const authority = singleHeader(request.header_fields, "host");
  if (scheme !== "https" || sni === null || authority === null) return rejection(400);
  const parsedHost = canonicalHandleHost(authority);
  const parsedSni = canonicalHandleHost(sni);
  if (parsedHost === null || parsedSni === null || parsedHost.host !== parsedSni.host) {
    return rejection(421);
  }
  return {
    method: request.method as "GET" | "HEAD",
    normalized_host: parsedHost.host,
    canonical_root: parsedHost.root,
    canonical_handle_label: parsedHost.handleLabel,
  };
}
