import { Schema } from "effect";
import type { ApiError, ApiErrorCtor, EndpointDefinition } from "./index.ts";

type JsonSchema = Record<string, unknown>;

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: OpenApiInfo;
  readonly paths: Record<string, Record<string, JsonSchema>>;
}

/**
 * Effect v4's own JSON Schema conversion — no AST sniffing. The generator
 * deliberately keeps schemas inline (small surface, no named component
 * reuse yet); if definitions grow, hoist them into `components/schemas`.
 */
export function schemaToOpenApi(value: unknown): JsonSchema {
  const document = Schema.toJsonSchemaDocument(value as Schema.Schema<unknown>);
  const schema = document.schema as JsonSchema;
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    schema.$defs = document.definitions as Record<string, JsonSchema>;
  }
  return schema;
}

const wireErrorBodySchema: JsonSchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" },
    details: { type: "object", additionalProperties: true },
    request_id: { type: "string" },
  },
  required: ["code", "message"],
};

/**
 * One OpenAPI response entry per distinct status in the endpoint's closed
 * error union. Status/code are read from a throwaway instance because the
 * catalog stores them as instance fields, not statics.
 */
function errorResponses(errors: readonly ApiErrorCtor[] | undefined): Record<string, JsonSchema> {
  const responses: Record<string, JsonSchema> = {};
  for (const Ctor of errors ?? []) {
    const instance = new Ctor({} as never) as ApiError;
    const status = String(instance.status);
    const existing = (responses[status]?.["x-error-codes"] as string[] | undefined) ?? [];
    responses[status] = {
      description: "Error envelope (old wire format)",
      content: { "application/json": { schema: wireErrorBodySchema } },
      "x-error-codes": [...existing, instance.code],
    };
  }
  return responses;
}

const pathParams = (path: string): readonly string[] =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? "");

const openApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const operationId = (endpoint: EndpointDefinition, index: number): string =>
  `${endpoint.method.toLowerCase()}_${
    endpoint.path
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, character: string) => character.toUpperCase())
      .replace(/^./, (character) => character.toLowerCase()) || `endpoint_${index}`
  }`;

type EndpointSource = readonly EndpointDefinition[] | Record<string, EndpointDefinition>;

const endpointList = (source: EndpointSource): readonly EndpointDefinition[] =>
  Array.isArray(source) ? source : Object.values(source);

export function generateOpenApi(
  source: EndpointSource,
  info: OpenApiInfo = { title: "Pirate API", version: "0.0.0" },
): OpenApiDocument {
  const endpoints = endpointList(source);
  const paths: Record<string, Record<string, JsonSchema>> = {};
  endpoints.forEach((endpoint, index) => {
    const pathName = openApiPath(endpoint.path);
    const path = paths[pathName] ?? {};
    paths[pathName] = path;
    const parameters = pathParams(endpoint.path).map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    path[endpoint.method.toLowerCase()] = {
      operationId: operationId(endpoint, index),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(endpoint.request
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: schemaToOpenApi(endpoint.request) } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Success",
          content: { "application/json": { schema: schemaToOpenApi(endpoint.response) } },
        },
        ...errorResponses(endpoint.errors),
      },
      "x-auth": endpoint.auth,
      "x-errors": endpoint.errors?.map((error) => error.name) ?? [],
    };
  });
  return { openapi: "3.1.0", info, paths };
}

export interface RouteBinding {
  readonly method: EndpointDefinition["method"];
  readonly path: string;
  readonly endpoint: EndpointDefinition;
}

export function generateRouteTable(source: EndpointSource): readonly RouteBinding[] {
  return endpointList(source).map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    endpoint,
  }));
}

/**
 * Typed fetch client. Method types come from the endpoint VALUES via
 * `Schema.Type`, so request/response stay schema-typed end to end and
 * contract drift fails to compile instead of failing at runtime.
 */
export function generateClient(registry: Record<string, EndpointDefinition>): string {
  const methods = Object.entries(registry).map(([key, endpoint], index) => ({
    ref: key,
    operationId: operationId(endpoint, index),
    method: endpoint.method,
    path: endpoint.path,
  }));
  const imports = methods.map(({ ref }) => `  ${ref},`).join("\n");
  const signatures = methods
    .map(
      ({ operationId, ref }) =>
        `  ${operationId}: (input: ClientInput<typeof ${ref}>) => Promise<ClientOutput<typeof ${ref}>>;`,
    )
    .join("\n");
  const bodies = methods
    .map(
      ({ operationId, method, path }) =>
        `  ${operationId}: (input) => request(${JSON.stringify(method)}, ${JSON.stringify(path)}, input),`,
    )
    .join("\n");
  return `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import type { Schema } from "effect";
import {
${imports}
} from "@pirate/contracts";

type ClientInput<E> = E extends { readonly request: Schema.Schema<infer I> } ? I : undefined;
type ClientOutput<E> = E extends { readonly response: Schema.Schema<infer A> } ? A : never;

export interface PirateApiClient {
${signatures}
}

export function createPirateApiClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): PirateApiClient {
  const request = async <T>(method: string, path: string, input: unknown): Promise<T> => {
    const url = Object.entries((input ?? {}) as Record<string, unknown>).reduce(
      (u, [key, value]) => u.replaceAll(\`:\${key}\`, encodeURIComponent(String(value))),
      path,
    );
    const response = await fetchImpl(new URL(url, baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    if (!response.ok) throw await response.json();
    return response.json() as Promise<T>;
  };
  return {
${bodies}
  };
}
`;
}
