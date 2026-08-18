import { Schema } from "effect";
import type { ApiError, ApiErrorCtor, EndpointDefinition, EndpointRequest } from "./index.ts";

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

function requestSchemas(endpoint: EndpointDefinition): EndpointRequest | undefined {
  const request = endpoint.request;
  if (request === undefined) return undefined;
  if (
    typeof request === "object" &&
    request !== null &&
    ("body" in request ||
      "bodyRequired" in request ||
      "bodyEncoding" in request ||
      "headers" in request ||
      "path" in request ||
      "query" in request)
  ) {
    return request as EndpointRequest;
  }
  // Compatibility for the phase-0 request shorthand: a schema value meant a
  // required JSON body. New endpoint declarations use the explicit shape.
  return { body: request as Schema.Schema<unknown> };
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
    const previous = responses[status];
    const existing = (previous?.["x-error-codes"] as string[] | undefined) ?? [];
    responses[status] = {
      description: "Error envelope (old wire format)",
      content: { "application/json": { schema: wireErrorBodySchema } },
      "x-error-codes": [...existing, instance.code],
      ...(previous?.headers === undefined ? {} : { headers: previous.headers }),
      ...(instance.code === "verification_start_in_progress"
        ? {
            headers: {
              "Retry-After": {
                required: true,
                schema: { type: "string", pattern: "^[1-9][0-9]*$" },
              },
            },
          }
        : {}),
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
    const request = requestSchemas(endpoint);
    const pathSchema = request?.path ? schemaToOpenApi(request.path) : undefined;
    const querySchema = request?.query ? schemaToOpenApi(request.query) : undefined;
    const headersSchema = request?.headers ? schemaToOpenApi(request.headers) : undefined;
    const pathProperties = (pathSchema?.properties as Record<string, JsonSchema> | undefined) ?? {};
    const queryProperties =
      (querySchema?.properties as Record<string, JsonSchema> | undefined) ?? {};
    const headerProperties =
      (headersSchema?.properties as Record<string, JsonSchema> | undefined) ?? {};
    const requiredPath = new Set((pathSchema?.required as string[] | undefined) ?? []);
    const requiredQuery = new Set((querySchema?.required as string[] | undefined) ?? []);
    const requiredHeaders = new Set((headersSchema?.required as string[] | undefined) ?? []);
    const parameters = [
      ...pathParams(endpoint.path).map((name) => ({
        name,
        in: "path",
        required: requiredPath.size === 0 || requiredPath.has(name),
        schema: pathProperties[name] ?? { type: "string" },
      })),
      ...Object.entries(queryProperties).map(([name, schema]) => ({
        name,
        in: "query",
        required: requiredQuery.has(name),
        schema,
      })),
      ...Object.entries(headerProperties).map(([name, schema]) => ({
        name,
        in: "header",
        required: requiredHeaders.has(name),
        schema,
      })),
    ];
    const successStatuses =
      endpoint.successStatus === undefined
        ? [200]
        : Array.isArray(endpoint.successStatus)
          ? endpoint.successStatus
          : [endpoint.successStatus];
    const successResponses = Object.fromEntries(
      successStatuses.map((status) => [
        String(status),
        {
          description: "Success",
          content: { "application/json": { schema: schemaToOpenApi(endpoint.response) } },
        },
      ]),
    );
    path[endpoint.method.toLowerCase()] = {
      operationId: operationId(endpoint, index),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(request?.body
        ? {
            requestBody: {
              required: request.bodyRequired !== false,
              content: {
                [request.bodyEncoding === "raw-text" ? "text/plain" : "application/json"]: {
                  schema: schemaToOpenApi(request.body),
                },
              },
            },
          }
        : {}),
      responses: {
        ...successResponses,
        ...errorResponses(endpoint.errors),
      },
      "x-auth": endpoint.auth,
      "x-errors": endpoint.errors?.map((error) => error.name) ?? [],
    };
  });
  return { openapi: "3.1.0", info, paths };
}

export interface RouteBinding {
  readonly name: string;
  readonly method: EndpointDefinition["method"];
  readonly path: string;
  readonly endpoint: EndpointDefinition;
}

export function generateRouteTable(source: EndpointSource): readonly RouteBinding[] {
  const entries = Array.isArray(source)
    ? source.map((endpoint, index) => [`endpoint_${index}`, endpoint] as const)
    : Object.entries(source);
  return entries.map(([name, endpoint]) => ({
    name,
    method: endpoint.method,
    path: endpoint.path,
    endpoint,
  }));
}

