import { HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE } from "@pirate/application/hns-static-platform-app-gateway";

export class HnsStaticPlatformGatewayUpstreamError extends Error {
  readonly name = "HnsStaticPlatformGatewayUpstreamError";
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

function locationAllowed(value: string): boolean {
  if (value.startsWith("//") || value.includes("\\")) return false;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return !invalidLocationValue(value);
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.host === "pirate.sc" || url.host === "app.pirate")
    );
  } catch {
    return false;
  }
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const maximum = HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE[9];
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HnsStaticPlatformGatewayUpstreamError("Upstream response is invalid");
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
        throw new HnsStaticPlatformGatewayUpstreamError("Upstream response is invalid");
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

export async function sanitizeHnsStaticPlatformGatewayResponse(
  upstream: Response,
  method: "GET" | "HEAD",
): Promise<Response> {
  if (upstream.status < 200 || upstream.status > 599) {
    throw new HnsStaticPlatformGatewayUpstreamError("Upstream response is invalid");
  }
  const location = upstream.headers.get("location");
  if (location !== null && !locationAllowed(location)) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new HnsStaticPlatformGatewayUpstreamError("Upstream response is invalid");
  }
  const body = await boundedBody(upstream);
  const declared = upstream.headers.get("content-length");
  if (method === "GET" && declared !== null && Number(declared) !== body.byteLength) {
    throw new HnsStaticPlatformGatewayUpstreamError("Upstream response is invalid");
  }
  if ((upstream.status === 204 || upstream.status === 304) && body.byteLength !== 0) {
    throw new HnsStaticPlatformGatewayUpstreamError("Upstream response is invalid");
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
  headers.set("cache-control", "no-store");
  if (method === "GET") headers.set("content-length", String(body.byteLength));
  const noBody = method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(noBody ? null : body, { status: upstream.status, headers });
}
