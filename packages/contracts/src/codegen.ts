import type { EndpointDefinition } from "./endpoint.ts";

type JsonSchema = Record<string, unknown>;

/** The small runtime surface of an Effect Schema used by the generator. */
interface SchemaLike {
  readonly ast?: {
    readonly _tag?: string;
    readonly literal?: unknown;
    readonly propertySignatures?: ReadonlyArray<{
      readonly name: string;
      readonly type: { readonly ast?: SchemaLike["ast"] };
    }>;
    readonly rest?: ReadonlyArray<{ readonly ast?: SchemaLike["ast"] }>;
    readonly types?: ReadonlyArray<{ readonly ast?: SchemaLike["ast"] }>;
    readonly context?: { readonly isOptional?: boolean };
  };
}

const schema = (value: unknown): SchemaLike | undefined =>
  typeof value === "object" && value !== null && "ast" in value ? (value as SchemaLike) : undefined;

/** Convert the intentionally small set of schemas used at the HTTP boundary. */
export function schemaToOpenApi(value: unknown): JsonSchema {
  const ast = schema(value)?.ast;
  if (!ast) return {};
  switch (ast._tag) {
    case "String":
      return { type: "string" };
    case "Number":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "Null":
      return { type: "null" };
    case "Literal":
      return { const: ast.literal, type: typeof ast.literal };
    case "Arrays":
      return { type: "array", items: schemaToOpenApi(ast.rest?.[0]) };
    case "Union":
      return { anyOf: (ast.types ?? []).map((member) => schemaToOpenApi(member)) };
    case "Objects": {
      const properties: JsonSchema = {};
      const required: string[] = [];
      for (const field of ast.propertySignatures ?? []) {
        properties[field.name] = schemaToOpenApi({ ast: field.type.ast });
        if (!field.type.ast?.context?.isOptional) required.push(field.name);
      }
      const result: JsonSchema = { type: "object", properties, additionalProperties: false };
      if (required.length > 0) result.required = required;
      return result;
    }
    default:
      return {};
  }
}

const operationId = (endpoint: EndpointDefinition, index: number): string =>
  `${endpoint.method.toLowerCase()}_${
    endpoint.path
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, character: string) => character.toUpperCase())
      .replace(/^./, (character) => character.toLowerCase()) || `endpoint_${index}`
  }`;

const openApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, JsonSchema>>;
}

export function generateOpenApi(
  endpoints: readonly EndpointDefinition[],
  info = { title: "Pirate API", version: "0.0.0" },
): OpenApiDocument {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  endpoints.forEach((endpoint, index) => {
    const pathName = openApiPath(endpoint.path);
    const path = paths[pathName] ?? {};
    paths[pathName] = path;
    path[endpoint.method.toLowerCase()] = {
      operationId: operationId(endpoint, index),
      ...(endpoint.request
        ? {
            requestBody: {
              content: { "application/json": { schema: schemaToOpenApi(endpoint.request) } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Success",
          content: { "application/json": { schema: schemaToOpenApi(endpoint.response) } },
        },
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

export function generateRouteTable(
  endpoints: readonly EndpointDefinition[],
): readonly RouteBinding[] {
  return endpoints.map((endpoint) => ({ method: endpoint.method, path: endpoint.path, endpoint }));
}

/** Generated client source is deliberately dependency-free and uses fetch. */
export function generateClient(endpoints: readonly EndpointDefinition[]): string {
  const methods = endpoints.map((endpoint, index) => {
    const name = operationId(endpoint, index);
    return { name, method: endpoint.method, path: endpoint.path };
  });
  return `// GENERATED FILE. DO NOT EDIT.\nexport interface PirateApiClient {\n${methods.map(({ name }) => `  ${name}: (input?: unknown) => Promise<unknown>;`).join("\n")}\n}\n\nexport function createPirateApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): PirateApiClient {\n  const request = async (method: string, path: string, input: unknown) => {\n    const response = await fetchImpl(new URL(path, baseUrl), { method, headers: { "content-type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });\n    if (!response.ok) throw await response.json();\n    return response.json();\n  };\n  return {\n${methods.map(({ name, method, path }) => `    ${JSON.stringify(name)}: (input = undefined) => request(${JSON.stringify(method)}, ${JSON.stringify(path)}, input),`).join("\n")}\n  };\n}\n`;
}
