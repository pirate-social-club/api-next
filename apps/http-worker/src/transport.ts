import {
  makeSessionExchangeHandler,
  type SessionExchangeServices,
} from "@pirate/application/use-cases/session-exchange";
import {
  AuthError,
  BadRequest,
  type EndpointDefinition,
  type EndpointRequest,
  InternalError,
  NotFound,
  toErrorBody,
} from "@pirate/contracts";
import { Schema } from "effect";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { routeTable } from "./generated/route-table.ts";

export interface Principal {
  readonly kind: "user" | "admin" | "agent" | "device";
  readonly subject: string;
  readonly scopes?: readonly string[];
}

/** The only request value a handler or policy authorizer can observe. */
export interface DecodedRequest {
  readonly body: unknown;
  readonly params: unknown;
  readonly query: unknown;
  readonly principal: Principal | null;
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
) => EndpointHandlerResult | unknown | Promise<EndpointHandlerResult | unknown>;

export interface AuthenticationArgs {
  readonly endpoint: EndpointDefinition;
  readonly credentials: {
    readonly authorization: string;
  };
}

export interface AuthorizationArgs {
  readonly endpoint: EndpointDefinition;
  readonly input: DecodedRequest;
}

export interface HttpWorkerConfig {
  /** Comma-separated exact allowed origins, or `*`, supplied by Worker configuration. */
  readonly corsOrigin: string;
}

export interface HttpWorkerOptions {
  readonly config?: HttpWorkerConfig;
  readonly handlers?: Readonly<Record<string, EndpointHandler>>;
  /** Application use cases are installed by generated route name. */
  readonly sessionExchange?: SessionExchangeServices;
  /** Profile projection is installed by the generated GetMyProfile binding. */
  readonly profile?: EndpointHandler;
  /** Runs before any request location is decoded. It receives no Hono data. */
  readonly authenticate?: (args: AuthenticationArgs) => Principal | Promise<Principal>;
  /** Runs after decoding and receives only the frozen request shape. */
  readonly authorize?: (args: AuthorizationArgs) => void | Promise<void>;
}

type HttpWorkerEnv = {
  Variables: { requestId: string };
};
type HttpContext = Context<HttpWorkerEnv>;

const isRequestShape = (request: EndpointDefinition["request"]): request is EndpointRequest =>
  typeof request === "object" &&
  request !== null &&
  ("body" in request || "bodyRequired" in request || "path" in request || "query" in request);

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

const decodeBody = async (context: HttpContext, request: EndpointRequest): Promise<unknown> => {
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
  context: HttpContext,
  principal: Principal | null,
): Promise<DecodedRequest> => {
  const request = requestShape(endpoint);
  return {
    body: request?.body === undefined ? undefined : await decodeBody(context, request),
    params:
      request?.path === undefined ? undefined : decode(request.path, context.req.param(), "path"),
    query:
      request?.query === undefined
        ? undefined
        : decode(request.query, context.req.query(), "query"),
    principal,
  };
};

const isPublic = (endpoint: EndpointDefinition): boolean => endpoint.auth.policy.kind === "public";
const isOptionalUser = (endpoint: EndpointDefinition): boolean =>
  endpoint.auth.optionalUser === true;

const declaredStatuses = (endpoint: EndpointDefinition): readonly number[] => {
  if (endpoint.successStatus === undefined) return [200];
  return typeof endpoint.successStatus === "number"
    ? [endpoint.successStatus]
    : endpoint.successStatus;
};

const errorCodeAndStatus = (error: unknown): { readonly code: string; readonly status: number } => {
  const serialized = toErrorBody(error);
  return { code: serialized.body.code, status: serialized.status };
};

const declaredError = (endpoint: EndpointDefinition, error: unknown): boolean => {
  const actual = errorCodeAndStatus(error);
  return (endpoint.errors ?? []).some((Ctor) => {
    if (!(error instanceof Ctor)) return false;
    const declared = new Ctor({} as never) as { readonly code: string; readonly status: number };
    return declared.code === actual.code && declared.status === actual.status;
  });
};

const constrainedError = (endpoint: EndpointDefinition, error: unknown): unknown => {
  const actual = errorCodeAndStatus(error);
  if (actual.code === "internal_error" || declaredError(endpoint, error)) return error;
  return new InternalError({ message: "Endpoint failed with an undeclared error" });
};

const corsOrigin = (
  context: HttpContext,
  config: HttpWorkerConfig | undefined,
): string | undefined => {
  const configured =
    config?.corsOrigin ?? (context.env as { CORS_ORIGIN?: string } | undefined)?.CORS_ORIGIN;
  return configured === "" ? undefined : configured;
};

const requestId = (context: HttpContext): string => {
  const existing = context.get("requestId");
  if (existing !== undefined) return existing;
  const generated = context.req.header("x-request-id")?.trim() || crypto.randomUUID();
  context.set("requestId", generated);
  return generated;
};

