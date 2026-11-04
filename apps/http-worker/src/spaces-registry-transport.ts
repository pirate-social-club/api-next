import {
  makeSpacesRegistryService,
  type SpacesRegistryEnvironmentV1,
  type SpacesRegistryStore,
} from "@pirate/application/use-cases/handles/spaces-registry";
import { Effect } from "effect";

/** The upstream operator calls these paths; no public route table names them. */
export type SpacesRegistryTransportOptions = Readonly<{
  basePath: string;
  store: SpacesRegistryStore;
  environment: SpacesRegistryEnvironmentV1;
  pageCapacity: number;
}>;

const MAX_BODY_BYTES = 1_048_576;
const PATHS = ["health", "pending", "ack", "committed"] as const;
type RegistryPath = (typeof PATHS)[number];

const reply = (
  status: number,
  body: unknown,
  extra?: ConstructorParameters<typeof Headers>[0],
): Response => {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
};

const readJson = async (
  request: Request,
): Promise<{ kind: "body"; value: unknown } | { kind: "bad_request" } | { kind: "too_large" }> => {
  const reader = request.body?.getReader();
  if (reader === undefined) return { kind: "bad_request" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { kind: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      kind: "body",
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { kind: "bad_request" };
  }
};

export function makeSpacesRegistryTransport(options: SpacesRegistryTransportOptions) {
  if (
    !/^\/internal\/[a-z0-9/-]+$/u.test(options.basePath) ||
    options.basePath.endsWith("/") ||
    options.basePath.includes("//")
  ) {
    throw new TypeError("Spaces registry private base path is invalid");
  }
  const service = makeSpacesRegistryService(options);
  const basePath = options.basePath;

  return {
    matches: (pathname: string) => pathname.startsWith(`${basePath}/`),
    serve: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname.slice(basePath.length + 1);
      if (!PATHS.includes(path as RegistryPath)) return reply(404, { error: "not_found" });
      const authorization = request.headers.get("authorization");
      const token = /^Bearer ([A-Za-z0-9._~-]+)$/iu.exec(authorization ?? "")?.[1];
      if (token === undefined) {
        return reply(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      }
      try {
        const credential = await Effect.runPromise(service.authenticate(token));
        if (credential === null) {
          return reply(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        }
        const expectedMethod = path === "health" || path === "pending" ? "GET" : "POST";
        if (request.method !== expectedMethod) {
          return reply(405, { error: "method_not_allowed" }, { allow: expectedMethod });
        }
        if (path === "health") return reply(200, { status: "ok" });
        if (path === "pending") {
          const result = await Effect.runPromise(
            service.pending(credential, url.searchParams.getAll("space")),
          );
          if (result.kind === "invalid_request") return reply(400, { error: "invalid_request" });
          if (result.kind === "forbidden") return reply(403, { error: "forbidden" });
          return reply(200, { handles: result.handles });
        }
        const parsed = await readJson(request);
        if (parsed.kind === "too_large") return reply(413, { error: "payload_too_large" });
        if (parsed.kind === "bad_request") return reply(400, { error: "invalid_request" });
        const result = await Effect.runPromise(
          path === "ack"
            ? service.acknowledge(credential, parsed.value)
            : service.committed(credential, parsed.value),
        );
        return result.kind === "invalid_request"
          ? reply(400, { error: "invalid_request" })
          : reply(200, { status: "ok", summary: result.summary });
      } catch {
        return reply(503, { error: "registry_unavailable" });
      }
    },
  };
}
