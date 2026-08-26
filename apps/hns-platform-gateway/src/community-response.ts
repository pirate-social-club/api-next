import {
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_RESPONSE_COOKIES,
} from "@pirate/application/hns-community-app-gateway";

export class HnsCommunityAppGatewayUpstreamError extends Error {
  readonly name = "HnsCommunityAppGatewayUpstreamError";
}

const removedResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function removedByPrefix(name: string): boolean {
  return (
    name.startsWith("cf-access-") ||
    name.startsWith("x-pirate-gateway-") ||
    name.startsWith("x-pirate-hns-forwarder-")
  );
}

function invalidLocationValue(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

function locationAllowed(value: string, externalHost: string): boolean {
  if (value.startsWith("//") || value.includes("\\")) return false;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return !invalidLocationValue(value);
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.host === "pirate.sc" || url.host === externalHost)
    );
  } catch {
    return false;
  }
}

function headerSetCookies(headers: Headers): readonly string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers);
  const value = headers.get("set-cookie");
  return value === null ? [] : [value];
}

function invalidCookieValue(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x20 || point === 0x7f || character === ";" || character === ",") return true;
  }
  return false;
}

function validCookieLine(line: string): string | null {
  if (
    new TextEncoder().encode(line).byteLength > HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[12]
  ) {
    return null;
  }
  const members = line.split(";").map((member) => member.trim());
  const cookie = members.shift() ?? "";
  const separator = cookie.indexOf("=");
  if (separator <= 0) return null;
  const name = cookie.slice(0, separator);
  const value = cookie.slice(separator + 1);
  if (
    !HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_RESPONSE_COOKIES.includes(
      name as (typeof HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_RESPONSE_COOKIES)[number],
    ) ||
    invalidCookieValue(value)
  ) {
    return null;
  }

  const attributes = new Map<string, string | null>();
  for (const member of members) {
    if (member.length === 0) return null;
    const attributeSeparator = member.indexOf("=");
    const attributeName = (attributeSeparator === -1 ? member : member.slice(0, attributeSeparator))
      .trim()
      .toLowerCase();
    const attributeValue =
      attributeSeparator === -1 ? null : member.slice(attributeSeparator + 1).trim();
    if (attributes.has(attributeName)) return null;
    attributes.set(attributeName, attributeValue);
  }

  const allowedAttributes = new Set([
    "secure",
    "httponly",
    "path",
    "samesite",
    "max-age",
    "expires",
  ]);
  if ([...attributes.keys()].some((attribute) => !allowedAttributes.has(attribute))) return null;
  if (
    attributes.get("secure") !== null ||
    attributes.get("path") !== "/" ||
    attributes.get("samesite")?.toLowerCase() !== "lax"
  ) {
    return null;
  }
  const httpOnly = attributes.has("httponly") && attributes.get("httponly") === null;
  if ((name === "__Host-pirate_session") !== httpOnly) return null;

  const maximumAge = attributes.get("max-age");
  if (
    maximumAge !== undefined &&
    (maximumAge === null || !/^(?:0|[1-9][0-9]*)$/u.test(maximumAge))
  ) {
    return null;
  }
  const expires = attributes.get("expires");
  if (expires !== undefined) {
    const expiresAt = expires === null ? Number.NaN : Date.parse(expires);
    if (maximumAge !== "0" || !Number.isFinite(expiresAt) || expiresAt >= Date.now()) return null;
  }
  return name;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const maximum = HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[13];
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HnsCommunityAppGatewayUpstreamError("Upstream response is invalid");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new HnsCommunityAppGatewayUpstreamError("Upstream response is invalid");
      }
      chunks.push(part.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled over-bound stream may retain the reader briefly.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function sanitizeHnsCommunityAppGatewayResponse(
  upstream: Response,
  method: "GET" | "HEAD" | "POST" | "PATCH",
  externalHost: string,
): Promise<Response> {
  if (upstream.status < 200 || upstream.status > 599) {
    throw new HnsCommunityAppGatewayUpstreamError("Upstream response is invalid");
  }
  const location = upstream.headers.get("location");
  if (location !== null && !locationAllowed(location, externalHost)) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new HnsCommunityAppGatewayUpstreamError("Upstream response is invalid");
  }
  const body = await boundedBody(upstream);
  const declared = upstream.headers.get("content-length");
  if (method !== "HEAD" && declared !== null && Number(declared) !== body.byteLength) {
    throw new HnsCommunityAppGatewayUpstreamError("Upstream response is invalid");
  }
  if ((upstream.status === 204 || upstream.status === 304) && body.byteLength !== 0) {
    throw new HnsCommunityAppGatewayUpstreamError("Upstream response is invalid");
  }
  const setCookies = headerSetCookies(upstream.headers);
  const cookieNames = setCookies.map(validCookieLine);
  if (
    cookieNames.some((name) => name === null) ||
    new Set(cookieNames).size !== cookieNames.length
  ) {
    throw new HnsCommunityAppGatewayUpstreamError("Upstream response is invalid");
  }
  const connectionFields = (upstream.headers.get("connection") ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  const headers = new Headers();
  for (const [rawName, value] of upstream.headers) {
    const name = rawName.toLowerCase();
    if (
      removedResponseHeaders.has(name) ||
      connectionFields.includes(name) ||
      removedByPrefix(name)
    ) {
      continue;
    }
    headers.append(name, value);
  }
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  headers.set("cache-control", "no-store");
  if (method === "GET" || method === "POST" || method === "PATCH") {
    headers.set("content-length", String(body.byteLength));
  }
  const noBody = method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(noBody ? null : body, { status: upstream.status, headers });
}
