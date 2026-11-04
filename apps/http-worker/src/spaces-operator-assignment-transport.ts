import { SpacesOperatorPrepareRequestV1 } from "@pirate/contracts";
import {
  SpacesOperatorAssignmentRefused,
  type SpacesOperatorAssignmentStore,
  SpacesOperatorCapabilityReportV1,
  SpacesOperatorFundingReportV1,
} from "@pirate/platform-cf/spaces-operator-assignment-repository";
import { Schema } from "effect";

const BASE = "/internal/spaces-operators/v1/assignments";

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

const readExactBody = async (
  request: Request,
  kind: "prepare" | "capability" | "funding",
): Promise<unknown> => {
  const reader = request.body?.getReader();
  if (reader === undefined) throw new SpacesOperatorAssignmentRefused("invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4_096) {
      await reader.cancel();
      throw new SpacesOperatorAssignmentRefused("invalid");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(raw);
    const decoded =
      kind === "prepare"
        ? Schema.decodeUnknownSync(SpacesOperatorPrepareRequestV1, { onExcessProperty: "error" })(
            parsed,
          )
        : kind === "capability"
          ? Schema.decodeUnknownSync(SpacesOperatorCapabilityReportV1, {
              onExcessProperty: "error",
            })(parsed)
          : Schema.decodeUnknownSync(SpacesOperatorFundingReportV1, { onExcessProperty: "error" })(
              parsed,
            );
    if (raw !== JSON.stringify(decoded)) throw new Error("noncanonical JSON");
    return decoded;
  } catch {
    throw new SpacesOperatorAssignmentRefused("invalid");
  }
};

/** Installed only when a scoped operator store is explicitly provided. */
export function makeSpacesOperatorAssignmentTransport(store: SpacesOperatorAssignmentStore) {
  return {
    matches: (pathname: string) => pathname === BASE || pathname.startsWith(`${BASE}/`),
    serve: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      const token = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization ?? "")?.[1];
      if (token === undefined)
        return reply(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      try {
        if (url.pathname === `${BASE}/prepare` && request.method === "POST" && url.search === "") {
          const result = await store.prepare(token, await readExactBody(request, "prepare"));
          return reply(result.replayed ? 200 : 201, result);
        }
        if (
          url.pathname === `${BASE}/capability` &&
          request.method === "POST" &&
          url.search === ""
        ) {
          const result = await store.reportCapability(
            token,
            await readExactBody(request, "capability"),
          );
          return reply(result.replayed ? 200 : 201, result);
        }
        if (url.pathname === `${BASE}/funding` && request.method === "POST" && url.search === "") {
          const result = await store.reportFunding(token, await readExactBody(request, "funding"));
          return reply(result.replayed ? 200 : 201, result);
        }
        const match =
          /^\/internal\/spaces-operators\/v1\/assignments\/(sassign_[0-9a-f]{32})$/u.exec(
            url.pathname,
          );
        if (
          match?.[1] !== undefined &&
          request.method === "GET" &&
          url.searchParams.size === 1 &&
          url.searchParams.has("generation")
        ) {
          const generation = Number(url.searchParams.get("generation"));
          if (!Number.isSafeInteger(generation) || generation < 1)
            return reply(400, { error: "invalid_request" });
          return reply(200, await store.readback(token, match[1], generation));
        }
        const report =
          /^\/internal\/spaces-operators\/v1\/assignments\/(capability|funding)\/(sopsreport_[0-9a-f]{32})$/u.exec(
            url.pathname,
          );
        if (
          report?.[1] !== undefined &&
          report[2] !== undefined &&
          request.method === "GET" &&
          url.search === ""
        ) {
          return reply(
            200,
            await store.readbackReport(
              token,
              report[1] === "capability" ? "capability_report" : "funding_report",
              report[2],
            ),
          );
        }
        if (
          [`${BASE}/prepare`, `${BASE}/capability`, `${BASE}/funding`].includes(url.pathname) ||
          match !== null ||
          report !== null
        ) {
          return reply(405, { error: "method_not_allowed" });
        }
        return reply(404, { error: "not_found" });
      } catch (error) {
        if (error instanceof SpacesOperatorAssignmentRefused) {
          const status = {
            invalid: 400,
            unauthorized: 401,
            forbidden: 403,
            conflict: 409,
            unavailable: 503,
            not_found: 404,
          }[error.reason];
          return reply(status, { error: error.reason });
        }
        return reply(503, { error: "operator_unavailable" });
      }
    },
  };
}
