import {
  MAX_BROWSER_SESSION_TTL_SECONDS,
  makeSessionExchangeHandler,
  type SessionExchangeHandlerResult,
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
  /** Present only when the endpoint declares a headers schema. */
  readonly headers?: unknown;
  readonly params: unknown;
  readonly query: unknown;
  readonly principal: Principal | null;
}

const endpointResultTag = Symbol("endpoint-result");
type ResponseHeaders = ConstructorParameters<typeof Headers>[0];

export interface EndpointHandlerResult {
  readonly body: unknown;
  readonly status?: number;
  readonly responseHeaders?: ResponseHeaders;
  readonly [endpointResultTag]: true;
}

export function withEndpointResult(
  body: unknown,
  status?: number,
  responseHeaders?: ResponseHeaders,
): EndpointHandlerResult {
  return status === undefined
    ? { [endpointResultTag]: true, body, ...(responseHeaders ? { responseHeaders } : {}) }
    : {
        [endpointResultTag]: true,
        body,
        status,
        ...(responseHeaders ? { responseHeaders } : {}),
      };
}

export type EndpointHandler = (
  input: DecodedRequest,
) => EndpointHandlerResult | unknown | Promise<EndpointHandlerResult | unknown>;

export interface AuthenticationArgs {
  readonly endpoint: EndpointDefinition;
  readonly credentials: {
    readonly authorization?: string;
    readonly sessionCookie?: string;
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

const requestShape = (endpoint: EndpointDefinition): EndpointRequest | undefined => {
  return endpoint.request;
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

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_COOKIE_HEADER_BYTES = 16 * 1024;
const MAX_COOKIE_VALUE_BYTES = 16 * 1024;
const SESSION_COOKIE_NAME = "__Host-pirate_session";
const CSRF_COOKIE_NAME = "__Host-pirate_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * Solid uses a same-origin `/api` proxy to this Worker. The host-only cookie
 * is therefore sent through that proxy; no cross-site cookie shortcut is part
 * of the browser contract.
 */
const SESSION_COOKIE_ATTRIBUTES = "; Path=/; Secure; SameSite=Lax";
const SESSION_COOKIE_CLEAR_ATTRIBUTES = `${SESSION_COOKIE_ATTRIBUTES}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;

type ParsedCookies = {
  readonly values: ReadonlyMap<string, string>;
  readonly duplicateNames: ReadonlySet<string>;
  readonly invalidNames: ReadonlySet<string>;
};

const SENSITIVE_COOKIE_NAMES = new Set([SESSION_COOKIE_NAME, CSRF_COOKIE_NAME]);
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

function parseCookies(context: HttpContext): ParsedCookies {
  const header = context.req.header("cookie") ?? "";
  if (header.length > MAX_COOKIE_HEADER_BYTES) {
    return {
      values: new Map(),
      duplicateNames: new Set(),
      invalidNames: new Set(SENSITIVE_COOKIE_NAMES),
    };
  }
  const cookies = new Map<string, string>();
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();
  const invalidNames = new Set<string>();
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      const bareName = pair.trim();
      if (SENSITIVE_COOKIE_NAMES.has(bareName)) {
        if (seenNames.has(bareName)) duplicateNames.add(bareName);
        seenNames.add(bareName);
        invalidNames.add(bareName);
      }
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const raw = pair.slice(separator + 1).trim();
    if (name === "") continue;
    if (SENSITIVE_COOKIE_NAMES.has(name)) {
      if (seenNames.has(name)) duplicateNames.add(name);
      seenNames.add(name);
    }
    if (SENSITIVE_COOKIE_NAMES.has(name) && raw.length === 0) {
      invalidNames.add(name);
      continue;
    }
    if (raw.length > MAX_COOKIE_VALUE_BYTES) {
      if (SENSITIVE_COOKIE_NAMES.has(name)) invalidNames.add(name);
      continue;
    }
    try {
      const value = decodeURIComponent(raw);
      if (
        value.length <= MAX_COOKIE_VALUE_BYTES &&
        !hasControlCharacter(value) &&
        (SENSITIVE_COOKIE_NAMES.has(name) ? value.length > 0 : true)
      ) {
        cookies.set(name, value);
      } else if (SENSITIVE_COOKIE_NAMES.has(name)) {
        invalidNames.add(name);
      }
    } catch {
      if (SENSITIVE_COOKIE_NAMES.has(name)) invalidNames.add(name);
      // Malformed cookies are ignored; a protected endpoint will fail closed
      // because it has no usable credential.
    }
  }
  return { values: cookies, duplicateNames, invalidNames };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function sessionCookieHeaders(token: string, ttlSeconds: number): readonly string[] {
  if (
    token.length === 0 ||
    token.length > MAX_COOKIE_VALUE_BYTES ||
    /[\s;\r\n]/u.test(token) ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_BROWSER_SESSION_TTL_SECONDS
  ) {
    throw new InternalError({ message: "Session exchange failed" });
  }
  const csrf = randomToken();
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${ttlSeconds}`,
    `${CSRF_COOKIE_NAME}=${csrf}${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${ttlSeconds}`,
  ];
}

function clearSessionCookieHeaders(): readonly string[] {
  return [
    `${SESSION_COOKIE_NAME}=${SESSION_COOKIE_CLEAR_ATTRIBUTES}; HttpOnly`,
    `${CSRF_COOKIE_NAME}=${SESSION_COOKIE_CLEAR_ATTRIBUTES}`,
  ];
}

function allowedOrigins(
  context: HttpContext,
  config: HttpWorkerConfig | undefined,
): readonly string[] {
  return (corsOrigin(context, config) ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "" && origin !== "*");
}

function enforceExactOrigin(context: HttpContext, config: HttpWorkerConfig | undefined): void {
  const origin = context.req.header("origin");
  if (origin === undefined || !allowedOrigins(context, config).includes(origin)) {
    throw new AuthError({ message: "Authentication failed" });
  }
}

function enforceCookieCsrf(
  context: HttpContext,
  config: HttpWorkerConfig | undefined,
  cookies: ReadonlyMap<string, string>,
): void {
  enforceExactOrigin(context, config);
  const csrfCookie = cookies.get(CSRF_COOKIE_NAME);
  const csrfHeader = context.req.header(CSRF_HEADER_NAME);
  if (
    csrfCookie === undefined ||
    csrfHeader === undefined ||
    csrfCookie.length === 0 ||
    csrfCookie.length > MAX_COOKIE_VALUE_BYTES ||
    csrfHeader !== csrfCookie
  ) {
    throw new AuthError({ message: "Authentication failed" });
  }
}

const invalidBody = (): BadRequest =>
  new BadRequest({ message: "Invalid body request", details: { location: "body" } });

const readBoundedBodyText = async (context: HttpContext): Promise<string> => {
  const declaredLength = context.req.header("content-length");
  if (
    declaredLength !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_REQUEST_BODY_BYTES)
  ) {
    throw invalidBody();
  }

