import {
  BadRequest,
  type EndpointDefinition,
  type EndpointRequest,
  InternalError,
  NotImplemented,
  toErrorBody,
} from "@pirate/contracts";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { routeTable } from "./generated/route-table.ts";

export interface DecodedRequest {
  readonly body?: unknown;
  readonly path?: unknown;
  readonly query?: unknown;
}

const endpointResultTag = Symbol("endpoint-result");

export interface EndpointHandlerResult {
  readonly body: unknown;
  readonly status?: number;
  readonly [endpointResultTag]: true;
}

export function withEndpointResult(body: unknown, status?: number): EndpointHandlerResult {
  return status === undefined
    ? { [endpointResultTag]: true, body }
    : { [endpointResultTag]: true, body, status };
}

export type EndpointHandler = (
  input: DecodedRequest,
  context: Context,
) => EndpointHandlerResult | unknown | Promise<EndpointHandlerResult | unknown>;

export interface AuthorizeArgs {
  readonly endpoint: EndpointDefinition;
  readonly input: DecodedRequest;
  readonly context: Context;
}

export interface HttpWorkerOptions {
  readonly handlers?: Readonly<Record<string, EndpointHandler>>;
  readonly authorize?: (args: AuthorizeArgs) => void | Promise<void>;
}

const isRequestShape = (request: EndpointDefinition["request"]): request is EndpointRequest =>
  typeof request === "object" &&
  request !== null &&
  ("body" in request || "path" in request || "query" in request);

const requestShape = (endpoint: EndpointDefinition): EndpointRequest | undefined => {
  if (endpoint.request === undefined) return undefined;
  return isRequestShape(endpoint.request) ? endpoint.request : { body: endpoint.request };
};

const decode = (
  schema: Schema.Schema<unknown> | undefined,
  value: unknown,
  location: string,
): unknown => {
  if (schema === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>)(value);
  } catch {
    throw new BadRequest({ message: `Invalid ${location} request`, details: { location } });
  }
};

const decodeBody = async (context: Context, request: EndpointRequest): Promise<unknown> => {
  if (request.body === undefined) return undefined;
  const text = await context.req.text();
  if (text.trim() === "") {
    if (request.bodyRequired === false) return undefined;
    throw new BadRequest({ message: "Invalid body request", details: { location: "body" } });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BadRequest({ message: "Invalid body request", details: { location: "body" } });
  }
  return decode(request.body, value, "body");
};

const decodeInput = async (
  endpoint: EndpointDefinition,
  context: Context,
): Promise<DecodedRequest> => {
  const request = requestShape(endpoint);
  if (request === undefined) return {};
  return {
    ...(request.body === undefined ? {} : { body: await decodeBody(context, request) }),
    ...(request.path === undefined
      ? {}
      : { path: decode(request.path, context.req.param(), "path") }),
    ...(request.query === undefined
      ? {}
      : { query: decode(request.query, context.req.query(), "query") }),
  };
};

const defaultSuccessStatus = (endpoint: EndpointDefinition): number => {
  if (endpoint.successStatus === undefined) return 200;
  return typeof endpoint.successStatus === "number"
    ? endpoint.successStatus
    : (endpoint.successStatus[0] ?? 200);
};

const isHandlerResult = (value: unknown): value is EndpointHandlerResult =>
  typeof value === "object" &&
  value !== null &&
  endpointResultTag in value &&
  value[endpointResultTag] === true;

const json = (_context: Context, body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });

export function createHttpWorker(options: HttpWorkerOptions = {}): Hono {
  const app = new Hono();

  for (const binding of routeTable) {
    app.on(binding.method, binding.path, async (context) => {
      const input = await decodeInput(binding.endpoint, context);
      await options.authorize?.({ endpoint: binding.endpoint, input, context });
      const handler = options.handlers?.[binding.name];
      if (handler === undefined) {
        if (binding.name === "Health") return json(context, { status: "ok" }, 200);
        throw new NotImplemented({
          message: "Endpoint handler is not installed",
          details: { endpoint: binding.name },
        });
      }
      const result = await handler(input, context);
      const body = isHandlerResult(result) ? result.body : result;
      const status = isHandlerResult(result)
        ? (result.status ?? defaultSuccessStatus(binding.endpoint))
        : defaultSuccessStatus(binding.endpoint);
      try {
        Schema.decodeUnknownSync(
          binding.endpoint.response as unknown as Schema.ConstraintDecoder<unknown>,
        )(body);
      } catch {
        throw new InternalError({ message: "Endpoint returned an invalid response" });
      }
      return json(context, body, status);
    });
  }

  app.onError((error, context) => {
    const requestId = context.req.header("x-request-id");
    const serialized = toErrorBody(error, requestId);
    return json(context, serialized.body, serialized.status);
  });

  return app;
}