export interface ClientErrorDefinition {
  readonly status: number;
  readonly code: string;
  readonly name: string;
  readonly retryable: boolean;
}

function clientErrorDefinitions(
  errors: readonly ApiErrorCtor[] | undefined,
): readonly ClientErrorDefinition[] {
  return (errors ?? []).map((Ctor) => {
    const instance = new Ctor({} as never) as ApiError;
    return {
      status: instance.status,
      code: instance.code,
      name: Ctor.name,
      retryable: instance.retryable,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const typeLiteral = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === null) return "null";
  return "unknown";
};

/**
 * Convert the JSON Schema emitted by Effect to a declaration suitable for the
 * standalone client. This intentionally consumes the same frozen schema
 * document used by OpenAPI and response validation; it is not a second,
 * hand-maintained model of an endpoint.
 */
function jsonSchemaToType(
  value: JsonSchema,
  root: JsonSchema = value,
  depth = 0,
  resolving: ReadonlySet<string> = new Set(),
): string {
  if (depth > 32) return "unknown";

  if (typeof value.$ref === "string") {
    const name = value.$ref.startsWith("#/$defs/") ? value.$ref.slice("#/$defs/".length) : "";
    const definitions = isRecord(root.$defs) ? root.$defs : undefined;
    const target = name === "" || definitions === undefined ? undefined : definitions[name];
    if (!isRecord(target) || resolving.has(name)) return "unknown";
    return jsonSchemaToType(target, root, depth + 1, new Set([...resolving, name]));
  }
  if (value.const !== undefined) return typeLiteral(value.const);
  if (Array.isArray(value.enum)) return value.enum.map(typeLiteral).join(" | ") || "never";

  const union = Array.isArray(value.anyOf)
    ? value.anyOf.filter(isRecord).map((part) => jsonSchemaToType(part, root, depth + 1, resolving))
    : Array.isArray(value.oneOf)
      ? value.oneOf
          .filter(isRecord)
          .map((part) => jsonSchemaToType(part, root, depth + 1, resolving))
      : undefined;
  if (union !== undefined) {
    const unique = [...new Set(union)];
    return unique.length === 0 ? "unknown" : unique.join(" | ");
  }
  if (Array.isArray(value.allOf)) {
    const intersection = value.allOf
      .filter(isRecord)
      .map((part) => jsonSchemaToType(part, root, depth + 1, resolving));
    return intersection.length === 0 ? "unknown" : intersection.join(" & ");
  }

  const type = value.type;
  if (Array.isArray(type)) {
    return type
      .map((member) => jsonSchemaToType({ type: member }, root, depth + 1, resolving))
      .join(" | ");
  }
  if (type === "null") return "null";
  if (type === "boolean") return "boolean";
  if (type === "integer" || type === "number") return "number";
  if (type === "string") return "string";
  if (type === "array") {
    return `ReadonlyArray<${isRecord(value.items) ? jsonSchemaToType(value.items, root, depth + 1, resolving) : "unknown"}>`;
  }
  if (type === "object" || isRecord(value.properties)) {
    const properties = isRecord(value.properties) ? value.properties : {};
    const required = new Set(
      Array.isArray(value.required)
        ? value.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const fields = Object.entries(properties).map(([name, property]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
      const optional = required.has(name) ? "" : "?";
      const type = isRecord(property)
        ? jsonSchemaToType(property, root, depth + 1, resolving)
        : "unknown";
      return `readonly ${key}${optional}: ${type}`;
    });
    const additional = value.additionalProperties;
    if (additional === true || isRecord(additional)) {
      const additionalType = isRecord(additional)
        ? jsonSchemaToType(additional, root, depth + 1, resolving)
        : "unknown";
      fields.push(`readonly [key: string]: ${additionalType}`);
    }
    return fields.length === 0 ? "Readonly<Record<string, unknown>>" : `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}

const pascalCase = (value: string): string =>
  value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("") || "Operation";

function clientInputType(endpoint: EndpointDefinition): string {
  const request = requestSchemas(endpoint);
  if (request === undefined) return "undefined";
  const fields: string[] = [];
  if (request.body !== undefined) {
    const schema = schemaToOpenApi(request.body);
    fields.push(
      `readonly body${request.bodyRequired === false ? "?" : ""}: ${jsonSchemaToType(schema)}`,
    );
  }
  if (request.headers !== undefined) {
    fields.push(`readonly headers: ${jsonSchemaToType(schemaToOpenApi(request.headers))}`);
  }
  if (request.path !== undefined) {
    fields.push(`readonly path: ${jsonSchemaToType(schemaToOpenApi(request.path))}`);
  }
  if (request.query !== undefined) {
    fields.push(`readonly query?: ${jsonSchemaToType(schemaToOpenApi(request.query))}`);
  }
  return fields.length === 0 ? "undefined" : `{ ${fields.join("; ")} }`;
}

function clientErrorType(
  operationTypeName: string,
  errors: readonly ClientErrorDefinition[],
): string {
  if (errors.length === 0) return "never";
  const members = errors.map(
    (error) =>
      `(ApiClientError & { readonly status: ${error.status}; readonly code: ${JSON.stringify(error.code)}; readonly declaredName: ${JSON.stringify(error.name)}; readonly retryable: boolean | undefined${error.code === "verification_start_in_progress" ? "; readonly retryAfterSeconds: number | undefined" : ""} })`,
  );
  return members.join(" | ").replace(/^/, `/* ${operationTypeName} declared errors */ `);
}

/** Generate a typed, runtime-validating client without package/runtime imports. */
export function generateClient(registry: Record<string, EndpointDefinition>): string {
  const methods = Object.entries(registry).map(([key, endpoint], index) => ({
    ref: key,
    operationId: operationId(endpoint, index),
    operationTypeName: pascalCase(operationId(endpoint, index)),
    registryTypeName: pascalCase(key),
    inputType: clientInputType(endpoint),
    responseType: jsonSchemaToType(schemaToOpenApi(endpoint.response)),
    method: endpoint.method,
    path: endpoint.path,
    responseSchema: schemaToOpenApi(endpoint.response),
    bodyEncoding: requestSchemas(endpoint)?.bodyEncoding ?? "json",
    successStatuses:
      endpoint.successStatus === undefined
        ? [200]
        : Array.isArray(endpoint.successStatus)
          ? endpoint.successStatus
          : [endpoint.successStatus],
    errors: clientErrorDefinitions(endpoint.errors),
  }));
  const signatures = methods
    .map(
      ({ operationId, operationTypeName }) =>
        `  ${operationId}: (input: ${operationTypeName}Input, options?: PirateApiRequestOptions) => Promise<${operationTypeName}Response>;`,
    )
    .join("\n");
  const bodies = methods
    .map(
      ({ operationId, method, path, bodyEncoding }) =>
        `  ${operationId}: (input, options) => request(${JSON.stringify(operationId)}, ${JSON.stringify(method)}, ${JSON.stringify(path)}, input, options${bodyEncoding === "json" ? "" : `, ${JSON.stringify(bodyEncoding)}`}),`,
    )
    .join("\n");
  const responseSchemas = methods
    .map(
      ({ operationId, responseSchema }) =>
        `  ${JSON.stringify(operationId)}: ${JSON.stringify(responseSchema)},`,
    )
    .join("\n");
  const successStatuses = methods
    .map(
      ({ operationId, successStatuses }) =>
        `  ${JSON.stringify(operationId)}: ${JSON.stringify(successStatuses)},`,
    )
    .join("\n");
  const errorDefinitions = methods
    .map(
      ({ operationId, errors }) => `  ${JSON.stringify(operationId)}: ${JSON.stringify(errors)},`,
    )
    .join("\n");
  const operationTypes = methods
    .map(({ operationTypeName, inputType, responseType, errors }) => {
      const errorType = clientErrorType(operationTypeName, errors);
      return `export type ${operationTypeName}Input = ${inputType};
export type ${operationTypeName}Response = ${responseType};
export type ${operationTypeName}Error = ${errorType};`;
    })
    .join("\n\n");
  const registryAliases = methods
    .filter(({ registryTypeName, operationTypeName }) => registryTypeName !== operationTypeName)
    .map(
      ({ registryTypeName, operationTypeName }) =>
        `export type ${registryTypeName}Input = ${operationTypeName}Input;
export type ${registryTypeName}Response = ${operationTypeName}Response;
export type ${registryTypeName}Error = ${operationTypeName}Error;`,
    )
    .join("\n\n");
  return `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
${operationTypes}

${registryAliases}

export interface PirateApiRequestOptions {
  readonly headers?: Headers | readonly [string, string][] | Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Browser cookie mode is limited to the same-origin Solid /api proxy. */
  readonly credentials?: "omit" | "same-origin";
}
export interface PirateApiClientOptions extends PirateApiRequestOptions {
  readonly fetchImpl?: typeof fetch;
}
type JsonSchema = Record<string, unknown>;
export interface ApiClientErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown> | null;
  readonly request_id?: string;
}
export interface ApiClientErrorDefinition {
  readonly status: number;
  readonly code: string;
  readonly name: string;
  readonly retryable: boolean;
}

export class ApiClientProtocolError extends Error {
  readonly _tag = "ApiClientProtocolError" as const;
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined = undefined) {
    super(message);
    this.name = "ApiClientProtocolError";
    this.status = status;
  }
}
export class ApiClientResponseValidationError extends Error {
  readonly _tag = "ApiClientResponseValidationError" as const;
  readonly operation: string;
  readonly status: number;
  readonly path: string;
  constructor(operation: string, status: number, path: string) {
    super("API response failed schema validation for " + operation + " at " + path);
    this.name = "ApiClientResponseValidationError";
    this.operation = operation;
    this.status = status;
    this.path = path;
  }
}
export class ApiClientError extends Error {
  readonly _tag = "ApiClientError" as const;
  readonly status: number;
  readonly code: string;
  readonly declaredName: string;
  readonly retryable: boolean | undefined;
  readonly details: Record<string, unknown> | null | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(definition: ApiClientErrorDefinition, body: ApiClientErrorBody, responseHeaders?: Headers) {
    super(body.message);
    this.name = definition.name;
    this.status = definition.status;
    this.code = body.code;
    this.declaredName = definition.name;
    this.retryable = body.retryable;
    this.details = body.details;
    this.requestId = body.request_id;
    const retryAfter = responseHeaders?.get("retry-after");
    const parsedRetryAfter = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
    this.retryAfterSeconds =
      Number.isSafeInteger(parsedRetryAfter) && parsedRetryAfter >= 1 && parsedRetryAfter <= 86400
        ? parsedRetryAfter
        : undefined;
  }
}
export class ApiClientUnexpectedError extends Error {
  readonly _tag = "ApiClientUnexpectedError" as const;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean | undefined;
  readonly details: Record<string, unknown> | null | undefined;
  readonly requestId: string | undefined;
  constructor(status: number, body: ApiClientErrorBody) {
    super("Unexpected declared API error: " + body.code);
    this.name = "ApiClientUnexpectedError";
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
    this.details = body.details;
    this.requestId = body.request_id;
  }
}

const RESPONSE_SCHEMAS: Record<string, JsonSchema> = {
${responseSchemas}
};
const SUCCESS_STATUSES: Record<string, readonly number[]> = {
${successStatuses}
};
const ERROR_DEFINITIONS: Record<string, readonly ApiClientErrorDefinition[]> = {
${errorDefinitions}
};
const WIRE_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" },
    details: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
    request_id: { type: "string" },
  },
  additionalProperties: true,
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function schemaError(value: unknown, schema: JsonSchema, path: string, root: JsonSchema): string | undefined {
  if (typeof schema.$ref === "string") {
    const defs = record(root.$defs) ? root.$defs : undefined;
    const target = typeof defs === "object" && defs !== null ? defs[schema.$ref.slice("#/$defs/".length)] : undefined;
    if (!record(target)) return "missing schema definition";
    return schemaError(value, target, path, root);
  }
  if (schema.const !== undefined && !Object.is(value, schema.const)) return "constant mismatch";
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return "enum mismatch";
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) if (record(part)) {
      const error = schemaError(value, part, path, root);
      if (error !== undefined) return error;
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part) => record(part) && schemaError(value, part, path, root) === undefined)) return "union mismatch";
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((part) => record(part) && schemaError(value, part, path, root) === undefined).length !== 1) return "union mismatch";
  const type = schema.type;
  if (Array.isArray(type)) {
    if (!type.some((candidate) => typeof candidate === "string" && schemaError(value, { type: candidate }, path, root) === undefined)) return "type mismatch";
    return undefined;
  }
  if (type === "null" && value !== null) return "expected null";
  if (type === "boolean" && typeof value !== "boolean") return "expected boolean";
  if (type === "string" && typeof value !== "string") return "expected string";
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return "expected number";
  if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return "expected integer";
  if (type === "array") {
    if (!Array.isArray(value)) return "expected array";
    if (record(schema.items)) for (let index = 0; index < value.length; index += 1) {
      const error = schemaError(value[index], schema.items, path + "[" + index + "]", root);
      if (error !== undefined) return error;
    }
  }
  if (type === "object") {
    if (!record(value)) return "expected object";
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === "string" && !(key in value)) return "missing required property " + key;
    const properties = record(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) if (key in value && record(child)) {
      const error = schemaError(value[key], child, path + "." + key, root);
      if (error !== undefined) return error;
    }
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) return "unexpected property " + key;
  }
  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) return "string too short";
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern).test(value)) return "string pattern mismatch";
  return undefined;
}
function parseWireError(value: unknown, status: number): ApiClientErrorBody {
  if (schemaError(value, WIRE_ERROR_SCHEMA, "$", WIRE_ERROR_SCHEMA) !== undefined || !record(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    throw new ApiClientProtocolError("API error response was not a valid wire envelope", status);
  }
  return value as unknown as ApiClientErrorBody;
}

export interface PirateApiClient {
${signatures}
}
export function createPirateApiClient(baseUrl: string, optionsOrFetch: PirateApiClientOptions | typeof fetch = {}): PirateApiClient {
  const config: PirateApiClientOptions =
    typeof optionsOrFetch === "function" ? { fetchImpl: optionsOrFetch } : optionsOrFetch;
  const fetchImpl = config.fetchImpl ?? fetch;
  const request = async <T>(operation: string, method: string, path: string, input: unknown, options?: PirateApiRequestOptions, bodyEncoding: "json" | "raw-text" = "json"): Promise<T> => {
    const requestInput = (input ?? {}) as { body?: unknown; headers?: Record<string, unknown>; path?: Record<string, unknown>; query?: Record<string, unknown> };
    const pathValue = Object.entries(requestInput.path ?? {}).reduce((urlPath, [key, value]) => urlPath.split(":" + key).join(encodeURIComponent(String(value))), path);
    const url = new URL(pathValue, baseUrl);
    for (const [key, value] of Object.entries(requestInput.query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers = new Headers();
    if (requestInput.headers !== undefined) {
      for (const [key, value] of Object.entries(requestInput.headers)) {
        if (value !== undefined && value !== null) headers.set(key, String(value));
      }
    }
    const addHeaders = (init: PirateApiRequestOptions["headers"] | undefined) => {
      if (init instanceof Headers) init.forEach((value, key) => headers.set(key, value));
      else if (Array.isArray(init)) for (const [key, value] of init) headers.set(key, value);
      else if (init !== undefined) for (const [key, value] of Object.entries(init)) headers.set(key, value);
    };
    addHeaders(config.headers);
    addHeaders(options?.headers);
    if (requestInput.body !== undefined && !headers.has("content-type")) headers.set("content-type", bodyEncoding === "raw-text" ? "text/plain" : "application/json");
    const signal = options?.signal ?? config.signal;
    const credentials = options?.credentials ?? config.credentials;
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(credentials === undefined ? {} : { credentials }),
      ...(requestInput.body === undefined ? {} : { body: bodyEncoding === "raw-text" ? requestInput.body as string : JSON.stringify(requestInput.body) }),
      ...(signal === undefined ? {} : { signal }),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ApiClientProtocolError("API response was not valid JSON", response.status); }
    if (!response.ok) {
      const body = parseWireError(payload, response.status);
      const definition = ERROR_DEFINITIONS[operation]?.find((candidate) => candidate.status === response.status && candidate.code === body.code);
      if (definition === undefined) throw new ApiClientUnexpectedError(response.status, body);
      throw new ApiClientError(definition, body, response.headers);
    }
    if (!(SUCCESS_STATUSES[operation] ?? []).includes(response.status)) throw new ApiClientProtocolError("API returned an undeclared success status", response.status);
    const error = schemaError(payload, RESPONSE_SCHEMAS[operation] ?? {}, "$", RESPONSE_SCHEMAS[operation] ?? {});
    if (error !== undefined) throw new ApiClientResponseValidationError(operation, response.status, error);
    return payload as T;
  };
  return {
${bodies}
  };
}
`;
}