  const body = context.req.raw.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw invalidBody();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidBody();
  }
};

const decodeBody = async (context: HttpContext, request: EndpointRequest): Promise<unknown> => {
  if (request.body === undefined) return undefined;
  const text = await readBoundedBodyText(context);
  const empty = request.bodyEncoding === "raw-text" ? text === "" : text.trim() === "";
  if (empty) {
    if (request.bodyRequired === false) return undefined;
    throw new BadRequest({ message: "Invalid body request", details: { location: "body" } });
  }
  if (request.bodyEncoding === "raw-text") return decode(request.body, text, "body");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidBody();
  }
  return decode(request.body, value, "body");
};

const decodeHeaders = (context: HttpContext, request: EndpointRequest): unknown => {
  if (request.headers === undefined) return undefined;
  return decode(request.headers, Object.fromEntries(context.req.raw.headers), "headers");
};

export const decodeInput = async (
  endpoint: EndpointDefinition,
  context: HttpContext,
  principal: Principal | null,
): Promise<DecodedRequest> => {
  const request = requestShape(endpoint);
  return {
    body: request?.body === undefined ? undefined : await decodeBody(context, request),
    ...(request?.headers === undefined ? {} : { headers: decodeHeaders(context, request) }),
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
  return { code: serialized.body.error.code, status: serialized.status };
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

// Public JWKS responses carry a bounded max-age so a future
// signing-key rotation propagates within the TTL instead of being defeated
// by unbounded intermediary caching. Well under any sane rotation interval.
const PUBLIC_CACHE_CONTROL = "public, max-age=3600, must-revalidate";

const json = (
  context: HttpContext,
  body: unknown,
  status: number,
  noStore: boolean,
  responseHeaders?: ResponseHeaders,
): Response => {
  const headers = new Headers({
    "content-type": "application/json; charset=UTF-8",
    "x-request-id": requestId(context),
  });
  for (const [name, value] of new Headers(responseHeaders ?? {}).entries()) {
    headers.append(name, value);
  }
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
      allowHeaders: ["Authorization", "Content-Type", "X-Request-Id", "X-CSRF-Token"],
      exposeHeaders: ["X-Request-Id"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  for (const binding of routeTable) {
    app.on(binding.method, binding.path, async (context) => {
      const handler =
        options.handlers?.[binding.name] ??
        (binding.name === "SessionExchange" ? sessionExchangeHandler : undefined) ??
        (binding.name === "SessionLogout" ? () => ({ status: "ok" }) : undefined) ??
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
        const parsedCookies = parseCookies(context);
        const cookies = parsedCookies.values;
        if (
          parsedCookies.duplicateNames.has(SESSION_COOKIE_NAME) ||
          parsedCookies.duplicateNames.has(CSRF_COOKIE_NAME) ||
          parsedCookies.invalidNames.has(SESSION_COOKIE_NAME) ||
          parsedCookies.invalidNames.has(CSRF_COOKIE_NAME)
        ) {
          throw new AuthError({ message: "Authentication failed" });
        }
        const sessionCookie = cookies.get(SESSION_COOKIE_NAME);
        const hasSessionCookie = sessionCookie !== undefined && sessionCookie !== "";
        const hasBrowserCredential = hasSessionCookie;
        if (hasAuthorizationHeader && hasSessionCookie) {
          throw new AuthError({ message: "Authentication failed" });
        }
        let principal: Principal | null = null;
        if (
          !isPublic(binding.endpoint) &&
          !hasCredentials &&
          !hasBrowserCredential &&
          !isOptionalUser(binding.endpoint)
        ) {
          throw new AuthError({ message: "Authentication required" });
        }
        if (
          !isPublic(binding.endpoint) &&
          hasAuthorizationHeader &&
          !hasCredentials &&
          !hasBrowserCredential
        ) {
          throw new AuthError({ message: "Authentication required" });
        }
        if (
          !isPublic(binding.endpoint) &&
          (hasCredentials || hasBrowserCredential) &&
          options.authenticate !== undefined
        ) {
          principal = await options.authenticate({
            endpoint: binding.endpoint,
            credentials: {
              ...(authorization === undefined ? {} : { authorization }),
              ...(hasBrowserCredential ? { sessionCookie } : {}),
            },
          });
        }

        // Cookie credentials are ambient and therefore need a same-origin
        // proof on every unsafe protected request. Explicit machine bearer
        // requests remain a separate authentication contract.
        if (
          UNSAFE_METHODS.has(context.req.method) &&
          (binding.name === "SessionExchange" || binding.name === "SessionLogout")
        ) {
          enforceExactOrigin(context, options.config);
        }

        if (
          hasBrowserCredential &&
          UNSAFE_METHODS.has(context.req.method) &&
          (!isPublic(binding.endpoint) || binding.name === "SessionLogout")
        ) {
          enforceCookieCsrf(context, options.config, cookies);
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
        const sessionResult =
          binding.name === "SessionExchange" && isSessionExchangeResult(result)
            ? result
            : undefined;
        const body = sessionResult
          ? sessionResult.response
          : isHandlerResult(result)
            ? result.body
            : result;
        const status = isHandlerResult(result)
          ? (result.status ?? declaredStatuses(binding.endpoint)[0] ?? 200)
          : (declaredStatuses(binding.endpoint)[0] ?? 200);
        validateHandlerStatus(binding.endpoint, status);
        const decoded = decodeResponse(binding.endpoint, body);
        const responseHeaders = isHandlerResult(result) ? result.responseHeaders : undefined;
        const cookiesToSet =
          sessionResult === undefined
            ? binding.name === "SessionLogout"
              ? clearSessionCookieHeaders()
              : undefined
            : sessionCookieHeaders(sessionResult.sessionToken, sessionResult.sessionTtlSeconds);
        const request = requestShape(binding.endpoint);
        const noStore =
          !isPublic(binding.endpoint) ||
          authorization !== undefined ||
          context.req.header("cookie") !== undefined ||
          request?.body !== undefined ||
          cookiesToSet !== undefined;
        const headers = new Headers(responseHeaders);
        for (const cookie of cookiesToSet ?? []) headers.append("set-cookie", cookie);
        return json(context, decoded, status, noStore, headers);
      } catch (error) {
        throw constrainedError(binding.endpoint, error);
      }
    });
  }

  app.onError((error, context) => {
    const serialized = toErrorBody(error, requestId(context));
    return json(context, serialized.body, serialized.status, true, serialized.headers);
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

function isSessionExchangeResult(value: unknown): value is SessionExchangeHandlerResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "response" in value &&
    "sessionToken" in value &&
    "sessionTtlSeconds" in value &&
    typeof value.sessionToken === "string" &&
    typeof value.sessionTtlSeconds === "number"
  );
}
