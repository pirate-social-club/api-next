import { HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE } from "@pirate/application/hns-community-handle-gateway";

export class HnsCommunityHandleGatewayUpstreamError extends Error {
  readonly name = "HnsCommunityHandleGatewayUpstreamError";
}

const allowedResponseHeaders = new Set([
  "content-type",
  "content-language",
  "content-encoding",
  "etag",
  "last-modified",
  "content-security-policy",
  "content-security-policy-report-only",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "x-content-type-options",
]);

async function boundedBody(response: Response): Promise<Uint8Array> {
  const maximum = HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[13];
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HnsCommunityHandleGatewayUpstreamError("Upstream response is invalid");
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
        throw new HnsCommunityHandleGatewayUpstreamError("Upstream response is invalid");
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

export async function sanitizeHnsCommunityHandleGatewayResponse(
  upstream: Response,
  method: "GET" | "HEAD",
): Promise<Response> {
  if (upstream.status === 404 || upstream.status === 503) {
    await upstream.body?.cancel().catch(() => undefined);
    return new Response(null, {
      status: upstream.status,
      headers: { "cache-control": "no-store" },
    });
  }
  if (
    upstream.status !== 200 ||
    upstream.headers.has("location") ||
    upstream.headers.has("set-cookie")
  ) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new HnsCommunityHandleGatewayUpstreamError("Upstream response is invalid");
  }
  const body = await boundedBody(upstream);
  const declared = upstream.headers.get("content-length");
  if (method === "GET" && declared !== null && Number(declared) !== body.byteLength) {
    throw new HnsCommunityHandleGatewayUpstreamError("Upstream response is invalid");
  }
  const headers = new Headers();
  for (const [rawName, value] of upstream.headers) {
    const name = rawName.toLowerCase();
    if (allowedResponseHeaders.has(name)) headers.append(name, value);
  }
  headers.set("cache-control", "no-store");
  headers.set("content-length", String(method === "HEAD" ? 0 : body.byteLength));
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}