// Public responses (JWKS, discovery) carry a bounded max-age so a future
// signing-key rotation propagates within the TTL instead of being defeated
// by unbounded intermediary caching. Well under any sane rotation interval.
const PUBLIC_CACHE_CONTROL = "public, max-age=3600, must-revalidate";

const json = (context: HttpContext, body: unknown, status: number, noStore: boolean): Response => {
  const headers = new Headers({
    "content-type": "application/json; charset=UTF-8",
    "x-request-id": requestId(context),
  });
  headers.set("cache-control", noStore ? "no-store" : PUBLIC_CACHE_CONTROL);
  return new Response(JSON.stringify(body), { status, headers });
};

const decodeResponse = (endpoint: EndpointDefinition, body: unknown): unknown => {
  try {
    return Schema.decodeUnknownSync(
      endpoint.response as unknown as Schema.ConstraintDecoder<unknown>,
    )(body);
  } catch {
    throw new InternalError({ message: "Endpoint returned an invalid response" });
  }
};

const validateHandlerStatus = (endpoint: EndpointDefinition, status: number): void => {
  if (!declaredStatuses(endpoint).includes(status)) {
    throw new InternalError({ message: "Endpoint returned an undeclared success status" });
  }
};

export function createHttpWorker(options: HttpWorkerOptions = {}): Hono<HttpWorkerEnv> {
  const sessionExchangeHandler =
    options.sessionExchange === undefined
      ? undefined
      : makeSessionExchangeHandler(options.sessionExchange);
  const installedProtectedHandlers = routeTable.filter(
    (binding) =>
      (options.handlers?.[binding.name] !== undefined ||
        (binding.name === "GetMyProfile" && options.profile !== undefined)) &&
      !isPublic(binding.endpoint),
  );
  if (installedProtectedHandlers.length > 0 && options.authenticate === undefined) {
    throw new Error("Protected handlers require an authenticator");
  }
  if (installedProtectedHandlers.length > 0 && options.authorize === undefined) {
    throw new Error("Protected handlers require an authorizer");
  }

  const app = new Hono<HttpWorkerEnv>();
  app.use("*", async (context, next) => {
    requestId(context);
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin, context) => {
        const configured = corsOrigin(context, options.config);
        if (configured === "*") return "*";
        const allowedOrigins = configured
          ?.split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
        return allowedOrigins?.includes(origin) === true ? origin : undefined;
      },
      allowHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  for (const binding of routeTable) {
    app.on(binding.method, binding.path, async (context) => {
      const handler =
        options.handlers?.[binding.name] ??
        (binding.name === "SessionExchange" ? sessionExchangeHandler : undefined) ??
        (binding.name === "GetMyProfile" ? options.profile : undefined);
      if (handler === undefined) {
        if (binding.name === "Health") {
          return json(context, decodeResponse(binding.endpoint, { status: "ok" }), 200, false);
        }
        throw new NotFound({ message: "Endpoint not found" });
      }

      try {
        const authorization = context.req.header("authorization");
        const hasAuthorizationHeader = authorization !== undefined;
        const hasCredentials = authorization !== undefined && authorization.trim() !== "";
        let principal: Principal | null = null;
        if (!isPublic(binding.endpoint) && !hasCredentials && !isOptionalUser(binding.endpoint)) {
          throw new AuthError({ message: "Authentication required" });
        }
        if (!isPublic(binding.endpoint) && hasAuthorizationHeader && !hasCredentials) {
          throw new AuthError({ message: "Authentication required" });
        }
        if (!isPublic(binding.endpoint) && hasCredentials && options.authenticate !== undefined) {
          principal = await options.authenticate({
            endpoint: binding.endpoint,
            credentials: { authorization },
          });
        }

        // Authentication deliberately precedes every request-schema decode.
        const input = await decodeInput(binding.endpoint, context, principal);
        if (
          !isPublic(binding.endpoint) &&
          (!isOptionalUser(binding.endpoint) || principal !== null)
        ) {
          await options.authorize?.({ endpoint: binding.endpoint, input });
        }

        const result = await handler(input);
        const body = isHandlerResult(result) ? result.body : result;
        const status = isHandlerResult(result)
          ? (result.status ?? declaredStatuses(binding.endpoint)[0] ?? 200)
          : (declaredStatuses(binding.endpoint)[0] ?? 200);
        validateHandlerStatus(binding.endpoint, status);
        const decoded = decodeResponse(binding.endpoint, body);
        const request = requestShape(binding.endpoint);
        const noStore =
          !isPublic(binding.endpoint) || authorization !== undefined || request?.body !== undefined;
        return json(context, decoded, status, noStore);
      } catch (error) {
        throw constrainedError(binding.endpoint, error);
      }
    });
  }

  app.onError((error, context) => {
    const serialized = toErrorBody(error, requestId(context));
    return json(context, serialized.body, serialized.status, true);
  });

  return app;
}

function isHandlerResult(value: unknown): value is EndpointHandlerResult {
  return (
    typeof value === "object" &&
    value !== null &&
    endpointResultTag in value &&
    value[endpointResultTag] === true
  );
}
