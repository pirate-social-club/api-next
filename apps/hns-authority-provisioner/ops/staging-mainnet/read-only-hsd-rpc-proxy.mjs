import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const requestMaxBytes = 4_096;
const responseMaxBytes = 1_048_576;
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;

export function allowedHsdReadRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).join(",") !== "method,params" || !Array.isArray(value.params)) {
    return false;
  }
  const params = value.params;
  switch (value.method) {
    case "getblockchaininfo":
      return params.length === 0;
    case "getblockheader":
      return params.length === 2 && typeof params[0] === "string" &&
        hashPattern.test(params[0]) && params[1] === true;
    case "getblockbyheight":
      return params.length === 3 && Number.isSafeInteger(params[0]) &&
        params[0] >= 0 && params[0] <= 1_000_000_000 &&
        params[1] === true && params[2] === false;
    case "getnameinfo":
    case "getnameresource":
      return params.length === 2 && typeof params[0] === "string" &&
        namePattern.test(params[0]) && typeof params[1] === "boolean";
    default:
      return false;
  }
}

function sameSecret(received, expected) {
  if (typeof received !== "string") return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function boundedBytes(stream, maximum) {
  if (stream === null) return new Uint8Array();
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error("bounded exchange exceeded limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function createReadOnlyHsdRpcProxy({ clientKey, upstreamKey, fetcher = fetch }) {
  if (!clientKey || !upstreamKey || clientKey.length > 512 || upstreamKey.length > 512) {
    throw new Error("HNS mainnet reader configuration is invalid");
  }
  const clientAuthorization = `Basic ${Buffer.from(`x:${clientKey}`).toString("base64")}`;
  const upstreamAuthorization = `Basic ${Buffer.from(`x:${upstreamKey}`).toString("base64")}`;
  let inFlight = 0;
  const server = createServer(async (request, reply) => {
    reply.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST" || request.url !== "/") {
      reply.writeHead(404).end();
      return;
    }
    if (!sameSecret(request.headers.authorization, clientAuthorization)) {
      reply.writeHead(401).end();
      return;
    }
    if (inFlight >= 4) {
      reply.writeHead(503).end();
      return;
    }
    inFlight += 1;
    try {
      const bytes = await boundedBytes(request, requestMaxBytes);
      const body = bytes.toString("utf8");
      const parsed = JSON.parse(body);
      if (!allowedHsdReadRequest(parsed) || JSON.stringify(parsed) !== body) {
        reply.writeHead(403).end();
        return;
      }
      const upstream = await fetcher("http://127.0.0.1:12037/", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
        headers: {
          accept: "application/json",
          authorization: upstreamAuthorization,
          "content-type": "application/json",
        },
        body,
      });
      if (!upstream.ok || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
        upstream.headers.get("content-type") ?? "",
      )) {
        reply.writeHead(502).end();
        return;
      }
      const response = await boundedBytes(upstream.body, responseMaxBytes);
      reply.writeHead(200, { "Content-Type": "application/json" }).end(response);
    } catch {
      reply.writeHead(502).end();
    } finally {
      inFlight -= 1;
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  const upstreamKey = process.env.HSD_API_KEY;
  if (!directory || !upstreamKey) throw new Error("HNS mainnet reader configuration is missing");
  const clientKey = (await readFile(`${directory}/staging-hsd-client-key`, "utf8")).trim();
  const server = createReadOnlyHsdRpcProxy({ clientKey, upstreamKey });
  server.listen(12039, "127.0.0.1");
}
